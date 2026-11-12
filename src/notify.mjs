/** Windows desktop notification (balloon / toast) with no extra dependencies. */
import { spawn } from 'node:child_process';
import { loadConfig, appendLog } from './store.mjs';

export function notify(title, message) {
  appendLog('notify', { title, message });
  if (process.env.CAM_NO_NOTIFY || !loadConfig().notifications) return;
  if (process.platform !== 'win32') return;
  const esc = (s) => String(s).replace(/'/g, "''").slice(0, 250);
  const ps = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$n = New-Object System.Windows.Forms.NotifyIcon',
    '$n.Icon = [System.Drawing.SystemIcons]::Information',
    `$n.BalloonTipTitle = '${esc(title)}'`,
    `$n.BalloonTipText = '${esc(message)}'`,
    '$n.Visible = $true',
    '$n.ShowBalloonTip(10000)',
    'Start-Sleep -Seconds 11',
    '$n.Dispose()',
  ].join('; ');
  try {
    spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref();
  } catch {}
}
