/** Network resilience: when Node's fetch fails (antivirus HTTPS scanning, proxy, firewall), say why and retry. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchUsage, net, networkError, checkNetwork, resetNetworkMemory } from '../src/api.mjs';

const usageBody = { five_hour: { utilization: 42, resets_at: '2030-01-01T00:00:00Z' }, seven_day: { utilization: 7, resets_at: '2030-01-05T00:00:00Z' } };
const okRes = (body) => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => body });
const fetchFailed = (code) => async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) }); };

test('fetch fails on intercepted HTTPS: the fallback with system certificates gets the usage', async () => {
  const saved = [globalThis.fetch, net.httpsGet];
  globalThis.fetch = fetchFailed('UNABLE_TO_GET_ISSUER_CERT_LOCALLY');
  net.httpsGet = async () => okRes(usageBody);
  try {
    const u = await fetchUsage('t');
    assert.equal(u.five.util, 42);
    assert.equal(u.week.util, 7);
  } finally { [globalThis.fetch, net.httpsGet] = saved; }
});

test('both paths fail: the error names the real cause instead of "fetch failed"', async () => {
  const saved = [globalThis.fetch, net.httpsGet];
  globalThis.fetch = fetchFailed('ECONNREFUSED');
  net.httpsGet = async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }); };
  try {
    await assert.rejects(fetchUsage('t'), (e) => e.network === true && /ECONNREFUSED/.test(e.message) && /firewall|blocked/.test(e.message) && e.status === undefined);
  } finally { [globalThis.fetch, net.httpsGet] = saved; }
});

test('networkError explains certificate, DNS and blocked-connection failures', () => {
  assert.match(networkError({ cause: { code: 'SELF_SIGNED_CERT_IN_CHAIN' } }).message, /intercepted/);
  assert.match(networkError({ cause: { code: 'ENOTFOUND' } }).message, /DNS|look up/);
  assert.match(networkError({ code: 'ETIMEDOUT' }).message, /blocked or timed out/);
});

test('cam doctor network check reports which path worked', async () => {
  const saved = [globalThis.fetch, net.httpsGet];
  globalThis.fetch = fetchFailed('UNABLE_TO_VERIFY_LEAF_SIGNATURE');
  net.httpsGet = async () => ({ ok: false, status: 401, headers: { get: () => 'application/json' }, json: async () => ({}) });
  try {
    const r = await checkNetwork();
    assert.equal(r.ok, true);
    assert.match(r.via, /system certificates/);
    assert.match(r.firstError, /UNABLE_TO_VERIFY_LEAF_SIGNATURE/);
  } finally { [globalThis.fetch, net.httpsGet] = saved; }
});

test('large-handshake resets: the small-handshake variant is tried and remembered', async () => {
  resetNetworkMemory();
  const saved = [globalThis.fetch, net.httpsGet];
  const seen = [];
  globalThis.fetch = fetchFailed('ECONNRESET');
  net.httpsGet = async (u, h, t, family, opts = {}) => {
    seen.push(`${family}${opts.small ? '+small' : ''}`);
    if (!opts.small) throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    return okRes(usageBody);
  };
  try {
    const u = await fetchUsage('t');
    assert.equal(u.five.util, 42);
    assert.deepEqual(seen, ['4', '0+small'], 'IPv4 first, then the small handshake');
    seen.length = 0;
    await fetchUsage('t');
    assert.deepEqual(seen, ['0+small'], 'next time the working variant goes first, without waiting for fetch');
  } finally { [globalThis.fetch, net.httpsGet] = saved; }
});
