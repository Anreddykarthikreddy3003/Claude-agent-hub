import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeView, rankViews, needsSwitch, planPrimes, nextAvailable, trackWindow, CYCLE, HOUR } from '../src/engine.mjs';
import { DEFAULT_CONFIG as cfg } from '../src/store.mjs';

const NOW = Date.UTC(2026, 10, 8, 6, 0, 0);
const MIN = 60e3;
const v = (name, five, fiveIn, week, weekIn, extra = {}) =>
  makeView(
    { name, paused: !!extra.paused },
    {
      five: { util: five, resetsAt: fiveIn == null ? null : NOW + fiveIn },
      week: { util: week, resetsAt: weekIn == null ? null : NOW + weekIn },
      needsLogin: !!extra.needsLogin,
    },
    NOW,
    cfg,
    extra.Y ?? 10,
  );

test('status thresholds', () => {
  assert.equal(v('A', 95, HOUR, 50, 72 * HOUR).status, 'session-limit');
  assert.equal(v('A', 10, HOUR, 98, 72 * HOUR).status, 'weekly-limit');
  assert.equal(v('A', 10, HOUR, 10, 72 * HOUR, { paused: true }).status, 'paused');
  assert.equal(v('A', 10, HOUR, 10, 72 * HOUR, { needsLogin: true }).status, 'needs-login');
  assert.equal(v('A', 94, HOUR, 97, 72 * HOUR).status, 'ok');
});

test('expired windows count as reset', () => {
  const x = v('A', 100, -MIN, 100, -MIN);
  assert.equal(x.status, 'ok');
  assert.equal(x.five.util, 0);
  assert.equal(x.windowRunning, false);
});

test('A limited -> picks the account whose 5h window resets soonest (scenario 1)', () => {
  const views = [v('A', 100, 2 * HOUR, 50, 72 * HOUR), v('B', 20, 1 * HOUR, 40, 48 * HOUR), v('C', 0, null, 30, 144 * HOUR)];
  assert.equal(needsSwitch(views[0]), true);
  assert.equal(rankViews(views.slice(1))[0].name, 'B');
});

test('waste alarm beats soonest 5h reset (scenario 4)', () => {
  const views = [
    v('A', 100, 2 * HOUR, 60, 120 * HOUR),
    v('B', 10, 25 * MIN, 20, 144 * HOUR),
    v('C', 40, 100 * MIN, 55, 18 * HOUR),
    v('D', 0, 175 * MIN, 99, 24 * HOUR),
  ];
  const r = rankViews(views.filter((x) => x.name !== 'A'));
  assert.equal(r[0].name, 'C');
  assert.equal(r[1].name, 'B');
  assert.ok(!r.find((x) => x.name === 'D'), 'weekly-exhausted account excluded');
});

test('critical slack outranks everything', () => {
  // 60% left, Y=10 -> needs 6 windows; resets in 30h -> 6 windows -> slack 0 -> critical
  const c = v('C', 0, null, 40, 30 * HOUR);
  assert.equal(c.slack, 0);
  assert.equal(c.critical, true);
  const r = rankViews([v('B', 0, 10 * MIN, 0, 150 * HOUR), c]);
  assert.equal(r[0].name, 'C');
});

test('low session headroom is not a switch target', () => {
  const r = rankViews([v('B', 92, HOUR, 10, 100 * HOUR), v('C', 50, 3 * HOUR, 10, 100 * HOUR)]);
  assert.deepEqual(r.map((x) => x.name), ['C']);
});

test('all limited -> nextAvailable is earliest return', () => {
  const views = [v('A', 100, 70 * MIN, 70, 50 * HOUR), v('B', 97, 3 * HOUR, 55, 50 * HOUR), v('C', 0, null, 99, 20 * HOUR)];
  assert.equal(rankViews(views).length, 0);
  const n = nextAvailable(views, NOW);
  assert.equal(n.name, 'A');
  assert.equal(n.at, NOW + 70 * MIN);
});

test('priming: nothing running -> evenly spaced every 5h/N (N=3 -> 100 min)', () => {
  const plan = planPrimes([v('A', 0, null, 0, 100 * HOUR), v('B', 0, null, 0, 120 * HOUR), v('C', 0, null, 0, 140 * HOUR)], NOW);
  assert.deepEqual(plan.map((p) => (p.at - NOW) / MIN), [0, 100, 200]);
});

test('priming: N=4 -> 75 min spacing', () => {
  const plan = planPrimes(['A', 'B', 'C', 'D'].map((n, i) => v(n, 0, null, 0, (100 + i) * HOUR)), NOW);
  assert.deepEqual(plan.map((p) => (p.at - NOW) / MIN), [0, 75, 150, 225]);
});

test('priming: idle accounts fill the gaps around running windows', () => {
  // A resets in 20 min -> grid phases at +20, +120, +220 (mod 5h). B, C idle.
  const plan = planPrimes([v('A', 30, 20 * MIN, 10, 100 * HOUR), v('B', 0, null, 10, 90 * HOUR), v('C', 0, null, 10, 95 * HOUR)], NOW);
  assert.deepEqual(plan.map((p) => [p.name, (p.at - NOW) / MIN]), [['B', 120], ['C', 220]]);
});

test('priming: window just ended on its grid slot -> prime immediately', () => {
  // B and C running; A idle and its slot is "now" -> wait 0
  const plan = planPrimes([v('A', 0, null, 10, 90 * HOUR), v('B', 5, 100 * MIN, 10, 90 * HOUR), v('C', 5, 200 * MIN, 10, 90 * HOUR)], NOW);
  assert.deepEqual(plan, [{ name: 'A', at: NOW }]);
});

test('priming skips paused, logged-out and weekly-exhausted accounts', () => {
  const plan = planPrimes(
    [v('A', 0, null, 99, 10 * HOUR), v('B', 0, null, 0, 90 * HOUR, { paused: true }), v('C', 0, null, 0, 90 * HOUR, { needsLogin: true }), v('D', 0, null, 0, 90 * HOUR)],
    NOW,
  );
  assert.deepEqual(plan.map((p) => p.name), ['D']);
});

test('priming never exceeds one cycle of waiting', () => {
  for (let k = 0; k < 50; k++) {
    const views = [v('A', 10, (k * 7) % 300 * MIN + MIN, 10, 90 * HOUR), v('B', 0, null, 10, 90 * HOUR), v('C', 0, null, 10, 90 * HOUR)];
    for (const p of planPrimes(views, NOW)) assert.ok(p.at >= NOW && p.at < NOW + CYCLE);
  }
});

test('learns weekly % per full session', () => {
  let t;
  ({ track: t } = trackWindow(undefined, { five: { util: 2, resetsAt: 1000 }, week: { util: 40 } }));
  ({ track: t } = trackWindow(t, { five: { util: 100, resetsAt: 1000 }, week: { util: 52 } }));
  const { sample } = trackWindow(t, { five: { util: 0, resetsAt: 9999 }, week: { util: 52 } });
  assert.equal(sample, 12);
});
