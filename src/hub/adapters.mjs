/**
 * One adapter per agent CLI. Each turns "send this message (resume this session)" into a headless
 * command, and turns the CLI's streamed output into normalised events:
 *   { kind: 'assistant'|'tool'|'tool_result'|'file'|'usage'|'error'|'system', text, name, detail, ok }
 * CLIs are started without a shell. Claude, Codex and Hermes get the prompt via stdin or a temp file;
 * Kimi and OpenCode only accept it as an argument, so it goes through argText() and can never be read as a flag.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { resolveClaude } from '../claude.mjs';
import { resolveCodex } from '../codex.mjs';
import { loadConfig, saveConfig } from '../store.mjs';

const clip = (s, n = 4000) => (s && s.length > n ? s.slice(0, n) + ` …[+${s.length - n} chars]` : s || '');
const short = (v, n = 300) => clip(typeof v === 'string' ? v : JSON.stringify(v ?? ''), n);
/** A prompt passed as a command-line argument: a leading space stops a CLI parsing "-x…" as an option. */
export const argText = (s) => (/^\s*-/.test(String(s ?? '')) ? ' ' + String(s) : String(s ?? ''));
/** Model names and session ids go after a flag; refuse anything that could itself be read as a flag. */
export const isFlagLike = (v) => typeof v === 'string' && /^\s*-/.test(v);

const whichCache = new Map(); // `where` is quick but it runs on every turn; cache per process
function which(name) {
  if (whichCache.has(name)) return whichCache.get(name);
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8', windowsHide: true });
  const hits = (r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (hits.length) whichCache.set(name, hits);
  return hits;
}

/** Async capture of a command's output: never blocks the hub (spawnSync froze every API call while it ran). */
export function runCapture(cmd, args, timeoutMs = 30000, opts = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let done = false;
    let c;
    try { c = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: opts.env || process.env, cwd: opts.cwd || undefined }); } catch (e) { resolve({ stdout: '', stderr: e.message, code: -1 }); return; }
    const t = setTimeout(() => { if (!done) { done = true; try { c.kill(); } catch {} resolve({ stdout, stderr: `${stderr}[timeout]`, code: -1 }); } }, timeoutMs);
    c.stdout.on('data', (d) => (stdout += d));
    c.stderr.on('data', (d) => (stderr += d));
    c.on('error', (e) => { if (!done) { done = true; clearTimeout(t); resolve({ stdout, stderr: e.message, code: -1 }); } });
    c.on('close', (code) => { if (!done) { done = true; clearTimeout(t); resolve({ stdout, stderr, code }); } });
  });
}

/** npm-installed CLIs: run `node <package>/bin/<file>` directly (no cmd.exe, no quoting problems). */
function npmBin(pkg, binRel, key) {
  const cfg = loadConfig();
  if (cfg[key] && fs.existsSync(cfg[key])) return { cmd: process.execPath, pre: [cfg[key]] };
  const root = (spawnSync('npm root -g', { encoding: 'utf8', shell: true, windowsHide: true }).stdout || '').trim();
  const js = path.join(root, pkg, binRel);
  if (root && fs.existsSync(js)) {
    saveConfig({ [key]: js });
    return { cmd: process.execPath, pre: [js] };
  }
  return null;
}

function exeBin(name) {
  const hit = which(name).find((p) => /\.exe$/i.test(p)) || (process.platform !== 'win32' ? which(name)[0] : null);
  return hit ? { cmd: hit, pre: [] } : null;
}

export function tmpPromptFile(text) {
  const f = path.join(os.tmpdir(), `cam-prompt-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.txt`);
  fs.writeFileSync(f, text);
  return f;
}

/** Shared failure classifier: limit | auth | model | fatal */
export function classify(text = '') {
  const s = String(text);
  if (/usage limit|rate.?limit|\b429\b|quota|hit your (5-hour|weekly|usage)? ?limit|limit reached|too many requests|credit balance/i.test(s)) return 'limit';
  if (/model[^.\n]{0,60}(not (found|supported|available|exist)|unknown|invalid|does not exist)|model_not_found|no model configured/i.test(s)) return 'model';
  if (/\b401\b|unauthori[sz]ed|not logged in|log ?in again|login required|invalid (refresh|bearer|api) ?token|authenticat(e|ion) (failed|error|required)|refresh tokens?|run .{0,30}(login|auth)/i.test(s)) return 'auth';
  return 'fatal';
}

// ───────────────────────────── Claude Code ─────────────────────────────
const claude = {
  id: 'claude',
  label: 'Claude Code',
  defaultModel: null, // whatever the account's default is
  resolve: () => ({ cmd: resolveClaude(), pre: [] }),
  args({ sessionId, model, permission }) {
    const a = ['-p', '--output-format', 'stream-json', '--verbose', '--strict-mcp-config'];
    if (sessionId) a.push('--resume', sessionId);
    if (model) a.push('--model', model);
    if (permission === 'read') a.push('--permission-mode', 'dontAsk', '--allowedTools', 'Read Grep Glob WebSearch WebFetch');
    else if (permission === 'edit') a.push('--permission-mode', 'acceptEdits');
    else if (permission === 'full') a.push('--permission-mode', 'bypassPermissions');
    return a;
  },
  stdin: (prompt) => prompt,
  // Run on whichever Claude account is active now; skip our own hooks inside helper turns.
  env: (env) => { delete env.CLAUDE_CONFIG_DIR; if (process.env.CAM_MAIN_CONFIG_DIR) env.CLAUDE_CONFIG_DIR = process.env.CAM_MAIN_CONFIG_DIR; env.CAM_INTERNAL = '1'; return env; },
  parse(j) {
    const out = [];
    if (j.type === 'system' && j.subtype === 'init') return [{ kind: 'session', id: j.session_id, model: j.model }];
    if (j.type === 'assistant') {
      for (const b of j.message?.content || []) {
        if (b.type === 'text' && b.text?.trim()) out.push({ kind: 'assistant', text: b.text });
        else if (b.type === 'tool_use') {
          const inp = b.input || {};
          const target = inp.file_path || inp.path || inp.command || inp.pattern || inp.url || inp.description || '';
          out.push({ kind: /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(b.name) ? 'file' : 'tool', name: b.name, text: short(target, 240) });
        }
      }
    } else if (j.type === 'user') {
      for (const b of j.message?.content || []) {
        if (b.type === 'tool_result' && b.is_error) out.push({ kind: 'tool_result', ok: false, text: short(typeof b.content === 'string' ? b.content : b.content?.map?.((c) => c.text).join(' '), 400) });
      }
    } else if (j.type === 'result') {
      const u = j.usage || {};
      out.push({ kind: 'usage', input: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0), cached: u.cache_read_input_tokens || 0, output: u.output_tokens || 0, cost: j.total_cost_usd });
      if (j.is_error) out.push({ kind: 'error', text: String(j.result || j.subtype || 'error') });
      else out.push({ kind: 'final', text: j.result || '' });
      if (j.session_id) out.push({ kind: 'session', id: j.session_id });
    }
    return out;
  },
  models: async () => ['opus', 'sonnet', 'haiku', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'].map((m) => ({ id: m, name: m })),
  acceptsAnyModel: true,
};

// ───────────────────────────── Codex ─────────────────────────────
const codex = {
  id: 'codex',
  label: 'Codex',
  defaultModel: 'gpt-6.1-sol',
  resolve: () => resolveCodex(),
  args({ sessionId, model, permission, cwd, effort }) {
    const sandbox = permission === 'full' ? 'danger-full-access' : permission === 'edit' ? 'workspace-write' : 'read-only';
    const o = ['--json', '--skip-git-repo-check', '-c', `sandbox_mode="${sandbox}"`];
    if (model) o.push('-m', model);
    if (effort) o.push('-c', `model_reasoning_effort="${effort}"`);
    return sessionId ? ['exec', 'resume', ...o, sessionId, '-'] : ['exec', ...o, '-C', cwd, '-'];
  },
  stdin: (prompt) => prompt,

  parse(j) {
    if (j.type === 'thread.started') return [{ kind: 'session', id: j.thread_id }];
    if (j.type === 'turn.completed') { const u = j.usage || {}; return [{ kind: 'usage', input: (u.input_tokens || 0) - (u.cached_input_tokens || 0), cached: u.cached_input_tokens || 0, output: (u.output_tokens || 0) + (u.reasoning_output_tokens || 0) }]; }
    if (j.type === 'turn.failed') return [{ kind: 'error', text: j.error?.message || 'turn failed' }];
    if (j.type === 'error') return [{ kind: 'error', text: j.message || j.error?.message || JSON.stringify(j).slice(0, 300) }];
    if (j.type !== 'item.completed' || !j.item) return [];
    const it = j.item;
    if (it.type === 'agent_message' && it.text) return [{ kind: 'assistant', text: it.text }];
    if (it.type === 'command_execution')
      return [{ kind: 'tool', name: 'shell', text: short(it.command, 240), ok: it.exit_code === 0, detail: it.exit_code !== 0 ? short(String(it.aggregated_output || '').split('\n').slice(-15).join('\n'), 1200) : undefined, exit: it.exit_code }];
    if (it.type === 'file_change') return (it.changes || []).map((c) => ({ kind: 'file', name: c.kind || 'edit', text: c.path }));
    if (it.type === 'mcp_tool_call') return [{ kind: 'tool', name: `${it.server}.${it.tool}`, text: '' }];
    if (it.type === 'web_search') return [{ kind: 'tool', name: 'web_search', text: short(it.query, 200) }];
    if (it.type === 'error') return [{ kind: 'error', text: it.message || 'error' }];
    return [];
  },
  async models() {
    const { cmd, pre } = resolveCodex();
    const r = await runCapture(cmd, [...pre, 'debug', 'models'], 40000);
    try {
      return JSON.parse(r.stdout).models.filter((m) => m.visibility !== 'hide').map((m) => ({ id: m.slug, name: m.display_name, note: m.description, efforts: (m.supported_reasoning_levels || []).map((x) => x.effort) }));
    } catch { return []; }
  },
};

// ───────────────────────────── Hermes Agent ─────────────────────────────
const hermes = {
  id: 'hermes',
  label: 'Hermes Agent',
  defaultModel: null,
  resolve: () => exeBin('hermes'),
  args({ sessionId, model, permission, cwd, promptFile }) {
    const a = ['chat', '--query-file', promptFile, '--format', 'stream-json', '-Q', '--in', cwd];
    if (sessionId) a.push('--resume', sessionId);
    if (model) a.push('-m', model);
    if (permission === 'full') a.push('--yolo');
    if (permission === 'read') a.push('--safe-mode');
    return a;
  },
  usesPromptFile: true,
  parse(j) {
    if (j.type === 'system' && j.subtype === 'init') return [{ kind: 'session', id: j.session_id, model: j.model }];
    if (j.type === 'text' && j.text) return [{ kind: 'delta', text: j.text }]; // streamed in pieces
    if (/tool/.test(j.type || '')) return [{ kind: /result/.test(j.type) ? 'tool_result' : 'tool', name: j.name || j.tool || j.tool_name || 'tool', text: short(j.args || j.input || j.arguments || j.output || '', 240), ok: j.error ? false : undefined }];
    if (j.type === 'error') return [{ kind: 'error', text: j.message || j.error || 'error' }];
    if (j.type === 'result') {
      const t = j.tokens || {};
      const ev = [{ kind: 'usage', input: t.input || 0, output: t.output || 0, cached: t.cache_read || 0 }];
      if (j.session_id) ev.push({ kind: 'session', id: j.session_id });
      if (j.exit_code && j.exit_code !== 0) ev.push({ kind: 'error', text: j.text || `exit ${j.exit_code}` });
      else ev.push({ kind: 'final', text: j.text || '' });
      return ev;
    }
    return [];
  },
  models: async () => [],
  acceptsAnyModel: true,
};

// ───────────────────────────── Kimi ─────────────────────────────
const kimi = {
  id: 'kimi',
  label: 'Kimi Code',
  defaultModel: null,
  resolve: () => exeBin('kimi'),
  args({ sessionId, model, permission, prompt }) {
    const a = ['--prompt', argText(prompt), '--output-format', 'stream-json'];
    if (sessionId) a.push('-S', sessionId);
    if (model) a.push('-m', model);
    if (permission === 'full') a.push('--yolo');
    if (permission === 'read') a.push('--plan'); // plan mode: research only, no changes
    return a;
  },
  parse(j) {
    const sid = j.session_id || j.sessionId || j.session?.id;
    const ev = [];
    if (sid) ev.push({ kind: 'session', id: sid });
    const role = j.role || '';
    const text = typeof j.content === 'string' ? j.content : Array.isArray(j.content) ? j.content.map((c) => c.text || '').join('') : j.text;
    if (role === 'assistant' && text?.trim()) ev.push({ kind: 'assistant', text });
    if (/tool/.test(`${j.type || ''}${role}`)) ev.push({ kind: 'tool', name: j.name || j.tool || 'tool', text: short(j.arguments || j.input || '', 200) });
    if (/error/.test(j.type || '')) ev.push({ kind: 'error', text: j.message || j.error || 'error' });
    if (j.usage) ev.push({ kind: 'usage', input: j.usage.input_tokens || j.usage.prompt_tokens || 0, output: j.usage.output_tokens || j.usage.completion_tokens || 0, cached: 0 });
    return ev;
  },
  models: async () => [],
  acceptsAnyModel: true,
};

// ───────────────────────────── OpenCode ─────────────────────────────
const opencode = {
  id: 'opencode',
  label: 'OpenCode',
  defaultModel: null,
  resolve: () => npmBin('opencode-ai', path.join('bin', 'opencode'), 'opencodeJs') || exeBin('opencode'),
  // Measured: on provider errors (e.g. "Free usage limit reached") OpenCode logs ERROR to its log stream,
  // emits nothing on stdout and retries forever. We enable error logs on stderr and fail fast on them.
  stderrFatal: /ERROR [^\n]*?error=(?!\{"error":\{"name":"AI_RetryError)([^\n]{0,400})/,
  args({ sessionId, model, cwd, prompt }) {
    const a = ['run', '--format', 'json', '--print-logs', '--log-level', 'ERROR', '--dir', cwd];
    if (sessionId) a.push('-s', sessionId);
    if (model) a.push('-m', model);
    a.push(argText(prompt));
    return a;
  },
  // OpenCode reads its permission config from OPENCODE_PERMISSION. Read-only agents may not edit files or
  // run shell commands; "deny" fails closed even though a headless run has nobody to answer prompts.
  env(env, a) {
    if (a.permission === 'read') env.OPENCODE_PERMISSION = JSON.stringify({ edit: 'deny', bash: 'deny' });
    return env;
  },
  parse(j) {
    const ev = [];
    if (j.sessionID) ev.push({ kind: 'session', id: j.sessionID });
    const p = j.part || {};
    if (j.type === 'text' && p.text?.trim()) ev.push({ kind: 'assistant', text: p.text });
    else if (j.type === 'tool_use') {
      const st = p.state || {};
      const inp = st.input || {};
      ev.push({ kind: /edit|write|patch/i.test(p.tool || '') ? 'file' : 'tool', name: p.tool || 'tool', text: short(inp.filePath || inp.path || inp.command || inp.pattern || '', 240), ok: st.status !== 'error' });
    } else if (j.type === 'step_finish' && p.tokens) ev.push({ kind: 'usage', input: p.tokens.input || 0, output: (p.tokens.output || 0) + (p.tokens.reasoning || 0), cached: p.tokens.cache?.read || 0 });
    else if (j.type === 'error') ev.push({ kind: 'error', text: j.error?.data?.message || j.error?.message || j.error?.name || 'error' });
    return ev;
  },
  async models() {
    const b = opencode.resolve();
    if (!b) return [];
    const r = await runCapture(b.cmd, [...b.pre, 'models'], 90000);
    return (r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter((s) => /^[\w.-]+\/[\w.:@-]+$/.test(s)).map((id) => ({ id, name: id, note: /-free$/.test(id) ? 'free' : '' }));
  },
};

// ───────────────────────────── Antigravity CLI (agy) ─────────────────────────────
const agy = {
  id: 'agy',
  label: 'Antigravity CLI',
  defaultModel: null,
  resolve: () => exeBin('agy'),
  // Measured on this machine: `agy --print` produces no output and never exits unless attached to a real
  // terminal (console). Until a PTY bridge exists, the hub refuses it with a clear message instead of hanging.
  unsupported: 'agy only prints in a real terminal window (its --print mode hangs when run in the background). Open it from the dashboard with "Open in terminal" instead.',
  args({ sessionId, model, prompt }) {
    const a = ['--print', argText(prompt)];
    if (sessionId) a.push('--conversation', sessionId);
    if (model) a.push('--model', model);
    return a;
  },
  parse: () => [],
  async models() {
    const b = exeBin('agy');
    if (!b) return [];
    const r = await runCapture(b.cmd, ['models'], 60000);
    return (r.stdout || '').split(/\r?\n/).map((l) => l.split('\t')).filter((p) => p.length >= 2 && p[0].trim()).map(([id, name]) => ({ id: id.trim(), name: name.trim() }));
  },
};

export const ADAPTERS = { claude, codex, hermes, kimi, opencode, agy };
export const PLATFORMS = Object.keys(ADAPTERS);

export function adapter(platform) {
  const a = ADAPTERS[platform];
  if (!a) throw new Error(`Unknown platform "${platform}". Available: ${PLATFORMS.join(', ')}`);
  return a;
}

/** Installed? version? (cached by the caller) */
export async function probePlatform(platform) {
  const a = adapter(platform);
  const bin = a.resolve();
  if (!bin) return { platform, label: a.label, installed: false };
  const r = await runCapture(bin.cmd, [...bin.pre, '--version'], 20000);
  const version = ((r.stdout || '') + (r.stderr || '')).split(/\r?\n/).find((l) => /\d+\.\d+/.test(l))?.trim() || 'unknown';
  return { platform, label: a.label, installed: true, version: version.slice(0, 80), unsupported: a.unsupported || null, defaultModel: a.defaultModel };
}
