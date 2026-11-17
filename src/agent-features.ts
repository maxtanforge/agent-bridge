/** 原生能力的应用层：状态查询、会话偏好、引导与交互，不拥有任务调度权。 */
import { AgentState } from './agent-state.ts';
import { Interactions } from './interactions.ts';
import { nativeCommand, NativeHelp } from './commands.ts';
import type { Store } from './store.ts';
import type { Inbound, Runtime, RuntimeHooks } from './types.ts';

type Ports = { workspace: string; key(m: Inbound): string; busy(key: string): boolean; send(m: Inbound, text: string): Promise<boolean>; question(m: Inbound, text: string, id: string): Promise<boolean | string>; steer(m: Inbound): Promise<void> };
type Run = { key: string; state: AgentState; session?: string; executing: boolean; abort: AbortController };
export class AgentFeatures {
  private states = new Map<string, AgentState>();
  private current?: Run;
  readonly interactions = new Interactions();
  db: Store; runtime: Runtime; ports: Ports;
  constructor(db: Store, runtime: Runtime, ports: Ports) { this.db = db; this.runtime = runtime; this.ports = ports; }
  state(key: string) { return this.states.get(key); }
  clear(key: string) { this.states.delete(key); }
  begin(m: Inbound, onActivity?: (text: string) => void) {
    const key = this.ports.key(m); const state = new AgentState(this.ports.workspace);
    const run: Run = { key, state, executing: false, abort: new AbortController() };
    this.current = run; this.states.delete(key); this.states.set(key, state);
    while (this.states.size > 128) this.states.delete(this.states.keys().next().value!);
    const hooks: RuntimeHooks = { ...this.db.preferences(key),
      onEvent: event => {
        if (this.current !== run || run.abort.signal.aborted) return;
        state.apply(event);
        if (event.type === 'update' && ['tool_call', 'tool_call_update', 'plan'].includes(String(event.update.sessionUpdate))) {
          onActivity?.(this.interactions.count(key) ? '等待你回答，直接回复即可；/questions 查看。' : state.activityText());
        }
      },
      onQuestion: async (question, signal) => {
        if (this.current !== run || !run.executing || run.session !== question.sessionId) return { action: 'cancel' };
        onActivity?.('等待你回答，直接回复即可；/questions 查看。');
        try {
          return await this.interactions.ask(key, question, signal ? AbortSignal.any([signal, run.abort.signal]) : run.abort.signal,
            (text, id) => this.ports.question(m, text, id));
        } finally {
          if (this.current === run && !run.abort.signal.aborted) onActivity?.(this.interactions.count(key)
            ? '等待你回答，直接回复即可；/questions 查看。' : state.activityText());
        }
      },
    };
    return { hooks, state,
      attach: (session: string) => { run.session = session; run.executing = true; },
      end: () => { run.executing = false; run.abort.abort(); this.interactions.cancel(key); if (this.current === run) this.current = undefined; },
    };
  }
  cancel(key: string) { if (this.current?.key === key) { this.current.executing = false; this.current.abort.abort(); } this.interactions.cancel(key); }
  brief(key: string) {
    return [this.state(key)?.brief(), this.interactions.count(key) ? `等待回答：${this.interactions.count(key)} 项，使用 /questions 查看。` : ''].filter(Boolean).join('\n');
  }
  async handle(m: Inbound): Promise<boolean> {
    const command = nativeCommand(m.text); if (!command) return false;
    const { name, argument } = command; const key = this.ports.key(m); const state = this.state(key) ?? new AgentState();
    const reply = (text: string) => this.ports.send(m, text);
    const questionReply = (id: string, text: string) => this.interactions.notify(key, id, text, (text, deliveryId) => this.ports.question(m, text, deliveryId));
    switch (name) {
      case 'help': await reply(NativeHelp); break;
      case 'commands': await reply(state.commandsText()); break;
      case 'tools': await reply(state.toolsText()); break;
      case 'plan': await reply(state.planText()); break;
      case 'usage': await reply(state.usageText()); break;
      case 'capabilities': await reply(state.capabilitiesText()); break;
      case 'config': await reply(`下次任务偏好：${JSON.stringify(this.db.preferences(key))}\n\n最近协商的配置：\n${state.configText()}`); break;
      case 'questions': {
        const items = this.interactions.list(key);
        if (!items.length) await reply('当前没有等待回答的问题。');
        for (const item of items) await questionReply(item.id, item.text);
        break;
      }
      case 'answer': {
        const match = /^(\S+)\s+([\s\S]+)$/.exec(argument);
        const text = match ? this.interactions.answer(key, match[1], match[2]) : '用法：/answer <问题编号> <回答或 JSON>';
        if (match && this.interactions.has(key, match[1])) await questionReply(match[1], text);
        else await reply(text);
        break;
      }
      case 'skip': await reply(this.interactions.skip(key, argument)); break;
      case 'steer': {
        if (!argument) { await reply('用法：/steer <补充要求>'); break; }
        await this.ports.steer({ ...m, text: argument });
        break;
      }
      case 'sessions': {
        const sessions = this.db.sessionHistory(key);
        await reply(sessions.length ? sessions.map(s => `${s.title ? `${s.title}\n` : ''}${s.acp} — ${s.at ? new Date(s.at).toISOString() : '旧会话'}`).join('\n\n') + '\n\n/resume <会话编号> 选择下次恢复；仅列最近 20 项。' : '当前会话没有可恢复的历史记录。'); break;
      }
      case 'resume':
        if (this.ports.busy(key)) { await reply('当前会话有执行中或排队任务，请完成或取消后切换。'); break; }
        if (this.db.resumeSession(key, argument)) { this.clear(key); await reply('已选择历史会话，下次任务恢复；恢复失败会保留上下文绑定并停止执行，可重试或用 /new 新开会话。'); }
        else await reply('会话不存在或不属于本人当前聊天和话题。');
        break;
      case 'mode': case 'model': case 'effort': {
        if (!argument) { await reply(`当前偏好：${JSON.stringify(this.db.preferences(key))}；/config 查看原生可选项。`); break; }
        if (this.ports.busy(key)) { await reply('当前会话有执行中或排队任务，请完成或取消后修改配置。'); break; }
        const value = argument === 'default' ? undefined : name === 'mode' && argument === 'execute' ? 'bypassPermissions' : argument;
        if (name === 'mode' && !['plan', 'bypassPermissions', undefined].includes(value)) { await reply('用法：/mode plan 或 /mode execute'); break; }
        if (value && (value.length > 160 || /\s/.test(value))) { await reply('配置值无效，请使用 /config 中的单个选项值。'); break; }
        this.db.setPreference(key, name, value); await reply('已保存下次任务偏好；启动时按 Claude 实际能力校验，不支持时不会执行任务。'); break;
      }
    }
    return true;
  }
}
