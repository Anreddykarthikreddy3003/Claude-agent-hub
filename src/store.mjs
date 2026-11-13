import fs from 'node:fs';
import path from 'node:path';
import { FILES } from './paths.mjs';
import { readJson, writeJsonAtomic, withLock } from './util.mjs';

export const DEFAULT_CONFIG = {
  /** 24/7 automatic "hi" priming for every account. Off until you opt in with `cam ready on`. */
  ready: false,
  /** Move Claude Code to the best account automatically when the active one runs out. */
  autoSwitch: true,
  /** Background usage polling for every platform (the Refresh buttons work either way). */
  monitoring: true,
  /** Overall switch for session priming on every platform. */
  primeAll: true,
  /** Codex priming: only for accounts whose plan has a 5-hour window (weekly-only plans have nothing to prime). */
  primeCodex: false,
  /** Switch away when the 5-hour session reaches this %. */
  sessionSwitchAt: 95,
  /** Stop using an account when its weekly usage reaches this %. */
  weeklyStopAt: 98,
  /** Never switch TO an account with less than this % of its session left. */
  minSessionHeadroom: 10,
  /** Weekly "slack" (spare 5h windows before reset) at or below which an account is critical. */
  slackCritical: 1,
  /** Alert + prioritise an account whose weekly reset is this close and still has this much unused. */
  wasteAlarm: { hours: 24, unusedPct: 30 },
  /** How often to refresh usage for idle accounts / the active account (minutes). */
  pollMinutes: 30, // idle accounts only change at their (known) reset times (always re-checked) or if used elsewhere
  activePollMinutes: 3, // hooks also refresh the active account on every prompt / reply
  /** Background loop interval (seconds). */
  tickSeconds: 60,
  /** Priming message settings. */
  primeModel: 'haiku',
  primeMessage: 'hi',
  /** Starting guess: weekly % used by one full 5-hour session (learned per account over time). */
  defaultSessionWeeklyPct: 10,
  notifications: true,
  claudePath: null,
};

export function loadConfig() {
  const c = readJson(FILES.config, {}) || {};
  return { ...DEFAULT_CONFIG, ...c, wasteAlarm: { ...DEFAULT_CONFIG.wasteAlarm, ...(c.wasteAlarm || {}) } };
}

export function saveConfig(patch) {
  const c = readJson(FILES.config, {}) || {};
  const next = { ...c, ...patch };
  writeJsonAtomic(FILES.config, next);
  return { ...DEFAULT_CONFIG, ...next };
}

export function loadAccounts() {
  return readJson(FILES.accounts, { accounts: [] })?.accounts || [];
}

export function saveAccounts(list) {
  writeJsonAtomic(FILES.accounts, { accounts: list });
}

const EMPTY_STATE = () => ({
  active: null,
  mainOwner: null,
  usage: {},
  track: {},
  Y: {},
  primes: {},
  plan: [],
  alerts: {},
  lastSwitch: null,
  daemon: {},
});

export function loadState() {
  return { ...EMPTY_STATE(), ...(readJson(FILES.state, {}) || {}) };
}

/** Read-modify-write the shared state under a short lock (daemon, hooks, CLI all write it). */
export async function updateState(fn) {
  return withLock(FILES.stateLock, async () => {
    const s = loadState();
    const r = await fn(s);
    writeJsonAtomic(FILES.state, s);
    return r;
  }, { timeoutMs: 10000, staleMs: 20000 });
}

export function appendLog(type, data = {}) {
  try {
    fs.mkdirSync(path.dirname(FILES.log), { recursive: true });
    fs.appendFileSync(FILES.log, JSON.stringify({ at: new Date().toISOString(), type, ...data }) + '\n');
    const st = fs.statSync(FILES.log);
    if (st.size > 2 * 1024 * 1024) {
      const lines = fs.readFileSync(FILES.log, 'utf8').trim().split('\n');
      fs.writeFileSync(FILES.log, lines.slice(-3000).join('\n') + '\n');
    }
  } catch {}
}

export function readLog(n = 30) {
  try {
    return fs.readFileSync(FILES.log, 'utf8').trim().split('\n').slice(-n).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

/** Copy a file into backups/ with a timestamp, keeping the newest `keep` per prefix. */
export function backup(src, prefix, keep = 15) {
  try {
    if (!fs.existsSync(src)) return null;
    fs.mkdirSync(FILES.backups, { recursive: true, mode: 0o700 });
    const dest = path.join(FILES.backups, `${prefix}.${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.copyFileSync(src, dest);
    try { fs.chmodSync(dest, 0o600); } catch {} // backups include login files: owner-only

    const old = fs.readdirSync(FILES.backups).filter((f) => f.startsWith(prefix + '.')).sort();
    for (const f of old.slice(0, Math.max(0, old.length - keep))) {
      try { fs.unlinkSync(path.join(FILES.backups, f)); } catch {}
    }
    return dest;
  } catch {
    return null;
  }
}
