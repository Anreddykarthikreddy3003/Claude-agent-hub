/** Client for the hub API (used by MCP tools and the CLI). Starts the background service if needed. */
import http from 'node:http';
import { readJson, sleep } from '../util.mjs';
import { HUB_INFO } from './store.mjs';

function request(info, method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      { host: '127.0.0.1', port: info.port, method, path, timeout: 120000, headers: { Authorization: `Bearer ${info.token}`, 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}) } },
      (res) => {
        let s = '';
        res.on('data', (d) => (s += d));
        res.on('end', () => {
          let j = null;
          try { j = s ? JSON.parse(s) : {}; } catch { j = { error: s }; }
          if (res.statusCode >= 400) reject(Object.assign(new Error(j?.error || `HTTP ${res.statusCode}`), { status: res.statusCode, code: j?.code }));
          else resolve(j);
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('hub request timed out')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

export async function hub(method, path, body) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const info = readJson(HUB_INFO, null);
    if (info?.port) {
      try {
        return await request(info, method, path, body);
      } catch (e) {
        if (e.status) throw e; // a real API error: don't retry
      }
    }
    if (attempt === 0) {
      const { ensureDaemon } = await import('../daemon.mjs');
      ensureDaemon();
    }
    await sleep(1000);
  }
  throw new Error('The Agent Hub is not running. Run: cam doctor');
}

/** Wait until an agent's turn ends (done / error / needs-login / waiting / stopped) or the timeout passes. */
export async function waitForAgent(id, timeoutMs = 600000) {
  const t0 = Date.now();
  for (;;) {
    const a = await hub('GET', `/api/agents/${encodeURIComponent(id)}`);
    if (!a.running && a.status !== 'working' && !a.queue) return a;
    if (Date.now() - t0 > timeoutMs) return { ...a, timedOut: true };
    await sleep(2000);
  }
}
