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

// ── outages must not look like logouts; the active slot stays current ──

const FAKE_FETCH = (status, type, extra = {}) =>
  `globalThis.fetch = async () => new Response(${JSON.stringify(type.includes('html') ? '<html><title>Attention Required! | Cloudflare</title></html>' : '{"type":"error","error":{"type":"permission_error"}}')}, { status: ${status}, headers: ${JSON.stringify({ 'content-type': type, ...extra })} });`;
const USAGE_B = `import { refreshUsage } from './src/collector.mjs'; await refreshUsage({ names: ['B'] }); const fs = await import('node:fs'); console.log(JSON.stringify(JSON.parse(fs.readFileSync(process.env.CAM_HOME + '/state.json', 'utf8')).usage.B));`;

test('Cloudflare 403 during an outage: account is not marked signed out, usage checks back off', () => {
  const sb = sandbox();
  const u = run(sb, FAKE_FETCH(403, 'text/html; charset=UTF-8', { 'cf-mitigated': 'challenge' }) + USAGE_B);
  assert.equal(u.needsLogin, false, JSON.stringify(u));
  assert.ok(u.backoffUntil > Date.now() + 10 * 60e3, 'backs off for at least 10 minutes');
});

test("Anthropic's own JSON 403 still means the account needs to sign in again", () => {
  const sb = sandbox();
  const u = run(sb, FAKE_FETCH(403, 'application/json') + USAGE_B);
  assert.equal(u.needsLogin, true, JSON.stringify(u));
});

const SYNC = `import { syncActiveSlot } from './src/switcher.mjs'; const r = await syncActiveSlot(); console.log(JSON.stringify({ r }));`;
test('active slot sync: rotated live tokens of a verified account are saved to its slot', () => {
  const live = { claudeAiOauth: { accessToken: 'at-A2', refreshToken: 'rt-A2', expiresAt: Date.now() + 9 * 3600e3, scopes: [], subscriptionType: 'pro' } };
  const sb = sandbox({ mainCreds: live });
  // Trust comes from detectActive's record (in real use it is set from Anthropic's profile endpoint).
  const r0 = run(sb, `import { tokenHash } from './src/util.mjs'; import { updateState } from './src/store.mjs'; const fs = await import('node:fs');
    const o = JSON.parse(fs.readFileSync(process.env.CAM_MAIN_CONFIG_DIR + '/.credentials.json', 'utf8')).claudeAiOauth;
    await updateState((s) => { s.mainOwner = { tokenHash: tokenHash(o), uuid: 'uuid-A', email: 'a@example.com', trusted: true, source: 'profile' }; s.active = 'A'; });
    console.log(JSON.stringify({ ok: true }));`);
  assert.equal(r0.ok, true);
  const r = run(sb, SYNC);
  assert.equal(r.r, true);
  assert.equal(read(path.join(sb.data, 'slots', 'A', '.credentials.json')).claudeAiOauth.refreshToken, 'rt-A2');
  assert.equal(read(path.join(sb.data, 'slots', 'B', '.credentials.json')).claudeAiOauth.refreshToken, 'rt-B', 'other slots untouched');
});

test('active slot sync: an unverified login is never copied into a slot', () => {
  const sb = sandbox({ mainCreds: { ...tok('X') }, mainMeta: oa('A') }); // metadata says A, token unknown
  const before = fs.readFileSync(path.join(sb.data, 'slots', 'A', '.credentials.json'), 'utf8');
  const r = run(sb, FAKE_FETCH(401, 'application/json') + SYNC); // profile lookup fails
  assert.equal(r.r, false);
  assert.equal(fs.readFileSync(path.join(sb.data, 'slots', 'A', '.credentials.json'), 'utf8'), before);
});

test('active slot sync: a newer saved copy is never replaced by an older live one', () => {
  const sb = sandbox(); // main holds A's tokens = slot match
  const newer = { claudeAiOauth: { accessToken: 'at-A', refreshToken: 'rt-A', expiresAt: Date.now() + 9 * 3600e3, scopes: [], subscriptionType: 'pro' } };
  fs.writeFileSync(path.join(sb.data, 'slots', 'A', '.credentials.json'), JSON.stringify(newer));
  const r = run(sb, SYNC);
  assert.equal(r.r, false);
  assert.equal(read(path.join(sb.data, 'slots', 'A', '.credentials.json')).claudeAiOauth.expiresAt, newer.claudeAiOauth.expiresAt);
});

// ── gentle rotation: no ping-pong, manual choices respected, rate limits honoured ──

const AUTO2 = `import { autoSwitchIfNeeded } from './src/switcher.mjs'; const r = await autoSwitchIfNeeded('test'); const fs = await import('node:fs'); const st = JSON.parse(fs.readFileSync(process.env.CAM_HOME + '/state.json', 'utf8')); console.log(JSON.stringify({ switched: !!r?.switched, to: r?.to || null, active: st.active, forced: st.forced?.name || null }));`;
const U = (fiveU, weekU, extra = {}) => ({ attemptAt: Date.now(), fetchedAt: Date.now(), five: { util: fiveU, resetsAt: Date.now() + 3600e3 }, week: { util: weekU, resetsAt: Date.now() + 48 * 3600e3 }, stale: false, error: null, needsLogin: false, ...extra });

test('no ping-pong: no automatic switch within 2 minutes of the last one, unless the account is used up', () => {
  const sb = sandbox();
  const st = (aFive, lastAgo) => fs.writeFileSync(path.join(sb.data, 'state.json'), JSON.stringify({ active: 'A', usage: { A: U(aFive, 20), B: U(5, 20) }, alerts: {}, lastSwitch: { from: 'B', to: 'A', at: Date.now() - lastAgo, reason: 'test' } }));
  st(96, 30e3);
  assert.equal(run(sb, AUTO2).switched, false, '96% 30 s after a switch: wait');
  st(100, 30e3);
  assert.equal(run(sb, AUTO2).switched, true, '100%: switch even right after a switch');
  const sb2 = sandbox();
  fs.writeFileSync(path.join(sb2.data, 'state.json'), JSON.stringify({ active: 'A', usage: { A: U(96, 20), B: U(5, 20) }, alerts: {}, lastSwitch: { from: 'B', to: 'A', at: Date.now() - 5 * 60e3, reason: 'test' } }));
  assert.equal(run(sb2, AUTO2).switched, true, '96% five minutes after a switch: switch');
});

test('manual switch to an account past 95% is held until 100% instead of being switched straight back', () => {
  const sb = sandbox();
  fs.writeFileSync(path.join(sb.data, 'state.json'), JSON.stringify({ active: 'A', usage: { A: U(10, 20), B: U(97, 20) }, alerts: {} }));
  const r = run(sb, `${SW} const r = await switchTo('B', 'manual (dashboard)'); const fs = await import('node:fs'); const st = JSON.parse(fs.readFileSync(process.env.CAM_HOME + '/state.json', 'utf8')); console.log(JSON.stringify({ changed: r.changed, forced: st.forced?.name || null }));`);
  assert.equal(r.changed, true);
  assert.equal(r.forced, 'B', 'implicit hold');
  // even after the 2-minute window, the background check keeps B until it reaches 100%
  const s = read(path.join(sb.data, 'state.json'));
  s.lastSwitch.at = Date.now() - 10 * 60e3;
  fs.writeFileSync(path.join(sb.data, 'state.json'), JSON.stringify(s));
  assert.equal(run(sb, AUTO2).switched, false);
});

test('manual switch to a healthy account sets no hold', () => {
  const sb = sandbox();
  fs.writeFileSync(path.join(sb.data, 'state.json'), JSON.stringify({ active: 'A', usage: { A: U(10, 20), B: U(30, 20) }, alerts: {} }));
  const r = run(sb, `${SW} await switchTo('B', 'manual (dashboard)'); const fs = await import('node:fs'); console.log(JSON.stringify({ forced: JSON.parse(fs.readFileSync(process.env.CAM_HOME + '/state.json', 'utf8')).forced || null }));`);
  assert.equal(r.forced, null);
});

test('429 with Retry-After: usage checks back off for at least that long', () => {
  const sb = sandbox();
  const u = run(sb, `globalThis.fetch = async () => new Response('{"error":"rate_limited"}', { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '1800' } });` + USAGE_B);
  assert.equal(u.needsLogin, false);
  assert.ok(u.backoffUntil >= Date.now() + 29 * 60e3, JSON.stringify(u));
});

test('the same account is never checked twice within 30 seconds, even on a forced refresh', () => {
  const sb = sandbox();
  fs.writeFileSync(path.join(sb.data, 'state.json'), JSON.stringify({ active: 'A', usage: { B: U(10, 20, { attemptAt: Date.now() - 5e3 }) }, alerts: {} }));
  const r = run(sb, `let calls = 0; globalThis.fetch = async () => { calls++; return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }); }; import('./src/collector.mjs').then(async ({ refreshUsage }) => { await refreshUsage({ names: ['B'], maxAgeMs: 0 }); console.log(JSON.stringify({ calls })); });`);
  assert.equal(r.calls, 0);
});

// ── switch at chat boundaries: a new chat has no history to reread ──

const CHAT = `import { switchAtChatStart } from './src/switcher.mjs'; const r = await switchAtChatStart(); console.log(JSON.stringify({ switched: !!r?.switched, to: r?.to || null }));`;
const chatState = (sb, aFive, bFive, extra = {}) => fs.writeFileSync(path.join(sb.data, 'state.json'), JSON.stringify({ active: 'A', usage: { A: U(aFive, 20), B: U(bFive, 20) }, alerts: {}, ...extra }));

test('new chat: switches early when the active session is past 90% and another account is clearly better', () => {
  const sb = sandbox();
  chatState(sb, 92, 10);
  const r = run(sb, CHAT);
  assert.equal(r.switched, true);
  assert.equal(r.to, 'B');
});

test('new chat: no early switch below 90%, when the other account is not clearly better, or while held', () => {
  let sb = sandbox(); chatState(sb, 70, 10);
  assert.equal(run(sb, CHAT).switched, false, 'below 90%');
  sb = sandbox(); chatState(sb, 92, 75);
  assert.equal(run(sb, CHAT).switched, false, 'B not clearly better');
  sb = sandbox(); chatState(sb, 92, 10, { forced: { name: 'A', at: Date.now() } });
  assert.equal(run(sb, CHAT).switched, false, 'held account');
  sb = sandbox(); chatState(sb, 92, 10, { lastSwitch: { from: 'B', to: 'A', at: Date.now() - 30e3, reason: 'test' } });
  assert.equal(run(sb, CHAT).switched, false, 'just switched');
});

// ── priming loop: no second "hi" while Anthropic's numbers lag the first one ──

function primeSandbox(fiveAfterRefresh) {
  const sb = sandbox();
  const now = Date.now();
  // Node stands in for the Claude CLI: if a "hi" is attempted it fails at once and is logged, nothing is sent.
  fs.writeFileSync(path.join(sb.data, 'config.json'), JSON.stringify({ ready: true, notifications: false, claudePath: process.execPath }));
  fs.writeFileSync(path.join(sb.data, 'state.json'), JSON.stringify({
    active: 'A',
    usage: { A: U(30, 20), B: { attemptAt: now - 15 * 60e3 - 10e3, fetchedAt: now - 15 * 60e3 - 10e3, five: { util: 0, resetsAt: null }, week: { util: 10, resetsAt: now + 48 * 3600e3 }, stale: false, error: null, needsLogin: false } },
    primes: { B: { lastAt: now - 15 * 60e3, ok: true, fails: 0 } },
    idleSince: { B: now - 6 * 3600e3 },
    alerts: {},
  }));
  const usage = JSON.stringify({ five_hour: fiveAfterRefresh, seven_day: { utilization: 10, resets_at: new Date(now + 48 * 3600e3).toISOString() } });
  const code = `globalThis.fetch = async () => new Response(${JSON.stringify(usage)}, { status: 200, headers: { 'content-type': 'application/json' } });
    const { runDuePrimes } = await import('./src/daemon.mjs'); await runDuePrimes();
    const fs = await import('node:fs'); const log = fs.existsSync(process.env.CAM_HOME + '/log.jsonl') ? fs.readFileSync(process.env.CAM_HOME + '/log.jsonl', 'utf8') : '';
    console.log(JSON.stringify({ primes: log.split(String.fromCharCode(10)).filter((l) => l.includes('"type":"prime"')).length }));`;
  return run(sb, code);
}

test('a recently primed account whose window now shows up is not primed again', () => {
  const r = primeSandbox({ utilization: 1, resets_at: new Date(Date.now() + 4.7 * 3600e3).toISOString() });
  assert.equal(r.primes, 0);
});

test('a recently primed account whose window still does not show up does get another hi', () => {
  const r = primeSandbox({ utilization: 0, resets_at: null });
  assert.equal(r.primes, 1, 'the retry path still works');
});

// ── freeze: stay on the active account until the user unfreezes ──

const FRZ = `import * as sw from './src/switcher.mjs'; const fs = await import('node:fs');
  const st = () => JSON.parse(fs.readFileSync(process.env.CAM_HOME + '/state.json', 'utf8'));`;

test('freeze: stays on the account even at 100%, refuses manual switches and new-chat switches', () => {
  const sb = sandbox();
  fs.writeFileSync(path.join(sb.data, 'state.json'), JSON.stringify({ active: 'A', usage: { A: U(100, 40), B: U(5, 20) }, alerts: {}, forced: { name: 'A', at: Date.now() } }));
  const r = run(sb, `${FRZ}
    const f = await sw.freezeActive();
    const auto = await sw.autoSwitchIfNeeded('background');
    const chat = await sw.switchAtChatStart();
    let manual = null; try { await sw.switchTo('B', 'manual (dashboard)'); manual = 'switched'; } catch (e) { manual = e.message; }
    console.log(JSON.stringify({ f: f.frozen, auto, chat, manual, active: st().active, frozen: st().frozen?.name, forced: st().forced || null }));`);
  assert.equal(r.f, 'A');
  assert.equal(r.auto.switched, false);
  assert.equal(r.auto.frozen, true);
  assert.equal(r.auto.limited, true, 'reports that the frozen account is at its limit');
  assert.equal(r.chat, null);
  assert.match(r.manual, /frozen/);
  assert.equal(r.active, 'A');
  assert.equal(r.frozen, 'A');
  assert.equal(r.forced, null, 'a force hold is replaced by the freeze');
});

test('unfreeze: automatic switching takes over again right away', () => {
  const sb = sandbox();
  fs.writeFileSync(path.join(sb.data, 'state.json'), JSON.stringify({ active: 'A', usage: { A: U(100, 40), B: U(5, 20) }, alerts: {}, frozen: { name: 'A', at: Date.now() } }));
  const r = run(sb, `${FRZ} const u = await sw.unfreeze(); console.log(JSON.stringify({ ...u, active: st().active, frozen: st().frozen || null }));`);
  assert.equal(r.unfrozen, 'A');
  assert.equal(r.switched, true);
  assert.equal(r.active, 'B');
  assert.equal(r.frozen, null);
});

test('freeze survives "automatic switching off" being turned back on, and a frozen healthy account is simply kept', () => {
  const sb = sandbox();
  fs.writeFileSync(path.join(sb.data, 'state.json'), JSON.stringify({ active: 'A', usage: { A: U(40, 40), B: U(5, 20) }, alerts: {}, frozen: { name: 'A', at: Date.now() } }));
  const r = run(sb, `${FRZ} const a = await sw.autoSwitchIfNeeded('prompt'); console.log(JSON.stringify(a));`);
  assert.equal(r.switched, false);
  assert.equal(r.limited, false);
});

test('a usage check that failed for a temporary reason is retried when its back-off ends, not 30 minutes later', () => {
  const count = (usageB) => {
    const sb = sandbox();
    fs.writeFileSync(path.join(sb.data, 'state.json'), JSON.stringify({ active: 'A', usage: { B: usageB }, alerts: {} }));
    return run(sb, `let calls = 0; globalThis.fetch = async () => { calls++; return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }); }; import('./src/collector.mjs').then(async ({ refreshUsage }) => { await refreshUsage({ names: ['B'], maxAgeMs: 30 * 60e3 }); console.log(JSON.stringify({ calls })); });`).calls;
  };
  const t = Date.now();
  assert.equal(count(U(10, 20, { attemptAt: t - 6 * 60e3, error: 'network error (ECONNRESET)', backoffUntil: t - 60e3 })), 1, 'back-off over: retry now');
  assert.equal(count(U(10, 20, { attemptAt: t - 2 * 60e3, error: 'network error (ECONNRESET)', backoffUntil: t + 3 * 60e3 })), 0, 'still backing off');
  assert.equal(count(U(10, 20, { attemptAt: t - 6 * 60e3 })), 0, 'healthy and recent: wait for the regular check');
});

// ── "Save this account" for a login that is already saved under another name ──

const IMPORT = `import { importCurrent } from './src/accounts.mjs'; const fs = await import('node:fs');
  let r; try { r = await importCurrent('3'); } catch (e) { r = { error: e.message }; }
  const accts = JSON.parse(fs.readFileSync(process.env.CAM_HOME + '/accounts.json', 'utf8')).accounts.map((a) => a.name);
  console.log(JSON.stringify({ ...r, accts }));`;

test('saving a login that belongs to an already saved account updates that account instead of duplicating it', () => {
  const sb = sandbox({ mainCreds: { ...tok('B2') }, mainMeta: oa('B') }); // Claude Code signed in to B again (new tokens)
  const r = run(sb, `globalThis.fetch = async () => new Response(JSON.stringify({ account: { uuid: 'uuid-B', email: 'b@example.com' } }), { status: 200, headers: { 'content-type': 'application/json' } });` + IMPORT);
  assert.equal(r.existing, true, JSON.stringify(r));
  assert.equal(r.name, 'B');
  assert.deepEqual(r.accts, ['A', 'B'], 'no account "3" was created');
  assert.equal(read(path.join(sb.data, 'slots', 'B', '.credentials.json')).claudeAiOauth.refreshToken, 'rt-B2', "B's saved login now holds the live tokens");
  assert.equal(read(path.join(sb.data, 'state.json')).active, 'B');
});

test('saving an already saved account without a verified identity (network down) is refused, nothing changes', () => {
  const sb = sandbox({ mainCreds: { ...tok('B2') }, mainMeta: oa('B') });
  const before = fs.readFileSync(path.join(sb.data, 'slots', 'B', '.credentials.json'), 'utf8');
  const r = run(sb, `globalThis.fetch = async () => { throw new TypeError('fetch failed'); }; (await import('./src/api.mjs')).net.httpsGet = async () => { throw Object.assign(new Error('reset'), { code: 'ECONNRESET' }); };` + IMPORT);
  assert.match(r.error, /verify/);
  assert.deepEqual(r.accts, ['A', 'B']);
  assert.equal(fs.readFileSync(path.join(sb.data, 'slots', 'B', '.credentials.json'), 'utf8'), before);
});
