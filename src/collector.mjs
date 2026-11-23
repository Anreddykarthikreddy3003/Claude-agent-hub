/** Fetches live 5-hour / weekly usage for every account and keeps state.json current. */
import { MAIN_CREDS, slotCreds, slotDir, FILES } from './paths.mjs';
import { withLock, tokenHash } from './util.mjs';
import { loadAccounts, loadConfig, loadState, updateState, appendLog } from './store.mjs';
import { fetchUsage } from './api.mjs';
import { cliRenew, findClaude } from './claude.mjs';
import { readOauth, detectActive } from './accounts.mjs';
import { trackWindow, makeView } from './engine.mjs';

/** Keep last known numbers, but treat windows whose reset time passed as over. */
function infer(prev, now) {
  const w = (x) => (!x ? null : x.resetsAt && x.resetsAt <= now ? { util: 0, resetsAt: null } : x);
  return { five: w(prev?.five), week: w(prev?.week) };
}

const expired = (o) => !o?.expiresAt || o.expiresAt < Date.now() + 60000;

/** Never ask Anthropic about the same account more than once per 30 s, whatever triggers it (hooks, buttons, tools). */
const MIN_GAP_MS = 30e3;

/**
 * How fresh the active account's numbers must be. Normally the configured interval (3 min); once its 5-hour
 * session passes 85%, every minute, so the switch still happens before the limit is hit.
 */
export function activeMaxAgeMs(name, cfg = loadConfig()) {
  const five = loadState().usage?.[name]?.five?.util ?? 0;
  return five >= 85 ? 60e3 : cfg.activePollMinutes * 60e3;
}

/**
 * Where does this account's LIVE login live right now? Decided from the tokens, at the moment of use:
 *  - main, if our trusted record says main belongs to this account, or the slot is a parked copy of main
 *  - its slot otherwise
 */
function locate(acc) {
  const mainO = readOauth(MAIN_CREDS);
  const slotO = readOauth(slotCreds(acc.name));
  const owner = loadState().mainOwner;
  const mainIsThis =
    !!mainO &&
    ((owner?.trusted && owner.tokenHash === tokenHash(mainO) && owner.uuid === acc.uuid) ||
      (!!slotO?.refreshToken && slotO.refreshToken === mainO.refreshToken));
  return mainIsThis ? { file: MAIN_CREDS, cfgDir: null, oauth: mainO, main: true } : { file: slotCreds(acc.name), cfgDir: slotDir(acc.name), oauth: slotO, main: false };
}

/**
 * May the service use (renew, prime, test) this account's SAVED copy right now?
 * Claude Code renews its own login every few hours and Anthropic retires the old refresh token each time. The
 * saved copy of the account Claude Code is on holds that same token. Using it after Claude Code renewed would
 * present a retired token, which Anthropic treats as stolen and answers by revoking the whole login: both copies
 * die and Claude Code asks to sign in. So: never for the account on Claude Code's login, and for no account while
 * that login can't be verified (it might be this one).
 */
export const WAITING = 'waiting to confirm which account Claude Code is using before touching this saved sign-in';
export function slotSafe(acc) {
  const mainO = readOauth(MAIN_CREDS);
  if (!mainO) return true; // Claude Code is signed out: nothing else holds these tokens
  const o = loadState().mainOwner;
  if (!o?.trusted || o.tokenHash !== tokenHash(mainO)) return false; // unverified, or renewed since verified
  return o.uuid !== acc.uuid;
}

/** Config dir holding this account's live login right now (null = Claude Code's main config). Throws WAITING when unsafe. */
export function liveConfigDir(name) {
  const acc = loadAccounts().find((a) => a.name === name);
  if (!acc) return slotDir(name);
  const loc = locate(acc);
  if (!loc.main && !slotSafe(acc)) throw new Error(WAITING);
  return loc.cfgDir;
}

const RENEW_RETRY_MS = 30 * 60e3;

/**
 * Let Claude Code renew the login, re-deciding its location INSIDE the lock. Returns { loc, waiting, failed, paused }.
 * A saved copy is renewed only when slotSafe() allows it; after a failed renewal the next try waits 30 minutes.
 */
async function refreshLogin(acc, prev) {
  const info = { waiting: false, failed: false, paused: false };
  await withLock(FILES.opsLock, async () => {
    const loc = locate(acc);
    if (!expired(loc.oauth)) return;
    if (!loc.main && !slotSafe(acc)) { info.waiting = true; return; }
    if (!loc.main && prev?.renewFailedAt && Date.now() - prev.renewFailedAt < RENEW_RETRY_MS) { info.paused = true; return; }
    const r = await cliRenew(loc.cfgDir);
    // Renewal must never reach the model (it would start the account's 5-hour window): say so if it ever does
    if (r.usedModel) appendLog('renew-used-model', { name: acc.name, text: r.text });
    const after = locate(acc);
    info.failed = expired(after.oauth);
    appendLog('renew', { name: acc.name, where: loc.main ? 'claude-code-login' : 'saved-copy', renewed: !info.failed });
  }, { timeoutMs: 20000 }).catch(() => { info.waiting = true; });
  return { loc: locate(acc), ...info };
}

async function fetchOne(acc, prev, { noRenew = false } = {}) {
  const now = Date.now();
  const base = { attemptAt: now, fetchedAt: prev?.fetchedAt || 0 };
  let loc = locate(acc);
  if (!loc.oauth) return { ...base, ...infer(prev, now), needsLogin: true, stale: true, error: 'no saved login' };
  if (loc.oauth.refreshTokenExpiresAt && loc.oauth.refreshTokenExpiresAt < now)
    return { ...base, ...infer(prev, now), needsLogin: true, stale: true, error: 'login expired (30-day limit)' };

  for (let attempt = 0; attempt < 2; attempt++) {
    if (expired(loc.oauth) || attempt === 1) {
      // Hooks never renew: they must stay fast, and the background service does it
      if (noRenew && expired(loc.oauth)) return { ...prev, ...base, ...infer(prev, now), stale: true };
      const rr = await refreshLogin(acc, prev);
      loc = rr.loc;
      if (expired(loc.oauth)) {
        const keep = { renewFails: prev?.renewFails || 0, renewFailedAt: prev?.renewFailedAt || null };
        if (rr.waiting) return { ...base, ...infer(prev, now), stale: true, ...keep, error: WAITING };
        if (findClaude().path === 'claude')
          return { ...base, ...infer(prev, now), stale: true, ...keep, error: 'sign-in token expired and could not be renewed: the Claude CLI was not found on this computer (install Claude Code, then run cam doctor)' };
        if (rr.paused) return { ...base, ...infer(prev, now), stale: true, ...keep, needsLogin: keep.renewFails >= 2, error: prev?.error || 'sign-in token expired; renewal paused after a failure' };
        const fails = keep.renewFails + (rr.failed ? 1 : 0);
        const dead = fails >= 2;
        return {
          ...base, ...infer(prev, now), stale: true, renewFails: fails, renewFailedAt: rr.failed ? now : keep.renewFailedAt, needsLogin: dead,
          error: dead
            ? 'signed out: Anthropic no longer accepts this saved sign-in (it was revoked or expired). Sign in again: Accounts → Sign in again'
            : 'sign-in token expired and renewing it failed; trying again in 30 minutes',
        };
      }
    }
    try {
      const u = await fetchUsage(loc.oauth.accessToken);
      return { attemptAt: now, fetchedAt: now, ...u, stale: false, error: null, needsLogin: false, renewFails: 0, renewFailedAt: null };
    } catch (e) {
      if (e.status === 401 && attempt === 0 && !e.cloudflare) continue; // force a CLI refresh, then retry once
      // Only Anthropic's own JSON auth errors mean "sign in again". Outages, Cloudflare challenges and network
      // failures keep the account as it was (marking it logged out would trigger a needless switch).
      const authError = !e.cloudflare && (e.status === 401 || e.status === 403);
      const transient = e.cloudflare || e.status === 429 || e.status >= 500 || !e.status;
      return {
        ...base, ...infer(prev, now), stale: true,
        needsLogin: authError,
        error: e.message,
        ...(transient ? { backoffUntil: now + Math.max((e.cloudflare ? 15 : 5) * 60e3, e.retryAfterMs || 0) } : {}),
      };
    }
  }
  return { ...base, ...infer(prev, now), stale: true, error: 'unknown' };
}

/**
 * Refresh usage. `names` limits which accounts; `maxAgeMs` skips accounts fetched recently
 * (unless one of their windows has reset since).
 */
export async function refreshUsage({ names = null, maxAgeMs = 0, noRenew = false } = {}) {
  const now = Date.now();
  const accounts = loadAccounts();
  await detectActive(); // keeps the trusted owner record current before locating logins
  const st = loadState();
  const results = {};
  for (const acc of accounts) {
    if (names && !names.includes(acc.name)) continue;
    const prev = st.usage?.[acc.name];
    const resetPassed = [prev?.five?.resetsAt, prev?.week?.resetsAt].some((t) => t && t <= now && t > (prev?.attemptAt || 0));
    if (prev?.backoffUntil && prev.backoffUntil > now) continue;
    if (prev && now - (prev.attemptAt || 0) < MIN_GAP_MS && !resetPassed) continue;
    // A check that failed for a temporary reason (network, outage, 429) is retried once its back-off ends,
    // instead of waiting for the next regular check (30 min for idle accounts).
    const retryFailed = !!prev?.error && !!prev.backoffUntil && prev.backoffUntil <= now;
    if (prev && maxAgeMs && now - (prev.attemptAt || 0) < maxAgeMs && !resetPassed && !retryFailed) continue;
    results[acc.name] = await fetchOne(acc, prev, { noRenew });
  }
  if (Object.keys(results).length) {
    await updateState((s) => {
      for (const [name, r] of Object.entries(results)) {
        s.usage[name] = r;
        if (!r.stale) {
          const { track, sample } = trackWindow(s.track[name], r);
          s.track[name] = track;
          if (sample) {
            s.Y[name] = s.Y[name] ? +(s.Y[name] * 0.7 + sample * 0.3).toFixed(2) : +sample.toFixed(2);
            appendLog('learned-session-cost', { name, weeklyPctPerSession: s.Y[name] });
          }
        }
      }
    });
  }
  return results;
}

export function yFor(name, st, cfg) {
  if (st.Y?.[name]) return st.Y[name];
  const known = Object.values(st.Y || {}).filter(Boolean);
  return known.length ? known.reduce((a, b) => a + b, 0) / known.length : cfg.defaultSessionWeeklyPct;
}

/** Current decision views for all accounts (no network). */
export function snapshot(now = Date.now()) {
  const cfg = loadConfig();
  const st = loadState();
  const accounts = loadAccounts();
  const views = accounts.map((a) => makeView(a, st.usage?.[a.name], now, cfg, yFor(a.name, st, cfg)));
  return { cfg, st, accounts, views, now };
}

export { appendLog };
