/** Adapter safety: prompts can't become flags, and read-only agents get each CLI's read-only controls. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ADAPTERS, argText, isFlagLike } from '../src/hub/adapters.mjs';

const base = { sessionId: null, model: null, cwd: '/tmp/project', promptFile: '/tmp/prompt.txt' };

test('argText keeps ordinary prompts unchanged', () => {
  assert.equal(argText('Review src/auth'), 'Review src/auth');
  assert.equal(argText('line one\n-- not a flag'), 'line one\n-- not a flag');
});

test('argText stops a prompt being parsed as an option', () => {
  for (const p of ['--yolo', '-p x', '  --dangerously', '-']) assert.ok(!argText(p).startsWith('-'), p);
});

test('isFlagLike catches model names and session ids that start with a dash', () => {
  assert.ok(isFlagLike('--yolo'));
  assert.ok(isFlagLike(' -m'));
  assert.ok(!isFlagLike('gpt-6.1-sol'));
  assert.ok(!isFlagLike('anthropic/claude-sonnet'));
  assert.ok(!isFlagLike(null));
});

test('no argument-based adapter passes a flag-like prompt through', () => {
  const evil = '--yolo';
  for (const id of ['kimi', 'opencode', 'agy']) {
    const args = ADAPTERS[id].args({ ...base, permission: 'read', prompt: evil });
    assert.ok(!args.includes(evil), `${id} passed the prompt as a bare flag`);
  }
});

test('read-only Kimi agents start in plan mode and never with --yolo', () => {
  const args = ADAPTERS.kimi.args({ ...base, permission: 'read', prompt: 'hi' });
  assert.ok(args.includes('--plan'));
  assert.ok(!args.includes('--yolo'));
});

test('read-only OpenCode agents may not edit files or run shell commands', () => {
  const env = ADAPTERS.opencode.env({}, { permission: 'read' });
  assert.deepEqual(JSON.parse(env.OPENCODE_PERMISSION), { edit: 'deny', bash: 'deny' });
  assert.equal(ADAPTERS.opencode.env({}, { permission: 'edit' }).OPENCODE_PERMISSION, undefined);
});

test('read-only Claude and Codex agents use their own read-only modes', () => {
  const c = ADAPTERS.claude.args({ ...base, permission: 'read', prompt: 'hi' });
  assert.ok(c.includes('--allowedTools'));
  assert.ok(!c.includes('bypassPermissions'));
  const x = ADAPTERS.codex.args({ ...base, permission: 'read', prompt: 'hi' }).join(' ');
  assert.match(x, /read-only/);
  assert.doesNotMatch(x, /danger-full-access/);
});
