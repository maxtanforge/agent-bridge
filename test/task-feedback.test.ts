import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { TaskFeedback } from '../src/task-feedback.ts';
import { AgentState } from '../src/agent-state.ts';

test('silent fallback retries with backoff, recovers, and stops retrying after completion', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let calls = 0; let removed = 0;
  const f = new TaskFeedback({ delayMs: 5000, ready: () => true,
    startTyping: async () => 'r', stopTyping: async () => { removed++; },
    send: async () => { calls++; if (calls === 1) throw new Error('network'); return calls >= 3; } });
  t.mock.timers.tick(5000); await nextTurn(); assert.equal(calls, 1);
  t.mock.timers.tick(999); await nextTurn(); assert.equal(calls, 1);
  t.mock.timers.tick(1); await nextTurn(); assert.equal(calls, 2);
  t.mock.timers.tick(2000); await nextTurn(); assert.equal(calls, 3); assert.equal(removed, 1);
  await f.dispose(); t.mock.timers.tick(10000); await nextTurn(); assert.equal(calls, 3);
});

test('permanent feedback failure has a bounded retry budget and stop cancels retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let calls = 0;
  const f = new TaskFeedback({ delayMs: 5000, ready: () => true, send: async () => { calls++; return false; } });
  for (const ms of [5000, 1000, 2000, 4000, 20000]) { t.mock.timers.tick(ms); await nextTurn(); }
  assert.equal(calls, 4);
  f.update('new', 'running'); t.mock.timers.tick(250); await nextTurn(); assert.equal(calls, 5);
  await f.dispose(); t.mock.timers.tick(10000); await nextTurn(); assert.equal(calls, 5);
});

test('silent startup gets feedback at five seconds and removes typing; late updates are ignored', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const events: string[] = [];
  const f = new TaskFeedback({ delayMs: 5000, ready: () => true,
    startTyping: async () => { events.push('typing'); return 'r'; },
    stopTyping: async () => { events.push('removed'); },
    send: async (text, activity) => { events.push(`${activity}:${text}`); return true; } });
  await nextTurn(); t.mock.timers.tick(4999); await nextTurn();
  assert.deepEqual(events, ['typing']);
  t.mock.timers.tick(1); await nextTurn();
  assert.deepEqual(events, ['typing', '正在处理，完成后通知你。:', 'removed']);
  await f.stop(); await f.dispose(); f.update('late', 'late');
  t.mock.timers.tick(10000); await nextTurn(); assert.equal(events.length, 3);
});

test('feedback serializes updates and stop waits for pending delivery', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let release!: () => void; const texts: string[] = [];
  const f = new TaskFeedback({ delayMs: 5000, ready: () => true,
    send: async text => { texts.push(text); await new Promise<void>(r => { release = r; }); return true; } });
  f.update('first', '正在执行'); t.mock.timers.tick(250); await nextTurn();
  f.update('second', '正在执行'); t.mock.timers.tick(250); await nextTurn();
  let stopped = false; const stop = f.stop().then(() => { stopped = true; });
  await nextTurn(); assert.equal(stopped, false); assert.deepEqual(texts, ['first']);
  release(); await stop; await f.dispose();
  t.mock.timers.tick(5000); assert.deepEqual(texts, ['first']);
});

test('late typing creation is removed after visible feedback, even after disposal', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let release!: (id: string) => void; let removed = 0;
  const f = new TaskFeedback({ delayMs: 5000, ready: () => true,
    startTyping: () => new Promise(r => { release = r; }), stopTyping: async () => { removed++; },
    send: async () => true });
  f.update('answer', '正在回复'); t.mock.timers.tick(250); await nextTurn();
  await f.stop(); const disposed = f.dispose(); release('r'); await disposed;
  assert.equal(removed, 1);
});

test('failed progress leaves typing until fallback succeeds; queued feedback waits', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let ready = false; let attempts = 0; let removed = 0;
  const f = new TaskFeedback({ delayMs: 5000, ready: () => ready,
    startTyping: async () => 'r', stopTyping: async () => { removed++; },
    send: async () => ++attempts > 1 });
  f.update('draft', '正在回复'); t.mock.timers.tick(250); await nextTurn(); assert.equal(attempts, 0);
  ready = true; t.mock.timers.tick(250); await nextTurn(); assert.equal(removed, 0);
  t.mock.timers.tick(4500); await nextTurn(); assert.equal(removed, 1);
  await f.stop(); await f.dispose();
});

test('activity preserves other running tools when the newest tool completes', () => {
  const state = new AgentState();
  const update = (id: string, status: string) => state.apply({ type: 'update', update: {
    sessionUpdate: 'tool_call_update', toolCallId: id, title: id, status } });
  update('test suite', 'in_progress'); update('read file', 'completed');
  assert.match(state.activityText(), /test suite/);
  update('test suite', 'completed'); assert.doesNotMatch(state.activityText(), /正在执行工具/);
});
