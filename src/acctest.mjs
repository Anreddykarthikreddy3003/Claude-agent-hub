/**
 * "Test" button: send the cheapest possible message on one account and report whether it works,
 * how long it took and exactly how many tokens it used. Tests are manual only (never automatic).
 *
 * Measured costs (2026-11-08):
 *   claude   minimal system prompt + haiku + no tools: ~210 tokens (default Claude Code prompt would be ~5.9k)
 *   codex    usage-API check: 0 tokens (a real "hi" is ~19k tokens: Codex's own instructions can't be trimmed)
 *   hermes   `-t none` (no tool definitions): ~1.2k tokens instead of ~12.8k
 *   agy      `agy models`: proves the login works, uses no model tokens (agy's print mode needs a real console)
 */
import path from 'node:path';
import { FILES } from './paths.mjs';
import { withLock, readJson, writeJsonAtomic } from './util.mjs';
import { DATA } from './paths.mjs';
import { appendLog } from './store.mjs';

const TESTS = path.join(DATA, 'account-tests.json');
const PROMPT = 'hi';

function parseJsonLines(out) {
  const xs = [];
  for (const l of String(out).split(/\r?\n/)) { try { xs.push(JSON.parse(l)); } catch {} }
  return xs;
}

async function testClaude(name) {
  const { resolveClaude } = await import('./claude.mjs');
  const { liveConfigDir } = await import('./collector.mjs');
  const { runCapture } = await import('./hub/adapters.mjs');
  const env = { ...process.env, CAM_INTERNAL: '1' };
  return withLock(FILES.opsLock, async () => {
    const dir = liveConfigDir(name); // decided inside the lock: never touch a parked copy of the active login
    if (dir) env.CLAUDE_CONFIG_DIR = dir; else delete env.CLAUDE_CONFIG_DIR;
    const r = await runCapture(resolveClaude(), ['-p', PROMPT, '--model', 'haiku', '--tools', '', '--strict-mcp-config', '--setting-sources', '', '--disable-slash-commands', '--no-session-persistence', '--system-prompt', 'Reply with one word.', '--output-format', 'json'], 90000, { env });
    let j = null;
    try { j = JSON.parse(r.stdout); } catch {}
    if (!j) return { ok: false, error: (r.stderr || r.stdout || 'no output').trim().slice(0, 300) };
    const u = j.usage || {};
    return { ok: !j.is_error, reply: String(j.result || '').slice(0, 80), error: j.is_error ? String(j.result).slice(0, 300) : null, tokens: { input: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0), cached: u.cache_read_input_tokens || 0, output: u.output_tokens || 0 }, costUsd: j.total_cost_usd || null };
  }, { timeoutMs: 60000 });
}

/**
 * Codex: a real "hi" costs ~19k tokens (Codex's own instructions), so the test checks the login and quota
 * through Codex's usage API instead: proves the account works without sending any message (0 tokens).
 */
async function testCodex(name) {
  const { PLATFORM_DEFS, accountHome } = await import('./platforms.mjs');
  const u = await PLATFORM_DEFS.codex.usage(accountHome('codex', name)).catch((e) => ({ error: e.message }));
  if (!u) return { ok: false, error: 'Not signed in (no Codex login found for this account).' };
  if (u.error) return { ok: false, error: `Codex rejected the login (${u.error}). Use "Sign in again".` };
  const wk = u.week ? `weekly ${u.week.util}% used` : 'quota available';
  if (u.limited) return { ok: false, error: `Signed in, but the usage limit is reached (${wk}).` };
  return { ok: true, reply: `signed in · ${wk}`, tokens: { input: 0, cached: 0, output: 0 }, note: 'Login + quota checked via the usage API (no message sent)' };
}

/** Optional full round-trip for Codex (not used by the Test button: ~19k tokens). */
export async function testCodexMessage(name) {
  const { resolveCodex } = await import('./codex.mjs');
  const { runCapture } = await import('./hub/adapters.mjs');
  const { accountEnv } = await import('./platforms.mjs');
  const { cmd, pre } = resolveCodex();
  const r = await runCapture(cmd, [...pre, 'exec', '--json', '--skip-git-repo-check', '--ephemeral', '-c', 'sandbox_mode="read-only"', '-c', 'model_reasoning_effort="low"', PROMPT], 120000, { env: { ...process.env, ...accountEnv('codex', name) } });
  const ev = parseJsonLines(r.stdout);
  const u = ev.find((e) => e.type === 'turn.completed')?.usage;
  const msg = ev.filter((e) => e.item?.type === 'agent_message').pop()?.item?.text;
  const err = ev.find((e) => e.type === 'error' || e.type === 'turn.failed');
  if (!msg) return { ok: false, error: (err?.message || err?.error?.message || r.stderr || 'no reply').trim().slice(0, 300) };
  return { ok: true, reply: msg.slice(0, 80), tokens: u ? { input: (u.input_tokens || 0) - (u.cached_input_tokens || 0), cached: u.cached_input_tokens || 0, output: (u.output_tokens || 0) + (u.reasoning_output_tokens || 0) } : null };
}

async function testHermes(name) {
  const { runCapture, ADAPTERS } = await import('./hub/adapters.mjs');
  const { accountEnv } = await import('./platforms.mjs');
  const bin = ADAPTERS.hermes.resolve();
  if (!bin) return { ok: false, error: 'Hermes is not installed' };
  // `-t none`: no tool definitions in the prompt. Measured 1.2k tokens instead of 12.8k.
  const r = await runCapture(bin.cmd, [...bin.pre, 'chat', '-q', PROMPT, '--format', 'stream-json', '-Q', '--max-turns', '1', '-t', 'none'], 120000, { env: { ...process.env, ...accountEnv('hermes', name) } });
  const ev = parseJsonLines(r.stdout);
  const res = ev.find((e) => e.type === 'result');
  const text = ev.filter((e) => e.type === 'text').map((e) => e.text).join('') || res?.text;
  if (!res || res.exit_code) return { ok: false, error: (res?.text || r.stderr || 'no reply').trim().slice(0, 300) };
  const t = res.tokens || {};
  return { ok: true, reply: String(text || '').slice(0, 80), model: ev.find((e) => e.type === 'system')?.model, tokens: { input: t.input || 0, cached: t.cache_read || 0, output: t.output || 0 } };
}

async function testKimi(name) {
  const { runCapture, ADAPTERS } = await import('./hub/adapters.mjs');
  const { accountEnv } = await import('./platforms.mjs');
  const bin = ADAPTERS.kimi.resolve();
  if (!bin) return { ok: false, error: 'Kimi is not installed' };
  const r = await runCapture(bin.cmd, ['-p', PROMPT, '--output-format', 'stream-json'], 120000, { env: { ...process.env, ...accountEnv('kimi', name) } });
  const ev = parseJsonLines(r.stdout);
  const reply = ev.filter((e) => e.role === 'assistant').map((e) => (typeof e.content === 'string' ? e.content : Array.isArray(e.content) ? e.content.map((c) => c.text || '').join('') : '')).join('').trim();
  if (!reply) return { ok: false, error: (r.stderr.split('\n').find((l) => /error/i.test(l)) || r.stderr || 'no reply').trim().slice(0, 300) };
  const u = ev.find((e) => e.usage)?.usage;
  return { ok: true, reply: reply.slice(0, 80), tokens: u ? { input: u.input_tokens || u.prompt_tokens || 0, cached: 0, output: u.output_tokens || u.completion_tokens || 0 } : null };
}

async function testOpencode(name) {
  const { runCapture, ADAPTERS } = await import('./hub/adapters.mjs');
  const { accountEnv } = await import('./platforms.mjs');
  const bin = ADAPTERS.opencode.resolve();
  if (!bin) return { ok: false, error: 'OpenCode is not installed' };
  const r = await runCapture(bin.cmd, [...bin.pre, 'run', '--format', 'json', '--print-logs', '--log-level', 'ERROR', PROMPT], 90000, { env: { ...process.env, ...accountEnv('opencode', name) } });
  const ev = parseJsonLines(r.stdout);
  const text = ev.filter((e) => e.type === 'text').map((e) => e.part?.text || '').join('').trim();
  const fin = ev.filter((e) => e.type === 'step_finish').pop()?.part?.tokens;
  const logErr = /error=([^\n]{0,240})/.exec(r.stderr)?.[1];
  const evErr = ev.find((e) => e.type === 'error');
  if (!text) return { ok: false, error: (evErr?.error?.data?.message || logErr || 'no reply (provider limit or login problem)').trim().slice(0, 300) };
  return { ok: true, reply: text.slice(0, 80), tokens: fin ? { input: fin.input || 0, cached: fin.cache?.read || 0, output: (fin.output || 0) + (fin.reasoning || 0) } : null };
}

async function testAgy(name) {
  const { runCapture, ADAPTERS } = await import('./hub/adapters.mjs');
  const { listAccounts } = await import('./platforms.mjs');
  const acc = listAccounts('agy').find((a) => a.name === name);
  if (!acc?.active) return { ok: false, error: 'Only the active Antigravity account can be tested. Click "Make active" first.' };
  const bin = ADAPTERS.agy.resolve();
  if (!bin) return { ok: false, error: 'agy is not installed' };
  const r = await runCapture(bin.cmd, ['models'], 60000);
  const models = r.stdout.split(/\r?\n/).filter((l) => l.includes('\t'));
  if (!models.length) return { ok: false, error: (r.stderr || r.stdout || 'no answer').trim().slice(0, 300) };
  return { ok: true, reply: `signed in · ${models.length} models available`, tokens: { input: 0, cached: 0, output: 0 }, note: 'Checks the login without using model tokens' };
}

const TESTERS = { claude: testClaude, codex: testCodex, hermes: testHermes, kimi: testKimi, opencode: testOpencode, agy: testAgy };

export async function testAccount(platform, name) {
  const fn = TESTERS[platform];
  if (!fn) throw new Error(`Unknown platform "${platform}"`);
  const t0 = Date.now();
  let r;
  try { r = await fn(name); } catch (e) { r = { ok: false, error: e.message }; }
  r = { ...r, platform, name, ms: Date.now() - t0, at: Date.now() };
  const all = readJson(TESTS, {}) || {};
  all[`${platform}:${name}`] = r;
  writeJsonAtomic(TESTS, all);
  appendLog('account-test', { platform, name, ok: r.ok, ms: r.ms, tokens: r.tokens || null, error: r.ok ? undefined : r.error });
  return r;
}

export function lastTests() {
  return readJson(TESTS, {}) || {};
}
