/** Human-readable output for the CLI, slash commands, status line and MCP tools. */
import { snapshot } from './collector.mjs';
import { rankViews, whyBest, nextAvailable, planPrimes } from './engine.mjs';
import { fmtDur, fmtTime, pad, writeJsonAtomic } from './util.mjs';
import { FILES } from './paths.mjs';
import { readLog } from './store.mjs';

const STATUS_LABEL = {
  ok: 'ok',
  'session-limit': '5h limit',
  'weekly-limit': 'weekly limit',
  paused: 'paused',
  'needs-login': 'NEEDS LOGIN',
};

function daemonLine(st, now) {
  const t = st.daemon?.lastTick;
  if (!t) return 'not running yet';
  const age = now - t;
  return age < 3 * 60e3 ? `running (checked ${fmtDur(age)} ago)` : `NOT RUNNING (last check ${fmtDur(age)} ago)`;
}

export function statusText() {
  const { cfg, st, views, accounts, now } = snapshot();
  const out = [];
  out.push(`Claude Agent Hub · auto-priming: ${cfg.ready ? 'ON (24/7)' : 'OFF'} · service: ${daemonLine(st, now)}`);
  if (!accounts.length) {
    out.push('', 'No accounts yet.', '  1. /accounts import <name>   save the login Claude Code is using now', '  2. /accounts add <name>      sign in to each other account once');
    return out.join('\n');
  }
  if (!st.active) out.push(st.mainOwner?.email ? `⚠ Claude Code is logged in to an unmanaged account (${st.mainOwner.email}).` : '⚠ Claude Code is not logged in to a managed account.');
  out.push('');
  out.push(`  ${pad('ACCOUNT', 10)}${pad('EMAIL', 28)}${pad('5H SESSION', 22)}${pad('WEEKLY', 24)}STATUS`);
  for (const v of views) {
    const mark = v.name === st.active ? '▶ ' : '  ';
    const five = v.five.resetsAt ? `${v.five.util}% ↻${fmtDur(v.five.resetsAt - now)}` : `${v.five.util}% no window`;
    const week = v.week.resetsAt ? `${v.week.util}% ↻${fmtTime(v.week.resetsAt)}` : `${v.week.util}%`;
    const flags = [STATUS_LABEL[v.status] || v.status];
    if (v.critical) flags.push('🚨 critical');
    else if (v.wasteAlarm) flags.push('⚠ use soon');
    if (v.stale) flags.push('(last known)');
    if (!v.known) flags.push('(not checked yet)');
    out.push(`${mark}${pad(v.name, 10)}${pad((v.email || '').slice(0, 26), 28)}${pad(five, 22)}${pad(week, 24)}${flags.join(' · ')}`);
  }
  out.push('');
  const ranked = rankViews(views.filter((v) => v.name !== st.active));
  if (ranked[0]) out.push(`Next if the current account runs out: ${ranked[0].name} (${whyBest(ranked[0])})`);
  else {
    const n = nextAvailable(views, now);
    out.push(n ? `No other account available now. Next: ${n.name} at ${fmtTime(n.at)}.` : 'No other account available.');
  }
  if (cfg.ready) {
    const plan = planPrimes(views, now);
    if (plan.length) out.push(`Next "hi": ${plan.map((p) => `${p.name} ${p.at <= now + 60e3 ? 'now' : fmtTime(p.at)}`).join(' · ')}`);
    else out.push('Next "hi": all 5h windows already running.');
  }
  if (st.lastSwitch) out.push(`Last switch: ${st.lastSwitch.from ?? '?'} → ${st.lastSwitch.to} at ${fmtTime(st.lastSwitch.at)} (${st.lastSwitch.reason})`);
  const dup = Object.entries(st.alerts || {}).filter(([k]) => k.startsWith('dup:'));
  for (const [, a] of dup) out.push(`⚠ ${a.message}`);
  return out.join('\n');
}

export function weekVerdict(v) {
  if (v.status === 'paused') return { level: 'muted', text: 'Paused' };
  if (v.status === 'needs-login') return { level: 'bad', text: 'Needs login' };
  if (v.remaining <= 2) return { level: 'good', text: 'Fully used' };
  if (v.slack < 0) return { level: 'bad', text: `~${Math.round(-v.slack * v.Y)}% will be lost` };
  if (v.critical) return { level: 'bad', text: 'Critical: use every window' };
  if (v.wasteAlarm) return { level: 'warn', text: 'Use first (resets soon)' };
  if (v.slack <= 4) return { level: 'warn', text: 'Tight' };
  return { level: 'good', text: 'On track' };
}

/** Structured snapshot for the editor status bar / dashboard. `cam status --json` */
export function statusJson() {
  const { cfg, st, views, now } = snapshot();
  const others = views.filter((v) => v.name !== st.active);
  const best = rankViews(others)[0];
  return {
    now,
    ready: cfg.ready,
    autoSwitch: cfg.autoSwitch !== false,
    forced: st.forced?.name || null,
    monitoring: cfg.monitoring !== false,
    primeAll: cfg.primeAll !== false,
    primeCodex: !!cfg.primeCodex,
    service: { running: now - (st.daemon?.lastTick || 0) < 3 * 60e3, lastTick: st.daemon?.lastTick || null },
    active: st.active,
    mainEmail: st.mainOwner?.email || null,
    accounts: views.map((v) => ({
      name: v.name,
      email: v.email,
      active: v.name === st.active,
      status: v.status,
      statusLabel: STATUS_LABEL[v.status] || v.status,
      five: v.five,
      week: v.week,
      remaining: v.remaining,
      need: v.need,
      avail: v.avail,
      slack: v.slack,
      critical: v.critical,
      wasteAlarm: v.wasteAlarm,
      usable: v.usable,
      stale: v.stale,
      known: v.known,
      Y: +v.Y.toFixed(1),
      verdict: weekVerdict(v),
    })),
    next: best ? { name: best.name, why: whyBest(best) } : null,
    nextAvailable: best ? null : nextAvailable(others, now),
    primes: cfg.ready ? planPrimes(views, now) : [],
    lastSwitch: st.lastSwitch || null,
  };
}

/** Write the UI snapshot to status.json (≈1 ms). Called after every tick, switch and hook. */
export function publishStatus() {
  try {
    writeJsonAtomic(FILES.status, statusJson());
  } catch {}
}

export function weekText() {
  const { views, now } = snapshot();
  if (!views.length) return 'No accounts yet. Run /accounts import <name>.';
  const out = ['Weekly plan: goal is 100% of every weekly limit before it resets', ''];
  out.push(`  ${pad('ACCOUNT', 10)}${pad('LEFT', 7)}${pad('RESETS', 22)}${pad('NEEDS', 13)}${pad('WINDOWS LEFT', 14)}VERDICT`);
  for (const v of views) {
    const resets = v.week.resetsAt ? `${fmtTime(v.week.resetsAt)} (${fmtDur(v.week.resetsAt - now)})` : 'unknown';
    let verdict;
    if (v.status === 'paused') verdict = 'paused';
    else if (v.status === 'needs-login') verdict = 'needs login';
    else if (v.remaining <= 2) verdict = '✅ fully used';
    else if (v.slack < 0) verdict = `❌ ~${Math.round((-v.slack) * v.Y)}% will be lost even at full use`;
    else if (v.critical) verdict = '🚨 critical: use it in every window';
    else if (v.wasteAlarm) verdict = '⚠ use first (resets soon)';
    else if (v.slack <= 4) verdict = '⚠ tight';
    else verdict = '✅ on track';
    out.push(`  ${pad(v.name, 10)}${pad(v.remaining + '%', 7)}${pad(resets, 22)}${pad(`~${v.need} sess.`, 13)}${pad(v.avail, 14)}${verdict}`);
  }
  const ys = [...new Set(views.map((v) => v.Y))];
  out.push('', `1 full 5h session ≈ ${ys.map((y) => `${+y.toFixed(1)}%`).join('/')} of a weekly limit (learned from your usage; default 10% until measured).`);
  const order = [...views].filter((v) => v.week.resetsAt && v.remaining > 2).sort((a, b) => a.week.resetsAt - b.week.resetsAt);
  if (order.length) out.push(`Use order this week (soonest reset first): ${order.map((v) => v.name).join(' → ')}`);
  return out.join('\n');
}

export function statusLine() {
  const { cfg, st, views, now } = snapshot();
  if (!views.length) return '👤 no accounts · /accounts import <name>';
  const a = views.find((v) => v.name === st.active);
  const parts = [];
  if (a) {
    parts.push(`👤 ${a.name}`);
    parts.push(`5h ${a.five.util}%${a.five.resetsAt ? ` ↻${fmtDur(a.five.resetsAt - now)}` : ''}`);
    parts.push(`wk ${a.week.util}%${a.week.resetsAt ? ` ↻${fmtDur(a.week.resetsAt - now)}` : ''}`);
  } else parts.push(st.mainOwner?.email ? `👤 unmanaged (${st.mainOwner.email})` : '👤 not logged in');
  const next = rankViews(views.filter((v) => v.name !== st.active))[0];
  if (next) parts.push(`next ${next.name}`);
  else {
    const n = nextAvailable(views.filter((v) => v.name !== st.active), now);
    if (n) parts.push(`next ${n.name} @${fmtTime(n.at)}`);
  }
  const ready = views.filter((v) => v.usable).length;
  parts.push(`${ready}/${views.length} ready`);
  if (!cfg.ready) parts.push('priming off');
  if (now - (st.daemon?.lastTick || 0) > 3 * 60e3) parts.push('⚠ service down');
  return parts.join(' │ ');
}

export function bestText() {
  const { st, views } = snapshot();
  const r = rankViews(views);
  if (!r.length) return 'No account is usable right now.';
  return r.map((v, i) => `${i + 1}. ${v.name}${v.name === st.active ? ' (active)' : ''}: ${whyBest(v)} · 5h ${v.five.util}% · weekly ${v.week.util}%`).join('\n');
}

export function logText(n = 25) {
  return readLog(n)
    .map((e) => {
      const { at, type, ...rest } = e;
      return `${fmtTime(Date.parse(at))}  ${pad(type, 22)} ${Object.keys(rest).length ? JSON.stringify(rest) : ''}`;
    })
    .join('\n') || '(empty)';
}
