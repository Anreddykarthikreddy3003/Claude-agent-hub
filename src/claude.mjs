/** Runs the real Claude Code CLI (so Claude Code itself owns token refresh). */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FILES } from './paths.mjs';
import { loadConfig } from './store.mjs';

/** Folders where editors keep extensions; the Claude Code extension bundles a full claude.exe in each. */
const EDITOR_EXT_DIRS = ['.vscode', '.vscode-insiders', '.antigravity', '.antigravity-ide', '.cursor', '.windsurf', '.vscodium'];

const verKey = (dir) => (dir.match(/(\d+)\.(\d+)\.(\d+)/) || [0, 0, 0, 0]).slice(1).map((x) => String(x).padStart(6, '0')).join('.');

/** The newest claude.exe bundled with the Claude Code extension in any editor, or null. */
export function bundledClaude() {
  const home = os.homedir();
  const hits = [];
  for (const d of EDITOR_EXT_DIRS) {
    const ext = path.join(home, d, 'extensions');
    let names = [];
    try { names = fs.readdirSync(ext).filter((x) => /^anthropic\.claude-code-/i.test(x)); } catch { continue; }
    for (const x of names) {
      const exe = path.join(ext, x, 'resources', 'native-binary', process.platform === 'win32' ? 'claude.exe' : 'claude');
      if (fs.existsSync(exe)) hits.push({ exe, key: verKey(x) });
    }
  }
  hits.sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
  return hits[0]?.exe || null;
}

let cached = null;
/**
 * Where the Claude Code CLI is, in order: the saved path, PATH (a real .exe), the standalone installer's
 * location, then the copy bundled with the Claude Code extension. Re-checked every minute, so installing or
 * updating Claude Code is picked up without restarting the service.
 */
export function resolveClaude() {
  if (cached && Date.now() - cached.at < 60e3 && (cached.path === 'claude' || fs.existsSync(cached.path))) return cached.path;
  const found = findClaude();
  cached = { path: found.path, source: found.source, at: Date.now() };
  return found.path;
}

/** Same search as resolveClaude(), plus where the CLI was found (for cam doctor and the dashboard). */
export function findClaude() {
  const cfg = loadConfig();
  if (cfg.claudePath && fs.existsSync(cfg.claudePath)) return { path: cfg.claudePath, source: 'saved path' };
  if (process.platform === 'win32') {
    const r = spawnSync('where', ['claude'], { encoding: 'utf8', windowsHide: true });
    const hit = (r.stdout || '').split(/\r?\n/).map((s) => s.trim()).find((s) => /\.exe$/i.test(s));
    if (hit) return { path: hit, source: 'PATH' };
    const local = path.join(os.homedir(), '.local', 'bin', 'claude.exe');
    if (fs.existsSync(local)) return { path: local, source: 'standalone install' };
  }
  const b = bundledClaude();
  if (b) return { path: b, source: 'Claude Code extension' };
  return { path: 'claude', source: 'not found' };
}

/**
 * configDir = null  -> the main Claude Code config (active account)
 * configDir = path  -> an account slot
 */
function envFor(configDir) {
  const env = { ...process.env, CAM_INTERNAL: '1' };
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
  else if (process.env.CAM_MAIN_CONFIG_DIR) env.CLAUDE_CONFIG_DIR = process.env.CAM_MAIN_CONFIG_DIR;
  else delete env.CLAUDE_CONFIG_DIR;
  return env;
}

function run(args, configDir, timeoutMs) {
  return new Promise((resolve) => {
    fs.mkdirSync(FILES.primeCwd, { recursive: true });
    let out = '';
    let err = '';
    let done = false;
    const child = spawn(resolveClaude(), args, {
      cwd: FILES.primeCwd,
      env: envFor(configDir),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      if (!done) {
        try { child.kill(); } catch {}
        resolve({ code: -1, out, err: err + '\n[timeout]' });
        done = true;
      }
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      if (!done) { done = true; clearTimeout(timer); resolve({ code: -1, out, err: String(e.message) }); }
    });
    child.on('close', (code) => {
      if (!done) { done = true; clearTimeout(timer); resolve({ code, out, err }); }
    });
  });
}

/**
 * Renewing a sign-in without sending a message. `claude auth status` reports "logged in" but no longer renews an
 * expired token (measured with Claude Code 2.1.88), while every start of `claude -p` does. A slash command that
 * doesn't exist is answered locally ("Unknown skill"): measured 0 output tokens, cost 0, no model call, so no
 * 5-hour window starts. Slash commands must stay ENABLED here (no --disable-slash-commands), or the text would
 * reach the model as a prompt.
 */
export const RENEW_ARGS = [
  '-p', '/agent-hub-renew-sign-in',
  '--output-format', 'json',
  '--model', 'haiku',
  '--tools', '',
  '--strict-mcp-config',
  '--setting-sources', '',
  '--no-session-persistence',
];

/** Lets Claude Code renew an expired sign-in for this config dir (null = Claude Code's own login). */
export async function cliRenew(configDir) {
  const r = await run(RENEW_ARGS, configDir, 60000);
  let j = null;
  try { j = JSON.parse(r.out); } catch {}
  const usedModel = !!j && ((j.total_cost_usd || 0) > 0 || (j.usage?.output_tokens || 0) > 0);
  return { ok: !!j, usedModel, text: String(j?.result || r.err || r.out || '').slice(0, 200) };
}

/** Sends the minimal "hi" that starts a 5-hour window. ~6k cached tokens on Haiku. */
export async function cliPrime(configDir) {
  const cfg = loadConfig();
  const r = await run(
    [
      '-p', cfg.primeMessage || 'hi',
      '--model', cfg.primeModel || 'haiku',
      '--tools', '',
      '--strict-mcp-config',
      '--setting-sources', '',
      '--disable-slash-commands',
      '--no-session-persistence',
      // Measured: Claude Code's default system prompt adds ~5.9k tokens written to a 1-hour cache (2x price)
      // to every "hi". A one-line system prompt starts the 5-hour window just the same: ~240 tokens, ~12x cheaper.
      '--system-prompt', 'Reply with one word.',
      '--output-format', 'json',
    ],
    configDir,
    150000,
  );
  let j = null;
  try { j = JSON.parse(r.out); } catch {}
  const ok = !!j && !j.is_error;
  const text = j?.result || r.err || r.out || '';
  return { ok, text: String(text).slice(0, 300), limited: /limit|exceeded|reset/i.test(String(text)) && !ok };
}
