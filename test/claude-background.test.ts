import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { ClaudeBackground } from '../src/claude-background.ts';
import { TaskLimits } from '../src/task.ts';

function event(run: ClaudeBackground, subtype: string, fields: Record<string, unknown>) {
  run.apply({ type: 'system', subtype, ...fields });
}

test('an idle shell session settles after the command exits without a follow-up', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const run = new ClaudeBackground();
  const controller = new AbortController();
  try {
    event(run, 'task_started', { task_id: 'shell', task_type: 'local_bash', is_backgrounded: true });
    event(run, 'session_state_changed', { state: 'idle' });
    const settled = run.drain(controller.signal);
    event(run, 'task_notification', { task_id: 'shell', status: 'completed' });
    await nextTurn();
    t.mock.timers.tick(TaskLimits.BackgroundFollowupGraceMs);
    assert.equal(await Promise.race([settled.then(() => 'done'), nextTurn('pending')]), 'done');
  } finally { controller.abort(); }
});

test('a resumed background subagent without a run ID holds the task', () => {
  const run = new ClaudeBackground();
  event(run, 'task_started', { task_id: 'review', task_type: 'local_agent', is_backgrounded: true });
  event(run, 'task_notification', { task_id: 'review', status: 'completed' });
  event(run, 'task_updated', { task_id: 'review', patch: { status: 'running' } });
  assert.equal(run.activity().running, 1);
  assert.equal(run.activity().completed, 0);
});

test('an early idle cannot hide the error result of a native follow-up', async () => {
  const run = new ClaudeBackground();
  const controller = new AbortController();
  const origin = { kind: 'task-notification', runId: '02' };
  try {
    event(run, 'task_started', { task_id: 'review', task_type: 'local_agent', is_backgrounded: true });
    event(run, 'task_notification', { task_id: 'review', status: 'completed' });
    run.apply({ type: 'user', origin });
    event(run, 'session_state_changed', { state: 'idle' });
    const settled = run.drain(controller.signal);
    assert.equal(await Promise.race([settled.then(() => 'done'), nextTurn('pending')]), 'pending');
    run.apply({ type: 'result', origin, is_error: true, num_turns: 1 });
    await settled;
    assert.equal(run.followupFailed, true);
  } finally { controller.abort(); }
});
