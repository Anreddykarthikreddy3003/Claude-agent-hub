/** Claude Code hook handlers. They must be fast and must never block the user. */
import { loadAccounts, loadConfig, appendLog } from './store.mjs';
import { detectActive } from './accounts.mjs';
import { refreshUsage, snapshot, activeMaxAgeMs } from './collector.mjs';
import { autoSwitchIfNeeded } from './switcher.mjs';
import { ensureDaemon } from './daemon.mjs';
import { fmtDur, fmtTime } from './util.mjs';
import { publishStatus } from './report.mjs';

const out = (obj) => process.stdout.write(JSON.stringify(obj));

function drainStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let s = '';
    const t = setTimeout(() => resolve(s), 300);
    process.stdin.on('data', (d) => (s += d));
    process.stdin.on('end', () => { clearTimeout(t); resolve(s); });
    process.stdin.on('error', () => { clearTimeout(t); resolve(s); });
  });
}

/** Show accounts by email (falls back to the saved name). */
const label = (n) => (n ? loadAccounts().find((a) => a.name === n)?.email || n : '?');

function switchedMsg(r) {
  return `🔄 Claude account switched ${label(r.from)} → ${label(r.to)} (${r.reason}). New chats use ${label(r.to)}; if this chat still reports a limit, start a new chat.`;
}

export async function runHook(event) {
  if (process.env.CAM_INTERNAL) return; // our own priming runs
  await drainStdin();
  try {
    ensureDaemon();
    if (!loadAccounts().length) {
      if (event === 'session-start')
        out({ systemMessage: 'Account manager: no accounts yet. Run /accounts import <name>, then /accounts add <name> for each other login.' });
      return;
    }
    const { name: active } = await detectActive();
    if (active) await refreshUsage({ names: [active], maxAgeMs: activeMaxAgeMs(active) });
    const r = await autoSwitchIfNeeded(event);
    publishStatus();
    if (r?.switched) return out({ systemMessage: switchedMsg(r) });
    if (r?.allLimited)
      return out({ systemMessage: `⛔ All Claude accounts are limited. Next: ${label(r.next?.name)} at ${fmtTime(r.next?.at)}; the switch happens automatically.` });
    if (event === 'session-start') {
      const { cfg, st, views, now } = snapshot();
      const a = views.find((v) => v.name === st.active);
      if (a)
        out({
          systemMessage: `👤 Claude account ${a.email || a.name} · 5h ${a.five.util}%${a.five.resetsAt ? ` (↻${fmtDur(a.five.resetsAt - now)})` : ''} · weekly ${a.week.util}% · ${views.filter((v) => v.usable).length}/${views.length} accounts ready · priming ${cfg.ready ? 'on' : 'off'}`,
        });
    }
  } catch (e) {
    appendLog('hook-error', { event, error: String(e?.message || e) });
  }
}

export { loadConfig };
