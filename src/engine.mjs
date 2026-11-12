/**
 * Pure decision logic: no I/O. Everything here is unit-tested.
 *
 * Usage record shape (per account):
 *   { five: { util, resetsAt }, week: { util, resetsAt }, needsLogin, stale }
 * util is 0-100, resetsAt is epoch ms or null (no running window).
 */

export const HOUR = 3600e3;
export const CYCLE = 5 * HOUR;

const inf = (x) => (x == null ? Infinity : x);
const mod = (x) => ((x % CYCLE) + CYCLE) % CYCLE;
const cdist = (a, b) => {
  const d = Math.abs(a - b) % CYCLE;
  return Math.min(d, CYCLE - d);
};

/** A window whose reset time has passed is over: usage 0, no running window. */
export function normWindow(w, now) {
  if (!w) return { util: 0, resetsAt: null };
  if (w.resetsAt && w.resetsAt <= now) return { util: 0, resetsAt: null };
  return { util: Number(w.util) || 0, resetsAt: w.resetsAt ?? null };
}

export function makeView(acc, u, now, cfg, Y) {
  const five = normWindow(u?.five, now);
  const week = normWindow(u?.week, now);
  let status = 'ok';
  if (acc.paused) status = 'paused';
  else if (u?.needsLogin) status = 'needs-login';
  else if (week.util >= cfg.weeklyStopAt) status = 'weekly-limit';
  else if (five.util >= cfg.sessionSwitchAt) status = 'session-limit';

  const remaining = Math.max(0, 100 - week.util);
  const hoursToWeekly = week.resetsAt ? (week.resetsAt - now) / HOUR : 168;
  const need = Math.ceil(remaining / Math.max(Y || 0, 0.5)); // 5h windows needed to use it all
  const avail = Math.floor(hoursToWeekly / 5); // 5h windows left before weekly reset
  const slack = avail - need;
  const inRotation = status === 'ok' || status === 'session-limit';

  return {
    name: acc.name,
    email: acc.email,
    status,
    five,
    week,
    remaining,
    hoursToWeekly,
    need,
    avail,
    slack,
    Y,
    critical: inRotation && remaining > 0 && slack <= cfg.slackCritical,
    wasteAlarm:
      inRotation && !!week.resetsAt && hoursToWeekly <= cfg.wasteAlarm.hours && remaining >= cfg.wasteAlarm.unusedPct,
    usable: status === 'ok' && 100 - five.util >= cfg.minSessionHeadroom,
    windowRunning: !!five.resetsAt,
    stale: !!u?.stale,
    known: !!u,
  };
}

/**
 * Order usable accounts best-first:
 *  1. critical weekly slack  2. waste alarm  3. 5h window resets soonest (use it before it's lost)
 *  4. weekly resets soonest  5. most session left
 */
export function rankViews(views) {
  return views
    .filter((v) => v.usable)
    .sort(
      (a, b) =>
        b.critical - a.critical ||
        b.wasteAlarm - a.wasteAlarm ||
        inf(a.five.resetsAt) - inf(b.five.resetsAt) ||
        inf(a.week.resetsAt) - inf(b.week.resetsAt) ||
        a.five.util - b.five.util ||
        a.name.localeCompare(b.name),
    );
}

export function whyBest(v) {
  if (v.critical) return `weekly critical: ${v.remaining}% left needs ~${v.need} sessions, only ${v.avail} windows before reset`;
  if (v.wasteAlarm) return `${v.remaining}% weekly unused and it resets in ${Math.round(v.hoursToWeekly)}h`;
  if (v.windowRunning) return `its 5h window resets soonest (use it before it is lost)`;
  return `fresh session available`;
}

/** The active account must be left when it is limited, paused, or logged out. */
export function needsSwitch(v) {
  return !v || v.status !== 'ok';
}

export function switchReason(v) {
  if (!v) return 'no active managed account';
  if (v.status === 'session-limit') return `${v.email || v.name} 5h session at ${v.five.util}%`;
  if (v.status === 'weekly-limit') return `${v.email || v.name} weekly at ${v.week.util}%`;
  if (v.status === 'paused') return `${v.email || v.name} is paused`;
  if (v.status === 'needs-login') return `${v.email || v.name} needs login`;
  return '';
}

/** When nothing is usable: which account comes back first, and when. */
export function nextAvailable(views, now) {
  let best = null;
  for (const v of views) {
    if (v.status === 'paused' || v.status === 'needs-login') continue;
    let at = null;
    if (v.status === 'weekly-limit') at = v.week.resetsAt;
    else if (v.five.resetsAt) at = v.five.resetsAt;
    else at = now;
    if (at && (!best || at < best.at)) best = { name: v.name, at };
  }
  return best;
}

/**
 * 24/7 priming plan. Accounts with a running 5h window are anchors; idle accounts get
 * a prime time so that all N windows reset evenly spaced, every 5h/N.
 * Returns [{ name, at }] (at = epoch ms; at <= now means "send hi now").
 */
export function planPrimes(views, now) {
  const rotation = views.filter((v) => v.status === 'ok' || v.status === 'session-limit');
  const anchors = rotation.filter((v) => v.windowRunning).sort((a, b) => a.five.resetsAt - b.five.resetsAt);
  const idle = rotation
    .filter((v) => !v.windowRunning)
    .sort(
      (a, b) =>
        b.critical - a.critical ||
        b.wasteAlarm - a.wasteAlarm ||
        inf(a.week.resetsAt) - inf(b.week.resetsAt) ||
        a.name.localeCompare(b.name),
    );
  if (!idle.length) return [];

  const N = anchors.length + idle.length;
  const G = CYCLE / N;
  const tol = Math.min(15 * 60e3, G * 0.2);

  if (!anchors.length) return idle.map((v, k) => ({ name: v.name, at: now + Math.round(k * G) }));

  const ref = mod(anchors[0].five.resetsAt);
  const grid = Array.from({ length: N }, (_, k) => mod(ref + k * G));
  const free = new Set(grid.keys());
  for (const a of anchors) {
    const ph = mod(a.five.resetsAt);
    let best = null;
    for (const k of free) if (best === null || cdist(grid[k], ph) < cdist(grid[best], ph)) best = k;
    free.delete(best);
  }
  const nowPh = mod(now);
  const waits = [...free]
    .map((k) => {
      const w = mod(grid[k] - nowPh);
      return w > CYCLE - tol ? 0 : w; // just missed the slot by a few minutes: go now
    })
    .sort((a, b) => a - b);
  return idle.map((v, i) => ({ name: v.name, at: now + Math.round(waits[i]) }));
}

/**
 * Learn Y = weekly % used by one full 5h session, from observed windows.
 * Mutates and returns the tracking record; returns a sample when a window completes.
 */
export function trackWindow(t, rec) {
  t = t || {};
  let sample = null;
  const fiveReset = rec?.five?.resetsAt ?? null;
  const fiveUtil = rec?.five?.util ?? 0;
  const weekUtil = rec?.week?.util ?? 0;
  if (t.windowResetsAt !== fiveReset) {
    if (t.valid && t.windowResetsAt && t.peak >= 40 && t.weeklyLast > t.weeklyStart) {
      const s = (t.weeklyLast - t.weeklyStart) / (t.peak / 100);
      if (s > 0.5 && s < 60) sample = s;
    }
    t.windowResetsAt = fiveReset;
    t.valid = !!fiveReset && fiveUtil <= 5;
    t.weeklyStart = weekUtil;
    t.peak = fiveUtil;
    t.weeklyLast = weekUtil;
    return { track: t, sample };
  }
  if (weekUtil < (t.weeklyLast ?? 0)) t.valid = false; // weekly reset mid-window
  t.peak = Math.max(t.peak ?? 0, fiveUtil);
  t.weeklyLast = weekUtil;
  return { track: t, sample };
}
