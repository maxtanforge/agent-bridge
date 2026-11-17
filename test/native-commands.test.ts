import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { Bridge } from '../src/bridge.ts';
import { Store } from '../src/store.ts';
import { SessionRestoreError } from '../src/runtime.ts';
import type { Inbound, Runtime, RuntimeHooks } from '../src/types.ts';

const message: Inbound = { account: 'a', chat: 'c', thread: 't', user: 'u', id: 'work', text: 'work' };
function fixture() {
  const db = new Store(':memory:'); const sent: string[] = []; const steered: string[] = [];
  let hooks: RuntimeHooks; let finish!: () => void; let prompts = 0;
  const runtime: Runtime = { async open(_old, _text, _permission, _signal, h) {
    hooks = h!; h?.onEvent?.({ type: 'capabilities', steering: true, image: true });
    h?.onEvent?.({ type: 'update', update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'review', description: 'Review' }] } });
    return 'native';
  }, async prompt() { prompts++; await new Promise<void>(r => { finish = r; }); return 'end_turn'; },
  async steer(_session, text) { steered.push(text); return 'injected'; }, async cancel() { finish?.(); }, async stop() { finish?.(); } };
  const bridge = new Bridge(db, runtime, { async send(_m, text) { sent.push(text); } }, { users: ['u', 'v'], admins: [], workspace: 'w', taskTimeout: 10000, cancelGrace: 10, queueLimit: 1 });
  let counter = 0;
  return { db, bridge, sent, runtime, steered, hooks: () => hooks, prompts: () => prompts,
    command: (text: string, user = 'u') => bridge.handle({ ...message, id: `cmd-${++counter}`, text, user }),
    finish: () => finish(), async close() { await bridge.stop(); db.close(); } };
}

test('ordinary busy text steers once; only explicit queue commands create follow-up tasks', async () => {
  const f = fixture(); const running = f.bridge.handle(message);
  try {
    await nextTurn();
    const input = { ...message, id: 'guidance', text: '先不要推送' };
    await f.bridge.handle(input); await f.bridge.handle(input);
    assert.deepEqual(f.steered, ['先不要推送']);
    await f.command('/queue 后续运行测试');
    await f.command('/queue'); assert.match(f.sent.at(-1)!, /后续运行测试/);
    assert.equal(f.prompts(), 1);
    await f.command('/cancel all'); f.finish(); await running;
  } finally { await f.close(); }
});

test('failed or unsupported automatic steering never becomes a queued task', async () => {
  const f = fixture(); const running = f.bridge.handle(message);
  try {
    await nextTurn(); f.runtime.steer = async () => { throw new Error('uncertain'); };
    await f.command('补充要求'); assert.match(f.sent.at(-1)!, /未确认/);
    await f.command('/queue'); assert.match(f.sent.at(-1)!, /没有/);
    await f.command('别人的消息', 'v'); assert.match(f.sent.at(-1)!, /本人|其他/);
    assert.equal(f.prompts(), 1); f.finish(); await running;
  } finally { await f.close(); }
});

test('queue payload bypasses both pending answers and control-command interpretation', async () => {
  const f = fixture(); const running = f.bridge.handle(message);
  try {
    await nextTurn();
    const answer = f.hooks().onQuestion!({ sessionId: 'native', message: 'Choose', requestedSchema: {
      type: 'object', properties: { choice: { type: 'string' } } } });
    await nextTurn(); await f.command('/queue /cancel');
    assert.match(f.sent.at(-1)!, /已加入队列/); assert.equal(f.bridge.active!.cancelled, false);
    await f.command('继续'); assert.deepEqual(await answer, { action: 'accept', content: { choice: '继续' } });
    assert.equal(f.steered.length, 0);
    await f.command('/cancel all'); f.finish(); await running;
  } finally { await f.close(); }
});

test('messages during startup are buffered and delivered when the original prompt is ready', async () => {
  const f = fixture(); let release!: () => void; const open = f.runtime.open;
  f.runtime.open = async (...args) => { await new Promise<void>(r => { release = r; }); return open(...args); };
  const running = f.bridge.handle(message);
  try {
    await nextTurn(); await f.command('补充内容');
    assert.match(f.sent.at(-1)!, /已接收/); assert.equal(f.steered.length, 0);
    assert.equal(f.db.db.prepare("SELECT count(*) AS n FROM tasks WHERE status='queued'").get()!.n, 0);
    release(); await nextTurn(); assert.deepEqual(f.steered, ['补充内容']); f.finish(); await running;
  } finally { release?.(); await f.close(); }
});

test('startup supplements are bounded and status and cancellation stay available when full', async () => {
  const f = fixture(); const gate = Promise.withResolvers<void>(); const open = f.runtime.open;
  f.runtime.open = async (...args) => { await gate.promise; args[3]?.throwIfAborted(); return open(...args); };
  const running = f.bridge.handle(message);
  try {
    await nextTurn();
    for (let i = 0; i < 20; i++) await f.command(`supplement-${i}`);
    await f.command('overflow'); assert.match(f.sent.at(-1)!, /补充已满.*未接收/);
    await f.command('/status'); assert.match(f.sent.at(-1)!, /待投递补充：20 条/);
    assert.equal(f.db.db.prepare("SELECT count(*) AS n FROM tasks WHERE status='queued'").get()!.n, 0);
    const cancelled = f.command('/cancel'); gate.resolve(); await Promise.all([cancelled, running]);
    assert.deepEqual(f.steered, []); assert.equal(f.prompts(), 0);
    assert.match(f.sent.join('\n'), /20 条待投递补充未执行/);
  } finally { gate.resolve(); await f.close(); }
});

test('concurrent supplements are delivered serially without rejecting the second message', async () => {
  const f = fixture(); const running = f.bridge.handle(message); let release!: () => void;
  try {
    await nextTurn();
    f.runtime.steer = async (_session, text) => {
      f.steered.push(text);
      if (text === 'first') await new Promise<void>(r => { release = r; });
      return 'injected';
    };
    const first = f.command('first'); await nextTurn();
    const second = f.command('second'); await nextTurn();
    assert.deepEqual(f.steered, ['first']);
    release(); await Promise.all([first, second]);
    assert.deepEqual(f.steered, ['first', 'second']);
    f.finish(); await running;
  } finally { release?.(); await f.close(); }
});

test('promptRequired continues once in the same session ahead of an explicit queued task', async () => {
  const f = fixture(); const requests: string[] = []; const prompt = f.runtime.prompt;
  f.runtime.prompt = async (session, text) => { requests.push(`${session}:${text}`); return prompt(session, text); };
  const running = f.bridge.handle(message);
  try {
    await nextTurn(); await f.command('/queue independent');
    f.runtime.steer = async () => { f.finish(); return 'promptRequired'; };
    const supplement = { ...message, id: 'continue-once', text: 'continue' };
    await f.bridge.handle(supplement); await f.bridge.handle(supplement); await nextTurn();
    assert.deepEqual(requests, ['native:work', 'native:continue']);
    await f.command('/cancel all'); f.finish(); await running;
  } finally { await f.close(); }
});

test('native slash commands wait for a prompt boundary instead of being steered', async () => {
  const f = fixture(); const texts: string[] = []; const prompt = f.runtime.prompt;
  f.runtime.prompt = async (session, text) => { texts.push(text); return prompt(session, text); };
  const running = f.bridge.handle(message);
  try {
    await nextTurn(); await f.command('/compact');
    assert.deepEqual(f.steered, []); assert.deepEqual(texts, ['work']);
    f.finish(); await nextTurn(); assert.deepEqual(texts, ['work', '/compact']);
    f.finish(); await running;
  } finally { await f.close(); }
});

test('busy attachments are prepared and delivered to the current session only', async () => {
  const f = fixture(); const running = f.bridge.handle(message); const deliveries: unknown[] = [];
  f.bridge.channel.prepare = async () => [{ type: 'text', text: 'attachment body' }];
  f.runtime.steer = async (session, text, attachments) => { deliveries.push({ session, text, attachments }); return 'injected'; };
  try {
    await nextTurn();
    await f.bridge.handle({ ...message, id: 'supplement-file', text: 'look at this', attachment: { type: 'file', key: 'file' } });
    assert.deepEqual(deliveries, [{ session: 'native', text: 'look at this', attachments: [{ type: 'text', text: 'attachment body' }] }]);
    f.finish(); await running;
  } finally { await f.close(); }
});

test('cancelling during attachment preparation never delivers that input to another task', async () => {
  const f = fixture(); const running = f.bridge.handle(message); let downloaded!: () => void;
  f.bridge.channel.prepare = async () => { await new Promise<void>(r => { downloaded = r; }); return [{ type: 'text', text: 'late file' }]; };
  try {
    await nextTurn();
    const input = f.bridge.handle({ ...message, id: 'late-file', attachment: { type: 'file', key: 'file' } });
    await nextTurn();
    const cancel = f.command('/cancel');
    await Promise.race([Promise.all([cancel, running]), new Promise((_, reject) => setTimeout(() => reject(new Error('cancel blocked by download')), 150))]);
    downloaded(); await input;
    assert.deepEqual(f.steered, []); assert.equal(f.prompts(), 1);
  } finally { downloaded?.(); await f.close(); }
});

test('cancellation does not wait for an unresolved steering response or retry it', async () => {
  const f = fixture(); const running = f.bridge.handle(message); let respond!: () => void;
  f.runtime.steer = async (_s, text) => { f.steered.push(text); await new Promise<void>(r => { respond = r; }); return 'injected'; };
  try {
    await nextTurn(); const input = f.command('supplement'); await nextTurn();
    const cancel = f.command('/cancel');
    await Promise.race([Promise.all([cancel, running]), new Promise((_, reject) => setTimeout(() => reject(new Error('cancel blocked by steering')), 150))]);
    respond(); await input; assert.deepEqual(f.steered, ['supplement']); assert.equal(f.prompts(), 1);
  } finally { respond?.(); await f.close(); }
});

test('ordinary replies answer pending questions before a full queue and duplicate replies never become tasks', async () => {
  const f = fixture(); const running = f.bridge.handle(message);
  try {
    await nextTurn(); await f.command('/queue queued task');
    const answer = f.hooks().onQuestion!({ sessionId: 'native', message: 'Choose', requestedSchema: {
      type: 'object', properties: { choice: { type: 'string', enum: ['keep', 'change'] } }, required: ['choice'] } });
    await nextTurn();
    await f.command('wrong'); assert.match(f.sent.at(-1)!, /无效/);
    const reply = { ...message, id: 'natural-answer', text: 'keep' };
    await f.bridge.handle(reply); assert.deepEqual(await answer, { action: 'accept', content: { choice: 'keep' } });
    const count = f.sent.length; await f.bridge.handle(reply); assert.equal(f.sent.length, count);
    assert.equal(f.prompts(), 1);
    await f.command('/queue'); assert.match(f.sent.at(-1)!, /queued task/); assert.doesNotMatch(f.sent.at(-1)!, /natural-answer|wrong/);
    await f.command('/cancel all'); f.finish(); await running;
  } finally { await f.close(); }
});

test('natural answers are owner and thread scoped; attachments are not silently queued as answers', async () => {
  const f = fixture(); const running = f.bridge.handle(message);
  try {
    await nextTurn();
    const answer = f.hooks().onQuestion!({ sessionId: 'native', message: 'Choose', requestedSchema: {
      type: 'object', properties: { choice: { type: 'string', enum: ['keep'] } } } });
    await nextTurn();
    await f.command('keep', 'v'); assert.match(f.sent.at(-1)!, /其他会话/);
    await f.command('/cancel all', 'v');
    await f.bridge.handle({ ...message, id: 'other-thread', thread: 'other', text: 'keep' });
    assert.match(f.sent.at(-1)!, /其他会话/);
    await f.bridge.handle({ ...message, id: 'other-cancel', thread: 'other', text: '/cancel all' });
    await f.bridge.handle({ ...message, id: 'file-answer', attachment: { type: 'file', key: 'resource' }, text: 'keep' });
    assert.match(f.sent.at(-1)!, /等待文字回答/);
    await f.command('keep'); assert.deepEqual(await answer, { action: 'accept', content: { choice: 'keep' } });
    f.finish(); await running;
  } finally { await f.close(); }
});

test('ACP metadata survives in task results and owner-scoped session history', async () => {
  const f = fixture(); const running = f.bridge.handle(message);
  try {
    await nextTurn();
    f.hooks().onEvent?.({ type: 'update', update: { sessionUpdate: 'session_info_update', title: '修复构建' } });
    f.hooks().onEvent?.({ type: 'update', update: { sessionUpdate: 'tool_call_update', toolCallId: 'edit', status: 'completed', content: [
      { type: 'diff', path: '/private/project/build.ts', oldText: 'private-content', newText: 'new-content' },
    ] } });
    f.finish(); await running;
    await f.command('/result');
    assert.match(f.sent.at(-1)!, /build\.ts/);
    assert.doesNotMatch(f.sent.at(-1)!, /\/private|private-content|new-content/);
    await f.command('/resume native');
    await f.command('/sessions');
    assert.match(f.sent.at(-1)!, /修复构建/);
    await f.command('/sessions', 'v');
    assert.doesNotMatch(f.sent.at(-1)!, /修复构建/);
  } finally { await f.close(); }
});

test('native queries and steering bypass full queue while preserving owner isolation', async () => {
  const f = fixture(); const running = f.bridge.handle(message);
  try {
    await nextTurn(); await f.command('/queue queued');
    await f.command('/commands'); assert.match(f.sent.at(-1)!, /\/review/);
    await f.command('/commands', 'v'); assert.doesNotMatch(f.sent.at(-1)!, /\/review/);
    await f.command('/steer do not commit', 'v'); assert.equal(f.steered.length, 0);
    await f.command('/steer do not commit'); assert.deepEqual(f.steered, ['do not commit']);
    assert.equal(f.prompts(), 1);
    f.hooks().onEvent?.({ type: 'update', update: { sessionUpdate: 'tool_call', toolCallId: 't', title: 'Test suite', status: 'in_progress' } });
    await f.command('/status'); assert.match(f.sent.at(-1)!, /Test suite/);
    await f.command('/cancel all'); f.finish(); await running;
    await f.command('/steer too late'); assert.equal(f.steered.length, 1);
  } finally { await f.close(); }
});

test('answer resumes only the owning pending question and task cancellation releases it', async () => {
  const f = fixture(); const running = f.bridge.handle(message);
  try {
    await nextTurn();
    const answer = f.hooks().onQuestion!({ sessionId: 'native', message: 'Choose', requestedSchema: { type: 'object', properties: { value: { type: 'string' } } } });
    await nextTurn(); const id = /\/answer ([\w-]+)/.exec(f.sent.at(-1)!)![1];
    await f.command(`/answer ${id} hello`, 'v'); assert.match(f.sent.at(-1)!, /无权|不存在/);
    await f.command(`/answer ${id} hello`); assert.deepEqual(await answer, { action: 'accept', content: { value: 'hello' } });
    const abandoned = f.hooks().onQuestion!({ sessionId: 'native', message: 'Again', requestedSchema: { type: 'object', properties: { value: { type: 'string' } } } });
    await f.command('/cancel'); await running; assert.deepEqual(await abandoned, { action: 'cancel' });
  } finally { await f.close(); }
});

test('reply-to question messages select the right request and expired replies never become new work', async () => {
  const f = fixture(); const running = f.bridge.handle(message); let n = 0;
  f.bridge.channel.question = async () => `question-message-${++n}`;
  try {
    await nextTurn();
    const one = f.hooks().onQuestion!({ sessionId: 'native', message: 'One', requestedSchema: { type: 'object', properties: { answer: { type: 'string' } } } });
    const two = f.hooks().onQuestion!({ sessionId: 'native', message: 'Two', requestedSchema: { type: 'object', properties: { answer: { type: 'string' } } } });
    await nextTurn();
    await f.bridge.handle({ ...message, id: 'reply-two', replyTo: 'question-message-2', text: 'second', unmentioned: true });
    assert.deepEqual(await two, { action: 'accept', content: { answer: 'second' } });
    await f.bridge.handle({ ...message, id: 'wrong-owner', user: 'v', replyTo: 'question-message-1', text: 'wrong', unmentioned: true });
    await f.bridge.handle({ ...message, id: 'reply-one', replyTo: 'question-message-1', text: 'first', unmentioned: true });
    assert.deepEqual(await one, { action: 'accept', content: { answer: 'first' } });
    f.finish(); await running;
    await f.bridge.handle({ ...message, id: 'expired-answer', replyTo: 'question-message-2', text: 'late' });
    assert.match(f.sent.at(-1)!, /过期|已结束/); assert.equal(f.prompts(), 1);
  } finally { await f.close(); }
});

test('group replies to the latest draft and questions reminder stay associated with the same form', async () => {
  const f = fixture(); const running = f.bridge.handle(message); let n = 0;
  f.bridge.channel.question = async (_m, text) => { f.sent.push(text); return `form-${++n}`; };
  try {
    await nextTurn();
    const result = f.hooks().onQuestion!({ sessionId: 'native', message: 'Two fields', requestedSchema: {
      type: 'object', properties: { first: { type: 'string' }, second: { type: 'string' } }, required: ['first', 'second'] } });
    await nextTurn();
    await f.bridge.handle({ ...message, id: 'first', replyTo: 'form-1', unmentioned: true, text: 'one' });
    assert.equal(n, 2);
    await f.bridge.handle({ ...message, id: 'second', replyTo: 'form-2', unmentioned: true, text: 'two' });
    assert.equal(n, 3);
    await f.command('/questions'); assert.equal(n, 4);
    await f.bridge.handle({ ...message, id: 'submit', replyTo: 'form-4', unmentioned: true, text: '提交' });
    assert.deepEqual(await result, { action: 'accept', content: { first: 'one', second: 'two' } });
    f.finish(); await running;
  } finally { await f.close(); }
});

test('history and preferences persist but cannot select another owner session', () => {
  const db = new Store(':memory:');
  try {
    db.saveSession('owner', 'mine'); db.saveSession('other', 'secret'); db.forget('owner');
    assert.equal(db.resumeSession('owner', 'secret'), false);
    assert.equal(db.resumeSession('owner', 'mine'), true); assert.equal(db.session('owner'), 'mine');
    assert.deepEqual(db.sessionHistory('owner').map(s => s.acp), ['mine']);
    db.setPreference('owner', 'mode', 'plan'); assert.equal(db.preferences('owner').mode, 'plan');
  } finally { db.close(); }
});

test('restore failures preserve the binding and unexecuted input for explicit recovery', async () => {
  const f = fixture();
  try {
    f.db.saveSession(f.bridge.key(message), 'saved-session');
    f.runtime.open = async old => { throw new SessionRestoreError(old!); };
    await f.bridge.handle({ ...message, text: '按刚才的方案继续' });
    assert.equal(f.prompts(), 0); assert.equal(f.db.session(f.bridge.key(message)), 'saved-session');
    assert.match(f.sent.at(-1)!, /恢复失败/); assert.match(f.sent.at(-1)!, /按刚才的方案继续/);
    assert.match(f.db.latestResult(f.bridge.key(message))!.text, /\/new/);
  } finally { await f.close(); }
});

test('attachments are prepared only when authorized work executes, never for rejected or cancelled queued work', async () => {
  const f = fixture(); const prepared: string[] = []; const blocks: unknown[] = [];
  f.bridge.channel.prepare = async (m, signal) => { signal.throwIfAborted(); prepared.push(m.id); return [{ type: 'text', text: 'log contents' }]; };
  const prompt = f.runtime.prompt;
  f.runtime.prompt = async (session, text, attachments) => { blocks.push(attachments); return prompt(session, text); };
  const attachment = { type: 'file' as const, key: 'resource', name: 'test.log' };
  try {
    await f.bridge.handle({ ...message, id: 'unauthorized', user: 'stranger', attachment });
    assert.deepEqual(prepared, []);
    const run = f.bridge.handle({ ...message, attachment }); await nextTurn();
    assert.deepEqual(prepared, ['work']); assert.deepEqual(blocks, [[{ type: 'text', text: 'log contents' }]]);
    await f.bridge.handle({ ...message, id: 'queued-file', text: '/queue work', attachment });
    await f.command('/cancel all'); f.finish(); await run;
    assert.deepEqual(prepared, ['work']);
  } finally { await f.close(); }
});
