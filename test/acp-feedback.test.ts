import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { Bridge } from '../src/bridge.ts';
import { Store } from '../src/store.ts';
import type { Runtime, RuntimeHooks, TaskReply } from '../src/types.ts';
const m = { account: 'a', chat: 'c', thread: '', user: 'u', id: 'm', text: 'work' };

test('failed terminal persistence stops accepting more workspace changes', async () => {
  const db = new Store(':memory:'); let prompts = 0; let fatal = 0;
  const runtime: Runtime = { async open() { return 's'; }, async prompt() { prompts++; return 'end_turn'; }, async cancel() {}, async stop() {} };
  const b = new Bridge(db, runtime, { async send() {} },
    { users: ['u'], admins: [], workspace: 'w', taskTimeout: 10000, cancelGrace: 10, onFatal: () => { fatal++; } });
  db.complete = () => { throw new Error('disk full'); };
  try {
    await b.handle(m); await b.handle({ ...m, id: 'second' });
    assert.equal(prompts, 1); assert.equal(fatal, 1);
  } finally { await b.stop(); db.close(); }
});

test('default stream projects ACP activity and questions, controls bypass queue, late events cannot overwrite final', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1700000000000 });
  const db = new Store(':memory:'); const replies: TaskReply[] = []; const messages: string[] = [];
  let hooks!: RuntimeHooks; let output!: (text: string) => void; let finish!: () => void; let removed = 0;
  const runtime: Runtime = {
    async open(_old, cb, _permission, _signal, h) { output = cb; hooks = h!; return 's'; },
    async prompt() { await new Promise<void>(r => { finish = r; }); return 'end_turn'; },
    async cancel() { finish(); }, async stop() { finish?.(); },
  };
  const b = new Bridge(db, runtime, {
    async send(_m, text) { messages.push(text); }, async task(_m, reply) { replies.push(reply); },
    async startTyping() { return 'reaction'; }, async stopTyping() { removed++; },
  }, { users: ['u'], admins: [], workspace: 'w', taskTimeout: 60000, cancelGrace: 10 });
  const run = b.handle(m);
  const tool = (id: string, status: string) => hooks.onEvent?.({ type: 'update', update: {
    sessionUpdate: 'tool_call_update', toolCallId: id, title: id, status } });
  try {
    await nextTurn(); tool('tests', 'in_progress'); tool('read', 'completed');
    t.mock.timers.tick(250); await nextTurn();
    assert.match(replies.at(-1)!.activity!, /tests/); assert.equal(removed, 1);
    const question = hooks.onQuestion!({ sessionId: 's', message: 'Which?', requestedSchema: {
      type: 'object', properties: { choice: { type: 'string' } }, required: ['choice'] } });
    t.mock.timers.tick(250); await nextTurn(); assert.match(replies.at(-1)!.activity!, /等待你回答/);
    tool('another', 'in_progress'); t.mock.timers.tick(250); await nextTurn();
    assert.match(replies.at(-1)!.activity!, /等待你回答/);
    const id = /\/answer ([\w-]+)/.exec(messages.find(s => s.includes('/answer'))!)![1];
    await b.handle({ ...m, id: 'answer', text: `/answer ${id} yes` });
    assert.equal((await question).action, 'accept');
    t.mock.timers.tick(250); await nextTurn(); assert.match(replies.at(-1)!.activity!, /tests/);
    await b.handle({ ...m, id: 'status', text: '/status' }); assert.match(messages.at(-1)!, /当前任务/);
    t.mock.timers.tick(4000); await nextTurn(); output('done'); finish(); await run;
    assert.equal(replies.at(-1)!.state, 'completed'); assert.equal(replies.at(-1)!.text, 'done');
    assert.equal(replies.at(-1)!.notifyCompletion, true);
    const count = replies.length; tool('late', 'in_progress'); output('late');
    t.mock.timers.tick(5000); await nextTurn(); assert.equal(replies.length, count);
    assert.equal(db.latestResult(b.key(m))!.text, 'done');
  } finally { finish?.(); await b.stop(); db.close(); }
});

test('default silent stream emits a status at the threshold without releasing workspace', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1700000000000 });
  const db = new Store(':memory:'); let finish!: () => void; const replies: TaskReply[] = [];
  const runtime: Runtime = { async open() { return 's'; }, async prompt() { await new Promise<void>(r => { finish = r; }); return 'end_turn'; },
    async cancel() { finish(); }, async stop() { finish?.(); } };
  const b = new Bridge(db, runtime, { async send() {}, async task(_m, reply) { replies.push(reply); } },
    { users: ['u'], admins: [], workspace: 'w', taskTimeout: 60000, cancelGrace: 10 });
  const run = b.handle(m);
  try {
    await nextTurn(); t.mock.timers.tick(4999); await nextTurn(); assert.equal(replies.length, 0);
    t.mock.timers.tick(1); await nextTurn(); assert.match(replies[0].activity!, /正在处理/); assert.ok(b.active);
    finish(); await run; assert.equal(replies.at(-1)!.state, 'completed');
  } finally { finish?.(); await b.stop(); db.close(); }
});
