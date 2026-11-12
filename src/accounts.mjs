/** Account slots: one saved Claude login per folder under ~/.claude-accounts/slots/<name>. */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { MAIN_CREDS, MAIN_STATE, SLOTS, slotDir, slotCreds, slotState } from './paths.mjs';
import { readJson, writeJsonAtomic, hash, withLock, tokenHash } from './util.mjs';
import { loadAccounts, saveAccounts, loadState, updateState, appendLog } from './store.mjs';
import { fetchProfile } from './api.mjs';
import { cliAuthStatus, resolveClaude } from './claude.mjs';
import { FILES } from './paths.mjs';

export const readOauth = (file) => readJson(file, null)?.claudeAiOauth || null;
const NAME_RE = /^[A-Za-z0-9_-]{1,24}$/;

function assertName(name) {
  if (!NAME_RE.test(name || '')) throw new Error('Account name must be 1-24 letters, digits, - or _ (e.g. A, work2).');
}

async function identify(oauth, configDir) {
  if (!oauth) return null;
  if (oauth.expiresAt && oauth.expiresAt < Date.now() + 30000) {
    await withLock(FILES.opsLock, () => cliAuthStatus(configDir));
    oauth = readOauth(configDir ? path.join(configDir, '.credentials.json') : MAIN_CREDS) || oauth;
  }
  try {
    return await fetchProfile(oauth.accessToken);
  } catch {
    const st = readJson(configDir ? path.join(configDir, '.claude.json') : MAIN_STATE, {});
    const oa = st?.oauthAccount;
    return oa ? { uuid: oa.accountUuid, email: oa.emailAddress } : null;
  }
}

/**
 * Which managed account is logged in to the main Claude Code config right now.
 * Identity is decided from the TOKEN, in order of trust:
 *   1. an exact token match with a saved slot              (trusted)
 *   2. our own record for this exact token (switch/profile) (trusted)
 *   3. Anthropic's profile endpoint for this token           (trusted)
 *   4. ~/.claude.json display metadata                       (UNTRUSTED: never used to overwrite a slot)
 */
export async function detectActive({ force = false } = {}) {
  const accounts = loadAccounts();
  const oauth = readOauth(MAIN_CREDS);
  if (!oauth) {
    await updateState((s) => { s.active = null; s.mainOwner = null; });
    return { name: null, loggedIn: false, trusted: true, tokenHash: null };
  }
  const th = tokenHash(oauth);
  const st = loadState();
  const fromRecord = () => {
    const acc = accounts.find((a) => a.uuid && a.uuid === st.mainOwner.uuid);
    return { name: acc?.name || null, loggedIn: true, uuid: st.mainOwner.uuid, email: st.mainOwner.email, trusted: true, tokenHash: th };
  };
  if (!force && st.mainOwner?.tokenHash === th && st.mainOwner.trusted) return fromRecord();

  let id = null;
  let source = null;
  for (const a of accounts) {
    const so = readOauth(slotCreds(a.name));
    if (so && ((so.refreshToken && so.refreshToken === oauth.refreshToken) || so.accessToken === oauth.accessToken)) {
      id = { uuid: a.uuid, email: a.email };
      source = 'slot-match';
      break;
    }
  }
  if (!id && st.mainOwner?.tokenHash === th && st.mainOwner.trusted) return fromRecord();
  if (!id && oauth.expiresAt > Date.now() + 30000) {
    try { id = await fetchProfile(oauth.accessToken); source = 'profile'; } catch {}
  }
  let trusted = !!id;
  if (!id) {
    const oa = readJson(MAIN_STATE, {})?.oauthAccount;
    if (oa) { id = { uuid: oa.accountUuid, email: oa.emailAddress }; source = 'metadata'; }
    trusted = false;
  }
  const acc = accounts.find((a) => a.uuid && a.uuid === id?.uuid);
  await updateState((s) => {
    s.mainOwner = { tokenHash: th, uuid: id?.uuid || null, email: id?.email || null, checkedAt: Date.now(), trusted, source };
    s.active = acc?.name || null;
  });
  return { name: acc?.name || null, loggedIn: true, uuid: id?.uuid, email: id?.email, trusted, tokenHash: th };
}

function register(name, id) {
  const list = loadAccounts();
  const dup = list.find((a) => a.uuid && a.uuid === id.uuid && a.name !== name);
  if (dup) throw new Error(`That login is the same Claude account as "${dup.name}" (${id.email}). Log in with a different account.`);
  const existing = list.find((a) => a.name === name);
  if (existing) Object.assign(existing, { uuid: id.uuid, email: id.email });
  else list.push({ name, uuid: id.uuid, email: id.email, paused: false, addedAt: new Date().toISOString() });
  saveAccounts(list);
  appendLog('account-added', { name, email: id.email });
}

/** Save the login that Claude Code is currently using as a slot (no new sign-in needed). */
export async function importCurrent(name) {
  assertName(name);
  if (loadAccounts().some((a) => a.name === name)) throw new Error(`An account named "${name}" already exists.`);
  const main = readJson(MAIN_CREDS, null);
  if (!main?.claudeAiOauth) throw new Error('Claude Code is not logged in. Log in first, or use "accounts add".');
  const id = await identify(main.claudeAiOauth, null);
  if (!id?.uuid) throw new Error('Could not identify the current login (network?). Try again.');
  fs.mkdirSync(slotDir(name), { recursive: true });
  writeJsonAtomic(slotCreds(name), { claudeAiOauth: main.claudeAiOauth });
  const oa = readJson(MAIN_STATE, {})?.oauthAccount;
  writeJsonAtomic(slotState(name), { hasCompletedOnboarding: true, ...(oa ? { oauthAccount: oa } : {}) });
  register(name, id);
  await detectActive({ force: true });
  return id;
}

/** Opens a console window that runs `claude auth login` into a fresh slot. */
export function addAccount(name) {
  assertName(name);
  if (loadAccounts().some((a) => a.name === name)) throw new Error(`An account named "${name}" already exists.`);
  return openLoginWindow(name);
}

/**
 * For the IDE: create (or reuse) a slot and return what a sign-in terminal needs.
 * The account is registered automatically by the daemon once the login file appears.
 */
export function prepareClaudeLogin(name, { relogin = false } = {}) {
  assertName(name);
  const exists = loadAccounts().some((a) => a.name === name);
  if (!relogin && exists) throw new Error(`A Claude account named "${name}" already exists. Use Sign in again.`);
  if (relogin && !exists) throw new Error(`No Claude account named "${name}".`);
  if (relogin && loadState().active === name)
    throw new Error(`"${name}" is the account Claude Code is using now: run /login inside Claude Code with the same account instead.`);
  const dir = slotDir(name);
  fs.mkdirSync(dir, { recursive: true });
  appendLog('account-login-started', { name, via: 'ide' });
  return { platform: 'claude', name, env: { CLAUDE_CONFIG_DIR: dir }, command: 'claude auth login', cwd: path.dirname(dir), hint: 'A browser opens. Sign in with the Claude account to add (use a private window if it picks the wrong account).' };
}

/** Sign in again to an existing (non-active) account whose login expired. */
export function reloginAccount(name) {
  if (!loadAccounts().some((a) => a.name === name)) throw new Error(`No account named "${name}".`);
  if (loadState().active === name)
    throw new Error(`"${name}" is the account Claude Code is using now: run /login inside Claude Code with the same account instead.`);
  return openLoginWindow(name);
}

export function openLoginWindow(name) {
  assertName(name);
  const dir = slotDir(name);
  fs.mkdirSync(dir, { recursive: true });
  const claude = resolveClaude();
  if (process.platform === 'win32') {
    const cmdFile = path.join(dir, 'login.cmd');
    fs.writeFileSync(
      cmdFile,
      [
        '@echo off',
        `title Claude login - ${name}`,
        `set "CLAUDE_CONFIG_DIR=${dir}"`,
        'echo.',
        `echo  Sign in with the Claude account you want to save as "${name}".`,
        'echo  TIP: if the browser signs you in to the wrong account automatically,',
        'echo       copy the login link into a private / incognito window instead.',
        'echo.',
        `"${claude}" auth login`,
        'echo.',
        `echo  Done. Close this window, then run /accounts in Claude Code to confirm "${name}".`,
        'pause',
      ].join('\r\n'),
    );
    spawn('cmd.exe', ['/c', 'start', '""', `"${cmdFile}"`], {
      detached: true,
      stdio: 'ignore',
      windowsVerbatimArguments: true,
    }).unref();
  } else {
    spawn(claude, ['auth', 'login'], { env: { ...process.env, CLAUDE_CONFIG_DIR: dir }, stdio: 'inherit' });
  }
  appendLog('account-login-started', { name });
  return dir;
}

/** Registers slots whose login window has finished. Returns names newly added. */
export async function scanPendingSlots() {
  const added = [];
  if (!fs.existsSync(SLOTS)) return added;
  const known = new Set(loadAccounts().map((a) => a.name));
  for (const name of fs.readdirSync(SLOTS)) {
    if (known.has(name) || !NAME_RE.test(name)) continue;
    const oauth = readOauth(slotCreds(name));
    if (!oauth) continue;
    try {
      const id = await identify(oauth, slotDir(name));
      if (!id?.uuid) continue;
      register(name, id);
      added.push(name);
    } catch (e) {
      appendLog('account-add-failed', { name, error: e.message });
      await updateState((s) => { s.alerts[`dup:${name}`] = { at: Date.now(), message: e.message }; });
      // Park the duplicate so it is not retried every minute (renamed folders are ignored).
      try { fs.renameSync(slotDir(name), `${slotDir(name)}.duplicate-${Date.now()}`); } catch {}
    }
  }
  if (added.length) await detectActive({ force: true });
  return added;
}

export async function removeAccount(name, { force = false } = {}) {
  const list = loadAccounts();
  const acc = list.find((a) => a.name === name);
  if (!acc) throw new Error(`No account named "${name}".`);
  const st = loadState();
  if (st.active === name && !force)
    throw new Error(`"${name}" is the account Claude Code is using right now. Switch first, or add --force.`);
  saveAccounts(list.filter((a) => a.name !== name));
  try { fs.rmSync(slotDir(name), { recursive: true, force: true }); } catch {}
  await updateState((s) => {
    delete s.usage[name]; delete s.track[name]; delete s.Y[name]; delete s.primes[name];
  });
  appendLog('account-removed', { name });
}

export function setPaused(name, paused) {
  const list = loadAccounts();
  const acc = list.find((a) => a.name === name);
  if (!acc) throw new Error(`No account named "${name}".`);
  acc.paused = !!paused;
  saveAccounts(list);
  appendLog(paused ? 'account-paused' : 'account-resumed', { name });
}
