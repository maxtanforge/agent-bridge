/** ACP 运行时：stdio 协商、新建/恢复会话、免审批模式、prompt 和 Adapter 进程生命周期。 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { client, ndJsonStream, PROTOCOL_VERSION, type ClientConnection, CreateElicitationRequest, type SessionNotification } from '@agentclientprotocol/sdk/unstable';
import type { Runtime, RuntimeHooks, RuntimeOptions, AgentQuestion, PromptAttachment } from './types.ts';
import { version } from './version.ts';
import { ClaudeBackground } from './claude-background.ts';
import { StopReason } from './task.ts';

const SdkMessage = z.object({ sessionId: z.string(), message: z.unknown() });
const BackgroundMessages = [
  ...['task_started', 'task_updated', 'task_notification', 'background_tasks_changed', 'session_state_changed']
    .map(subtype => ({ type: 'system', subtype })),
  { type: 'user', origin: 'task-notification' },
  { type: 'result', origin: 'task-notification' },
];

/** 免审批模式 ID：会话必须声明支持且 set_mode 确认后才允许 prompt。 */
const BypassMode = 'bypassPermissions';

export class SessionRestoreError extends Error {
  readonly sessionId: string;
  constructor(sessionId: string, cause?: unknown) {
    super(`Unable to restore session ${sessionId}; retry or explicitly start a new session`, { cause });
    this.sessionId = sessionId;
    this.name = 'SessionRestoreError';
  }
}

export class AcpRuntime implements Runtime {
  cwd: string; entry: string; process?: ChildProcessWithoutNullStreams; connection?: ClientConnection;
  private stopping?: Promise<void>;
  private readySession?: string;
  private steering = false;
  private image = false;
  private lifetime = new AbortController();
  private options: RuntimeOptions;
  private closeSession?: string;
  private closeSupported = false;
  private prompting = false;
  private background?: ClaudeBackground;
  private backgroundActivity?: (run: ClaudeBackground) => void;
  private backgroundSummary?: (text: string) => void;
  constructor(cwd: string, entry?: string, options: RuntimeOptions = {}) {
    this.options = options;
    this.cwd = cwd;
    this.entry = entry ?? join(dirname(createRequire(import.meta.url).resolve('@agentclientprotocol/claude-agent-acp/package.json')), 'dist/index.js');
  }
  async open(old: string | undefined, update: Parameters<Runtime['open']>[1], permission: Parameters<Runtime['open']>[2], signal?: AbortSignal, hooks: RuntimeHooks = {}) {
    signal?.throwIfAborted();
    // ACP v1 prompt completion does not establish background quiescence. Give
    // each task its own process so late events cannot reach the next task.
    await this.stop();
    signal?.throwIfAborted();
    // 环境变量白名单：只传 Adapter 运行所需变量；飞书密钥、NPM_TOKEN 等不会进入模型子进程。
    // 证书变量供自签 CA 网关使用；APPDATA/LOCALAPPDATA/SYSTEMDRIVE 供 Windows 本地开发的工具链使用。
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) =>
      /^(PATH|HOME|USERPROFILE|SYSTEMROOT|WINDIR|TEMP|TMP|COMSPEC|PATHEXT|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|LANG|LANGUAGE|LC_.*|TZ|ANTHROPIC_.*|CLAUDE_CONFIG_DIR|CLAUDE_CODE_SUBAGENT_MODEL|NPM_CONFIG_REGISTRY|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR|APPDATA|LOCALAPPDATA|SYSTEMDRIVE)$/.test(k.toUpperCase())));
    // Compose 可能注入空字符串。省略空网关地址，让 Claude 按自身配置解析路由。
    const gateway = env.ANTHROPIC_BASE_URL?.trim();
    if (gateway) env.ANTHROPIC_BASE_URL = gateway;
    else delete env.ANTHROPIC_BASE_URL;
    // 空的证书路径同样省略：Node 会把空文件路径当作加载失败而不是忽略。
    for (const variable of ['NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR'] as const) {
      const value = env[variable]?.trim();
      if (value) env[variable] = value;
      else delete env[variable];
    }
    // POSIX 下 detached 创建独立进程组：取消时才能连同工具子进程一起终止。
    const child = spawn(process.execPath, [this.entry], { cwd: this.cwd, env, stdio: 'pipe', windowsHide: true, detached: process.platform !== 'win32' });
    this.process = child;
    child.stderr.resume(); // 只消费防止背压，不写业务日志。
    this.lifetime = new AbortController();
    const requestedMode = hooks.mode ?? BypassMode;
    let activeSession: string | undefined;
    const pending = new Map<string, SessionNotification>();
    let live = false;
    let modeUpdate: string | undefined;
    let config: import('@agentclientprotocol/sdk').SessionConfigOption[] = [];
    const notification = ({ sessionId, update: u }: SessionNotification) => {
      if (this.connection !== connection) return;
      if (!activeSession) {
        // History is never forwarded; retain only latest setup metadata per session.
        if (['config_option_update', 'available_commands_update', 'current_mode_update', 'session_info_update'].includes(u.sessionUpdate)) {
          const key = `${sessionId}:${u.sessionUpdate}`;
          if (!pending.has(key) && pending.size >= 96) pending.delete(pending.keys().next().value!);
          pending.set(key, { sessionId, update: u });
        }
        return;
      }
      if (sessionId !== activeSession) return;
      if (u.sessionUpdate === 'current_mode_update') {
        modeUpdate = u.currentModeId;
        if (u.currentModeId !== requestedMode) {
          this.readySession = undefined;
          if (live) {
            connection.close(new Error('Permission mode changed unexpectedly'));
            void this.stop().catch(() => {});
            return;
          }
        }
      }
      if (u.sessionUpdate === 'config_option_update') { config = u.configOptions; hooks.onEvent?.({ type: 'config', options: config }); }
      if (['available_commands_update', 'session_info_update'].includes(u.sessionUpdate) || (live && this.prompting && ['tool_call', 'tool_call_update', 'plan', 'usage_update'].includes(u.sessionUpdate))) {
        hooks.onEvent?.({ type: 'update', update: u });
      }
      if (live && this.prompting && u.sessionUpdate === 'agent_message_chunk' && u.content.type === 'text') {
        const run = this.background;
        let prefix = '';
        if (run?.waiting && u.content.text) {
          // Child output is grouped in its native completion report. Keep the main follow-up readable.
          if ((u._meta?.claudeCode as { parentToolUseId?: unknown } | undefined)?.parentToolUseId) return;
          if (!run.hasFollowupText) prefix = '\n\n';
          run.hasFollowupText = true;
          run.noteFollowup();
        }
        update(prefix + u.content.text);
      }
    };
    this.backgroundActivity = run => hooks.onEvent?.({ type: 'background', activity: run.activity() });
    this.backgroundSummary = update;
    const connection: ClientConnection = client()
      .onNotification('session/update', ({ params }) => notification(params))
      .onNotification('_claude/sdkMessage', SdkMessage, ({ params }) => {
        if (this.connection !== connection || !live || !activeSession || !this.background) return;
        if (params.sessionId === activeSession && this.background.apply(params.message) && this.background.waiting) {
          this.backgroundActivity?.(this.background);
        }
      })
      .onRequest('elicitation/create', async ({ params, signal: requestSignal }) => {
        if (this.connection !== connection || !hooks.onQuestion || !live || !this.prompting || !CreateElicitationRequest.isForm(params) || !('sessionId' in params) || params.sessionId !== activeSession) return { action: 'cancel' as const };
        const combined = AbortSignal.any([requestSignal, this.lifetime.signal]);
        if (combined.aborted) return { action: 'cancel' as const };
        if (this.background?.waiting) this.background.noteFollowup();
        const answer = await new Promise<import('./types.ts').QuestionAnswer>((resolve, reject) => {
          const abort = () => resolve({ action: 'cancel' });
          combined.addEventListener('abort', abort, { once: true });
          Promise.resolve().then(() => hooks.onQuestion!(params as AgentQuestion, combined)).then(resolve, reject)
            .finally(() => combined.removeEventListener('abort', abort));
        });
        return answer.action === 'accept' ? { action: 'accept' as const, content: answer.content } : { action: answer.action };
      })
      .onRequest('session/request_permission', ({ params }) => this.connection === connection && live && this.prompting && !this.lifetime.signal.aborted && params.sessionId === activeSession ? permission(params as Parameters<Parameters<Runtime['open']>[2]>[0]) : { outcome: { outcome: 'cancelled' as const } })
      .connect(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)));
    this.connection = connection;
    connection.signal.addEventListener('abort', () => {
      if (this.connection !== connection) return;
      this.readySession = undefined;
      this.lifetime.abort();
    }, { once: true });
    child.on('error', error => connection.close(error));
    child.on('exit', () => connection.close(new Error('ACP process exited')));
    // Closing the connection interrupts startup requests. The catch below awaits
    // the same cleanup promise before propagating the failure.
    const abort = () => { void this.stop().catch(() => {}); };
    signal?.addEventListener('abort', abort, { once: true });
    // 30 秒只约束协议启动步骤。工具执行可能持续数小时，prompt 由 Bridge 总时限控制。
    const opts = () => ({ cancellationSignal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000), stopWaitingOnCancel: true });
    const sessionParams = {
      cwd: this.cwd, mcpServers: this.options.mcpServers ?? [],
      _meta: { claudeCode: {
        emitRawSDKMessages: BackgroundMessages,
        options: {
          allowDangerouslySkipPermissions: true,
          // Adapter retains its native user/project/local settingSources defaults.
          settings: { includeCoAuthoredBy: false, attribution: { commit: '', pr: '', sessionUrl: false } },
          ...(this.options.maxTurns === undefined ? {} : { maxTurns: this.options.maxTurns }),
          ...(this.options.maxBudgetUsd === undefined ? {} : { maxBudgetUsd: this.options.maxBudgetUsd }),
        },
      } },
    };
    try {
      signal?.throwIfAborted();
      const init = await connection.agent.request('initialize', {
        protocolVersion: PROTOCOL_VERSION, clientCapabilities: {
          ...(hooks.onQuestion ? { elicitation: { form: {} } } : {}),
          _meta: { jetbrains: { air: { version: 1, capabilities: ['backgroundSubagents'] } } },
        }, clientInfo: { name: 'agent-bridge', version },
      }, opts());
      if (init.protocolVersion !== PROTOCOL_VERSION) throw new Error('Unsupported ACP version');
      this.steering = (init._meta?.steering as { supported?: unknown } | undefined)?.supported === true;
      this.image = init.agentCapabilities?.promptCapabilities?.image === true;
      this.closeSupported = !!init.agentCapabilities?.sessionCapabilities?.close;
      hooks.onEvent?.({ type: 'capabilities', steering: this.steering, image: init.agentCapabilities?.promptCapabilities?.image === true });
      const restore = async () => {
        try {
          const params = { sessionId: old!, ...sessionParams };
          if (init.agentCapabilities?.sessionCapabilities?.resume) return { ...await connection.agent.request<import('@agentclientprotocol/sdk/unstable').ResumeSessionResponse>('session/resume', params, opts()), sessionId: old! };
          if (init.agentCapabilities?.loadSession) return { ...await connection.agent.request<import('@agentclientprotocol/sdk/unstable').LoadSessionResponse>('session/load', params, opts()), sessionId: old! };
          throw new Error('Session restoration unavailable');
        } catch (error) { signal?.throwIfAborted(); throw new SessionRestoreError(old!, error); }
      };
      const selected = old ? await restore() : await connection.agent.request<import('@agentclientprotocol/sdk/unstable').NewSessionResponse>('session/new', sessionParams, opts());
      if (!selected) throw new Error('Missing session');
      this.closeSession = selected.sessionId;
      config = selected.configOptions ?? [];
      hooks.onEvent?.({ type: 'config', options: config });
      activeSession = selected.sessionId;
      for (const item of pending.values()) notification(item);
      pending.clear();
      if (!selected?.modes?.availableModes.some(mode => mode.id === requestedMode)) throw new Error('Noninteractive permission mode unavailable');
      modeUpdate = undefined;
      // ACP set_mode has an empty success response: its ACK confirms application.
      // The adapter emits current_mode_update when it falls back to another mode.
      await connection.agent.request('session/set_mode', { sessionId: selected.sessionId, modeId: requestedMode }, opts());
      if (modeUpdate !== undefined && modeUpdate !== requestedMode) throw new Error('Noninteractive permission mode not confirmed');
      for (const [category, value] of [['model', hooks.model], ['thought_level', hooks.effort]] as const) {
        if (value === undefined) continue;
        const option = config.find(o => o.category === category || o.id === (category === 'model' ? 'model' : 'effort'));
        if (!option || option.type !== 'select' || !option.options.flatMap(o => 'options' in o ? o.options : [o]).some(o => o.value === value)) throw new Error(`${category} preference unavailable`);
        const result = await connection.agent.request<import('@agentclientprotocol/sdk/unstable').SetSessionConfigOptionResponse>('session/set_config_option', { sessionId: selected.sessionId, configId: option.id, value }, opts());
        config = result.configOptions;
        if (!config.some(o => o.id === option.id && o.currentValue === value)) throw new Error(`${category} preference not confirmed`);
        hooks.onEvent?.({ type: 'config', options: config });
      }
      if (modeUpdate !== undefined && modeUpdate !== requestedMode) throw new Error('Noninteractive permission mode not confirmed');
      signal?.throwIfAborted();
      this.readySession = selected.sessionId;
      live = true;
      return selected.sessionId;
    } catch (error) {
      await this.stop();
      throw error;
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }
  async prompt(sessionId: string, text: string, attachments: PromptAttachment[] = []) {
    if (!this.connection || this.readySession !== sessionId) throw new Error('Runtime not ready');
    if (attachments.some(a => a.type === 'image') && !this.image) throw new Error('Native image input unavailable');
    // The Adapter may answer this prompt while Claude still has background work.
    const prompt: import('@agentclientprotocol/sdk/unstable').ContentBlock[] = [{ type: 'text', text }, ...attachments];
    const connection = this.connection;
    const lifetime = this.lifetime.signal;
    const background = new ClaudeBackground();
    this.background = background;
    this.prompting = true;
    try {
      const { stopReason } = await connection.agent.request('session/prompt', { sessionId, prompt });
      if (stopReason !== StopReason.EndTurn || !background.tracked) return stopReason;
      background.waiting = true;
      this.backgroundActivity?.(background);
      try { await background.drain(lifetime); }
      catch (error) {
        if (lifetime.aborted && !connection.signal.aborted && this.connection === connection) return StopReason.Cancelled;
        throw error;
      }
      const summary = background.summary();
      if (summary) this.backgroundSummary?.(`\n\n后台结果\n${summary}`);
      if (background.followupFailed) return StopReason.BackgroundFollowupFailed;
      const { failed, stopped } = background.activity();
      return failed || stopped ? StopReason.BackgroundFailed : stopReason;
    } finally {
      if (this.background === background) {
        this.background = undefined;
        this.prompting = false;
      }
    }
  }
  async steer(sessionId: string, text: string, attachments: PromptAttachment[] = []): Promise<'injected' | 'promptRequired'> {
    if (!this.connection || this.readySession !== sessionId) throw new Error('Runtime not ready');
    if (!this.steering) throw new Error('Native steering unavailable');
    if (attachments.some(a => a.type === 'image') && !this.image) throw new Error('Native image input unavailable');
    const result = await this.connection.agent.request('_session/steering', {
      sessionId, prompt: [{ type: 'text', text }, ...attachments], _meta: { steering: { idleBehavior: 'promptRequired' } },
    }, { cancellationSignal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(30000)]), stopWaitingOnCancel: true });
    if (!result || typeof result !== 'object' || !('outcome' in result)) throw new Error('Invalid steering outcome');
    if (result.outcome !== 'injected' && result.outcome !== 'promptRequired') throw new Error('Invalid steering outcome');
    return result.outcome;
  }
  async cancel(sessionId: string) {
    if (sessionId !== this.readySession) return;
    this.readySession = undefined;
    this.lifetime.abort();
    await this.connection?.agent.notify('session/cancel', { sessionId });
  }
  /** 终止 Adapter 及其进程组；同一轮清理共享 Promise，失败时保留句柄供再次清理。 */
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.lifetime.abort();
    this.steering = false;
    this.image = false;
    const child = this.process;
    const connection = this.connection;
    const closeSession = this.closeSupported ? this.closeSession : undefined;
    this.closeSession = undefined; this.closeSupported = false;
    this.background = undefined; this.backgroundActivity = undefined; this.backgroundSummary = undefined;
    this.prompting = false;
    this.connection = undefined; this.readySession = undefined;
    if (!child && !connection) return Promise.resolve();
    const cleanup = Promise.resolve().then(async () => {
      if (connection && closeSession && !connection.signal.aborted) {
        try {
          await connection.agent.request('session/close', { sessionId: closeSession }, { cancellationSignal: AbortSignal.timeout(1000), stopWaitingOnCancel: true });
        } catch { /* Closing is best effort; process termination remains mandatory. */ }
      }
      try { connection?.close(); }
      finally { if (child) await this.terminate(child); }
      if (this.process === child) this.process = undefined;
    });
    const pending = cleanup.finally(() => { if (this.stopping === pending) this.stopping = undefined; });
    this.stopping = pending;
    return pending;
  }
  protected useProcessGroups = process.platform !== 'win32';
  protected terminationGraceMs = 1500;
  protected terminationTimeoutMs = 1500;
  protected signalProcess(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals | 0): boolean {
    if (!child.pid) return false; // spawn failed before creating a process.
    try {
      return process.kill(this.useProcessGroups ? -child.pid : child.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
      throw error;
    }
  }
  protected async terminate(child: ChildProcessWithoutNullStreams) {
    if (!child.pid) return;
    const gone = () => this.useProcessGroups
      ? !this.signalProcess(child, 0)
      : child.exitCode !== null || child.signalCode !== null;
    const waitUntilGone = async (timeout: number) => {
      const deadline = Date.now() + timeout;
      while (!gone()) {
        if (Date.now() >= deadline) return false;
        await new Promise(resolve => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
      }
      return true;
    };
    // POSIX leader exit never substitutes for checking the entire process group.
    // On Windows exitCode/signalCode are only populated after exit is observed.
    if (gone()) return;
    this.signalProcess(child, 'SIGTERM');
    if (await waitUntilGone(this.terminationGraceMs)) return;
    this.signalProcess(child, 'SIGKILL');
    if (!await waitUntilGone(this.terminationTimeoutMs)) throw new Error('ACP process termination timed out');
  }
}
