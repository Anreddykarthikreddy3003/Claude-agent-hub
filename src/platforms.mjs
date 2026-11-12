/**
 * Multiple accounts for every agent platform (Claude is handled by accounts.mjs/switcher.mjs).
 *
 * Isolation (verified on this machine):
 *   codex    CODEX_HOME=<dir>            login: codex login            status: auth.json (+ live usage API)
 *   hermes   HERMES_HOME=<dir>           login: hermes model           status: auth.json providers
 *   kimi     KIMI_CODE_HOME=<dir>        login: kimi login             status: credentials/ + config default_model
 *   opencode XDG_DATA_HOME=<dir>/data    login: opencode auth login    status: data/opencode/auth.json providers
 *   agy      (no home override)          login: agy                    login FILE is swapped, like Claude
 * "default" = the CLI's normal home folder (the account you already use).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA } from './paths.mjs';
import { readJson, writeJsonAtomic, hash, withLock } from './util.mjs';
import { appendLog } from './store.mjs';

const HOME = os.homedir();
const LOCAL = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
const REG = path.join(DATA, 'platforms.json');
const ROOT = path.join(DATA, 'platforms');
const NAME_RE = /^[A-Za-z0-9_-]{1,24}$/;
const accDir = (p, n) => path.join(ROOT, p, n);

const b64json = (jwt) => { try { return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString()); } catch { return {}; } };
const first = (...xs) => xs.find((x) => x != null && x !== '');

export const PLATFORM_DEFS = {
  codex: {
    label: 'Codex',
    home: path.join(HOME, '.codex'),
    env: (dir) => ({ CODEX_HOME: dir }),
    login: 'codex login',
    loginHint: 'A browser window opens. Sign in with the ChatGPT account you want to add.',
    status(dir) {
      const a = readJson(path.join(dir, 'auth.json'), null);
      if (!a?.tokens?.refresh_token && !a?.OPENAI_API_KEY) return { signedIn: false };
      const id = b64json(a.tokens?.id_token || '');
      return { signedIn: true, email: id.email || null, plan: id['https://api.openai.com/auth']?.chatgpt_plan_type || (a.OPENAI_API_KEY ? 'API key' : null), key: hash(a.tokens?.account_id || a.tokens?.refresh_token || '') };
    },
    async usage(dir) {
      const a = readJson(path.join(dir, 'auth.json'), null);
      const t = a?.tokens;
      if (!t?.access_token) return null;
      const r = await fetch('https://chatgpt.com/backend-api/wham/usage', {
        headers: { Authorization: `Bearer ${t.access_token}`, 'chatgpt-account-id': t.account_id || '', 'User-Agent': 'codex-cli', originator: 'codex_cli_rs' },
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) return { error: `HTTP ${r.status}` };
      const j = await r.json();
      const win = (w) => (w ? { util: Math.round(w.used_percent || 0), resetsAt: w.reset_at ? w.reset_at * 1000 : null, hours: Math.round((w.limit_window_seconds || 0) / 3600) } : null);
      const rl = j.rate_limit || {};
      const wins = [win(rl.primary_window), win(rl.secondary_window)].filter(Boolean);
      return { limited: !!rl.limit_reached, five: wins.find((w) => w.hours <= 6) || null, week: wins.find((w) => w.hours > 6) || null };
    },
  },
  hermes: {
    label: 'Hermes Agent',
    home: path.join(LOCAL, 'hermes'),
    env: (dir) => ({ HERMES_HOME: dir }),
    login: 'hermes model',
    loginHint: 'Pick your provider and sign in (Nous Portal, OpenAI, Qwen, …).',
    status(dir) {
      const a = readJson(path.join(dir, 'auth.json'), null);
      const provs = Object.keys(a?.providers || {});
      const pool = Object.entries(a?.credential_pool || {}).filter(([, v]) => Array.isArray(v) && v.length).map(([k]) => k);
      if (!provs.length && !pool.length) return { signedIn: false };
      const relogin = Object.values(a.providers || {}).some((p) => p?.last_auth_error?.relogin_required);
      return { signedIn: true, warning: relogin ? 'Provider asks you to sign in again' : null, email: null, plan: [...new Set([...provs, ...pool])].join(', '), key: hash(JSON.stringify(a.providers || {}).slice(0, 2000)) };
    },
  },
  kimi: {
    label: 'Kimi Code',
    home: path.join(HOME, '.kimi-code'),
    env: (dir) => ({ KIMI_CODE_HOME: dir }),
    login: 'kimi login',
    loginHint: 'A device code is shown. Open the link and approve it with your Kimi account.',
    status(dir) {
      const cdir = path.join(dir, 'credentials');
      const has = fs.existsSync(cdir) && fs.readdirSync(cdir).some((f) => fs.statSync(path.join(cdir, f)).size > 20);
      if (!has) return { signedIn: false };
      const cfg = (() => { try { return fs.readFileSync(path.join(dir, 'config.toml'), 'utf8'); } catch { return ''; } })();
      const model = /^\s*default_model\s*=\s*"([^"]+)"/m.exec(cfg)?.[1] || null;
      return { signedIn: true, plan: model ? `model ${model}` : null, warning: model ? null : 'No default model set: run `kimi`, then /model', key: hash(cdir) };
    },
  },
  opencode: {
    label: 'OpenCode',
    home: path.join(HOME, '.local', 'share'),
    env: (dir) => ({ XDG_DATA_HOME: path.join(dir, 'data') }),
    login: 'opencode auth login',
    loginHint: 'Choose a provider (OpenAI, Google/Antigravity, Anthropic, …) and sign in.',
    authFile: (dir, isDefault) => (isDefault ? path.join(HOME, '.local', 'share', 'opencode', 'auth.json') : path.join(dir, 'data', 'opencode', 'auth.json')),
    status(dir, isDefault) {
      const a = readJson(this.authFile(dir, isDefault), null);
      const provs = Object.keys(a || {});
      if (!provs.length) return { signedIn: false };
      const expired = provs.filter((p) => a[p]?.expires && a[p].expires < Date.now() && !a[p]?.refresh);
      return { signedIn: true, plan: provs.join(', '), warning: expired.length ? `Expired: ${expired.join(', ')}` : null, key: hash(provs.join()) };
    },
  },
  agy: {
    label: 'Antigravity CLI',
    // Measured: agy keeps its login in Windows Credential Manager (generic credential "gemini:antigravity"),
    // not in a file and not per home folder. Accounts are saved copies of that credential, swapped in when chosen.
    cred: 'gemini:antigravity',
    swap: true,
    login: 'agy',
    loginHint: 'agy opens its Google sign-in. Use the account you want to add; when agy shows its prompt, type /exit. Your previous login is restored automatically if you cancel.',
    status(dir) {
      const s = readJson(path.join(dir, 'credential.json'), null);
      if (!s?.blob) return { signedIn: false };
      return { signedIn: true, ...agyIdentity(Buffer.from(s.blob, 'base64')) };
    },
    // Antigravity quota per model (same data the Antigravity IDE shows): remainingFraction + resetTime.
    async usage(dir) {
      const s = readJson(path.join(dir, 'credential.json'), null);
      let tok = null;
      try { tok = JSON.parse(Buffer.from(s.blob, 'base64').toString('utf8')).token; } catch {}
      if (!tok?.access_token) return null;
      const r = await fetch('https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels', {
        method: 'POST',
        headers: { Authorization: `Bearer ${tok.access_token}`, 'Content-Type': 'application/json', 'User-Agent': 'antigravity' },
        body: '{}',
        signal: AbortSignal.timeout(12000),
      });
      if (!r.ok) return { error: `HTTP ${r.status}`, expired: r.status === 401 };
      const j = await r.json();
      const groups = {};
      for (const m of Object.values(j.models || {})) {
        const q = m.quotaInfo;
        if (!q || q.remainingFraction == null) continue;
        const n = m.displayName || '';
        const label = /claude/i.test(n) ? 'Claude models' : /gpt|oss/i.test(n) ? 'GPT-OSS' : /pro/i.test(n) ? 'Gemini Pro' : /flash/i.test(n) ? 'Gemini Flash' : 'Other models';
        const util = Math.round((1 - q.remainingFraction) * 100);
        const resetsAt = q.resetTime ? Date.parse(q.resetTime) : null;
        const g = (groups[label] ||= { label, util: 0, resetsAt: null });
        g.util = Math.max(g.util, util);
        if (resetsAt && (!g.resetsAt || resetsAt < g.resetsAt)) g.resetsAt = resetsAt;
      }
      const list = Object.values(groups).sort((a, b) => b.util - a.util);
      return { groups: list, limited: list.some((g) => g.util >= 100) };
    },
  },
};
export const ACCOUNT_PLATFORMS = Object.keys(PLATFORM_DEFS);

function reg() { return readJson(REG, {}) || {}; }
function saveReg(r) { writeJsonAtomic(REG, r); }
function def(p) { const d = PLATFORM_DEFS[p]; if (!d) throw new Error(`Unknown platform "${p}"`); return d; }

/** The folder that holds an account's login (default = the CLI's own home). */
export function accountHome(platform, name) {
  const d = def(platform);
  if (!name || name === 'default') return d.home;
  return accDir(platform, name);
}

/** Environment variables that make a CLI use this account. {} for the default account. */
export function accountEnv(platform, name) {
  const d = def(platform);
  if (!name || name === 'default' || !d.env) return {};
  return d.env(accDir(platform, name));
}

export function listAccounts(platform) {
  const d = def(platform);
  const r = reg()[platform] || { accounts: [], default: 'default' };
  const out = [];
  // agy has no "home" account: every account is a saved copy of its Credential Manager login.
  if (!d.swap) out.push({ name: 'default', isDefaultHome: true, paused: !!r.pausedDefault, ...d.status(d.home, true) });
  for (const a of r.accounts || []) {
    const st = d.swap ? d.status(accDir(platform, a.name)) : d.status(accDir(platform, a.name), false);
    out.push({ ...a, ...st });
  }
  const preferred = r.default || 'default';
  for (const a of out) {
    a.preferred = a.name === preferred;
    a.limitedUntil = r.limits?.[a.name] && r.limits[a.name] > Date.now() ? r.limits[a.name] : null;
    a.usage = r.usage?.[a.name] || null;
  }
  // agy: which saved account is live right now (cached by the daemon; reading Credential Manager is async)
  if (d.swap) {
    const liveKey = r.live?.key;
    const liveEmail = r.live?.email;
    for (const a of out) a.active = !!a.key && (a.key === liveKey || (!!liveEmail && a.email === liveEmail));
    if (r.pending) for (const a of out) if (a.name === r.pending.name) a.pendingLogin = true;
  }
  return out;
}

export function allPlatformAccounts() {
  return Object.fromEntries(ACCOUNT_PLATFORMS.map((p) => [p, { label: PLATFORM_DEFS[p].label, login: PLATFORM_DEFS[p].login, loginHint: PLATFORM_DEFS[p].loginHint, swap: !!PLATFORM_DEFS[p].swap, accounts: listAccounts(p) }]));
}

/**
 * Create an account folder and return what the IDE needs to open a sign-in terminal:
 * { platform, name, env, command, cwd, hint }.
 */
export async function prepareLogin(platform, name, { relogin = false } = {}) {
  const d = def(platform);
  if (d.swap) return prepareAgyLogin(name, relogin);
  if (!NAME_RE.test(name || '')) throw new Error('Account name: 1-24 letters, digits, - or _ (e.g. work2).');
  const r = reg();
  const pr = (r[platform] ||= { accounts: [], default: 'default' });
  if (name !== 'default' && !pr.accounts.some((a) => a.name === name)) {
    if (relogin) throw new Error(`No ${d.label} account named "${name}".`);
    pr.accounts.push({ name, addedAt: new Date().toISOString(), paused: false });
    saveReg(r);
    appendLog('platform-account-added', { platform, name });
  } else if (!relogin && name !== 'default') throw new Error(`A ${d.label} account named "${name}" already exists. Use Sign in again.`);
  const dir = name === 'default' ? d.home : accDir(platform, name);
  fs.mkdirSync(dir, { recursive: true });
  if (platform === 'opencode') fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  return { platform, name, env: accountEnv(platform, name), command: d.login, cwd: HOME, hint: d.loginHint };
}

// ───────────── agy: credential-swap accounts (Windows Credential Manager) ─────────────
function agyIdentity(blob) {
  let j = {};
  try { j = JSON.parse(blob.toString('utf8')); } catch {}
  return { email: j.id_token_email || null, plan: j.auth_method || null, key: hash(j.token ? JSON.stringify(j.token).slice(0, 4000) : blob.toString('base64')) };
}

async function agyLive() {
  const { credRead } = await import('./wincred.mjs');
  const c = await credRead(PLATFORM_DEFS.agy.cred);
  return c ? { user: c.user, blob: c.blob, ...agyIdentity(c.blob) } : null;
}

function saveAgySlot(name, live) {
  const dir = accDir('agy', name);
  fs.mkdirSync(dir, { recursive: true });
  writeJsonAtomic(path.join(dir, 'credential.json'), { user: live.user, blob: live.blob.toString('base64'), savedAt: Date.now() });
  try { fs.chmodSync(path.join(dir, 'credential.json'), 0o600); } catch {}
}

/** Make sure the live agy login is saved as an account (auto-import the first time). Returns its name. */
async function ensureAgyLiveSaved() {
  const live = await agyLive();
  const r = reg();
  const pr = (r.agy ||= { accounts: [], default: null });
  pr.live = live ? { key: live.key, email: live.email, at: Date.now() } : { key: null, at: Date.now() };
  if (!live) { saveReg(r); return null; }
  let owner = pr.accounts.find((a) => PLATFORM_DEFS.agy.status(accDir('agy', a.name)).key === live.key);
  if (!owner) {
    // same Google account signed in again (new token)? match by email, otherwise import as a new account
    owner = live.email && pr.accounts.find((a) => PLATFORM_DEFS.agy.status(accDir('agy', a.name)).email === live.email);
    if (!owner) {
      let base = (live.email || 'main').split('@')[0].replace(/[^A-Za-z0-9_-]/g, '').slice(0, 20) || 'main';
      let name = base, i = 2;
      while (pr.accounts.some((a) => a.name === name)) name = `${base}${i++}`;
      owner = { name, addedAt: new Date().toISOString(), paused: false, imported: true };
      pr.accounts.push(owner);
      appendLog('platform-account-imported', { platform: 'agy', name, email: live.email });
    }
  }
  saveReg(r);
  saveAgySlot(owner.name, live); // always keep the freshest token in the slot
  return owner.name;
}

async function prepareAgyLogin(name, relogin) {
  if (!NAME_RE.test(name || '')) throw new Error('Account name: 1-24 letters, digits, - or _ (e.g. work2).');
  const r0 = reg();
  if (r0.agy?.pending) throw new Error('An Antigravity sign-in is already in progress. Finish it or close its terminal first.');
  const prev = await ensureAgyLiveSaved(); // the current login is safe before anything else happens
  const r = reg();
  const pr = (r.agy ||= { accounts: [], default: null });
  const exists = pr.accounts.some((a) => a.name === name);
  if (!relogin && exists) throw new Error(`An Antigravity account named "${name}" already exists. Use Sign in again.`);
  if (relogin && !exists) throw new Error(`No Antigravity account named "${name}".`);
  if (!exists) pr.accounts.push({ name, addedAt: new Date().toISOString(), paused: false });
  pr.pending = { name, prev, prevKey: pr.live?.key || null, at: Date.now() };
  saveReg(r);
  const { credDelete } = await import('./wincred.mjs');
  await credDelete(PLATFORM_DEFS.agy.cred);
  appendLog('platform-login-started', { platform: 'agy', name, previous: prev });
  return { platform: 'agy', name, env: {}, command: PLATFORM_DEFS.agy.login, cwd: HOME, hint: PLATFORM_DEFS.agy.loginHint, swap: true };
}

/**
 * Daemon tick + when the sign-in terminal closes:
 *  - a new agy login appeared → save it as the pending account
 *  - no new login after `graceMs` (or the terminal was closed) → restore the previous login (rollback)
 */
export async function captureSwapLogins({ finished = false } = {}) {
  if (process.platform !== 'win32') return;
  const r = reg();
  const p = r.agy?.pending;
  if (!p) { if (Date.now() - (r.agy?.live?.at || 0) > 5 * 60e3) await ensureAgyLiveSaved().catch(() => {}); return; }
  const live = await agyLive();
  if (live && live.key !== p.prevKey) {
    saveAgySlot(p.name, live);
    const fresh = reg();
    delete fresh.agy.pending;
    fresh.agy.live = { key: live.key, email: live.email, at: Date.now() };
    saveReg(fresh);
    appendLog('platform-login-captured', { platform: 'agy', name: p.name, email: live.email });
    return { captured: p.name };
  }
  const expired = Date.now() - p.at > 15 * 60e3;
  if ((finished || expired) && !live) return rollbackAgy('sign-in was not completed');
  if ((finished || expired) && live && live.key === p.prevKey) { const fresh = reg(); delete fresh.agy.pending; saveReg(fresh); }
}

async function rollbackAgy(why) {
  const r = reg();
  const p = r.agy?.pending;
  if (!p) return;
  const { credWrite } = await import('./wincred.mjs');
  const slot = p.prev && readJson(path.join(accDir('agy', p.prev), 'credential.json'), null);
  if (slot?.blob) await credWrite(PLATFORM_DEFS.agy.cred, slot.user || 'antigravity', Buffer.from(slot.blob, 'base64'));
  const fresh = reg();
  // drop the placeholder account if it never got a login
  if (!fs.existsSync(path.join(accDir('agy', p.name), 'credential.json'))) fresh.agy.accounts = fresh.agy.accounts.filter((a) => a.name !== p.name);
  delete fresh.agy.pending;
  saveReg(fresh);
  appendLog('platform-login-rolled-back', { platform: 'agy', name: p.name, restored: p.prev || null, why });
  return { rolledBack: true, restored: p.prev || null };
}

/** agy: make a saved account the live one (the current login is saved back first). */
export async function activateSwap(platform, name) {
  if (platform !== 'agy') throw new Error(`${def(platform).label} accounts don't need switching; choose the account per agent.`);
  return withLock(path.join(DATA, 'swap-agy.lock'), async () => {
    const slot = readJson(path.join(accDir('agy', name), 'credential.json'), null);
    if (!slot?.blob) throw new Error(`"${name}" has no saved Antigravity login. Sign in first.`);
    await ensureAgyLiveSaved();
    const { credWrite } = await import('./wincred.mjs');
    await credWrite(PLATFORM_DEFS.agy.cred, slot.user || 'antigravity', Buffer.from(slot.blob, 'base64'));
    const r = reg();
    r.agy.live = { key: PLATFORM_DEFS.agy.status(accDir('agy', name)).key, at: Date.now() };
    saveReg(r);
    appendLog('platform-account-activated', { platform: 'agy', name });
    return { active: name };
  });
}

export function setPreferred(platform, name) {
  const r = reg();
  (r[platform] ||= { accounts: [], default: 'default' }).default = name;
  saveReg(r);
}

export function setPausedAccount(platform, name, paused) {
  const r = reg();
  const pr = (r[platform] ||= { accounts: [], default: 'default' });
  if (name === 'default') pr.pausedDefault = !!paused;
  else { const a = pr.accounts.find((x) => x.name === name); if (!a) throw new Error('No such account'); a.paused = !!paused; }
  saveReg(r);
}

export async function removeAccount(platform, name) {
  if (platform === 'agy' && reg().agy?.pending?.name === name) await rollbackAgy('account removed during sign-in');
  if (name === 'default') throw new Error('The default account is your normal CLI login; sign out with the CLI itself.');
  const r = reg();
  const pr = r[platform];
  if (!pr?.accounts?.some((a) => a.name === name)) throw new Error('No such account');
  pr.accounts = pr.accounts.filter((a) => a.name !== name);
  if (pr.default === name) pr.default = 'default';
  saveReg(r);
  fs.rmSync(accDir(platform, name), { recursive: true, force: true });
  appendLog('platform-account-removed', { platform, name });
}

/** Mark an account limited (by the hub) so failover skips it until the time passes. */
export function markLimited(platform, name, until) {
  const r = reg();
  const pr = (r[platform] ||= { accounts: [], default: 'default' });
  (pr.limits ||= {})[name || 'default'] = until;
  saveReg(r);
}

/** Next usable account for failover (signed in, not paused, not limited), preferred first. */
export function nextAccount(platform, exclude) {
  const list = listAccounts(platform).filter((a) => a.signedIn && !a.paused && !a.limitedUntil && a.name !== exclude && !(a.usage?.limited));
  list.sort((a, b) => (b.preferred - a.preferred) || ((a.usage?.week?.util ?? 50) - (b.usage?.week?.util ?? 50)));
  return list[0]?.name || null;
}

export function preferredAccount(platform) {
  const list = listAccounts(platform);
  const p = list.find((a) => a.preferred && a.signedIn && !a.paused);
  return p?.name || nextAccount(platform, null) || 'default';
}

/**
 * Refresh live usage where the platform offers it (Codex, Antigravity).
 * Called by the daemon every few minutes, and by the dashboard's Refresh button (`only` = one platform).
 */
export async function refreshPlatformUsage({ only = null } = {}) {
  for (const platform of ACCOUNT_PLATFORMS) {
    if (only && platform !== only) continue;
    const d = PLATFORM_DEFS[platform];
    if (!d.usage) continue;
    const r = reg();
    const pr = (r[platform] ||= { accounts: [], default: 'default' });
    const usage = { ...(pr.usage || {}) };
    if (platform === 'agy') await ensureAgyLiveSaved().catch(() => {}); // sync the freshest token into its slot
    for (const a of listAccounts(platform).filter((x) => x.signedIn)) {
      try {
        let u = await d.usage(accountHome(platform, a.name));
        if (platform === 'agy' && u?.expired && a.active) {
          // Google tokens last ~1 h and agy refreshes them only when it runs: `agy models` refreshes it (no model tokens used)
          const { runCapture, ADAPTERS } = await import('./hub/adapters.mjs');
          const bin = ADAPTERS.agy.resolve();
          if (bin) await runCapture(bin.cmd, ['models'], 60000);
          await ensureAgyLiveSaved().catch(() => {});
          u = await d.usage(accountHome(platform, a.name));
        }
        // keep the last good numbers (marked stale) rather than replacing them with an error
        if (u?.error && usage[a.name] && !usage[a.name].error) usage[a.name] = { ...usage[a.name], stale: true };
        else usage[a.name] = { ...u, at: Date.now() };
      } catch (e) {
        usage[a.name] = usage[a.name] && !usage[a.name].error ? { ...usage[a.name], stale: true } : { error: e.message, at: Date.now() };
      }
    }
    const fresh = reg();
    (fresh[platform] ||= { accounts: [], default: 'default' }).usage = usage;
    saveReg(fresh);
  }
}

/**
 * Codex session priming (switch: Home → Automation → Codex). Only accounts whose plan has a 5-hour window
 * benefit: the window starts on first use, like Claude's. Weekly-only plans (e.g. Team) are skipped.
 * Idle = 0% used and the reset time is still "a full window from now" (it floats until something is sent).
 * Cost: a Codex "hi" is ~19k tokens (mostly cached), so at most one per account per 5-hour window.
 */
export async function primeCodexAccounts() {
  const now = Date.now();
  const r = reg();
  const pr = (r.codex ||= { accounts: [], default: 'default' });
  const sent = [];
  for (const a of listAccounts('codex').filter((x) => x.signedIn && !x.paused && !x.limitedUntil)) {
    const five = a.usage?.five;
    if (!five) continue; // weekly-only plan: nothing to prime
    const idle = five.util === 0 && (!five.resetsAt || five.resetsAt - now > five.hours * 3600e3 - 3 * 60e3);
    const last = pr.primes?.[a.name] || 0;
    if (!idle || now - last < five.hours * 3600e3 * 0.9) continue;
    const { testCodexMessage } = await import('./acctest.mjs');
    const res = await testCodexMessage(a.name).catch((e) => ({ ok: false, error: e.message }));
    const fresh = reg();
    ((fresh.codex ||= { accounts: [], default: 'default' }).primes ||= {})[a.name] = Date.now();
    saveReg(fresh);
    appendLog('prime', { platform: 'codex', name: a.name, ok: !!res.ok, tokens: res.tokens || null, error: res.ok ? undefined : res.error });
    sent.push(a.name);
  }
  if (sent.length) await refreshPlatformUsage({ only: 'codex' });
  return sent;
}
