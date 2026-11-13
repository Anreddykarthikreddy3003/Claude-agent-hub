/** Fetches live 5-hour / weekly usage for every account and keeps state.json current. */
import { MAIN_CREDS, slotCreds, slotDir, FILES } from './paths.mjs';
import { withLock, tokenHash } from './util.mjs';
import { loadAccounts, loadConfig, loadState, updateState, appendLog } from './store.mjs';
import { fetchUsage } from './api.mjs';
import { cliAuthStatus } from './claude.mjs';
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

/** Config dir holding this account's live login right now (null = Claude Code's main config). */
export function liveConfigDir(name) {
  const acc = loadAccounts().find((a) => a.name === name);
  return acc ? locate(acc).cfgDir : slotDir(name);
}

/** Let Claude Code refresh the login, re-deciding its location INSIDE the lock (never refresh a parked copy). */
async function refreshLogin(acc) {
  await withLock(FILES.opsLock, async () => {
    const loc = locate(acc);
    if (expired(loc.oauth)) await cliAuthStatus(loc.cfgDir);
  }).catch(() => {});
  return locate(acc);
}

async function fetchOne(acc, prev) {
  const now = Date.now();
  const base = { attemptAt: now, fetchedAt: prev?.fetchedAt || 0 };
  let loc = locate(acc);
  if (!loc.oauth) return { ...base, ...infer(prev, now), needsLogin: true, stale: true, error: 'no saved login' };
  if (loc.oauth.refreshTokenExpiresAt && loc.oauth.refreshTokenExpiresAt < now)
    return { ...base, ...infer(prev, now), needsLogin: true, stale: true, error: 'login expired (30-day limit)' };

  for (let attempt = 0; attempt < 2; attempt++) {
    if (expired(loc.oauth) || attempt === 1) {
      loc = await refreshLogin(acc);
      if (expired(loc.oauth)) return { ...base, ...infer(prev, now), stale: true, error: 'token idle; refreshes on next prime/use' };
    }
    try {
      const u = await fetchUsage(loc.oauth.accessToken);
      return { attemptAt: now, fetchedAt: now, ...u, stale: false, error: null, needsLogin: false };
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
export async function refreshUsage({ names = null, maxAgeMs = 0 } = {}) {
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
    if (prev && maxAgeMs && now - (prev.attemptAt || 0) < maxAgeMs && !resetPassed) continue;
    results[acc.name] = await fetchOne(acc, prev);
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
