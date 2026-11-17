/** One task's visible feedback. Ports must use bounded delivery; this owns no runtime or queue. */
import { TaskLimits } from './task.ts';

type Ports = {
  delayMs: number;
  ready(): boolean;
  send(text: string, activity: string): Promise<boolean>;
  startTyping?(): Promise<string | undefined>;
  stopTyping?(id: string): Promise<unknown>;
};
export class TaskFeedback {
  private ports: Ports;
  private ended = false;
  private visible = false;
  private text = '';
  private activity = '';
  private dirty = false;
  private sending = false;
  private failures = 0;
  private retry?: ReturnType<typeof setTimeout>;
  private reaction?: string;
  private hidden = false;
  private removed = new Set<string>();
  private removal = Promise.resolve();
  private delivery = Promise.resolve();
  private typing: Promise<void>;
  private interval: ReturnType<typeof setInterval>;
  private fallback: ReturnType<typeof setTimeout>;
  constructor(ports: Ports) {
    this.ports = ports;
    this.typing = ports.startTyping?.().then(id => this.typingCreated(id), () => {}) ?? Promise.resolve();
    this.interval = setInterval(() => this.flush(), TaskLimits.ProgressIntervalMs);
    this.fallback = setTimeout(() => {
      if (this.ended || this.visible) return;
      this.activity ||= '正在处理，完成后通知你。';
      this.dirty = true; this.flush();
    }, ports.delayMs);
  }
  /** Also accepts a late reaction from a timed-out channel operation. */
  typingCreated(id: string | undefined) {
    if (!id) return;
    this.reaction = id;
    if (this.hidden) this.hideTyping();
  }
  private hideTyping() {
    this.hidden = true;
    const id = this.reaction;
    if (!id || this.removed.has(id)) return;
    this.removed.add(id);
    this.removal = Promise.resolve().then(() => this.ports.stopTyping?.(id)).then(() => {}, () => {});
  }
  update(text: string, activity: string) {
    if (this.ended || (text === this.text && activity === this.activity)) return;
    if (this.failures >= 4) this.failures = 0;
    this.text = text; this.activity = activity; this.dirty = true;
  }
  private flush() {
    if (this.ended || !this.dirty || this.sending || this.retry || !this.ports.ready()) return;
    this.dirty = false; this.sending = true;
    this.delivery = this.ports.send(this.text, this.activity).then(sent => {
      if (sent) { this.failures = 0; this.visible = true; this.hideTyping(); }
      else this.retryFeedback();
    }, () => this.retryFeedback()).finally(() => { this.sending = false; });
  }
  private retryFeedback() {
    if (this.ended || ++this.failures > 3) return;
    this.dirty = true;
    this.retry = setTimeout(() => {
      this.retry = undefined; this.flush();
    }, 1000 * 2 ** (this.failures - 1));
  }
  stop() {
    this.ended = true; clearInterval(this.interval); clearTimeout(this.fallback); clearTimeout(this.retry);
    return this.delivery;
  }
  async dispose() {
    await this.stop(); this.hideTyping(); await this.typing; await this.removal;
  }
}
