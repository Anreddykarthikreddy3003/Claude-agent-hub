/** One-command setup/teardown: background task, status line, `cam` shortcut, Claude Code plugin. */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { FILES, DATA, ROOT, BIN, HOME, MAIN_SETTINGS, MAIN_CREDS } from './paths.mjs';
import { readJson, writeJsonAtomic, pidAlive } from './util.mjs';
import { loadConfig, saveConfig, loadAccounts, loadState, backup } from './store.mjs';
import { resolveClaude } from './claude.mjs';

export const TASK_NAME = 'ClaudeAgentHub';
export const MARKETPLACE = 'claude-agent-hub';
export const PLUGIN_ID = `claude-agent-hub@${MARKETPLACE}`;

const fwd = (p) => p.replace(/\\/g, '/');

function ps(script) {
  return spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });
}

function statusLineCommand() {
  return `"${fwd(process.execPath)}" "${fwd(BIN)}" statusline`;
}

function installTask() {
  const vbs = [
    'Set sh = CreateObject("WScript.Shell")',
    `sh.Run """${process.execPath}"" ""${BIN}"" daemon", 0, False`,
  ].join('\r\n');
  fs.writeFileSync(FILES.launcher, vbs);
  const r = ps(
    [
      `$a = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument '"${FILES.launcher}"'`,
      `$t = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)`,
      `$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 5)`,
      `Register-ScheduledTask -TaskName '${TASK_NAME}' -Action $a -Trigger $t -Settings $s -Description 'Claude Agent Hub background service (starts it if not running)' -Force | Out-Null`,
      `'ok'`,
    ].join('; '),
  );
  return { ok: /ok/.test(r.stdout || ''), detail: (r.stderr || '').trim().split('\n')[0] };
}

function taskExists() {
  const r = ps(`if (Get-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue) { 'yes' } else { 'no' }`);
  return /yes/.test(r.stdout || '');
}

function installStatusLine() {
  const s = readJson(MAIN_SETTINGS, {}) || {};
  const cmd = statusLineCommand();
  if (s.statusLine && !String(s.statusLine.command || '').includes('cam.mjs'))
    return { ok: false, detail: 'you already have a custom status line; left unchanged' };
  backup(MAIN_SETTINGS, 'settings', 5);
  s.statusLine = { type: 'command', command: cmd, padding: 0 };
  writeJsonAtomic(MAIN_SETTINGS, s);
  return { ok: true };
}

function installShims() {
  const bin = path.join(HOME, '.local', 'bin');
  if (!fs.existsSync(bin)) return { ok: false, detail: `${bin} not found` };
  fs.writeFileSync(path.join(bin, 'cam.cmd'), `@"${process.execPath}" "${BIN}" %*\r\n`);
  fs.writeFileSync(path.join(bin, 'cam'), `#!/bin/sh\nexec "${fwd(process.execPath)}" "${fwd(BIN)}" "$@"\n`);
  return { ok: true, detail: bin };
}

function installPlugin() {
  const claude = resolveClaude();
  const env = { ...process.env, CAM_INTERNAL: '1' };
  const run = (args) => spawnSync(claude, args, { encoding: 'utf8', windowsHide: true, env, timeout: 120000 });
  const m = run(['plugin', 'marketplace', 'add', ROOT]);
  const mOut = `${m.stdout}${m.stderr}`;
  const i = run(['plugin', 'install', PLUGIN_ID]);
  const iOut = `${i.stdout}${i.stderr}`;
  const ok = i.status === 0 || /already|installed/i.test(iOut);
  return { ok, detail: ok ? '' : (iOut || mOut).trim().split('\n').slice(-3).join(' ') };
}

/** Status bar extension for Antigravity / VS Code (the Claude Code panel doesn't show status lines). */
function installStatusBar() {
  const b = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build-vsix.mjs')], { encoding: 'utf8', windowsHide: true });
  const vsix = (b.stdout || '').trim().split(/\r?\n/).pop();
  if (b.status !== 0 || !vsix) return { ok: false, detail: `could not build the .vsix: ${b.stderr}` };
  const local = process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local');
  const editors = [
    path.join(local, 'Programs', 'Antigravity IDE', 'bin', 'antigravity-ide.cmd'),
    path.join(local, 'Programs', 'Antigravity', 'bin', 'antigravity.cmd'),
    path.join(local, 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd'),
  ].filter((p) => fs.existsSync(p));
  const done = [];
  for (const cli of editors) {
    const r = spawnSync(`"${cli}"`, ['--install-extension', `"${vsix}"`, '--force'], { shell: true, encoding: 'utf8', windowsHide: true, timeout: 120000 });
    if (r.status === 0) done.push(path.basename(cli, '.cmd'));
  }
  return done.length
    ? { ok: true, detail: `installed in ${done.join(', ')}` }
    : { ok: false, detail: `install it manually: Extensions → … → Install from VSIX → ${vsix}` };
}

function startDaemon() {
  spawn(process.execPath, [BIN, 'daemon'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

export function install() {
  const lines = [];
  const mark = (ok, label, detail) => lines.push(`${ok ? '✅' : '⚠ '} ${label}${detail ? ` — ${detail}` : ''}`);
  fs.mkdirSync(FILES.backups, { recursive: true });
  fs.mkdirSync(FILES.primeCwd, { recursive: true });
  const claudePath = resolveClaude();
  saveConfig({ ...readJson(FILES.config, {}), claudePath: claudePath !== 'claude' ? claudePath : null });
  mark(true, `Data folder ${DATA}`);
  mark(claudePath !== 'claude', `Claude CLI ${claudePath}`);

  const t = installTask();
  mark(t.ok, 'Background service (Windows scheduled task, checks every 5 min, runs on battery too)', t.detail);
  const sl = installStatusLine();
  mark(sl.ok, 'Status line in Claude Code', sl.detail);
  const sh = installShims();
  mark(sh.ok, '`cam` command available in terminals', sh.detail);
  const pl = installPlugin();
  mark(pl.ok, `Claude Code plugin (${PLUGIN_ID}): hooks, /accounts /switch-account /week /ready, MCP tools`, pl.detail);
  const sb = installStatusBar();
  mark(sb.ok, 'Status bar in Antigravity / VS Code (bottom-left)', sb.detail);
  startDaemon();
  mark(true, 'Background service started');

  lines.push('');
  if (!loadAccounts().length) {
    lines.push('Next steps:');
    lines.push('  1. cam accounts import A        (saves the login Claude Code is using now as "A")');
    lines.push('  2. cam accounts add B           (opens a login window, sign in to your 2nd account)');
    lines.push('     cam accounts add C ...       (repeat for every other account)');
    lines.push('  3. Restart Claude Code / reload the Antigravity window so the plugin loads.');
    lines.push('  Optional: cam ready on          (24/7 session priming; off by default, read the README first)');
  } else lines.push('Restart Claude Code / reload the Antigravity window so the plugin loads.');
  return lines.join('\n');
}

export function uninstall({ purge = false } = {}) {
  const lines = [];
  ps(`Unregister-ScheduledTask -TaskName '${TASK_NAME}' -Confirm:$false -ErrorAction SilentlyContinue`);
  lines.push('Removed scheduled task');
  const info = readJson(FILES.pid, null);
  if (info?.pid && pidAlive(info.pid)) { try { process.kill(info.pid); } catch {} }
  lines.push('Stopped background service');
  const s = readJson(MAIN_SETTINGS, null);
  if (s?.statusLine && String(s.statusLine.command || '').includes('cam.mjs')) {
    backup(MAIN_SETTINGS, 'settings', 5);
    delete s.statusLine;
    writeJsonAtomic(MAIN_SETTINGS, s);
    lines.push('Removed status line');
  }
  for (const f of ['cam.cmd', 'cam']) { try { fs.unlinkSync(path.join(HOME, '.local', 'bin', f)); } catch {} }
  const claude = resolveClaude();
  spawnSync(claude, ['plugin', 'uninstall', PLUGIN_ID], { windowsHide: true, timeout: 60000, env: { ...process.env, CAM_INTERNAL: '1' } });
  spawnSync(claude, ['plugin', 'marketplace', 'remove', MARKETPLACE], { windowsHide: true, timeout: 60000, env: { ...process.env, CAM_INTERNAL: '1' } });
  lines.push('Uninstalled plugin');
  if (purge) {
    fs.rmSync(DATA, { recursive: true, force: true });
    lines.push(`Deleted ${DATA} (all saved logins)`);
  } else lines.push(`Kept ${DATA} (saved logins). Use --purge to delete.`);
  lines.push('Claude Code keeps whichever account is logged in right now.');
  return lines.join('\n');
}

export function keepAwake(on) {
  const cmds = on
    ? ['powercfg /change standby-timeout-ac 0', 'powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0', 'powercfg /setactive SCHEME_CURRENT']
    : ['powercfg /change standby-timeout-ac 30', 'powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 1', 'powercfg /setactive SCHEME_CURRENT'];
  const r = ps(cmds.join('; '));
  return r.status === 0
    ? on
      ? 'Laptop will not sleep while plugged in, and closing the lid (plugged in) does nothing.'
      : 'Restored: sleep after 30 min on power, closing the lid sleeps.'
    : `powercfg failed: ${r.stderr}`;
}

export async function doctor() {
  const out = [];
  const ok = (c, label, extra = '') => out.push(`${c ? '✅' : '❌'} ${label}${extra ? ` — ${extra}` : ''}`);
  ok(Number(process.versions.node.split('.')[0]) >= 20, `Node ${process.versions.node}`);
  const claude = resolveClaude();
  ok(claude !== 'claude' || process.platform !== 'win32', `Claude CLI`, claude);
  ok(!!readJson(MAIN_CREDS, null)?.claudeAiOauth, 'Claude Code is logged in');
  const accounts = loadAccounts();
  ok(accounts.length > 0, `Accounts saved: ${accounts.length}`, accounts.map((a) => `${a.name}${a.paused ? ' (paused)' : ''}`).join(', '));
  for (const a of accounts) {
    const c = readJson(path.join(DATA, 'slots', a.name, '.credentials.json'), null)?.claudeAiOauth;
    ok(!!c, `  slot ${a.name} has a saved login`, c?.refreshTokenExpiresAt ? `login valid until ${new Date(c.refreshTokenExpiresAt).toDateString()}` : '');
  }
  const st = loadState();
  const age = Date.now() - (st.daemon?.lastTick || 0);
  ok(age < 3 * 60e3, 'Background service running', st.daemon?.lastTick ? `last check ${Math.round(age / 1000)}s ago` : 'never ran');
  if (process.platform === 'win32') ok(taskExists(), `Scheduled task ${TASK_NAME}`);
  const s = readJson(MAIN_SETTINGS, {}) || {};
  ok(String(s.statusLine?.command || '').includes('cam.mjs'), 'Status line configured');
  ok(!!s.enabledPlugins?.[PLUGIN_ID], `Plugin ${PLUGIN_ID} enabled`);
  out.push(`ℹ  24/7 priming — ${loadConfig().ready ? 'on' : 'off (opt in with: cam ready on)'}`);
  return out.join('\n');
}
