/**
 * Bridge to OpenAI Codex CLI (`codex exec`), so the Claude "master" can run Codex as a participant:
 * start a thread, continue it, and read back what Codex said, ran and changed.
 * Prompts go through stdin (no shell quoting problems); every exchange is logged to <project>/.duo/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { loadConfig, saveConfig } from './store.mjs';

const SANDBOXES = ['read-only', 'workspace-write', 'danger-full-access'];

/** Find Codex: prefer `node <npm-global>/@openai/codex/bin/codex.js` on Windows (no cmd.exe quoting). */
export function resolveCodex() {
  const cfg = loadConfig();
  if (cfg.codexJs && fs.existsSync(cfg.codexJs)) return { cmd: process.execPath, pre: [cfg.codexJs] };
  if (process.platform === 'win32') {
    const r = spawnSync('npm root -g', { encoding: 'utf8', shell: true, windowsHide: true, timeout: 30000 });
    const js = path.join((r.stdout || '').trim(), '@openai', 'codex', 'bin', 'codex.js');
    if (fs.existsSync(js)) {
      saveConfig({ codexJs: js });
      return { cmd: process.execPath, pre: [js] };
    }
  }
  return { cmd: 'codex', pre: [] };
}

function summarise(events) {
  const out = { threadId: null, messages: [], commands: [], files: [], errors: [], usage: null };
  for (const e of events) {
    if (e.type === 'thread.started') out.threadId = e.thread_id;
    if (e.type === 'turn.completed') out.usage = e.usage || null;
    if (e.type === 'turn.failed' || e.type === 'error') out.errors.push(e.error?.message || e.message || JSON.stringify(e).slice(0, 300));
    if (e.type !== 'item.completed' || !e.item) continue;
    const it = e.item;
    if (it.type === 'agent_message' && it.text) out.messages.push(it.text);
    else if (it.type === 'command_execution')
      out.commands.push({ command: it.command, exit: it.exit_code, output: String(it.aggregated_output || '').slice(-1500) });
    else if (it.type === 'file_change') for (const c of it.changes || []) out.files.push(`${c.kind || 'edit'} ${c.path}`);
    else if (it.type === 'error') out.errors.push(it.message || JSON.stringify(it).slice(0, 300));
  }
  return out;
}

/**
 * Run one Codex turn. threadId = continue that conversation; otherwise start a new one.
 * sandbox: read-only (discuss/review) | workspace-write (may edit + run commands in cwd) | danger-full-access
 */
export function runCodex({ prompt, threadId = null, sandbox = 'read-only', cwd = process.cwd(), model = null, effort = null, timeoutMs = 30 * 60e3 }) {
  if (!prompt) throw new Error('prompt is required');
  if (!SANDBOXES.includes(sandbox)) throw new Error(`sandbox must be one of ${SANDBOXES.join(', ')}`);
  if (!fs.existsSync(cwd)) throw new Error(`Folder not found: ${cwd}`);
  const { cmd, pre } = resolveCodex();
  // `exec resume` has no -s flag; the config override works for both new and resumed threads.
  const opts = ['--json', '--skip-git-repo-check', '-c', `sandbox_mode="${sandbox}"`];
  if (model) opts.push('-m', model);
  if (effort) opts.push('-c', `model_reasoning_effort="${effort}"`);
  const args = threadId
    ? [...pre, 'exec', 'resume', ...opts, threadId, '-']
    : [...pre, 'exec', ...opts, '-C', cwd, '-'];
  const started = Date.now();

  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env } });
    let buf = '';
    let err = '';
    const events = [];
    const timer = setTimeout(() => { try { child.kill(); } catch {} err += '\n[timed out]'; }, timeoutMs);
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try { events.push(JSON.parse(line)); } catch {}
      }
    });
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => { clearTimeout(timer); resolve({ ...summarise(events), threadId, errors: [e.message], durationMs: Date.now() - started }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const s = summarise(events);
      if (!s.threadId) s.threadId = threadId;
      if (code !== 0 && !s.messages.length) s.errors.push(err.trim().split('\n').slice(-5).join('\n') || `codex exited with ${code}`);
      resolve({ ...s, sandbox, cwd, durationMs: Date.now() - started });
    });
    child.stdin.end(prompt);
  });
}

/** Append the exchange to <cwd>/.duo/<date>-<thread>.md so you can read the whole conversation later. */
export function logExchange(r, prompt, label = 'Codex') {
  try {
    const dir = path.join(r.cwd || process.cwd(), '.duo');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${new Date().toISOString().slice(0, 10)}-${(r.threadId || 'thread').slice(0, 13)}.md`);
    const t = new Date().toLocaleTimeString('en-GB');
    const lines = [`\n## ${t} · Master → ${label}\n`, prompt.trim(), `\n## ${t} · ${label} (${Math.round(r.durationMs / 1000)}s, sandbox ${r.sandbox})\n`];
    if (r.commands.length) lines.push('**Ran:**', ...r.commands.map((c) => `- \`${c.command}\` → exit ${c.exit}`), '');
    if (r.files.length) lines.push('**Changed:**', ...r.files.map((f) => `- ${f}`), '');
    lines.push(r.messages.join('\n\n') || `_(no reply)_ ${r.errors.join('; ')}`);
    fs.appendFileSync(file, lines.join('\n') + '\n');
    return file;
  } catch {
    return null;
  }
}

/** Text the master reads back. */
export function formatResult(r, logFile) {
  const parts = [];
  parts.push(`Codex thread: ${r.threadId || '(none)'}  ← pass to codex_continue to keep this conversation`);
  parts.push(`Sandbox: ${r.sandbox} · ${Math.round(r.durationMs / 1000)}s${r.usage ? ` · tokens in ${r.usage.input_tokens} / out ${r.usage.output_tokens}` : ''}`);
  if (r.commands.length) {
    parts.push(`\nCommands Codex ran (${r.commands.length}):`);
    for (const c of r.commands.slice(-12)) parts.push(`  • ${c.command}  → exit ${c.exit}`);
    const failed = r.commands.filter((c) => c.exit && c.exit !== 0).slice(-2);
    for (const c of failed) parts.push(`    output of failing "${c.command}":\n${c.output.split('\n').slice(-25).map((l) => '      ' + l).join('\n')}`);
  }
  if (r.files.length) parts.push(`\nFiles Codex changed:\n${r.files.map((f) => '  • ' + f).join('\n')}`);
  if (r.errors.length) parts.push(`\nErrors: ${r.errors.join(' | ')}`);
  parts.push('\n--- Codex says ---\n' + (r.messages.join('\n\n') || '(no message)'));
  if (logFile) parts.push(`\n(Transcript: ${logFile})`);
  return parts.join('\n');
}
