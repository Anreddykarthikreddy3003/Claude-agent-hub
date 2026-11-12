/**
 * Switcher safety tests in a sandbox (fake accounts; CAM_HOME / CAM_MAIN_CONFIG_DIR point to temp dirs,
 * so nothing touches the real Claude login). Each scenario runs in a child process because paths are
 * resolved at import time.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tok = (n) => ({ claudeAiOauth: { accessToken: `at-${n}`, refreshToken: `rt-${n}`, expiresAt: Date.now() + 8 * 3600e3, scopes: [], subscriptionType: 'pro' } });
const oa = (n) => ({ oauthAccount: { accountUuid: `uuid-${n}`, emailAddress: `${n.toLowerCase()}@example.com` } });

function sandbox({ mainCreds = { ...tok('A'), mcpOAuth: { keep: 'me' } }, mainMeta = oa('A') } = {}) {
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'cam-sw-'));
  const data = path.join(sb, 'data');
  const main = path.join(sb, 'main');
  fs.mkdirSync(main, { recursive: true });
  for (const n of ['A', 'B']) {
    fs.mkdirSync(path.join(data, 'slots', n), { recursive: true });
    fs.writeFileSync(path.join(data, 'slots', n, '.credentials.json'), JSON.stringify(tok(n)));
    fs.writeFileSync(path.join(data, 'slots', n, '.claude.json'), JSON.stringify(oa(n)));
  }
  fs.writeFileSync(path.join(data, 'accounts.json'), JSON.stringify({ accounts: ['A', 'B'].map((n) => ({ name: n, uuid: `uuid-${n}`, email: `${n.toLowerCase()}@example.com`, paused: false })) }));
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ ready: false, notifications: false }));
  if (mainCreds !== undefined) fs.writeFileSync(path.join(main, '.credentials.json'), typeof mainCreds === 'string' ? mainCreds : JSON.stringify(mainCreds));
  fs.writeFileSync(path.join(main, '.claude.json'), JSON.stringify({ ...mainMeta, projects: { x: 1 } }));
  return { sb, data, main };
}

function run(sb, code) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, CAM_HOME: sb.data, CAM_MAIN_CONFIG_DIR: sb.main, CAM_NO_NOTIFY: '1' },
    timeout: 60000,
  });
  const last = (r.stdout || '').trim().split('\n').pop();
  try { return JSON.parse(last); } catch { throw new Error(`no JSON from child: ${r.stdout}\n${r.stderr}`); }
}
const SW = `import { switchTo } from './src/switcher.mjs';`;
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

test('normal switch A -> B: tokens swapped, A saved back, other keys kept, identity updated', () => {
  const sb = sandbox();
  // simulate Claude Code having refreshed A's tokens in main since A was saved
  const live = { ...tok('A'), mcpOAuth: { keep: 'me' } };
  live.claudeAiOauth.accessToken = 'at-A-live';
  fs.writeFileSync(path.join(sb.main, '.credentials.json'), JSON.stringify(live));
  // make A's slot a parked copy (same refresh token) so identity is a trusted slot match
  const r = run(sb, `${SW} try { const r = await switchTo('B','manual'); console.log(JSON.stringify(r)); } catch (e) { console.log(JSON.stringify({ error: e.message })); }`);
  assert.equal(r.changed, true, JSON.stringify(r));
  const main = read(path.join(sb.main, '.credentials.json'));
  assert.equal(main.claudeAiOauth.accessToken, 'at-B');
  assert.deepEqual(main.mcpOAuth, { keep: 'me' });
  assert.equal(read(path.join(sb.data, 'slots', 'A', '.credentials.json')).claudeAiOauth.accessToken, 'at-A-live');
  const meta = read(path.join(sb.main, '.claude.json'));
  assert.equal(meta.oauthAccount.accountUuid, 'uuid-B');
  assert.deepEqual(meta.projects, { x: 1 });
  const st = read(path.join(sb.data, 'state.json'));
  assert.equal(st.active, 'B');
  assert.equal(st.mainOwner.trusted, true);
});

test('corrupt main credentials: switch aborts and changes nothing', () => {
  const sb = sandbox({ mainCreds: '{"claudeAiOauth": {"accessToken": "at-A", "refreshTo' });
  const before = fs.readFileSync(path.join(sb.main, '.credentials.json'), 'utf8');
  const slotA = fs.readFileSync(path.join(sb.data, 'slots', 'A', '.credentials.json'), 'utf8');
  const r = run(sb, `${SW} try { await switchTo('B','manual'); console.log(JSON.stringify({ ok: true })); } catch (e) { console.log(JSON.stringify({ error: e.message })); }`);
  assert.ok(r.error, 'must refuse');
  assert.equal(fs.readFileSync(path.join(sb.main, '.credentials.json'), 'utf8'), before);
  assert.equal(fs.readFileSync(path.join(sb.data, 'slots', 'A', '.credentials.json'), 'utf8'), slotA);
});

test('unverifiable identity (token matches no slot, profile unreachable): no switch, no slot overwritten', () => {
  const sb = sandbox({ mainCreds: { ...tok('X') }, mainMeta: oa('A') }); // metadata claims A, token is unknown
  const slotA = fs.readFileSync(path.join(sb.data, 'slots', 'A', '.credentials.json'), 'utf8');
  const r = run(sb, `${SW} try { await switchTo('B','auto (test)'); console.log(JSON.stringify({ ok: true })); } catch (e) { console.log(JSON.stringify({ error: e.message })); }`);
  assert.match(r.error || '', /Cannot verify/);
  assert.equal(fs.readFileSync(path.join(sb.data, 'slots', 'A', '.credentials.json'), 'utf8'), slotA);
  assert.equal(read(path.join(sb.main, '.credentials.json')).claudeAiOauth.accessToken, 'at-X');
});

test('identity is decided by token, not by stale display metadata', () => {
  // main holds B's tokens but ~/.claude.json still says A (e.g. a deferred identity write)
  const sb = sandbox({ mainCreds: { ...tok('B') }, mainMeta: oa('A') });
  const r = run(sb, `import { detectActive } from './src/accounts.mjs'; console.log(JSON.stringify(await detectActive({ force: true })));`);
  assert.equal(r.name, 'B');
  assert.equal(r.trusted, true);
});

test('force switch: held at 98% weekly, released and switched away at 100%', () => {
  const sb = sandbox();
  const now = Date.now();
  const usage = (fiveU, weekU) => ({ attemptAt: now, fetchedAt: now, five: { util: fiveU, resetsAt: now + 3600e3 }, week: { util: weekU, resetsAt: now + 48 * 3600e3 }, stale: false, error: null, needsLogin: false });
  const writeState = (aWeek, forced) => fs.writeFileSync(path.join(sb.data, 'state.json'), JSON.stringify({ active: 'A', usage: { A: usage(10, aWeek), B: usage(5, 20) }, alerts: {}, ...(forced ? { forced: { name: 'A', at: now } } : {}) }));
  const AUTO = `import { autoSwitchIfNeeded } from './src/switcher.mjs'; const r = await autoSwitchIfNeeded('test'); const fs = await import('node:fs'); const st = JSON.parse(fs.readFileSync(process.env.CAM_HOME + '/state.json', 'utf8')); console.log(JSON.stringify({ switched: !!r?.switched, to: r?.to || null, active: st.active, forced: st.forced?.name || null }));`;

  writeState(98, true);
  let r = run(sb, AUTO);
  assert.equal(r.switched, false, 'forced account at 98% must be held');
  assert.equal(r.forced, 'A');

  writeState(100, true);
  r = run(sb, AUTO);
  assert.equal(r.switched, true, 'at 100% automatic switching takes over');
  assert.equal(r.to, 'B');
  assert.equal(r.forced, null, 'hold ends');
});

test('without force, the normal 98% weekly rule still switches away', () => {
  const sb = sandbox();
  const now = Date.now();
  const u = (w) => ({ attemptAt: now, fetchedAt: now, five: { util: 10, resetsAt: now + 3600e3 }, week: { util: w, resetsAt: now + 48 * 3600e3 }, stale: false, error: null, needsLogin: false });
  fs.writeFileSync(path.join(sb.data, 'state.json'), JSON.stringify({ active: 'A', usage: { A: u(98), B: u(20) }, alerts: {} }));
  const r = run(sb, `import { autoSwitchIfNeeded } from './src/switcher.mjs'; const r = await autoSwitchIfNeeded('test'); console.log(JSON.stringify({ switched: !!r?.switched, to: r?.to || null }));`);
  assert.equal(r.switched, true);
  assert.equal(r.to, 'B');
});
