/**
 * Agent registry on disk (survives daemon / IDE restarts):
 *   hub/agents/<id>/agent.json   current state
 *   hub/agents/<id>/events.jsonl append-only normalised timeline
 *   hub/links.jsonl              who messaged whom (Agent Map edges)
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { DATA } from '../paths.mjs';
import { readJson, writeJsonAtomic } from '../util.mjs';

export const HUB = path.join(DATA, 'hub');
const AGENTS = path.join(HUB, 'agents');
const LINKS = path.join(HUB, 'links.jsonl');
export const HUB_INFO = path.join(DATA, 'hub.json');

/** In-process bus: the API server streams these to the dashboard (SSE). */
export const bus = new EventEmitter();
bus.setMaxListeners(100);

const dir = (id) => path.join(AGENTS, id);
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,39}$/;

export function listAgents() {
  if (!fs.existsSync(AGENTS)) return [];
  return fs
    .readdirSync(AGENTS)
    .map((id) => readJson(path.join(dir(id), 'agent.json'), null))
    .filter(Boolean)
    .sort((a, b) => a.createdAt - b.createdAt);
}

export function getAgent(idOrName) {
  if (!idOrName) return null;
  const direct = readJson(path.join(dir(idOrName), 'agent.json'), null);
  if (direct) return direct;
  const lower = String(idOrName).toLowerCase();
  return listAgents().find((a) => a.name.toLowerCase() === lower && a.status !== 'removed') || null;
}

export function saveAgent(a) {
  a.updatedAt = Date.now();
  writeJsonAtomic(path.join(dir(a.id), 'agent.json'), a);
  bus.emit('agent', a);
  return a;
}

export function patchAgent(id, patch) {
  const a = getAgent(id);
  if (!a) throw new Error(`No agent "${id}".`);
  return saveAgent({ ...a, ...patch });
}

export function createAgent({ name, platform, model = null, role = '', cwd, permission = 'read', parentId = null, account = null, createdBy = 'user' }) {
  if (!NAME_RE.test(name || '')) throw new Error('Agent name: 1-40 letters, digits, space, - _ . (e.g. "reviewer").');
  const live = listAgents().filter((a) => a.status !== 'removed');
  if (live.some((a) => a.name.toLowerCase() === name.toLowerCase())) throw new Error(`An agent named "${name}" already exists.`);
  if (!cwd || !fs.existsSync(cwd)) throw new Error(`Project folder not found: ${cwd}`);
  const id = `ag_${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
  const a = {
    id, name, platform, model, role, cwd, permission, parentId, account, createdBy,
    sessionId: null, status: 'idle', statusDetail: '', queue: [], waitingUntil: null, retries: 0,
    tokens: { input: 0, output: 0, cached: 0, turns: 0 }, lastReply: '', lastError: null,
    createdAt: Date.now(), updatedAt: Date.now(),
  };
  fs.mkdirSync(dir(id), { recursive: true });
  saveAgent(a);
  appendEvent(id, { kind: 'system', text: `Created ${platform} agent "${name}"${model ? ` · model ${model}` : ''} · permission ${permission} · ${cwd}` });
  return a;
}

export function appendEvent(id, ev) {
  const e = { t: Date.now(), ...ev };
  try {
    fs.appendFileSync(path.join(dir(id), 'events.jsonl'), JSON.stringify(e) + '\n');
  } catch {}
  bus.emit('event', { agentId: id, event: e });
  return e;
}

/** Last `limit` events after timestamp `since` (cheap tail read; transcripts can grow large). */
export function readEvents(id, { since = 0, limit = 400 } = {}) {
  const f = path.join(dir(id), 'events.jsonl');
  let txt = '';
  try {
    const st = fs.statSync(f);
    const max = 4 * 1024 * 1024;
    const fd = fs.openSync(f, 'r');
    const len = Math.min(st.size, max);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    txt = buf.toString('utf8');
    if (st.size > max) txt = txt.slice(txt.indexOf('\n') + 1);
  } catch {
    return [];
  }
  const out = [];
  for (const line of txt.split('\n')) {
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      if (e.t > since) out.push(e);
    } catch {}
  }
  return out.slice(-limit);
}

export const eventsPath = (id) => path.join(dir(id), 'events.jsonl');

export function addLink(fromName, toId, text) {
  const l = { t: Date.now(), from: fromName, to: toId, preview: String(text || '').slice(0, 140) };
  try {
    fs.mkdirSync(HUB, { recursive: true });
    fs.appendFileSync(LINKS, JSON.stringify(l) + '\n');
  } catch {}
  bus.emit('link', l);
}

export function readLinks(limit = 500) {
  try {
    return fs.readFileSync(LINKS, 'utf8').trim().split('\n').slice(-limit).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}
