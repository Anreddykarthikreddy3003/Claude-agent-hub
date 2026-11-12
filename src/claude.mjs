/** Runs the real Claude Code CLI (so Claude Code itself owns token refresh). */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { FILES } from './paths.mjs';
import { loadConfig } from './store.mjs';

export function resolveClaude() {
  const cfg = loadConfig();
  if (cfg.claudePath && fs.existsSync(cfg.claudePath)) return cfg.claudePath;
  if (process.platform === 'win32') {
    const r = spawnSync('where', ['claude'], { encoding: 'utf8', windowsHide: true });
    const hit = (r.stdout || '').split(/\r?\n/).map((s) => s.trim()).find((s) => /\.exe$/i.test(s));
    if (hit) return hit;
  }
  return 'claude';
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

/** Lets Claude Code refresh an expired access token (no message is sent). */
export async function cliAuthStatus(configDir) {
  const r = await run(['auth', 'status', '--json'], configDir, 45000);
  try { return JSON.parse(r.out); } catch { return null; }
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
