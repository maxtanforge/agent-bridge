import type { Inbound, PromptAttachment } from './types.ts';

type Input = { message: Inbound; attachments?: PromptAttachment[] };
type Ports = {
  signal: AbortSignal;
  prepare(message: Inbound): Promise<PromptAttachment[]>;
  steer(input: Input): Promise<'injected' | 'promptRequired'>;
  reply(message: Inbound, text: string): Promise<unknown>;
};

/** A bounded mailbox owned by one task. Only confirmed-undelivered inputs may become its next prompt. */
export class ConversationInputs {
  private entries: Input[] = [];
  private running = false;
  private closed = false;
  private draining?: Promise<void>;
  private ports: Ports;
  private limit: number;
  constructor(ports: Ports, limit = 20) { this.ports = ports; this.limit = limit; }
  get count() { return this.entries.length; }
  async accept(message: Inbound) {
    if (this.closed || this.ports.signal.aborted) { await this.ports.reply(message, '当前任务正在结束，本条未接收；请在任务结束后继续对话。'); return; }
    if (this.count >= this.limit) { await this.ports.reply(message, '当前会话待投递补充已满，本条未接收；请稍后重试。'); return; }
    this.entries.push({ message });
    if (!this.running || this.count > 1 || message.text.startsWith('/')) {
      await this.ports.reply(message, '已接收，等待当前会话按顺序处理；/status 查看，/cancel 停止当前任务及待投递补充。');
    }
    await this.flush();
  }
  startTurn() { this.running = true; void this.flush(); }
  async endTurn() { this.running = false; await this.draining; }
  close() { this.closed = true; this.running = false; const count = this.count; this.entries = []; return count; }
  private async prepare(input: Input) {
    input.attachments ??= input.message.attachment ? await this.ports.prepare(input.message) : [];
    return input;
  }
  async next(): Promise<Input | undefined> {
    while (!this.closed && !this.ports.signal.aborted && this.entries.length) {
      const input = this.entries[0];
      try {
        await this.prepare(input);
        if (this.ports.signal.aborted || this.closed) return;
        this.entries.shift(); return input;
      } catch {
        this.entries.shift();
        await this.ports.reply(input.message, '附件准备失败，本条补充未投递，请检查附件后重发。');
      }
    }
  }
  private flush(): Promise<void> {
    if (this.draining) return this.draining;
    const work = Promise.resolve().then(async () => {
      while (this.running && !this.closed && !this.ports.signal.aborted && this.entries.length) {
        const input = this.entries[0];
        // Native slash commands must enter through session/prompt, never the steering extension.
        if (input.message.text.startsWith('/')) return;
        try { await this.prepare(input); }
        catch {
          this.entries.shift();
          await this.ports.reply(input.message, '附件准备失败，本条补充未投递，请检查附件后重发。'); continue;
        }
        if (!this.running || this.closed || this.ports.signal.aborted) return;
        try {
          const outcome = await this.ports.steer(input);
          if (outcome === 'promptRequired') {
            this.running = false; // Keep ownership until the current prompt settles, then start next().
            await this.ports.reply(input.message, '当前轮次已结束，补充将继续在同一会话处理，无需重发。');
            return;
          }
          this.entries.shift();
          await this.ports.reply(input.message, '补充要求已交给当前会话。');
        } catch {
          this.entries.shift(); // An unknown delivery outcome is never retried.
          await this.ports.reply(input.message, '任务引导未确认，可能不受支持或连接异常。未自动重试或入队；请查看 /status 和最终结果。');
        }
      }
    });
    const tracked = work.finally(() => { if (this.draining === tracked) this.draining = undefined; });
    this.draining = tracked;
    return tracked;
  }
}
