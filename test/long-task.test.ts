import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { Bridge } from '../src/bridge.ts';
import { Store } from '../src/store.ts';
import type { Runtime, RuntimeHooks, Inbound, TaskReply } from '../src/types.ts';

const message: Inbound = { account: 'a', chat: 'c', thread: 't', user: 'u', id: 'work', text: 'long task' };

test('shows the foreground reply while background work still holds the queue', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const db = new Store(':memory:');
  const replies: TaskReply[] = [];
  const sent: string[] = [];
  const finish = Promise.withResolvers<string>();
  let hooks: RuntimeHooks | undefined;
  let write!: (text: string) => void;
  let prompts = 0;
  const runtime: Runtime = {
    async open(_old, update, _permission, _signal, options) {
      hooks = options;
      write = update;
      return 's';
    },
    async prompt() {
      if (++prompts > 1) return 'end_turn';
      write('foreground response');
      hooks?.onEvent?.({ type: 'background', activity: {
        running: 2, completed: 0, failed: 0, stopped: 0,
        items: [{ title: 'Review', status: 'running' }, { title: 'Build', status: 'running' }],
      } });
      return finish.promise;
    },
    async cancel() { finish.resolve('cancelled'); },
    async stop() {},
  };
  const bridge = new Bridge(db, runtime, {
    async send(_m, text) { sent.push(text); },
    async task(_m, reply) { replies.push(reply); },
  }, { users: ['u'], admins: [], workspace: 'w', taskTimeout: 10000, cancelGrace: 10 });
  const run = bridge.handle(message);
  try {
    await nextTurn();
    await bridge.handle({ ...message, id: 'queued', text: '/queue next' });
    await bridge.handle({ ...message, id: 'status-bg', text: '/status' });
    t.mock.timers.tick(250);
    await nextTurn();
    assert.equal(prompts, 1);
    assert.match(sent.at(-1)!, /等待后台任务/);
    assert.match(replies.at(-1)!.activity!, /后台.*2 项/);
    assert.match(replies.at(-1)!.activity!, /Review（运行中）/);
    assert.equal(replies.at(-1)!.text, 'foreground response');
    assert.equal(replies.at(-1)!.state, 'running');
    finish.resolve('background_failed');
    await run;
    await nextTurn();
    assert.equal(prompts, 2);
    assert.equal(replies.find(reply => reply.state === 'failed')?.notifyCompletion, true);
    assert.ok(replies.some(reply => reply.state === 'failed' && /后台任务失败或被停止/.test(reply.text)));
  } finally {
    finish.resolve('cancelled');
    await run;
    await bridge.stop();
    db.close();
    t.mock.timers.reset();
  }
});
function fixture() {
  const db = new Store(':memory:'); const sent: string[] = [];
  let finish!: (reason: string) => void; let update!: (text: string) => void; let prompts = 0; let stops = 0;
  const runtime: Runtime = {
    async open(_old, cb) { update = cb; return 'session'; },
    async prompt() { prompts++; return new Promise<string>(resolve => { finish = resolve; }); },
    async cancel() { finish('cancelled'); }, async stop() { stops++; finish?.('cancelled'); },
  };
  const bridge = new Bridge(db, runtime, {
    async send(_m, text) { sent.push(text); },
  }, { users: ['u', 'v', 'admin'], admins: ['admin'], workspace: 'w', replyMode: 'stream', taskTimeout: 7200000, cancelGrace: 10 });
  return { db, bridge, sent, runtime, finish: (reason = 'end_turn') => finish(reason), update: (text: string) => update(text),
    prompts: () => prompts, stops: () => stops };
}

test('status is a control command when idle and never starts Claude', async () => {
  const f = fixture(); let prompts = 0;
  f.runtime.prompt = async () => { prompts++; return 'end_turn'; };
  try {
    await f.bridge.handle({ ...message, text: '/status' });
    assert.equal(prompts, 0); assert.match(f.sent.at(-1)!, /没有正在执行/);
  } finally { await f.bridge.stop(); f.db.close(); }
});

test('an hour without output keeps the session alive; status and final delivery still work', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1700000000000 });
  const f = fixture(); const run = f.bridge.handle(message);
  try {
    await nextTurn(); t.mock.timers.tick(3600000); await nextTurn();
    await f.bridge.handle({ ...message, id: 'status-hour', text: '/status' });
    assert.equal(f.stops(), 0); assert.ok(f.bridge.active); assert.equal(f.prompts(), 1);
    assert.match(f.sent.at(-1)!, /执行中/); assert.match(f.sent.at(-1)!, /60 分钟/);
    assert.match(f.sent.at(-1)!, /暂未收到文字进展/);
    f.update('finished after one hour'); f.finish(); await run;
    assert.equal(f.bridge.active, undefined);
    assert.equal(f.db.latestResult(f.bridge.key(message))?.text, 'finished after one hour');
    assert.equal(f.db.latestResult(f.bridge.key(message))?.delivery, 'sent');
  } finally { f.finish(); await run; await f.bridge.stop(); f.db.close(); t.mock.timers.reset(); }
});

test('status shows recent output time without leaking it to other users or conversations', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1700000000000 });
  const f = fixture(); const run = f.bridge.handle(message);
  try {
    await nextTurn(); f.update('PRIVATE_OUTPUT'); t.mock.timers.tick(60000); await nextTurn();
    for (const [index, override] of [
      { user: 'v' }, { thread: 'other' }, { chat: 'other' }, { account: 'other' },
      { user: 'admin', thread: 'other' },
    ].entries()) {
      await f.bridge.handle({ ...message, ...override, id: `hidden-${index}`, text: '/status' });
      assert.doesNotMatch(f.sent.at(-1)!, /PRIVATE_OUTPUT|已运行|最近文本输出/);
    }
    for (const user of ['u', 'admin']) {
      await f.bridge.handle({ ...message, user, id: `visible-${user}`, text: '/status' });
      assert.match(f.sent.at(-1)!, /最近文本输出：1 分钟/);
      assert.doesNotMatch(f.sent.at(-1)!, /PRIVATE_OUTPUT/);
    }
    const count = f.sent.length;
    await f.bridge.handle({ ...message, user: 'stranger', id: 'unauthorized', text: '/status' });
    assert.equal(f.sent.length, count);
  } finally { f.finish(); await run; await f.bridge.stop(); f.db.close(); t.mock.timers.reset(); }
});

test('the two-hour execution deadline cancels and releases the session', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 1700000000000 });
  const f = fixture(); const run = f.bridge.handle(message);
  try {
    await nextTurn(); t.mock.timers.tick(7199999); await nextTurn();
    assert.ok(f.bridge.active); assert.equal(f.stops(), 0);
    t.mock.timers.tick(1); await run;
    assert.equal(f.bridge.active, undefined); assert.ok(f.stops() > 0);
    assert.match(f.db.latestResult(f.bridge.key(message))!.text, /达到执行时限/);
  } finally { f.finish(); await run; await f.bridge.stop(); f.db.close(); t.mock.timers.reset(); }
});

test('status distinguishes session startup from final delivery and becomes idle after cleanup', async () => {
  const f = fixture(); const open = f.runtime.open;
  let releaseOpen!: () => void; let releaseDelivery!: () => void;
  const opening = new Promise<void>(r => { releaseOpen = r; });
  const delivery = new Promise<void>(r => { releaseDelivery = r; });
  f.runtime.open = async (...args) => { await opening; return open(...args); };
  f.bridge.channel.task = async () => { await delivery; };
  const run = f.bridge.handle(message);
  try {
    await f.bridge.handle({ ...message, id: 'starting', text: '/status' });
    assert.match(f.sent.at(-1)!, /准备中/);
    releaseOpen(); await nextTurn(); f.finish(); await nextTurn();
    await f.bridge.handle({ ...message, id: 'delivering', text: '/status' });
    assert.match(f.sent.at(-1)!, /结果发送与清理中/);
    await f.bridge.handle({ ...message, id: 'late-cancel', text: '/cancel' });
    await f.bridge.handle({ ...message, id: 'still-delivering', text: '/status' });
    assert.match(f.sent.at(-1)!, /结果发送与清理中/);
    releaseDelivery(); await run;
    await f.bridge.handle({ ...message, id: 'idle', text: '/status' });
    assert.match(f.sent.at(-1)!, /没有正在执行/);
  } finally { releaseOpen(); releaseDelivery(); await nextTurn(); f.finish(); await run; await f.bridge.stop(); f.db.close(); }
});

test('status remains available while a cancellation is waiting for execution to stop', async () => {
  const f = fixture(); f.runtime.cancel = async () => {};
  f.bridge.options.cancelGrace = 1000;
  const run = f.bridge.handle(message); await nextTurn();
  const cancelling = f.bridge.handle({ ...message, id: 'cancel', text: '/cancel' });
  try {
    await f.bridge.handle({ ...message, id: 'cancelling', text: '/status' });
    assert.match(f.sent.at(-1)!, /取消中/);
  } finally { f.finish('cancelled'); await run; await cancelling; await f.bridge.stop(); f.db.close(); }
});
