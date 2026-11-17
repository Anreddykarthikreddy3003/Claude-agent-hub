/** Finding the Claude CLI on a computer that only has the Claude Code editor extension (no PATH entry). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fakeHome(exts) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cam-home-'));
  for (const [editor, version] of exts) {
    const dir = path.join(home, editor, 'extensions', `anthropic.claude-code-${version}-win32-x64`, 'resources', 'native-binary');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude'), '');
  }
  fs.mkdirSync(path.join(home, '.claude-accounts'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude-accounts', 'config.json'), '{}');
  return home;
}

function find(home) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', "import { findClaude } from './src/claude.mjs'; console.log(JSON.stringify(findClaude()));"], {
    cwd: ROOT, encoding: 'utf8',
    // no PATH entry for claude, a home with only editor extensions
    env: { ...process.env, USERPROFILE: home, HOME: home, CAM_HOME: path.join(home, '.claude-accounts'), PATH: path.dirname(process.execPath) + path.delimiter + (process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32') : '/usr/bin') },
  });
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

test('extension-only computer: the CLI bundled with the Claude Code extension is used', () => {
  const home = fakeHome([['.antigravity-ide', '2.1.323']]);
  const r = find(home);
  assert.equal(r.source, 'Claude Code extension');
  assert.match(r.path, /anthropic\.claude-code-2\.1\.323/);
});

test('several editors and versions: the newest bundled CLI wins', () => {
  const home = fakeHome([['.vscode', '2.1.9'], ['.antigravity-ide', '2.1.325'], ['.antigravity-ide', '2.1.323'], ['.cursor', '2.1.100']]);
  assert.match(find(home).path, /2\.1\.325/);
});

test('no Claude Code anywhere: reported as not found instead of failing later', () => {
  assert.equal(find(fakeHome([])).source, 'not found');
});

test('sign-in renewal never reaches the model: a slash command that does not exist, with slash commands enabled', async () => {
  const { RENEW_ARGS } = await import('../src/claude.mjs');
  const prompt = RENEW_ARGS[RENEW_ARGS.indexOf('-p') + 1];
  assert.match(prompt, /^\/[a-z-]+$/, 'a bare slash command, answered locally ("Unknown skill")');
  assert.ok(!RENEW_ARGS.includes('--disable-slash-commands'), 'with slash commands disabled the text would be sent to the model');
  assert.ok(!['/usage', '/status', '/cost', '/help', '/login'].includes(prompt), 'not a name that exists or could exist as a real command');
});
