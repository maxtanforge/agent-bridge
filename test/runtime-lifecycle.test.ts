import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AcpRuntime } from '../src/runtime.ts';
const permission = async () => ({ outcome: { outcome: 'cancelled' as const } });
async function scenario(config: object, run: (rt: AcpRuntime, calls: () => any[]) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'acp-lifecycle-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify(config));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = dir;
  const rt = new AcpRuntime(process.cwd(), fileURLToPath(new URL('./fixture-lifecycle.mjs', import.meta.url)));
  try { await run(rt, () => readFileSync(join(dir, 'calls.jsonl'), 'utf8').trim().split('\n').map(s => JSON.parse(s))); }
  finally { await rt.stop(); if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous; rmSync(dir, { recursive: true }); }
}
test('new task restores context in a fresh process with fresh callbacks and no history', async () => scenario({}, async (rt, calls) => {
  let first = ''; let second = ''; let approvals = 0; const events: any[] = [];
  const session = await rt.open(undefined, t => first += t, permission);
  await rt.prompt(session, 'one');
  const child = rt.process;
  await rt.open(session, t => second += t, async () => { approvals++; return permission(); }, undefined, { onEvent: e => events.push(e) });
  assert.notEqual(rt.process!.pid, child!.pid);
  assert.equal(second, '');
  assert.ok(events.some(e => e.type === 'update' && e.update.sessionUpdate === 'available_commands_update'));
  assert.ok(!events.some(e => e.type === 'update' && e.update.sessionUpdate === 'tool_call'));
  await rt.prompt(session, 'two');
  assert.equal(first, 'live'); assert.equal(second, 'live'); assert.equal(approvals, 1);
  assert.equal(calls().filter(c => c.method === 'initialize').length, 2);
  assert.equal(calls().filter(c => c.method === 'session/resume').length, 1);
}));
for (const resume of [true, false]) test(`restore chooses ${resume ? 'resume' : 'load'}`, async () => scenario({ resume }, async (rt, calls) => {
  await rt.open('saved', () => {}, permission);
  assert.equal(calls().filter(c => ['session/resume', 'session/load'].includes(c.method))[0].method, resume ? 'session/resume' : 'session/load');
}));
for (const config of [{ fail: true }, { resume: false, load: false }]) test(`restoration fails closed ${JSON.stringify(config)}`, async () => scenario(config, async (rt, calls) => {
  await assert.rejects(rt.open('saved', () => {}, permission), { name: 'SessionRestoreError' });
  assert.equal(calls().filter(c => c.method === 'session/new').length, 0);
  assert.equal(calls().filter(c => c.method === 'session/load').length, 0);
  await assert.rejects(rt.prompt('saved', 'input'), /not ready/);
}));
test('negotiated close precedes termination and has bounded grace', async () => scenario({ hangClose: true }, async (rt, calls) => {
  await rt.open(undefined, () => {}, permission);
  const start = Date.now(); await rt.stop();
  assert.equal(calls().filter(c => c.method === 'session/close').length, 1);
  assert.ok(Date.now() - start < 3000); assert.equal(rt.process, undefined);
}));
test('cancel ends pending prompt and invalidates reuse', async () => scenario({}, async (rt, calls) => {
  await rt.open(undefined, () => {}, permission); const child = rt.process;
  const prompting = rt.prompt('saved', 'hang'); await rt.cancel('saved');
  assert.equal(await prompting, 'cancelled');
  await rt.open('saved', () => {}, permission);
  assert.notEqual(rt.process, child);
  assert.equal(calls().filter(c => c.method === 'session/cancel').length, 1);
}));
test('steering preserves attachments', async () => scenario({}, async (rt, calls) => {
  await rt.open(undefined, () => {}, permission);
  const attachments = [{ type: 'image' as const, data: 'YQ==', mimeType: 'image/png' }];
  await rt.steer('saved', 'image', attachments);
  assert.deepEqual(calls().find(c => c.method === '_session/steering').params.prompt, [{ type: 'text', text: 'image' }, ...attachments]);
}));
for (const changed of [{ mode: 'acceptEdits' }, { model: 'b' }, { effort: 'b' }]) test(`changed configuration repeats setup ${JSON.stringify(changed)}`, async () => scenario({}, async (rt, calls) => {
  await rt.open(undefined, () => {}, permission); const pid = rt.process!.pid;
  await rt.open('saved', () => {}, permission, undefined, changed);
  assert.notEqual(rt.process!.pid, pid);
  assert.equal(calls().filter(c => c.method === 'initialize').length, 2);
  assert.equal(calls().filter(c => c.method === 'session/resume').length, 1);
}));
test('closed transport is replaced and stale child exit cannot invalidate replacement', async () => scenario({}, async rt => {
  await rt.open(undefined, () => {}, permission); const old = rt.process!;
  rt.connection!.close(new Error('broken transport'));
  await rt.open('saved', () => {}, permission);
  assert.notEqual(rt.process!.pid, old.pid);
  old.emit('exit', 1, null);
  assert.equal(await rt.prompt('saved', 'still live'), 'end_turn');
}));
test('steering validates image capability before sending', async () => scenario({ image: false }, async (rt, calls) => {
  await rt.open(undefined, () => {}, permission);
  await assert.rejects(rt.steer('saved', 'image', [{ type: 'image', data: 'YQ==', mimeType: 'image/png' }]), /image input unavailable/);
  assert.equal(calls().filter(c => c.method === '_session/steering').length, 0);
}));
test('cancel prevents any further prompt on the cancelled connection', async () => scenario({}, async rt => {
  await rt.open(undefined, () => {}, permission);
  await rt.cancel('saved');
  await assert.rejects(rt.prompt('saved', 'too late'), /not ready/);
}));
test('unadvertised close is omitted while process is terminated', async () => scenario({ close: false }, async (rt, calls) => {
  await rt.open(undefined, () => {}, permission);
  await rt.stop();
  assert.equal(calls().filter(c => c.method === 'session/close').length, 0);
  assert.equal(rt.process, undefined);
}));
test('a different session never reuses the previous process', async () => scenario({}, async (rt, calls) => {
  await rt.open(undefined, () => {}, permission); const pid = rt.process!.pid;
  await rt.open('other', () => {}, permission);
  assert.notEqual(rt.process!.pid, pid);
  assert.equal(calls().filter(c => c.method === 'session/resume')[0].params.sessionId, 'other');
  assert.equal(await rt.prompt('other', 'next owner'), 'end_turn');
}));
for (const preference of ['model', 'effort'] as const) test(`effective ${preference} drift is reset for the next task without interrupting the turn`, async () => scenario({}, async (rt, calls) => {
  const hooks = { [preference]: 'a' };
  await rt.open(undefined, () => {}, permission, undefined, hooks); const pid = rt.process!.pid;
  assert.equal(await rt.prompt('saved', `drift:${preference}`), 'end_turn');
  assert.equal(rt.process!.pid, pid);
  await rt.open('saved', () => {}, permission, undefined, hooks);
  assert.notEqual(rt.process!.pid, pid);
  assert.equal(calls().filter(c => c.method === 'session/set_config_option' && c.params.configId === preference && c.params.value === 'a').length, 2);
}));
test('late output from an old task cannot arrive during the next task prompt', async () => scenario({}, async rt => {
  let first = ''; let second = '';
  await rt.open(undefined, text => first += text, permission);
  await rt.prompt('saved', 'late');
  await rt.open('saved', text => second += text, permission);
  assert.equal(await rt.prompt('saved', 'delayed'), 'end_turn');
  assert.equal(first, 'live');
  assert.equal(second, 'new task');
}));
test('multiple prompts within one open retain the same connection and session', async () => scenario({}, async (rt, calls) => {
  let text = '';
  await rt.open(undefined, chunk => text += chunk, permission); const pid = rt.process!.pid;
  await rt.prompt('saved', 'first');
  await rt.prompt('saved', 'second');
  assert.equal(rt.process!.pid, pid);
  assert.equal(text, 'livelive');
  assert.deepEqual(calls().filter(c => c.method === 'session/prompt').map(c => c.params.sessionId), ['saved', 'saved']);
  assert.equal(calls().filter(c => c.method === 'initialize').length, 1);
}));
