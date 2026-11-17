import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Interactions } from '../src/interactions.ts';

const question = { sessionId: 's', message: 'Choose', requestedSchema: { type: 'object' as const,
  properties: { choice: { type: 'string', oneOf: [{ const: 'A', title: 'A' }, { const: 'B', title: 'B' }] } }, required: ['choice'] } };

test('repeated reminders keep reply references bounded even for an active question', async () => {
  const pending = new Interactions();
  const result = pending.ask('owner', question, undefined, async () => true);
  try {
    const id = pending.list('owner')[0].id;
    for (let i = 0; i < 1025; i++) await pending.notify('owner', id, 'reminder', async () => `message-${i}`);
    assert.equal(pending.matches('owner', 'message-0'), false);
    assert.equal(pending.matches('owner', 'message-1'), true);
    assert.equal(pending.matches('owner', 'message-1024'), true);
    assert.match(pending.reply('owner', '2', 'message-1024')!, /已提交/);
    assert.deepEqual(await result, { action: 'accept', content: { choice: 'B' } });
  } finally { pending.cancel('owner'); }
});

test('conversational answers accept option labels and numbers without a question ID', async () => {
  for (const input of ['现状即可', '2']) {
    const pending = new Interactions(); let rendered = '';
    const result = pending.ask('owner', { ...question, requestedSchema: { type: 'object', properties: {
      question_0: { type: 'string', oneOf: [{ const: 'change', title: '改 module 路径' }, { const: 'keep', title: '现状即可' }] },
      question_0_custom: { type: 'string', title: 'Other' },
    } } }, undefined, async text => { rendered = text; return true; });
    assert.match(rendered, /2\. 现状即可/); assert.match(rendered, /直接回复/);
    assert.doesNotMatch(rendered, /question_0_custom/);
    assert.equal(pending.reply('other', input), undefined);
    assert.match(pending.reply('owner', input)!, /已提交/);
    assert.deepEqual(await result, { action: 'accept', content: { question_0: 'keep' } });
  }
});

test('custom answers use the native sibling field, while invalid option numbers stay pending', async () => {
  const pending = new Interactions();
  const result = pending.ask('owner', { ...question, requestedSchema: { type: 'object', properties: {
    question_0: { type: 'string', enum: ['A', 'B'] }, question_0_custom: { type: 'string' },
  } } }, undefined, async () => true);
  assert.match(pending.reply('owner', '9')!, /无效/); assert.equal(pending.count('owner'), 1);
  pending.reply('owner', '先只改测试环境');
  assert.deepEqual(await result, { action: 'accept', content: { question_0_custom: '先只改测试环境' } });
});

test('multi-field forms collect conversational answers incrementally and validate before settlement', async () => {
  const pending = new Interactions();
  const result = pending.ask('owner', { ...question, requestedSchema: { type: 'object', properties: {
    selected: { type: 'array', items: { enum: ['a', 'b', 'c'] }, minItems: 1 },
    count: { type: 'integer', minimum: 1 }, enabled: { type: 'boolean' },
  }, required: ['selected', 'count', 'enabled'] } }, undefined, async () => true);
  assert.match(pending.reply('owner', '1，3')!, /下一项/);
  assert.match(pending.reply('owner', '0')!, /无效/);
  assert.match(pending.reply('owner', '2')!, /下一项/);
  assert.match(pending.reply('owner', '是')!, /确认|核对/);
  assert.equal(pending.count('owner'), 1);
  assert.match(pending.reply('owner', '提交')!, /已提交/);
  assert.deepEqual(await result, { action: 'accept', content: { selected: ['a', 'c'], count: 2, enabled: true } });
});

test('native single choice keeps an explicit note alongside the selected value', async () => {
  const pending = new Interactions();
  const result = pending.ask('owner', { ...question, requestedSchema: { type: 'object', properties: {
    question_0: { type: 'string', enum: ['A', 'B'] }, question_0_custom: { type: 'string' },
  } } }, undefined, async () => true);
  assert.match(pending.reply('owner', '9 备注：note')!, /无效/);
  pending.reply('owner', '2 备注：先测试，再发布');
  assert.deepEqual(await result, { action: 'accept', content: { question_0: 'B', question_0_custom: '先测试，再发布' } });
});

test('multi-field drafts support edits and optional skips without losing selected answers', async () => {
  const pending = new Interactions();
  const result = pending.ask('owner', { ...question, requestedSchema: { type: 'object', properties: {
    first: { type: 'string', enum: ['A', 'B'] }, second: { type: 'string' }, third: { type: 'integer', minimum: 1 },
  }, required: ['first', 'third'] } }, undefined, async () => true);
  assert.match(pending.reply('owner', '跳过本项')!, /必填/);
  pending.reply('owner', 'A'); pending.reply('owner', '跳过本项');
  assert.match(pending.reply('owner', '3')!, /核对/);
  assert.match(pending.reply('owner', '修改 first B')!, /B/);
  assert.match(pending.reply('owner', '修改 third 0')!, /无效/);
  pending.reply('owner', '提交');
  assert.deepEqual(await result, { action: 'accept', content: { first: 'B', third: 3 } });
});

test('multiple pending requests require explicit ID and cancellation discards partial answers', async () => {
  const pending = new Interactions();
  const one = pending.ask('owner', question, undefined, async () => true);
  const two = pending.ask('owner', question, undefined, async () => true);
  assert.match(pending.reply('owner', 'A')!, /多个/);
  pending.cancel('owner'); await Promise.all([one, two]);
  assert.equal(pending.reply('owner', 'A'), undefined);
});

test('native multi-select accepts choices plus a custom answer and keeps invalid replies pending', async () => {
  const pending = new Interactions();
  const result = pending.ask('owner', { ...question, requestedSchema: { type: 'object', properties: {
    question_0: { type: 'array', items: { anyOf: [{ const: '改路径', title: '改路径' }, { const: '现状即可', title: '现状即可' }] } },
    question_0_custom: { type: 'string' },
  } } }, undefined, async () => true);
  assert.match(pending.reply('owner', '9')!, /无效/);
  assert.match(pending.reply('owner', '其他：')!, /无效/);
  pending.reply('owner', '1，其他：先运行测试');
  assert.deepEqual(await result, { action: 'accept', content: { question_0: ['改路径'], question_0_custom: '先运行测试' } });
});

test('custom prose punctuation is preserved for native multi-select questions', async () => {
  const pending = new Interactions();
  const result = pending.ask('owner', { ...question, requestedSchema: { type: 'object', properties: {
    question_0: { type: 'array', items: { enum: ['A', 'B'] } }, question_0_custom: { type: 'string' },
  } } }, undefined, async () => true);
  pending.reply('owner', '先测试，再发布');
  assert.deepEqual(await result, { action: 'accept', content: { question_0_custom: '先测试，再发布' } });
});

test('expiry discards partially collected fields and explicit answers cannot revive them', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = new Interactions(); let id = '';
  const result = pending.ask('owner', { ...question, requestedSchema: { type: 'object', properties: {
    first: { type: 'string' }, second: { type: 'string' },
  } } }, undefined, async text => { id = /\/answer ([\w-]+)/.exec(text)![1]; return true; });
  pending.reply('owner', 'one'); t.mock.timers.tick(600000);
  assert.deepEqual(await result, { action: 'cancel' });
  assert.match(pending.answer('owner', id, 'two'), /过期/);
});

test('question answers bypass work scheduling, are owner-scoped and consumed once', async () => {
  const pending = new Interactions(); let text = '';
  const answer = pending.ask('owner', question, undefined, async t => { text = t; return true; });
  const id = /\/answer ([\w-]+)/.exec(text)![1];
  assert.match(pending.answer('other', id, 'A'), /不存在|无权/);
  assert.match(pending.answer('owner', id, 'wrong'), /无效/);
  assert.match(pending.answer('owner', id, 'A'), /已提交/);
  assert.deepEqual(await answer, { action: 'accept', content: { choice: 'A' } });
  assert.match(pending.answer('owner', id, 'B'), /不存在|过期/);
});

test('question cancellation and failed delivery release waiting runtime', async () => {
  const pending = new Interactions(); const controller = new AbortController();
  const answer = pending.ask('owner', question, controller.signal, async () => true);
  controller.abort(); assert.deepEqual(await answer, { action: 'cancel' });
  assert.deepEqual(await pending.ask('owner', question, undefined, async () => false), { action: 'cancel' });
  assert.equal(pending.count('owner'), 0);
});

test('JSON answers enforce required fields, types and enum values without consuming invalid answers', async () => {
  const pending = new Interactions(); let id = '';
  const answer = pending.ask('owner', { ...question, requestedSchema: { type: 'object', properties: {
    count: { type: 'integer', minimum: 1 }, selected: { type: 'array', items: { enum: ['a', 'b'] }, minItems: 1 },
  }, required: ['count', 'selected'] } }, undefined, async text => { id = /\/answer ([\w-]+)/.exec(text)![1]; return true; });
  for (const value of ['{}', '{"count":0,"selected":["a"]}', '{"count":1,"selected":["x"]}', '{"count":1,"selected":["a"],"extra":true}']) {
    assert.match(pending.answer('owner', id, value), /无效/);
  }
  assert.match(pending.answer('owner', id, '{"count":2,"selected":["a"]}'), /已提交/);
  assert.deepEqual(await answer, { action: 'accept', content: { count: 2, selected: ['a'] } });
});

test('multi-question forms show full questions and option descriptions, not only short headers', async () => {
  const pending = new Interactions(); let rendered = '';
  const answer = pending.ask('owner', { ...question, message: 'Please answer the following questions.', requestedSchema: { type: 'object', properties: {
    question_0: { type: 'string', title: '数据库', description: '生产环境应该使用哪种数据库？', oneOf: [{ const: 'SQLite', title: 'SQLite', description: '单实例本地存储' }] },
    question_1: { type: 'string', title: '环境', description: '先部署到测试环境还是生产环境？' },
  } } }, undefined, async text => { rendered = text; return true; });
  assert.match(rendered, /生产环境应该使用哪种数据库/); assert.match(rendered, /单实例本地存储/);
  assert.match(rendered, /先部署到测试环境还是生产环境/);
  pending.cancel('owner'); await answer;
});

test('expired questions release callbacks and late replies are rejected', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = new Interactions(); let id = '';
  const answer = pending.ask('owner', question, undefined, async text => { id = /\/answer ([\w-]+)/.exec(text)![1]; return true; });
  t.mock.timers.tick(600000);
  assert.deepEqual(await answer, { action: 'cancel' });
  assert.match(pending.answer('owner', id, 'A'), /过期/);
});
