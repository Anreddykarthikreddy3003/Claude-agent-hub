/**
 * Hub API: 127.0.0.1 only, bearer token (stored in ~/.claude-accounts/hub.json, readable only by this user).
 * Used by the IDE dashboard (live via Server-Sent Events) and by the Claude master's MCP tools.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeJsonAtomic } from '../util.mjs';
import { appendLog, readLog, saveConfig } from '../store.mjs';
import { statusJson, publishStatus } from '../report.mjs';
import { bus, HUB_INFO, listAgents, getAgent, createAgent, patchAgent, readEvents, readLinks, appendEvent, eventsPath } from './store.mjs';
import { send, stop, retry, isRunning } from './runner.mjs';
import { PLATFORMS, probePlatform, adapter } from './adapters.mjs';
import { listModels, resolveModel, modelsCachedAt, warmModelCache } from './models.mjs';
import { testAccount, lastTests } from '../acctest.mjs';
import { allPlatformAccounts, refreshPlatformUsage, PLATFORM_DEFS, captureSwapLogins, prepareLogin, setPreferred, setPausedAccount, activateSwap, removeAccount as removePlatformAccount } from '../platforms.mjs';

// Installed CLIs + versions: probed asynchronously (in parallel) and cached; never blocks a request.
let platformCache = { at: 0, list: [] };
let platformInflight = null;
export function refreshPlatforms() {
  if (platformInflight) return platformInflight;
  platformInflight = Promise.all(PLATFORMS.map((p) => probePlatform(p).catch((e) => ({ platform: p, installed: false, error: e.message }))))
    .then((list) => { platformCache = { at: Date.now(), list }; return list; })
    .finally(() => { platformInflight = null; });
  return platformInflight;
}
function platforms() {
  if (Date.now() - platformCache.at > 10 * 60e3) refreshPlatforms();
  return platformCache.list;
}

/** Recent Claude Code chats (from the extension or CLI) and their helper agents, read from Claude's own files. */
function claudeChats({ hours = 24, max = 12 } = {}) {
  const root = path.join(os.homedir(), '.claude', 'projects');
  const out = [];
  let projects = [];
  try { projects = fs.readdirSync(root); } catch { return out; }
  const cutoff = Date.now() - hours * 3600e3;
  for (const p of projects) {
    let files = [];
    try { files = fs.readdirSync(path.join(root, p)).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const full = path.join(root, p, f);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (st.mtimeMs < cutoff) continue;
      const sid = f.replace(/\.jsonl$/, '');
      let title = '';
      let cwd = '';
      try {
        const fd = fs.openSync(full, 'r');
        const buf = Buffer.alloc(Math.min(st.size, 96 * 1024));
        fs.readSync(fd, buf, 0, buf.length, 0);
        fs.closeSync(fd);
        for (const line of buf.toString('utf8').split('\n')) {
          if (!line.includes('"type":"user"')) continue;
          try {
            const j = JSON.parse(line);
            cwd = cwd || j.cwd || '';
            const c = j.message?.content;
            const t = typeof c === 'string' ? c : Array.isArray(c) ? c.find((x) => x.type === 'text')?.text : '';
            if (t && !t.startsWith('<')) { title = t.replace(/\s+/g, ' ').slice(0, 90); break; }
          } catch {}
        }
      } catch {}
      const subDir = path.join(root, p, sid, 'subagents');
      const helpers = [];
      try {
        for (const m of fs.readdirSync(subDir).filter((x) => x.endsWith('.meta.json'))) {
          try {
            const meta = JSON.parse(fs.readFileSync(path.join(subDir, m), 'utf8'));
            helpers.push({ id: m.replace(/^agent-|\.meta\.json$/g, ''), description: meta.description || meta.agentType, type: meta.agentType, model: meta.pickedEffortModel || null, finished: !!meta.finished });
          } catch {}
        }
      } catch {}
      out.push({ sessionId: sid, title: title || '(untitled chat)', cwd, updatedAt: st.mtimeMs, sizeKb: Math.round(st.size / 1024), helpers: helpers.slice(-30) });
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, max);
}

const agentView = (a) => ({
  id: a.id, name: a.name, platform: a.platform, model: a.model || a.modelSeen || null, role: a.role, cwd: a.cwd,
  permission: a.permission, parentId: a.parentId, account: a.account || null, status: a.status, statusDetail: a.statusDetail,
  waitingUntil: a.waitingUntil, queue: (a.queue || []).length, tokens: a.tokens, sessionId: a.sessionId,
  lastReply: (a.lastReply || '').slice(0, 600), lastError: a.lastError ? String(a.lastError).slice(0, 400) : null,
  createdBy: a.createdBy, createdAt: a.createdAt, updatedAt: a.updatedAt, running: isRunning(a.id),
});

export function stateSnapshot() {
  return {
    now: Date.now(),
    accounts: statusJson(),
    agents: listAgents().filter((a) => a.status !== 'removed').map(agentView),
    links: readLinks(400),
    platforms: platforms(),
    platformAccounts: allPlatformAccounts(),
    claudeChats: claudeChats(),
    tests: lastTests(),
  };
}

async function body(req) {
  let s = '';
  for await (const c of req) { s += c; if (s.length > 1e6) throw Object.assign(new Error('body too large'), { status: 413 }); }
  if (!s) return {};
  try { return JSON.parse(s); } catch { throw Object.assign(new Error('invalid JSON'), { status: 400 }); }
}

export async function createAndStart(b) {
  const platform = String(b.platform || '').toLowerCase();
  adapter(platform); // validates
  const model = await resolveModel(platform, b.model || null);
  let parentId = null;
  if (b.parent) parentId = getAgent(b.parent)?.id || null;
  const a = createAgent({ name: b.name, platform, model, role: b.role || '', cwd: b.cwd, permission: ['read', 'edit', 'full'].includes(b.permission) ? b.permission : 'read', parentId, createdBy: b.from || 'user', account: b.account || null });
  if (b.effort) patchAgent(a.id, { effort: b.effort });
  let delivery = null;
  if (b.task) {
    const intro = b.role ? `Your role: ${b.role}\n\n` : '';
    delivery = send(a.id, intro + b.task, { from: b.from || 'user' });
  }
  return { agent: agentView(getAgent(a.id)), delivery };
}

const routes = [
  ['GET', /^\/api\/health$/, () => ({ ok: true, pid: process.pid })],
  ['GET', /^\/api\/state$/, async (_m, q) => { if (q.get('refresh') === '1' || !platformCache.list.length) await refreshPlatforms(); return stateSnapshot(); }],
  ['GET', /^\/api\/agents$/, () => listAgents().filter((a) => a.status !== 'removed').map(agentView)],
  ['POST', /^\/api\/agents$/, async (_m, _q, b) => createAndStart(b)],
  ['GET', /^\/api\/agents\/([^/]+)$/, ([, id]) => { const a = getAgent(id); if (!a) throw Object.assign(new Error('no such agent'), { status: 404 }); return { ...agentView(a), transcript: eventsPath(a.id) }; }],
  ['GET', /^\/api\/agents\/([^/]+)\/events$/, ([, id], q) => { const a = getAgent(id); if (!a) throw Object.assign(new Error('no such agent'), { status: 404 }); return readEvents(a.id, { since: Number(q.get('since') || 0), limit: Math.min(Number(q.get('limit') || 400), 2000) }); }],
  ['POST', /^\/api\/agents\/([^/]+)\/send$/, ([, id], _q, b) => send(id, b.text, { from: b.from || 'user' })],
  ['POST', /^\/api\/agents\/([^/]+)\/stop$/, ([, id]) => stop(id)],
  ['POST', /^\/api\/agents\/([^/]+)\/retry$/, ([, id]) => retry(id)],
  ['POST', /^\/api\/agents\/([^/]+)\/model$/, async ([, id], _q, b) => { const a = getAgent(id); if (!a) throw Object.assign(new Error('no such agent'), { status: 404 }); const model = await resolveModel(a.platform, b.model); patchAgent(a.id, { model }); appendEvent(a.id, { kind: 'system', text: `Model set to ${model}` }); return { model }; }],
  ['DELETE', /^\/api\/agents\/([^/]+)$/, ([, id]) => { const a = getAgent(id); if (!a) throw Object.assign(new Error('no such agent'), { status: 404 }); try { stop(a.id); } catch {} patchAgent(a.id, { status: 'removed' }); return { removed: true }; }],
  ['GET', /^\/api\/models\/([a-z]+)$/, async ([, p], q) => listModels(p, { refresh: q.get('refresh') === '1' })],
  ['GET', /^\/api\/platforms$/, async (_m, q) => (q.get('refresh') === '1' || !platformCache.list.length ? refreshPlatforms() : platforms())],
  ['GET', /^\/api\/models-cache$/, () => Object.fromEntries(PLATFORMS.map((p) => [p, modelsCachedAt(p)]))],
  ['GET', /^\/api\/logs$/, (_m, q) => readLog(Math.min(Number(q.get('n') || 100), 1000))],
  ['POST', /^\/api\/accounts\/switch$/, async (_m, _q, b) => (await import('../switcher.mjs')).switchTo(b.name, 'manual (dashboard)')],
  ['POST', /^\/api\/ready$/, (_m, _q, b) => { saveConfig({ ready: !!b.on }); bus.emit('accountsChanged'); return { ready: !!b.on }; }],
  // Force-switch to a Claude account past its thresholds; it is held until 100% (then auto-switching resumes)
  ['POST', /^\/api\/platform-accounts\/claude\/([^/]+)\/force$/, async ([, n]) => (await import('../switcher.mjs')).forceSwitch(decodeURIComponent(n))],
  ['POST', /^\/api\/accounts\/release-hold$/, async () => (await import('../switcher.mjs')).releaseForced()],
  // Home-page switches: { ready?: bool, autoSwitch?: bool }
  ['POST', /^\/api\/settings$/, (_m, _q, b) => {
    const patch = {};
    if (typeof b.ready === 'boolean') patch.ready = b.ready;
    for (const k of ['autoSwitch', 'monitoring', 'primeAll', 'primeCodex']) if (typeof b[k] === 'boolean') patch[k] = b[k];
    saveConfig(patch);
    appendLog('settings-changed', patch);
    bus.emit('accountsChanged');
    return patch;
  }],
  // ── accounts for every platform ──
  ['GET', /^\/api\/platform-accounts$/, () => allPlatformAccounts()],
  ['POST', /^\/api\/platform-accounts\/([a-z]+)\/login$/, async ([, p], _q, b) => {
    if (p === 'claude') return (await import('../accounts.mjs')).prepareClaudeLogin(b.name, { relogin: !!b.relogin });
    return prepareLogin(p, b.name, { relogin: !!b.relogin });
  }],
  ['POST', /^\/api\/platform-accounts\/([a-z]+)\/([^/]+)\/test$/, async ([, p, n]) => testAccount(p, decodeURIComponent(n))],
  // Manual "Refresh" button: fetch live usage for one platform now (ignores the polling interval).
  ['POST', /^\/api\/platform-accounts\/([a-z]+)\/refresh$/, async ([, p]) => {
    const t0 = Date.now();
    if (p === 'claude') {
      const { refreshUsage } = await import('../collector.mjs');
      await refreshUsage(); // every Claude account, live
      publishStatus();
      bus.emit('accountsChanged');
    } else {
      if (p === 'agy') await captureSwapLogins().catch(() => {});
      await refreshPlatformUsage({ only: p });
    }
    const hasUsage = p === 'claude' || !!PLATFORM_DEFS[p]?.usage;
    return { platform: p, ms: Date.now() - t0, hasUsage, at: Date.now() };
  }],
  ['POST', /^\/api\/platform-accounts\/([a-z]+)\/login-finished$/, async ([, p]) => (p === 'agy' ? (await captureSwapLogins({ finished: true })) || { ok: true } : { ok: true })],
  ['POST', /^\/api\/platform-accounts\/([a-z]+)\/([^/]+)\/preferred$/, ([, p, n]) => { setPreferred(p, n); return { preferred: n }; }],
  ['POST', /^\/api\/platform-accounts\/([a-z]+)\/([^/]+)\/pause$/, async ([, p, n], _q, b) => {
    if (p === 'claude') { (await import('../accounts.mjs')).setPaused(n, !!b.paused); return { paused: !!b.paused }; }
    setPausedAccount(p, n, !!b.paused); return { paused: !!b.paused };
  }],
  ['POST', /^\/api\/platform-accounts\/([a-z]+)\/([^/]+)\/activate$/, async ([, p, n]) => {
    if (p === 'claude') return (await import('../switcher.mjs')).switchTo(n, 'manual (dashboard)');
    return activateSwap(p, n);
  }],
  ['DELETE', /^\/api\/platform-accounts\/([a-z]+)\/([^/]+)$/, async ([, p, n]) => {
    if (p === 'claude') { await (await import('../accounts.mjs')).removeAccount(n); return { removed: n }; }
    await removePlatformAccount(p, n); return { removed: n };
  }],
];

export function startServer() {
  const token = crypto.randomBytes(24).toString('hex');
  const clients = new Set();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const auth = req.headers.authorization === `Bearer ${token}` || url.searchParams.get('token') === token;
    if (!auth) { res.writeHead(401).end('unauthorized'); return; }
    if (url.pathname === '/api/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(': connected\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    const route = routes.find(([m, re]) => m === req.method && re.test(url.pathname));
    if (!route) { res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'not found' })); return; }
    try {
      const b = req.method === 'GET' || req.method === 'DELETE' ? {} : await body(req);
      const result = await route[2](url.pathname.match(route[1]), url.searchParams, b);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result ?? {}));
    } catch (e) {
      const status = e.status || (e.code === 'MODEL_NOT_FOUND' ? 422 : 400);
      res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: e.message, code: e.code || null }));
    }
  });
  const push = (type, data) => {
    const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) { try { c.write(msg); } catch { clients.delete(c); } }
  };
  bus.on('agent', (a) => push('agent', agentView(a)));
  bus.on('accountsChanged', () => push('accounts', statusJson()));
  bus.on('event', (e) => push('event', e));
  bus.on('link', (l) => push('link', l));
  const beat = setInterval(() => push('ping', { t: Date.now() }), 25000);
  beat.unref();
  server.on('error', (e) => appendLog('hub-server-error', { error: e.message }));
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    writeJsonAtomic(HUB_INFO, { port, token, pid: process.pid, startedAt: Date.now() });
    try { fs.chmodSync(HUB_INFO, 0o600); } catch {}
    appendLog('hub-started', { port });
    // Warm caches in the background so the dashboard's first look is instant.
    refreshPlatforms()
      .then((list) => warmModelCache(list.filter((p) => p.installed && ['codex', 'opencode', 'agy'].includes(p.platform)).map((p) => p.platform)))
      .catch(() => {});
  });
  return { server, push };
}
