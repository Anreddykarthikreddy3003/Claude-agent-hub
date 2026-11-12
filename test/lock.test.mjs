import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('withLock: 6 processes x 15 increments never lose an update', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cam-lock-'));
  const counter = path.join(dir, 'n.txt');
  fs.writeFileSync(counter, '0');
  const script = `
    import { withLock } from ${JSON.stringify(new URL('../src/util.mjs', import.meta.url).href)};
    import fs from 'node:fs';
    for (let i = 0; i < 15; i++) {
      await withLock(${JSON.stringify(path.join(dir, 'x.lock'))}, async () => {
        const n = Number(fs.readFileSync(${JSON.stringify(counter)}, 'utf8'));
        await new Promise((r) => setTimeout(r, 3));
        fs.writeFileSync(${JSON.stringify(counter)}, String(n + 1));
      }, { timeoutMs: 60000 });
    }`;
  const runs = Array.from({ length: 6 }, () =>
    new Promise((resolve, reject) => {
      const c = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      c.stderr.on('data', (d) => (err += d));
      c.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err))));
    }),
  );
  await Promise.all(runs);
  assert.equal(Number(fs.readFileSync(counter, 'utf8')), 90);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('withLock: a lock left by a dead process is recovered', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cam-lock-'));
  const lock = path.join(dir, 'y.lock');
  fs.mkdirSync(`${lock}.d`);
  fs.writeFileSync(path.join(`${lock}.d`, 'owner.json'), JSON.stringify({ token: 'dead', pid: 999999, at: Date.now() - 10000 }));
  const { withLock } = await import('../src/util.mjs');
  const t0 = Date.now();
  const r = await withLock(lock, async () => 'ok', { timeoutMs: 5000 });
  assert.equal(r, 'ok');
  assert.ok(Date.now() - t0 < 3000);
  assert.ok(!fs.existsSync(`${lock}.d`), 'released');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('readJsonStrict: missing -> null, corrupt -> throws', async () => {
  const { readJsonStrict } = await import('../src/util.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cam-json-'));
  assert.equal(readJsonStrict(path.join(dir, 'nope.json')), null);
  fs.writeFileSync(path.join(dir, 'bad.json'), '{"half":');
  assert.throws(() => readJsonStrict(path.join(dir, 'bad.json')), /not valid JSON/);
  fs.rmSync(dir, { recursive: true, force: true });
});
