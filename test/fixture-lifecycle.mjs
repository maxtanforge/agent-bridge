import { createInterface } from 'node:readline';
import { readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
const dir = process.env.CLAUDE_CONFIG_DIR;
const config = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
const send = m => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
const modes = { currentModeId: 'bypassPermissions', availableModes: ['bypassPermissions', 'acceptEdits'].map(id => ({ id, name: id })) };
const configOptions = ['model', 'effort'].map(id => ({ id, name: id, category: id === 'effort' ? 'thought_level' : 'model', type: 'select', currentValue: 'a', options: ['a', 'b'].map(value => ({ value, name: value })) }));
let sessionId = 'saved';
let pending;
let sdkFilters = [];
const update = update => send({ method: 'session/update', params: { sessionId, update } });
const sdk = (subtype, fields) => {
  if (sdkFilters.some(filter => filter.type === 'system' && filter.subtype === subtype)) {
    send({ method: '_claude/sdkMessage', params: { sessionId, message: { type: 'system', subtype, ...fields } } });
  }
};
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  appendFileSync(join(dir, 'calls.jsonl'), JSON.stringify(m) + '\n');
  const result = result => send({ id: m.id, result });
  if (m.method === 'initialize') return result({ protocolVersion: 1, agentCapabilities: { loadSession: config.load !== false, sessionCapabilities: { ...(config.resume === false ? {} : { resume: {} }), ...(config.close === false ? {} : { close: {} }) }, promptCapabilities: { image: config.image !== false } }, _meta: { steering: { supported: true } } });
  if (['session/new', 'session/load', 'session/resume'].includes(m.method)) {
    if (config.fail && m.method !== 'session/new') return send({ id: m.id, error: { code: -32603, message: 'restore failed' } });
    sessionId = m.params.sessionId ?? 'saved';
    sdkFilters = m.params._meta?.claudeCode?.emitRawSDKMessages ?? [];
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'history' } });
    update({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'help', description: 'Help' }] });
    return result({ ...(m.method === 'session/new' ? { sessionId } : {}), modes, configOptions });
  }
  if (m.method === 'session/set_mode') return result({});
  if (m.method === 'session/set_config_option') {
    configOptions.find(o => o.id === m.params.configId).currentValue = m.params.value;
    return result({ configOptions });
  }
  if (m.method === 'session/close') { if (!config.hangClose) result({}); return; }
  if (m.method === '_session/steering') return result({ outcome: 'injected' });
  if (m.method === 'session/cancel') { if (pending) send({ id: pending, result: { stopReason: 'cancelled' } }); return; }
  if (m.method === 'session/prompt') {
    if (['background', 'background-failed', 'background-hang'].includes(m.params.prompt[0].text)) {
      const variant = m.params.prompt[0].text;
      const review = { task_id: 'review', run_id: '02', task_type: 'local_agent', is_backgrounded: true, description: 'Review' };
      const build = { task_id: 'build', task_type: 'local_bash' };
      const monitor = { task_id: 'monitor', task_type: 'local_bash', ambient: true };
      sdk('task_started', review);
      sdk('background_tasks_changed', { tasks: [review, build, monitor] });
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'started' } });
      result({ stopReason: 'end_turn' });
      sdk('session_state_changed', { state: 'idle' });
      if (variant !== 'background-hang') setTimeout(() => {
        sdk('task_notification', { task_id: 'review', run_id: '01', status: 'failed', summary: 'Stale failure' });
        sdk('task_notification', { task_id: 'review', run_id: '02', status: 'completed', summary: 'Review ready' });
        sdk('task_notification', { task_id: 'build', status: variant === 'background-failed' ? 'failed' : 'completed', summary: 'Build result' });
        sdk('background_tasks_changed', { tasks: [monitor] });
        send({ id: 'background-question', method: 'elicitation/create', params: { sessionId, mode: 'form', message: 'Confirm summary?', requestedSchema: { type: 'object', properties: {} } } });
      }, 35);
      return;
    }
    if (m.params.prompt[0].text === 'hang') { pending = m.id; return; }
    if (m.params.prompt[0].text === 'late') setTimeout(() => update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'late from old task' } }), 100);
    if (m.params.prompt[0].text === 'delayed') return setTimeout(() => {
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'new task' } });
      result({ stopReason: 'end_turn' });
    }, 250);
    if (m.params.prompt[0].text.startsWith('drift:')) {
      configOptions.find(o => o.id === m.params.prompt[0].text.slice(6)).currentValue = 'b';
      update({ sessionUpdate: 'config_option_update', configOptions });
    }
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'live' } });
    update({ sessionUpdate: 'tool_call', toolCallId: 'tool', title: 'Tool', status: 'completed' });
    pending = m.id;
    return send({ id: 'permission', method: 'session/request_permission', params: { sessionId, toolCall: { toolCallId: 'tool', title: 'Tool' }, options: [] } });
  }
  if (m.id === 'permission') send({ id: pending, result: { stopReason: 'end_turn' } });
  if (m.id === 'background-question') {
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'follow-up summary' } });
    sdk('session_state_changed', { state: 'idle' });
  }
});
