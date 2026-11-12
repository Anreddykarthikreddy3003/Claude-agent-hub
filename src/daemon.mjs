/** Background service: usage polling, 24/7 priming, automatic switching, alerts. */
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { FILES, BIN, slotDir } from './paths.mjs';
import { readJson, writeJsonAtomic, withLock, pidAlive, sleep, fmtTime } from './util.mjs';
import { loadConfig, loadState, updateState, appendLog } from './store.mjs';
import { scanPendingSlots, detectActive } from './accounts.mjs';
import { refreshUsage, snapshot, liveConfigDir } from './collector.mjs';
import { autoSwitchIfNeeded, retryPendingIdentity } from './switcher.mjs';
import { planPrimes } from './engine.mjs';
import { cliPrime } from './claude.mjs';
import { notify } from './notify.mjs';
import { publishStatus, statusJson } from './report.mjs';
import { resumeDue, stopAll } from './hub/runner.mjs';

const DAEMON_LOCK = FILES.pid;

export async function primeAccount(name) {
  // Location decided inside the lock from the tokens (never prime a parked copy of the active login).
  const r = await withLock(FILES.opsLock, () => cliPrime(liveConfigDir(name)), { timeoutMs: 60000 });
  let fails = 0;
  await updateState((s) => {
    const prev = s.primes[name] || {};
    fails = r.ok ? 0 : (prev.fails || 0) + 1;
    s.primes[name] = { lastAt: Date.now(), ok: r.ok, error: r.ok ? null : r.text, fails };
  });
  appendLog('prime', { name, ok: r.ok, ...(r.ok ? {} : { error: r.text }) });
  await refreshUsage({ names: [name] });
  if (!r.ok && fails === 3) notify(`Priming ${name} keeps failing`, r.text || 'Check: cam log');
  return r;
}

export async function runDuePrimes() {
  const { cfg, st, views, now } = snapshot();
  const on = cfg.ready && cfg.primeAll !== false;
  const plan = on ? planPrimes(views, now) : [];
  await updateState((s) => { s.plan = plan; });
  if (!on) return [];
  const done = [];
  for (const p of plan) {
    if (p.at > now + 30000) continue;
    const last = st.primes?.[p.name];
    if (last?.lastAt && now - last.lastAt < 10 * 60e3) continue; // give the new window time to show up
    if (last?.fails >= 3 && now - last.lastAt < 60 * 60e3) continue; // back off after repeated failures
    const r = await primeAccount(p.name);
    done.push({ name: p.name, ok: r.ok });
  }
  return done;
}

async function checkAlerts() {
  const { st, views, now } = snapshot();
  const day = new Date().toDateString();
  const fire = [];
  for (const v of views) {
    if (v.wasteAlarm) {
      const key = `waste:${v.name}:${v.week.resetsAt}`;
      if (!st.alerts?.[key]) fire.push([key, `${v.name}: ${v.remaining}% of weekly unused`, `Weekly resets ${fmtTime(v.week.resetsAt)}. It is now used first.`]);
    }
    if (v.status === 'needs-login') {
      const key = `login:${v.name}:${day}`;
      if (!st.alerts?.[key]) fire.push([key, `${v.name} needs to log in again`, `Run /accounts relogin ${v.name} in Claude Code.`]);
    }
  }
  if (fire.length || Object.keys(st.alerts || {}).length > 200) {
    await updateState((s) => {
      for (const [key] of fire) s.alerts[key] = now;
      for (const [k, t] of Object.entries(s.alerts)) {
        const at = typeof t === 'number' ? t : t?.at;
        if (!at || now - at > 8 * 24 * 3600e3) delete s.alerts[k];
      }
    });
    for (const [, title, msg] of fire) notify(title, msg);
  }
}

export async function tick() {
  const cfg = loadConfig();
  const added = await scanPendingSlots();
  for (const n of added) notify(`Account ${n} added`, 'It is now part of the automatic rotation.');
  await detectActive();
  // Background monitoring switch: when off, only the active Claude account is kept current (needed for auto-switching)
  if (cfg.monitoring !== false) await refreshUsage({ maxAgeMs: cfg.pollMinutes * 60e3 });
  const st = loadState();
  if (st.active) await refreshUsage({ names: [st.active], maxAgeMs: cfg.activePollMinutes * 60e3 });
  await autoSwitchIfNeeded('background');
  await retryPendingIdentity();
  await runDuePrimes();
  await checkAlerts();
  await updateState((s) => { s.daemon = { ...s.daemon, pid: process.pid, lastTick: Date.now() }; });
  publishStatus();
  if (hubPush) {
    try {
      const pl = await import('./platforms.mjs');
      await pl.captureSwapLogins();
      if (cfg.monitoring !== false && Date.now() - lastPlatformUsage > cfg.pollMinutes * 60e3) { lastPlatformUsage = Date.now(); await pl.refreshPlatformUsage(); }
      if (cfg.primeAll !== false && cfg.primeCodex) await pl.primeCodexAccounts();
      hubPush('platformAccounts', pl.allPlatformAccounts());
    } catch (e) { appendLog('platform-accounts-error', { error: e.message }); }
    hubPush('accounts', statusJson());
    resumeDue();
  }
}

let hubPush = null;
let lastPlatformUsage = 0;

function acquireDaemonLock() {
  for (let i = 0; i < 2; i++) {
    try {
      const fd = fs.openSync(DAEMON_LOCK, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
      fs.closeSync(fd);
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const info = readJson(DAEMON_LOCK, {});
      const lastTick = loadState().daemon?.lastTick || 0;
      const fresh = Date.now() - Math.max(lastTick, info?.startedAt || 0) < 5 * 60e3;
      if (info?.pid && pidAlive(info.pid) && fresh) return false;
      try { fs.unlinkSync(DAEMON_LOCK); } catch {}
    }
  }
  return false;
}

export async function runDaemon({ once = false } = {}) {
  fs.mkdirSync(FILES.backups, { recursive: true });
  if (once) {
    await tick();
    return;
  }
  if (!acquireDaemonLock()) {
    console.log('Background service is already running.');
    return;
  }
  const release = () => {
    try { if (readJson(DAEMON_LOCK, {})?.pid === process.pid) fs.unlinkSync(DAEMON_LOCK); } catch {}
  };
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => process.exit(0));
  await updateState((s) => { s.daemon = { ...s.daemon, pid: process.pid, startedAt: Date.now() }; });
  appendLog('daemon-start', { pid: process.pid });
  try {
    const { startServer } = await import('./hub/server.mjs');
    hubPush = startServer().push;
    process.on('exit', () => { try { stopAll(); } catch {} });
  } catch (e) {
    appendLog('hub-start-failed', { error: String(e?.stack || e).slice(0, 600) });
  }
  for (;;) {
    try {
      await tick();
    } catch (e) {
      appendLog('daemon-error', { error: String(e?.stack || e).slice(0, 800) });
    }
    // keep the lock file fresh so other starters see we're alive
    try { writeJsonAtomic(DAEMON_LOCK, { pid: process.pid, startedAt: readJson(DAEMON_LOCK, {})?.startedAt || Date.now(), beat: Date.now() }); } catch {}
    await sleep(Math.max(15, loadConfig().tickSeconds) * 1000);
  }
}

/** Start the background service if it isn't running (called by hooks / status line). */
export function ensureDaemon() {
  const st = loadState();
  if (Date.now() - (st.daemon?.lastTick || 0) < 3 * 60e3) return false;
  const info = readJson(DAEMON_LOCK, null);
  if (info?.pid && pidAlive(info.pid) && Date.now() - (info.beat || info.startedAt || 0) < 3 * 60e3) return false;
  if (Date.now() - (st.daemon?.spawnAttemptAt || 0) < 60e3) return false;
  spawn(process.execPath, [BIN, 'daemon'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  updateState((s) => { s.daemon = { ...s.daemon, spawnAttemptAt: Date.now() }; }).catch(() => {});
  return true;
}
