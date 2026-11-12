#!/usr/bin/env node
/** cam — Claude Agent Hub CLI. Run `cam help`. */
import { statusText, weekText, statusLine, bestText, logText } from '../src/report.mjs';

const HELP = `cam — Claude Agent Hub

Accounts (log in once per account):
  cam accounts                     show all accounts, usage, resets, next switch
  cam accounts import <name>       save the login Claude Code is using now
  cam accounts add <name>          open a login window and save another account
  cam accounts relogin <name>      sign in again to an existing account
  cam accounts remove <name>       forget an account (deletes its saved login)
  cam accounts pause|resume <name> take an account out of / back into rotation

Everyday:
  cam status                       same as "cam accounts"
  cam switch [name] [--force]      switch now (no name = best); --force: use it past 95%/98% and hold it until 100%
  cam best                         ranked list of usable accounts
  cam week                         weekly-limit plan (is anything going to be wasted?)
  cam refresh                      fetch live usage for all accounts now
  cam ready on|off                 24/7 automatic priming ("hi") on/off
  cam prime <name>                 send the priming "hi" to one account now
  cam log [n]                      recent events (switches, primes, alerts)

Setup:
  cam install                      background service + status line + plugin
  cam uninstall [--purge]          remove everything (--purge also deletes saved logins)
  cam keep-awake on|off            stop the laptop sleeping while plugged in
  cam doctor                       check that everything is working
`;

async function main() {
  const [cmd = 'status', ...rest] = process.argv.slice(2);
  const arg = rest[0];
  const need = (what) => {
    if (!arg) throw new Error(`Usage: cam ${cmd} ${what}`);
    return arg;
  };

  switch (cmd) {
    case 'help': case '-h': case '--help':
      return console.log(HELP);

    case 'status':
    case 'accounts': {
      const sub = cmd === 'accounts' ? rest[0] : undefined;
      const name = rest[1];
      const acc = await import('../src/accounts.mjs');
      if (sub && sub !== 'list') {
        if (!name) throw new Error(`Usage: cam accounts ${sub} <name>`);
        if (sub === 'import') {
          const id = await acc.importCurrent(name);
          return console.log(`Saved the current login (${id.email}) as "${name}". It is the active account.`);
        }
        if (sub === 'add' || sub === 'relogin') {
          if (sub === 'relogin') acc.reloginAccount(name);
          else acc.addAccount(name);
          return console.log(
            `A login window opened for "${name}". Sign in there with that account.\n` +
              `It is picked up automatically within a minute after you finish (or run: cam accounts).`,
          );
        }
        if (sub === 'remove') {
          await acc.removeAccount(name, { force: rest.includes('--force') });
          return console.log(`Removed "${name}".`);
        }
        if (sub === 'pause' || sub === 'resume') {
          acc.setPaused(name, sub === 'pause');
          return console.log(`"${name}" ${sub === 'pause' ? 'paused (out of rotation)' : 'back in rotation'}.`);
        }
        throw new Error(`Unknown: cam accounts ${sub}. See: cam help`);
      }
      if (!rest.includes('--cached')) {
        await acc.scanPendingSlots();
        const { refreshUsage } = await import('../src/collector.mjs');
        await refreshUsage({ maxAgeMs: 60e3 });
      }
      if (rest.includes('--json')) {
        const { statusJson, publishStatus } = await import('../src/report.mjs');
        publishStatus();
        return console.log(JSON.stringify(statusJson()));
      }
      return console.log(statusText());
    }

    case 'switch': {
      const { refreshUsage, snapshot } = await import('../src/collector.mjs');
      const { switchTo } = await import('../src/switcher.mjs');
      const { rankViews } = await import('../src/engine.mjs');
      let target = arg && arg !== 'best' ? arg : null;
      if (!target) {
        await refreshUsage({ maxAgeMs: 60e3 });
        const { st, views } = snapshot();
        target = rankViews(views.filter((v) => v.name !== st.active))[0]?.name;
        if (!target) throw new Error('No other account is usable right now. See: cam accounts');
      }
      if (rest.includes('--force')) {
        const { forceSwitch } = await import('../src/switcher.mjs');
        const r = await forceSwitch(target);
        return console.log(`${r.changed ? `Switched ${r.from ?? '(unmanaged)'} → ${r.to}` : `Staying on ${r.to}`}. Held until it reaches 100%, then automatic switching resumes.`);
      }
      const r = await switchTo(target, 'manual');
      return console.log(r.changed ? `Switched ${r.from ?? '(unmanaged)'} → ${r.to}. New chats use ${r.to}.` : `Already on ${r.to}.`);
    }

    case 'best': {
      const { refreshUsage } = await import('../src/collector.mjs');
      await refreshUsage({ maxAgeMs: 60e3 });
      return console.log(bestText());
    }

    case 'week': {
      const { refreshUsage } = await import('../src/collector.mjs');
      await refreshUsage({ maxAgeMs: 5 * 60e3 });
      return console.log(weekText());
    }

    case 'refresh': {
      const { refreshUsage } = await import('../src/collector.mjs');
      await refreshUsage();
      return console.log(statusText());
    }

    case 'ready': {
      const { saveConfig, loadConfig } = await import('../src/store.mjs');
      if (arg === 'on' || arg === 'off') saveConfig({ ready: arg === 'on' });
      const on = loadConfig().ready;
      return console.log(
        on
          ? '24/7 priming is ON: every account gets a "hi" when its 5h window ends, spaced evenly so a fresh session is always close.'
          : '24/7 priming is OFF. Automatic switching still works. Turn back on: cam ready on',
      );
    }

    case 'prime': {
      const { primeAccount } = await import('../src/daemon.mjs');
      const r = await primeAccount(need('<name>'));
      return console.log(r.ok ? `Sent "hi" to ${arg}. Its 5-hour window is running.` : `Prime failed: ${r.text}`);
    }

    case 'log':
      return console.log(logText(Number(arg) || 25));

    case 'daemon': {
      const { runDaemon } = await import('../src/daemon.mjs');
      return runDaemon({ once: rest.includes('--once') });
    }

    case 'hook': {
      const { runHook } = await import('../src/hooks.mjs');
      return runHook(arg || 'unknown');
    }

    case 'statusline': {
      try {
        const { ensureDaemon } = await import('../src/daemon.mjs');
        ensureDaemon();
        process.stdout.write(statusLine());
      } catch {
        process.stdout.write('👤 account manager: error (cam doctor)');
      }
      return;
    }

    case 'mcp': {
      const { runMcp } = await import('../src/mcp.mjs');
      return runMcp();
    }

    case 'install': {
      const { install } = await import('../src/install.mjs');
      return console.log(install());
    }
    case 'uninstall': {
      const { uninstall } = await import('../src/install.mjs');
      return console.log(uninstall({ purge: rest.includes('--purge') }));
    }
    case 'keep-awake': {
      const { keepAwake } = await import('../src/install.mjs');
      if (arg !== 'on' && arg !== 'off') throw new Error('Usage: cam keep-awake on|off');
      return console.log(keepAwake(arg === 'on'));
    }
    case 'doctor': {
      const { doctor } = await import('../src/install.mjs');
      return console.log(await doctor());
    }
    default:
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((e) => {
  if (process.argv[2] === 'hook' || process.argv[2] === 'statusline') return; // never break Claude Code
  console.error(`Error: ${e.message}`);
  process.exitCode = 1;
});
