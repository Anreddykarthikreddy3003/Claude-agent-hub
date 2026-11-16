/** Read-only calls to Anthropic's OAuth endpoints, the same ones Claude Code's /usage uses. */
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';

const API = 'https://api.anthropic.com';

// ── network fallback ──
// Node's fetch trusts only its own certificate list and ignores proxy settings. On computers with antivirus
// HTTPS scanning, a company network or a proxy it fails with a bare "fetch failed" while Claude Code itself
// works. The fallback below trusts the operating system's certificates too and goes through HTTPS_PROXY.

let caCache = null;
function caBundle() {
  if (caCache) return caCache;
  const all = new Set(tls.rootCertificates);
  try { for (const c of tls.getCACertificates?.('system') || []) all.add(c); } catch {}
  return (caCache = [...all]);
}

function proxyFor(host) {
  const p = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (!p) return null;
  const no = (process.env.NO_PROXY || process.env.no_proxy || '').split(',').map((s) => s.trim().replace(/^\*?\./, '')).filter(Boolean);
  if (no.some((d) => d === '*' || host === d || host.endsWith('.' + d))) return null;
  try { return new URL(/^\w+:\/\//.test(p) ? p : 'http://' + p); } catch { return null; }
}

function tunnel(proxy, host, timeoutMs) {
  return new Promise((resolve, reject) => {
    const headers = { Host: `${host}:443` };
    if (proxy.username) headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64');
    const req = http.request({ host: proxy.hostname, port: proxy.port || 80, method: 'CONNECT', path: `${host}:443`, headers, timeout: timeoutMs });
    req.on('connect', (res, socket) => (res.statusCode === 200 ? resolve(socket) : (socket.destroy(), reject(Object.assign(new Error(`proxy answered ${res.statusCode}`), { code: 'EPROXY' })))));
    req.on('timeout', () => req.destroy(Object.assign(new Error('proxy timed out'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.end();
  });
}

async function httpsGet(url, headers, timeoutMs) {
  const u = new URL(url);
  const proxy = proxyFor(u.hostname);
  const socket = proxy ? await tunnel(proxy, u.hostname, timeoutMs) : null;
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: u.hostname, port: 443, path: u.pathname + u.search, method: 'GET', headers, ca: caBundle(), servername: u.hostname, timeout: timeoutMs,
      ...(socket ? { createConnection: () => tls.connect({ socket, servername: u.hostname, ca: caBundle() }) } : {}),
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode,
        headers: { get: (k) => { const v = res.headers[String(k).toLowerCase()]; return Array.isArray(v) ? v[0] : v ?? null; } },
        json: async () => JSON.parse(body),
      }));
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.end();
  });
}

/** Swappable in tests, so no test ever reaches the real network. */
export const net = { httpsGet };

/** The real reason behind a network failure, in words a person can act on. */
export function networkError(e) {
  const c = e?.cause?.code || e?.code || e?.cause?.name || e?.name || 'unknown';
  const hint =
    /CERT|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)|DEPTH_ZERO/i.test(c) ? 'HTTPS is being intercepted (antivirus HTTPS scanning or a company network)' :
    /ENOTFOUND|EAI_AGAIN/.test(c) ? 'cannot look up api.anthropic.com (no internet, or DNS blocked)' :
    /EPROXY/.test(c) ? 'the proxy refused the connection' :
    /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET|TimeoutError|AbortError/i.test(c) ? 'the connection was blocked or timed out (a firewall or antivirus blocking node.exe, a VPN, or a proxy that needs HTTPS_PROXY)' :
    (e?.cause?.message || e?.message || 'unknown network error');
  const err = new Error(`network error (${c}): ${hint}`);
  err.network = true;
  err.code = c;
  return err;
}

async function request(url, headers, timeoutMs) {
  try {
    return { res: await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) }), via: 'fetch' };
  } catch (first) {
    // fetch failed before any HTTP answer: try again with the system's certificates and any proxy
    try {
      return { res: await net.httpsGet(url, headers, timeoutMs), via: 'system certificates / proxy', first };
    } catch (second) {
      throw networkError(second?.code || second?.cause ? second : first);
    }
  }
}

/** One unauthenticated request: can this computer reach Anthropic at all, and how? (for cam doctor) */
export async function checkNetwork(timeoutMs = 10000) {
  try {
    const { res, via, first } = await request(API + '/api/oauth/usage', { 'User-Agent': 'claude-agent-hub/1.0' }, timeoutMs);
    return { ok: true, status: res.status, via, firstError: first ? networkError(first).message : null };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function get(pathname, token, timeoutMs = 10000) {
  const { res } = await request(API + pathname, {
    Authorization: `Bearer ${token}`,
    'anthropic-beta': 'oauth-2025-04-20',
    'Content-Type': 'application/json',
    'User-Agent': 'claude-agent-hub/1.0',
  }, timeoutMs);
  if (!res.ok) {
    // A Cloudflare challenge or HTML error page means the service is having trouble (or is challenging the
    // network), not that the login is bad. Anthropic's own auth errors come back as JSON.
    const cloudflare = res.headers.get('cf-mitigated') === 'challenge' || /text\/html/i.test(res.headers.get('content-type') || '');
    const err = new Error(`HTTP ${res.status} from ${pathname}${cloudflare ? ' (Cloudflare / service page, not a login problem)' : ''}`);
    err.status = res.status;
    err.cloudflare = cloudflare;
    const ra = Number(res.headers.get('retry-after'));
    if (ra > 0) err.retryAfterMs = Math.min(ra, 3600) * 1000;
    throw err;
  }
  return res.json();
}

const ts = (s) => (s ? Date.parse(s) || null : null);

export function parseUsage(j) {
  const win = (w) => ({ util: Number(w?.utilization) || 0, resetsAt: ts(w?.resets_at) });
  return { five: win(j?.five_hour), week: win(j?.seven_day) };
}

export async function fetchUsage(token) {
  return parseUsage(await get('/api/oauth/usage', token));
}

export async function fetchProfile(token) {
  const j = await get('/api/oauth/profile', token);
  return {
    uuid: j?.account?.uuid || null,
    email: j?.account?.email || null,
    name: j?.account?.display_name || j?.account?.full_name || null,
    pro: !!j?.account?.has_claude_pro,
    max: !!j?.account?.has_claude_max,
  };
}
