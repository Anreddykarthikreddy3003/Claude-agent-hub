/** Read-only calls to Anthropic's OAuth endpoints, the same ones Claude Code's /usage uses. */
const API = 'https://api.anthropic.com';

async function get(pathname, token, timeoutMs = 10000) {
  const res = await fetch(API + pathname, {
    headers: {
      Authorization: `Bearer ${token}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'Content-Type': 'application/json',
      'User-Agent': 'claude-agent-hub/1.0',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} from ${pathname}`);
    err.status = res.status;
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
