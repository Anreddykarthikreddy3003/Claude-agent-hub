/**
 * Turn runner: one message to an agent = one headless CLI run that resumes the agent's session.
 *  - one turn at a time per agent; messages that arrive meanwhile are queued, then delivered together
 *  - limit  → Claude: auto-switch account and continue; others: wait with backoff; all resume automatically
 *  - auth   → agent marked needs-login with the exact command to run
 *  - model  → agent marked error with the list of available models
 *  - crash  → turns that were running when the daemon stopped are continued on the next start
 *  - lost session → a new session starts with a capped context recap, so nothing is lost
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DATA } from '../paths.mjs';
import { appendLog } from '../store.mjs';
import { fmtTime } from '../util.mjs';
import { getAgent, saveAgent, patchAgent, listAgents, appendEvent, readEvents, addLink, eventsPath } from './store.mjs';
import { adapter, classify, tmpPromptFile } from './adapters.mjs';
import { modelTable } from './models.mjs';

const running = new Map(); // agentId -> child process
const TURN_TIMEOUT = 45 * 60e3;
const STALL_MS = 15 * 60e3;
const LOGIN_HINT = {
  claude: 'Run /accounts in Claude Code (or cam accounts relogin <name>).',
  codex: 'Run: codex login',
  hermes: 'Run: hermes auth (or hermes model) in a terminal.',
  kimi: 'Run: kimi, then /login inside it.',
  opencode: 'Run: opencode auth login',
  agy: 'Open agy once in a terminal and sign in.',
};

export const isRunning = (id) => running.has(id);

/** Kill the whole process tree (on Windows child.kill() only stops a wrapper like `node opencode`). */
function killTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {}
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill(); } catch {} }
  }
}

/** Capped recap of an agent's history, used when its session can't be resumed. ≈ 5k tokens max. */
export function buildRecap(id, max = 20000) {
  const ev = readEvents(id, { limit: 3000 });
  const firstTask = ev.find((e) => e.kind === 'user');
  const replies = ev.filter((e) => e.kind === 'assistant').slice(-6);
  const files = [...new Set(ev.filter((e) => e.kind === 'file').map((e) => e.text))].slice(-30);
  const tools = ev.filter((e) => e.kind === 'tool').length;
  let s = '## Context recap (your previous session could not be resumed)\n';
  if (firstTask) s += `Original task: ${firstTask.text.slice(0, 3000)}\n`;
  if (files.length) s += `Files you changed: ${files.join(', ')}\n`;
  s += `You had run ${tools} tool calls. Your most recent replies:\n`;
  for (const r of replies) s += `- ${r.text.slice(0, 2500)}\n`;
  s += `Full transcript (if you need details): ${eventsPath(id)}\n---\n`;
  return s.length > max ? s.slice(0, max) + '\n…[recap truncated]\n---\n' : s;
}

// Per-platform accounts (codex, hermes, kimi, opencode): each account is an isolated CLI home folder.
import { accountEnv, preferredAccount, nextAccount, markLimited, PLATFORM_DEFS } from '../platforms.mjs';

/** Public entry: deliver a message to an agent (starts a turn now, or queues it). */
export function send(idOrName, message, { from = 'user' } = {}) {
  const a = getAgent(idOrName);
  if (!a || a.status === 'removed') throw new Error(`No agent "${idOrName}".`);
  if (!message?.trim()) throw new Error('Empty message.');
  appendEvent(a.id, { kind: 'user', from, text: message });
  if (from !== 'user') addLink(from, a.id, message);
  if (running.has(a.id) || a.status === 'waiting') {
    a.queue = [...(a.queue || []), { from, text: message }];
    saveAgent(a);
    return { queued: true, position: a.queue.length, status: a.status };
  }
  runTurn(a.id, message).catch((e) => appendLog('hub-error', { agent: a.name, error: String(e?.stack || e).slice(0, 600) }));
  return { started: true };
}

export function stop(idOrName) {
  const a = getAgent(idOrName);
  if (!a) throw new Error(`No agent "${idOrName}".`);
  const c = running.get(a.id);
  if (c) killTree(c);
  patchAgent(a.id, { status: 'stopped', statusDetail: 'stopped by user', waitingUntil: null, pending: null, queue: [] });
  appendEvent(a.id, { kind: 'status', text: 'Stopped by user.' });
  return { stopped: true };
}

function finishStatus(a, status, detail, extra = {}) {
  Object.assign(a, { status, statusDetail: detail, ...extra });
  saveAgent(a);
  appendEvent(a.id, { kind: 'status', status, text: detail });
}

async function runTurn(id, message, { retry = 0 } = {}) {
  let a = getAgent(id);
  const ad = adapter(a.platform);
  if (ad.unsupported) return finishStatus(a, 'error', ad.unsupported, { lastError: ad.unsupported });
  const bin = ad.resolve();
  if (!bin) return finishStatus(a, 'error', `${ad.label} is not installed on this machine.`, { lastError: 'not installed' });

  let prompt = message;
  if (a.needsRecap) { prompt = buildRecap(a.id) + message; a.needsRecap = false; }
  const multi = PLATFORM_DEFS[a.platform] && !PLATFORM_DEFS[a.platform].swap;
  if (multi && !a.account) { a.account = preferredAccount(a.platform); saveAgent(a); }
  const promptFile = ad.usesPromptFile ? tmpPromptFile(prompt) : null;
  const args = ad.args({ sessionId: a.sessionId, model: a.model, permission: a.permission, cwd: a.cwd, prompt, promptFile, effort: a.effort });
  let env = ad.env ? ad.env({ ...process.env }, a) : { ...process.env };
  if (multi) env = { ...env, ...accountEnv(a.platform, a.account) };

  finishStatus(a, 'working', retry ? `retrying (${retry})` : 'working', { turnStartedAt: Date.now(), lastError: null });
  let child;
  try {
    child = spawn(bin.cmd, [...bin.pre, ...args], { cwd: a.cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    return finishStatus(a, 'error', `Could not start ${ad.label}: ${e.message}`, { lastError: e.message });
  }
  running.set(a.id, child);
  if (ad.stdin) child.stdin.end(ad.stdin(prompt)); else child.stdin.end();

  const errors = [];
  let lastText = '';
  let finalText = '';
  let stderr = '';
  let buf = '';
  const tokens = { input: 0, output: 0, cached: 0 };
  let delta = ''; // CLIs that stream a reply in pieces: join them into one message
  const flush = () => { if (delta.trim()) { lastText = delta; appendEvent(a.id, { kind: 'assistant', text: delta }); } delta = ''; };
  let lastActivity = Date.now();
  const onLine = (line) => {
    let j;
    try { j = JSON.parse(line); } catch { return; }
    lastActivity = Date.now();
    for (const ev of ad.parse(j) || []) {
      if (ev.kind === 'delta') { delta += ev.text; continue; }
      flush();
      if (ev.kind === 'session') { if (ev.id && ev.id !== a.sessionId) { a.sessionId = ev.id; saveAgent(a); } if (ev.model && !a.model) a.modelSeen = ev.model; continue; }
      if (ev.kind === 'usage') { tokens.input += ev.input || 0; tokens.output += ev.output || 0; tokens.cached += ev.cached || 0; continue; }
      if (ev.kind === 'error') { errors.push(ev.text); continue; }
      if (ev.kind === 'final') { finalText = ev.text; continue; }
      if (ev.kind === 'assistant') lastText = ev.text;
      appendEvent(a.id, ev);
    }
  };
  const kill = (why) => { if (!errors.includes(why)) errors.push(why); killTree(child); };
  const timer = setTimeout(() => kill('turn timed out after 45 min'), TURN_TIMEOUT);
  // Stall watchdog: a CLI that produces nothing for 15 min is stuck (e.g. silent retry loops).
  const stall = setInterval(() => { if (Date.now() - lastActivity > STALL_MS) kill(`no output for ${Math.round(STALL_MS / 60e3)} min (stalled)`); }, 30e3);
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) onLine(l); }
  });
  child.stderr.on('data', (d) => {
    stderr = (stderr + d).slice(-4000);
    const m = ad.stderrFatal && String(d).match(ad.stderrFatal);
    if (m) kill(m[1].trim()); // CLI reported a fatal error only in its logs: fail fast instead of hanging
  });
  const code = await new Promise((resolve) => {
    child.on('error', (e) => { errors.push(e.message); resolve(-1); });
    child.on('close', resolve);
  });
  clearTimeout(timer);
  clearInterval(stall);
  if (buf.trim()) onLine(buf.trim());
  flush();
  running.delete(a.id);
  if (promptFile) { try { fs.unlinkSync(promptFile); } catch {} }

  a = getAgent(id); // re-read: user may have stopped/removed it meanwhile
  if (!a || a.status === 'stopped' || a.status === 'removed') return;
  a.tokens = { input: (a.tokens?.input || 0) + tokens.input, output: (a.tokens?.output || 0) + tokens.output, cached: (a.tokens?.cached || 0) + tokens.cached, turns: (a.tokens?.turns || 0) + 1 };
  if (tokens.input + tokens.output) appendEvent(a.id, { kind: 'usage', input: tokens.input, output: tokens.output, cached: tokens.cached });

  const reply = lastText || finalText;
  const failed = errors.length > 0 || (code !== 0 && !reply);
  if (!failed) {
    if (!lastText && finalText) appendEvent(a.id, { kind: 'assistant', text: finalText });
    a.lastReply = reply.slice(0, 20000);
    a.retries = 0;
    finishStatus(a, 'done', 'turn finished', { lastTurnAt: Date.now() });
    return drainQueue(a.id);
  }

  const why = (errors.join(' | ') || stderr.trim().split('\n').slice(-4).join(' ') || `exit code ${code}`).slice(0, 1500);
  const kind = classify(`${why}\n${stderr}`);
  appendEvent(a.id, { kind: 'error', text: why, class: kind });
  appendLog('hub-turn-failed', { agent: a.name, platform: a.platform, kind, why: why.slice(0, 300) });

  if (kind === 'limit') return handleLimit(a, message, why);
  if (kind === 'auth') return finishStatus(a, 'needs-login', `${ad.label} needs you to log in. ${LOGIN_HINT[a.platform] || ''}`, { lastError: why, pending: { text: message } });
  if (kind === 'model') {
    const table = await modelTable(a.platform).catch(() => '');
    return finishStatus(a, 'error', `Model "${a.model || '(default)'}" is not available for ${ad.label}. Pick one and run: set model.\n${table}`, { lastError: why });
  }
  if (a.sessionId && /session|conversation|thread|resume/i.test(why) && /not found|no such|invalid|unknown|missing/i.test(why) && retry < 1) {
    a.sessionId = null;
    a.needsRecap = true;
    saveAgent(a);
    appendEvent(a.id, { kind: 'system', text: 'Previous session could not be resumed. Starting a new session with a context recap.' });
    return runTurn(id, message, { retry: retry + 1 });
  }
  return finishStatus(a, 'error', `Turn failed: ${why.slice(0, 400)}`, { lastError: why });
}

async function handleLimit(a, message, why) {
  const cont = `You were interrupted by a usage limit. Continue exactly where you stopped. The request was:\n${message}`;
  if (a.platform === 'claude') {
    const { refreshUsage } = await import('../collector.mjs');
    const { autoSwitchIfNeeded } = await import('../switcher.mjs');
    const st = (await import('../store.mjs')).loadState();
    if (st.active) await refreshUsage({ names: [st.active], maxAgeMs: 0 });
    const r = await autoSwitchIfNeeded(`hub: ${a.name} hit a limit`);
    if (r?.switched) {
      appendEvent(a.id, { kind: 'system', text: `Claude limit reached. Switched account ${r.from ?? '?'} → ${r.to}. Continuing the same session.` });
      return runTurn(a.id, cont, { retry: 1 });
    }
    const at = r?.next?.at && r.next.at > Date.now() ? r.next.at + 60e3 : Date.now() + 30 * 60e3;
    return finishStatus(a, 'waiting', `All Claude accounts are limited. Resumes automatically at ${fmtTime(at)}.`, { waitingUntil: at, pending: { text: cont }, lastError: why });
  }
  if (PLATFORM_DEFS[a.platform] && !PLATFORM_DEFS[a.platform].swap) {
    const prev = a.account || 'default';
    markLimited(a.platform, prev, Date.now() + 5 * 3600e3);
    const next = nextAccount(a.platform, prev);
    if (next) {
      Object.assign(a, { account: next, sessionId: null, needsRecap: true });
      saveAgent(a);
      appendEvent(a.id, { kind: 'system', text: `${adapter(a.platform).label} limit on account "${prev}". Switched to account "${next}" and continued with a context recap (sessions don't carry across accounts).` });
      return runTurn(a.id, message, { retry: 1 });
    }
  }
  const backoff = Math.min(15 * 60e3 * 2 ** (a.retries || 0), 2 * 3600e3);
  const at = Date.now() + backoff;
  return finishStatus(a, 'waiting', `${adapter(a.platform).label} usage limit. Retrying automatically at ${fmtTime(at)}.`, { waitingUntil: at, pending: { text: cont }, retries: (a.retries || 0) + 1, lastError: why });
}

function drainQueue(id) {
  const a = getAgent(id);
  if (!a?.queue?.length) return;
  const items = a.queue;
  a.queue = [];
  saveAgent(a);
  const text = items.length === 1 ? items[0].text : items.map((q, i) => `Message ${i + 1} (from ${q.from}):\n${q.text}`).join('\n\n');
  return runTurn(id, text);
}

/** Daemon tick: resume agents whose wait is over; continue turns interrupted by a daemon restart. */
export function resumeDue() {
  const now = Date.now();
  for (const a of listAgents()) {
    if (running.has(a.id)) continue;
    if (a.status === 'working') {
      // the daemon stopped mid-turn: continue it (the session keeps everything done so far)
      appendEvent(a.id, { kind: 'system', text: 'The hub restarted during this turn. Continuing where it stopped.' });
      const last = readEvents(a.id, { limit: 200 }).filter((e) => e.kind === 'user').pop();
      runTurn(a.id, `Continue where you stopped. The request was:\n${last?.text || '(see your session)'}`, { retry: 1 }).catch(() => {});
    } else if (a.status === 'waiting' && a.waitingUntil && a.waitingUntil <= now && a.pending?.text) {
      const text = a.pending.text;
      patchAgent(a.id, { pending: null, waitingUntil: null });
      appendEvent(a.id, { kind: 'system', text: 'Wait is over. Resuming.' });
      runTurn(a.id, text, { retry: 1 }).catch(() => {});
    }
  }
}

/** Re-run the message that failed (after fixing a login, a model, or a transient error). */
export function retry(idOrName) {
  const a = getAgent(idOrName);
  if (!a) throw new Error(`No agent "${idOrName}".`);
  if (running.has(a.id)) return { running: true };
  const last = a.pending?.text || readEvents(a.id, { limit: 300 }).filter((e) => e.kind === 'user').pop()?.text;
  if (!last) throw new Error('Nothing to retry.');
  patchAgent(a.id, { pending: null, waitingUntil: null, retries: 0 });
  appendEvent(a.id, { kind: 'system', text: 'Retrying the last message.' });
  runTurn(a.id, last, { retry: 1 }).catch(() => {});
  return { started: true };
}

export function stopAll() {
  for (const c of running.values()) killTree(c);
}
