/**
 * Switching = swap the `claudeAiOauth` login inside Claude Code's main credentials file.
 *
 * Safety rules (from the Claude-vs-Codex review, see .duo/):
 *  - The ACTIVE account's live tokens are in the main config. Before swapping they are saved back to its slot.
 *  - Identity comes from the token (detectActive). An UNVERIFIED identity never overwrites a slot.
 *  - Strict reads: a credentials file that exists but can't be parsed aborts the switch (never treated as empty).
 *  - Re-verify that main still holds the exact tokens that were identified, immediately before writing.
 *  - Automatic switches never overwrite a login this tool doesn't manage.
 *  - Credentials + our state are the commit point; the ~/.claude.json display identity is best-effort
 *    and retried by the daemon if Windows has the file locked.
 */
import fs from 'node:fs';
import { MAIN_CREDS, MAIN_STATE, FILES, slotCreds, slotState } from './paths.mjs';
import { readJson, readJsonStrict, writeJsonAtomic, withLock, tokenHash, fmtTime } from './util.mjs';
import { loadAccounts, updateState, appendLog, backup, loadState, loadConfig } from './store.mjs';
import { detectActive, readOauth } from './accounts.mjs';
import { snapshot } from './collector.mjs';
import { rankViews, needsSwitch, switchReason, nextAvailable, whyBest } from './engine.mjs';
import { notify } from './notify.mjs';
import { publishStatus } from './report.mjs';

function dailyBackupMainState() {
  const st = loadState();
  const day = new Date().toDateString();
  if (st.alerts?.[`backup-claude-json:${day}`]) return;
  backup(MAIN_STATE, 'claude-json', 5);
  updateState((s) => { s.alerts[`backup-claude-json:${day}`] = Date.now(); }).catch(() => {});
}

/** Update the account identity Claude Code displays. Never throws; returns true on success. */
export function writeDisplayIdentity(target) {
  try {
    const tgtOa = readJson(slotState(target), {})?.oauthAccount;
    if (!fs.existsSync(MAIN_STATE)) return true;
    dailyBackupMainState();
    const ms = readJsonStrict(MAIN_STATE);
    if (!ms) return true;
    if (tgtOa) ms.oauthAccount = tgtOa;
    delete ms.cachedUsageUtilization;
    writeJsonAtomic(MAIN_STATE, ms);
    return true;
  } catch (e) {
    appendLog('identity-write-deferred', { target, error: e.message });
    return false;
  }
}

/** Called by the daemon: finish a display-identity update that Windows blocked earlier. */
export async function retryPendingIdentity() {
  const st = loadState();
  const t = st.pendingIdentity;
  if (!t) return;
  if (st.active !== t) return updateState((s) => { delete s.pendingIdentity; });
  if (writeDisplayIdentity(t)) await updateState((s) => { delete s.pendingIdentity; });
}

const AUTO = (reason) => !/^manual|requested/.test(reason || '');

export async function switchTo(target, reason = 'manual') {
  return withLock(FILES.opsLock, async () => {
    const acc = loadAccounts().find((a) => a.name === target);
    if (!acc) throw new Error(`No account named "${target}".`);
    if (acc.paused) throw new Error(`"${target}" is paused. Resume it first.`);
    const tgtFile = readJsonStrict(slotCreds(target));
    if (!tgtFile?.claudeAiOauth) throw new Error(`"${target}" has no saved login. Run: /accounts relogin ${target}`);

    const det = await detectActive({ force: true });
    const from = det.name;
    // A manual pick of an account already past the switch thresholds is deliberate: hold it until 100%
    // (like Force) instead of letting the next background check switch straight back.
    const tv = snapshot().views.find((v) => v.name === target);
    const holdManual = /^manual/.test(reason || '') && (tv?.status === 'session-limit' || tv?.status === 'weekly-limit');
    if (from === target) return { changed: false, from, to: target, reason };
    if (det.loggedIn && !det.trusted)
      throw new Error('Cannot verify which account Claude Code is logged in to right now (offline or token expired). Not switching, to avoid overwriting a saved login. Will retry.');
    if (det.loggedIn && !from && AUTO(reason))
      throw new Error(`Claude Code is logged in to an account this tool doesn't manage (${det.email || 'unknown'}). Automatic switching leaves it alone.`);

    // Strict read + re-verify: main must still hold exactly the tokens we identified.
    const main = readJsonStrict(MAIN_CREDS) || {};
    if (det.loggedIn && tokenHash(main.claudeAiOauth) !== det.tokenHash)
      throw new Error('Claude Code refreshed its login during the switch. Retrying on the next check.');
    backup(MAIN_CREDS, 'credentials');

    // 1) Save the outgoing account's live tokens back to its slot (verified identity only).
    if (from && main.claudeAiOauth) {
      const slot = readJsonStrict(slotCreds(from)) || {};
      slot.claudeAiOauth = main.claudeAiOauth;
      writeJsonAtomic(slotCreds(from), slot);
      const oa = readJson(MAIN_STATE, {})?.oauthAccount;
      if (oa && oa.accountUuid === acc.uuid) {
        // display metadata already belongs to the target (stale); don't copy it into the outgoing slot
      } else if (oa) {
        const ss = readJson(slotState(from), {}) || {};
        ss.oauthAccount = oa;
        ss.hasCompletedOnboarding = true;
        writeJsonAtomic(slotState(from), ss);
      }
    }

    // 2) Commit: install the incoming tokens (other keys such as MCP logins untouched) + record ownership.
    main.claudeAiOauth = tgtFile.claudeAiOauth;
    writeJsonAtomic(MAIN_CREDS, main);
    await updateState((s) => {
      s.active = target;
      s.mainOwner = { tokenHash: tokenHash(tgtFile.claudeAiOauth), uuid: acc.uuid, email: acc.email, checkedAt: Date.now(), trusted: true, source: 'switch' };
      s.lastSwitch = { from, to: target, at: Date.now(), reason };
      delete s.pendingIdentity;
      // any switch that isn't a forced one ends a previous "hold until 100%"
      if (holdManual) s.forced = { name: target, at: Date.now(), implicit: true };
      else if (!/^forced/.test(reason || '')) delete s.forced;
    });

    // 3) Best-effort display identity (Windows may have ~/.claude.json locked; retried by the daemon).
    if (!writeDisplayIdentity(target)) await updateState((s) => { s.pendingIdentity = target; });

    appendLog('switch', { from, to: target, reason });
    publishStatus();
    return { changed: true, from, to: target, reason };
  });
}

/**
 * Keep the active account's saved copy current. Claude Code rotates the refresh token every time it refreshes,
 * so between switches the slot copy goes stale (its refresh token is dead). If the live login were then
 * overwritten, for example by an older chat writing back its own account, that account would need a new
 * sign-in. Mirroring verified live tokens into the slot on every check closes that gap.
 */
export async function syncActiveSlot() {
  return withLock(FILES.opsLock, async () => {
    const det = await detectActive();
    if (!det.loggedIn || !det.trusted || !det.name) return false;
    const main = readJsonStrict(MAIN_CREDS);
    const live = main?.claudeAiOauth;
    if (!live?.refreshToken || tokenHash(live) !== det.tokenHash) return false; // changed while we looked
    const slot = readJsonStrict(slotCreds(det.name)) || {};
    const saved = slot.claudeAiOauth;
    if (saved && saved.refreshToken === live.refreshToken && saved.accessToken === live.accessToken) return false;
    if (saved?.expiresAt && live.expiresAt && saved.expiresAt > live.expiresAt) return false; // never go backwards
    slot.claudeAiOauth = live;
    writeJsonAtomic(slotCreds(det.name), slot);
    appendLog('slot-synced', { name: det.name });
    return true;
  }, { timeoutMs: 5000 }).catch(() => false);
}

/**
 * Force-switch: use an account even though it is past the normal thresholds (e.g. 98% weekly).
 * It is then held until it reaches 100% (or becomes unusable); after that automatic switching resumes.
 */
export async function forceSwitch(target) {
  const r = await switchTo(target, 'forced (dashboard)');
  await updateState((s) => { s.forced = { name: target, at: Date.now() }; });
  appendLog('forced-hold-started', { name: target });
  publishStatus();
  return { ...r, forced: true };
}

/** End a forced hold without switching (automatic switching applies again right away). */
export async function releaseForced() {
  await updateState((s) => { delete s.forced; });
  appendLog('forced-hold-released', {});
  publishStatus();
  return { released: true };
}

/**
 * Called when a new chat starts. Switching mid-chat makes the next reply reread the whole history on the new
 * account (prompt cache and earlier thinking stay with the old account). A new chat has nothing to reread, so
 * if the active account is close to its switch point anyway, move now. Only when another account has clearly
 * more session left, automatic switching is on, nothing is held, and no switch happened in the last 2 minutes.
 */
export async function switchAtChatStart() {
  const cfg = loadConfig();
  if (cfg.autoSwitch === false) return null;
  const { st, views, now } = snapshot();
  const active = st.active;
  if (!active || st.forced?.name === active) return null;
  if (st.lastSwitch?.at && now - st.lastSwitch.at < 2 * 60e3) return null;
  const av = views.find((v) => v.name === active);
  if (!av || av.status !== 'ok' || av.five.util < (cfg.newChatSwitchAt ?? 90)) return null;
  const best = rankViews(views.filter((v) => v.name !== active))[0];
  if (!best || best.five.util > av.five.util - 30) return null; // only when it is clearly better
  try {
    const r = await switchTo(best.name, `${av.email || av.name} 5h session at ${av.five.util}%, switched as a new chat started`);
    return { switched: r.changed, ...r, why: whyBest(best) };
  } catch (e) {
    appendLog('switch-deferred', { to: best.name, error: e.message });
    return null;
  }
}

/** Called by the daemon, hooks and the hub: leave the active account if it is limited, pick the best one. */
export async function autoSwitchIfNeeded(source = 'auto') {
  const { st, views, now } = snapshot();
  if (!views.length) return null;
  // One "all limited" alert per episode: cleared as soon as any account is usable again.
  if (st.alerts?.['all-limited'] && rankViews(views).length) await updateState((s) => { delete s.alerts['all-limited']; });
  // Home-page switch: automatic switching off = keep the current account (alerts still fire)
  if (loadConfig().autoSwitch === false) return null;
  const active = st.active;
  if (!active && readOauth(MAIN_CREDS)) return null; // Claude Code is on an unmanaged login: leave it alone
  const av = views.find((v) => v.name === active);
  // Forced account: the user chose it on purpose (e.g. to use the last 2% of a week). Hold it until it is
  // really used up (100% session or weekly) or unusable, instead of leaving at the usual 95% / 98% thresholds.
  if (active && st.forced?.name === active) {
    const exhausted = !av || av.status === 'paused' || av.status === 'needs-login' || av.five.util >= 100 || av.week.util >= 100;
    if (!exhausted) return null;
    await updateState((s) => { delete s.forced; });
    appendLog('forced-hold-ended', { name: active, five: av?.five?.util, week: av?.week?.util });
  }
  if (active && !needsSwitch(av)) return null;
  // No ping-pong: after any switch, wait 2 minutes before switching again, unless the account is really
  // used up or signed out (stale or glitchy numbers must not flip accounts back and forth).
  const reallyOut = !av || av.status === 'needs-login' || av.status === 'paused' || av.five.util >= 100 || av.week.util >= 100;
  if (active && !reallyOut && st.lastSwitch?.at && now - st.lastSwitch.at < 2 * 60e3) return null;

  const best = rankViews(views.filter((v) => v.name !== active))[0];
  if (!best) {
    const next = nextAvailable(views, now);
    if (!st.alerts?.['all-limited']) {
      await updateState((s) => { s.alerts['all-limited'] = now; });
      notify('All Claude accounts are limited', next ? `Next: ${views.find((v) => v.name === next.name)?.email || next.name} at ${fmtTime(next.at)}. It will switch automatically.` : 'No account is available.');
      appendLog('all-limited', { next });
    }
    return { switched: false, allLimited: true, next };
  }
  const reason = switchReason(av);
  try {
    const r = await switchTo(best.name, `${reason} (${source})`);
    if (r.changed) notify(`Claude account → ${best.email || best.name}`, `${reason}. ${best.email || best.name}: ${whyBest(best)}.`);
    return { switched: r.changed, ...r, why: whyBest(best) };
  } catch (e) {
    appendLog('switch-deferred', { to: best.name, error: e.message });
    return { switched: false, deferred: true, error: e.message };
  }
}
