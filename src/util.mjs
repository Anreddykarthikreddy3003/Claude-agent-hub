import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Write JSON via temp file + rename so readers never see a half-written file. */
export function writeJsonAtomic(file, obj) {
  // Many of these files hold login tokens: owner-only from the first byte. On Windows the profile folder's
  // ACL already restricts them; the modes matter on macOS / Linux.
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.cam-${process.pid}-${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (e) {
      if (i >= 15) {
        try { fs.unlinkSync(tmp); } catch {}
        throw e;
      }
      sleepSync(40 * (i + 1)); // Windows: target may be briefly locked by another reader
    }
  }
}

export function hash(s) {
  return crypto.createHash('sha256').update(String(s ?? '')).digest('hex').slice(0, 16);
}

export function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/**
 * Cross-process lock.
 * - Acquire: mkdir is atomic, so exactly one process creates the lock directory.
 * - Owner: a random token in <lock>/owner.json, heartbeated every 2 s while held.
 * - Stale: only when the heartbeat is older than staleMs, or the owner pid is dead AND the lock is >2 s old
 *   (so a half-created lock is never mistaken for stale).
 * - Steal: rename the stale directory to a unique name first. Rename is atomic, so only one stealer wins,
 *   and nobody can delete a lock that was just re-acquired by someone else.
 * - Release: remove only if the owner token is still ours.
 */
export async function withLock(file, fn, { timeoutMs = 30000, staleMs = 30000 } = {}) {
  const dir = `${file}.d`;
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const token = crypto.randomBytes(8).toString('hex');
  const ownerFile = path.join(dir, 'owner.json');
  const start = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(dir);
      fs.writeFileSync(ownerFile, JSON.stringify({ token, pid: process.pid, at: Date.now() }));
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let st = null;
      try { st = fs.statSync(dir); } catch { continue; } // vanished: retry immediately
      const info = readJson(ownerFile, null);
      const age = Date.now() - Math.max(st.mtimeMs, info?.at || 0);
      const dead = info?.pid ? !pidAlive(info.pid) : false;
      if (age > staleMs || (dead && age > 2000)) {
        const grave = `${dir}.stale-${token}`;
        try {
          fs.renameSync(dir, grave);
          fs.rmSync(grave, { recursive: true, force: true });
        } catch {}
        continue;
      }
      if (Date.now() - start > timeoutMs) throw new Error('Busy: another account operation is running, try again.');
      await sleep(120 + Math.random() * 80);
    }
  }
  const beat = setInterval(() => {
    try { fs.writeFileSync(ownerFile, JSON.stringify({ token, pid: process.pid, at: Date.now() })); } catch {}
  }, 2000);
  beat.unref?.();
  try {
    return await fn();
  } finally {
    clearInterval(beat);
    try {
      if (readJson(ownerFile, null)?.token === token) fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
}

/** Read JSON strictly: null if the file does not exist; retries, then throws if it exists but can't be parsed. */
export function readJsonStrict(file) {
  for (let i = 0; i < 5; i++) {
    let txt;
    try {
      txt = fs.readFileSync(file, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      if (i === 4) throw new Error(`Cannot read ${file}: ${e.code || e.message}`);
      sleepSync(60);
      continue;
    }
    try {
      return JSON.parse(txt);
    } catch {
      if (i === 4) throw new Error(`${file} is not valid JSON (being written by another program?). Not touching it.`);
      sleepSync(60); // another program may be mid-write
    }
  }
  return null;
}

export const tokenHash = (oauth) => (oauth ? hash(oauth.refreshToken || oauth.accessToken) : null);

export function fmtDur(ms) {
  if (ms == null || !Number.isFinite(ms)) return '—';
  if (ms <= 0) return 'now';
  const m = Math.round(ms / 60000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const mm = m % 60;
  if (d) return `${d}d${h}h`;
  if (h) return `${h}h${String(mm).padStart(2, '0')}m`;
  return `${mm}m`;
}

export function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const t = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
  if (d.toDateString() === new Date().toDateString()) return t;
  return `${d.toLocaleDateString('en-GB', { weekday: 'short' })} ${t}`;
}

export const pad = (s, n) => {
  s = String(s);
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
};
