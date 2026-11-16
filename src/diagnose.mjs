/**
 * `cam diagnose`: one report with everything needed to debug a setup remotely. Emails are shortened and no
 * token, password or proxy credential is ever printed. The report is also saved to ~/.claude-accounts/diagnose.txt.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dns from 'node:dns/promises';
import { spawnSync } from 'node:child_process';
import { FILES, DATA, ROOT } from './paths.mjs';
import { readJson, pidAlive } from './util.mjs';
import { loadAccounts, loadConfig, loadState } from './store.mjs';
import { findClaude, bundledClaude } from './claude.mjs';
import { net, networkError } from './api.mjs';
import { doctor } from './install.mjs';

const mask = (s) => String(s ?? '').replace(/([A-Za-z0-9._%+-]{1,2})[A-Za-z0-9._%+-]*@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g, '$1…@$2'); // emails only (needs a dotted domain)
const ago = (t) => (t ? `${Math.round((Date.now() - t) / 60e3)} min ago` : 'never');

function ps(script, timeout = 30000) {
  if (process.platform !== 'win32') return '(not Windows)';
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout });
  return ((r.stdout || '') + (r.stderr ? `\n${r.stderr}` : '')).trim() || '(no output)';
}

async function attemptMany(label, fn, tries = 5) {
  let ok = 0;
  const errs = {};
  const ms = [];
  for (let i = 0; i < tries; i++) {
    const t = Date.now();
    try { await fn(); ok++; ms.push(Date.now() - t); } catch (e) { const c = e?.cause?.code || e?.code || e?.name || 'error'; errs[c] = (errs[c] || 0) + 1; }
  }
  const avg = ms.length ? ` · ~${Math.round(ms.reduce((a, b) => a + b, 0) / ms.length)} ms` : '';
  const why = Object.keys(errs).length ? ` · failures: ${Object.entries(errs).map(([c, n]) => `${c}×${n}`).join(', ')}` : '';
  return `${label.padEnd(26)} ${ok}/${tries} ok${avg}${why}`;
}

export async function diagnose() {
  const out = [];
  const sec = (t) => out.push('', `## ${t}`);
  const URL_ = 'https://api.anthropic.com/api/oauth/usage';
  const H = { 'User-Agent': 'claude-agent-hub/1.0' };

  out.push('# Agent Hub diagnose', `generated ${new Date().toISOString()}`);

  sec('Versions');
  const pkg = readJson(path.join(ROOT, 'package.json'), {});
  out.push(`Agent Hub ${pkg.version} · ${ROOT}`);
  out.push(`Windows/OS ${os.version?.() || os.type()} ${os.release()} · ${os.arch()}`);
  out.push(`Node ${process.version} · OpenSSL ${process.versions.openssl} · ${process.execPath}`);
  const fc = findClaude();
  const cv = fc.path !== 'claude' ? spawnSync(fc.path, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 20000 }) : null;
  out.push(`Claude CLI ${fc.path} (${fc.source}) · ${cv ? (cv.stdout || cv.stderr || '').trim().split('\n')[0] : 'not runnable'}`);
  out.push(`Bundled with the editor extension: ${bundledClaude() || 'none'}`);

  sec('cam doctor');
  try { out.push(mask(await doctor())); } catch (e) { out.push(`doctor failed: ${e.message}`); }

  sec('Accounts and state');
  const st = loadState();
  const cfg = loadConfig();
  out.push(`active: ${st.active ?? '(none)'} · frozen: ${st.frozen?.name ?? '-'} · forced: ${st.forced?.name ?? '-'}`);
  out.push(`Claude Code's login: ${st.mainOwner ? `${mask(st.mainOwner.email)} · verified: ${!!st.mainOwner.trusted} (${st.mainOwner.source}) · checked ${ago(st.mainOwner.checkedAt)}` : 'not signed in'}`);
  out.push(`settings: monitoring ${cfg.monitoring !== false} · autoSwitch ${cfg.autoSwitch !== false} · priming ${!!cfg.ready && cfg.primeAll !== false}`);
  for (const a of loadAccounts()) {
    const u = st.usage?.[a.name] || {};
    out.push(`- ${a.name} ${mask(a.email)}${a.paused ? ' (paused)' : ''} · 5h ${u.five?.util ?? '?'}% · wk ${u.week?.util ?? '?'}% · fetched ${ago(u.fetchedAt)} · tried ${ago(u.attemptAt)}${u.error ? ` · ERROR ${mask(u.error)}` : ''}${u.backoffUntil > Date.now() ? ' · backing off' : ''}`);
  }
  const pid = readJson(FILES.pid, null);
  out.push(`service pid ${pid?.pid ?? '-'} alive: ${pid?.pid ? pidAlive(pid.pid) : false} · last tick ${ago(st.daemon?.lastTick)}`);

  sec('Network: DNS');
  try {
    const all = await dns.lookup('api.anthropic.com', { all: true });
    out.push(all.map((x) => `IPv${x.family} ${x.address}`).join(' · '));
  } catch (e) { out.push(`lookup failed: ${e.code || e.message}`); }

  sec('Network: connection tests (5 tries each, fresh connection every time)');
  out.push(await attemptMany('Node fetch', async () => { const r = await fetch(URL_, { headers: H, signal: AbortSignal.timeout(8000) }); await r.arrayBuffer(); }));
  for (const [label, fam, small] of [['IPv4, normal handshake', 4, false], ['IPv6, normal handshake', 6, false], ['IPv4, small handshake', 4, true], ['IPv6, small handshake', 6, true], ['any, normal handshake', 0, false]]) {
    out.push(await attemptMany(label, () => net.httpsGet(URL_, H, 8000, fam, { small })));
  }
  out.push('(an HTTP answer such as 401 counts as ok: the connection worked)');

  sec('Windows network and security');
  out.push(ps("Get-NetAdapter | Where-Object Status -eq 'Up' | Format-Table -AutoSize Name, InterfaceDescription, LinkSpeed, DriverVersion | Out-String -Width 200"));
  out.push(ps("Get-NetIPInterface -ConnectionState Connected | Where-Object InterfaceAlias -notlike 'Loopback*' | Format-Table -AutoSize InterfaceAlias, AddressFamily, NlMtu | Out-String -Width 200"));
  out.push(ps("try { $p = Get-MpPreference; $s = Get-MpComputerStatus; 'Defender: real-time ' + $s.RealTimeProtectionEnabled + ' | network protection ' + $p.EnableNetworkProtection + ' (0 off, 1 block, 2 audit) | network inspection ' + (-not $p.DisableNetworkProtectionPerfTelemetry) } catch { 'Defender status unavailable: ' + $_.Exception.Message }"));
  out.push(ps("Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct | ForEach-Object { 'Antivirus: ' + $_.displayName }; Get-CimInstance -Namespace root/SecurityCenter2 -ClassName FirewallProduct -ErrorAction SilentlyContinue | ForEach-Object { 'Firewall product: ' + $_.displayName }"));
  out.push(ps("Get-NetFirewallProfile | ForEach-Object { 'Firewall ' + $_.Name + ': ' + $_.Enabled }"));
  out.push(ps("netsh winhttp show proxy"));
  out.push(ps("$i = Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'; 'System proxy enabled: ' + $i.ProxyEnable + ' | server set: ' + [bool]$i.ProxyServer + ' | PAC script: ' + [bool]$i.AutoConfigURL"));
  out.push(`Environment: HTTPS_PROXY ${!!(process.env.HTTPS_PROXY || process.env.https_proxy)} · HTTP_PROXY ${!!(process.env.HTTP_PROXY || process.env.http_proxy)} · NO_PROXY ${!!(process.env.NO_PROXY || process.env.no_proxy)} · NODE_EXTRA_CA_CERTS ${!!process.env.NODE_EXTRA_CA_CERTS} · NODE_OPTIONS ${!!process.env.NODE_OPTIONS}`);

  sec('Editor extensions and plugin');
  const home = os.homedir();
  for (const d of ['.vscode', '.antigravity', '.antigravity-ide', '.cursor', '.windsurf']) {
    try {
      const names = fs.readdirSync(path.join(home, d, 'extensions')).filter((x) => /anthropic\.claude-code-|claude-agent-hub|claude-account-manager/i.test(x));
      if (names.length) out.push(`${d}: ${names.join(', ')}`);
    } catch {}
  }
  const ip = readJson(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), {});
  for (const [k, v] of Object.entries(ip.plugins || ip || {})) if (/agent-hub|account-manager/.test(k)) out.push(`plugin ${k}: ${(Array.isArray(v) ? v : [v]).map((x) => x.version).join(', ')}`);

  sec('Recent log (last 25 events)');
  try {
    const lines = fs.readFileSync(FILES.log, 'utf8').trim().split('\n').slice(-25);
    out.push(...lines.map(mask));
  } catch { out.push('(no log)'); }

  const text = out.join('\n');
  try { fs.writeFileSync(path.join(DATA, 'diagnose.txt'), text); } catch {}
  return text + `\n\n(saved to ${path.join(DATA, 'diagnose.txt')})`;
}
