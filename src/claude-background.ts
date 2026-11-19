import type { BackgroundActivity, BackgroundStatus } from './types.ts';
import { BackgroundStatusLabel, TaskLimits } from './task.ts';

type Work = { run?: string; status: BackgroundStatus; title: string; shell: boolean; summary?: string; missing?: boolean };
type Fields = Record<string, unknown>;

function record(value: unknown): Fields | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Fields : undefined;
}

function brief(value: unknown) {
  return typeof value === 'string' ? value.replace(/[\r\n]+/g, ' ').trim().slice(0, 300) : '';
}

function terminal(value: unknown): BackgroundStatus | undefined {
  if (value === 'completed' || value === 'failed' || value === 'stopped') return value;
  if (value === 'killed' || value === 'cancelled') return 'stopped';
}

/** Waits for live work and any follow-up Claude starts in the same session. */
export class ClaudeBackground {
  private work = new Map<string, Work>();
  private snapshot?: Set<string>;
  private followups = new Set<string>();
  private idle = false;
  private earlyIdle?: 'shell' | 'other';
  private wake?: () => void;
  waiting = false;
  hasFollowupText = false;
  followupFailed = false;

  apply(message: unknown) {
    const event = record(message);
    if (!event) return false;
    if (event.type !== 'system') {
      if (this.tracked) this.applyFollowup(event);
      return false;
    }
    if (event.subtype === 'session_state_changed') {
      if (event.state === 'idle') {
        this.earlyIdle = this.runningKind ?? (this.idle && this.earlyIdle === 'shell' ? 'shell' : undefined);
        this.idle = true;
      } else if (event.state === 'running' || event.state === 'requires_action') {
        this.idle = false;
      }
      this.wake?.();
      return false;
    }

    let changed = false;
    const patch = event.subtype === 'task_updated' ? record(event.patch) : undefined;
    const status = event.subtype === 'task_notification' ? terminal(event.status) : terminal(patch?.status);
    const task = typeof event.task_id === 'string' ? this.work.get(event.task_id) : undefined;
    if (event.subtype === 'background_tasks_changed' && Array.isArray(event.tasks)) {
      const live = new Set<string>();
      for (const item of event.tasks) {
        const task = record(item);
        if (!task || typeof task.task_id !== 'string') continue;
        if (task.ambient === true) {
          changed = this.work.delete(task.task_id) || changed;
          continue;
        }
        live.add(task.task_id);
        changed = this.start(task, this.snapshot?.has(task.task_id) === false) || changed;
      }
      for (const [id, task] of this.work) {
        if (task.status !== 'running' || live.has(id)) continue;
        task.status = 'failed';
        task.missing = true;
        task.summary = 'Claude 未返回该后台任务的终态。';
        changed = true;
      }
      this.snapshot = live;
    } else if (event.subtype === 'task_started' && event.is_backgrounded === true) {
      changed = this.start(event);
    } else if (!status && patch && (patch.is_backgrounded === true || (task && ['pending', 'running'].includes(String(patch.status))))) {
      changed = this.start({ ...event, description: patch.description }, true);
    }

    if (status && task && (!event.run_id || !task.run || event.run_id === task.run)) {
      changed ||= task.status !== status || !!task.missing;
      task.status = status;
      task.summary = brief(event.summary ?? patch?.error) || (task.missing ? undefined : task.summary);
      task.missing = false;
    }

    if (changed) {
      if (this.idle) this.earlyIdle = this.runningKind ?? this.earlyIdle;
      this.wake?.();
    }
    return changed;
  }

  private start(task: Fields, resume = false) {
    if (typeof task.task_id !== 'string' || task.ambient === true) return false;
    const run = typeof task.run_id === 'string' ? task.run_id : undefined;
    const existing = this.work.get(task.task_id);
    if (existing) {
      if (run && existing.run && run < existing.run) return false;
      const newRun = !!(run && existing.run && run > existing.run);
      if (!newRun && !existing.missing && (!resume || existing.status === 'running')) {
        existing.run ??= run;
        return false;
      }
    }
    const title = brief(task.description).slice(0, 60) || existing?.title || (task.task_type === 'local_agent' ? '子 Agent' : '后台任务');
    this.work.set(task.task_id, { run: run ?? existing?.run, status: 'running', title,
      shell: task.task_type === 'local_bash' || (existing?.shell ?? false) });
    return true;
  }

  get tracked() { return this.work.size > 0; }
  private get runningKind() {
    let shell = false;
    for (const task of this.work.values()) {
      if (task.status !== 'running') continue;
      if (!task.shell) return 'other';
      shell = true;
    }
    return shell ? 'shell' : undefined;
  }

  noteFollowup() {
    if (this.earlyIdle) this.idle = false;
    this.wake?.();
  }

  private applyFollowup(event: Fields) {
    const origin = record(event.origin);
    if (origin?.kind !== 'task-notification' || origin.subkind !== undefined || event.parent_tool_use_id) return;
    const key = typeof origin.runId === 'string' ? origin.runId : typeof origin.taskId === 'string' ? origin.taskId : '';
    if (event.type === 'user') {
      this.followups.add(key);
      this.noteFollowup();
    } else if (event.type === 'result' && (event.num_turns !== 0 || event.is_error === true)) {
      this.followups.delete(key);
      this.followupFailed ||= event.is_error === true;
      this.wake?.();
    }
  }

  activity(): BackgroundActivity {
    const activity: BackgroundActivity = { running: 0, completed: 0, failed: 0, stopped: 0, items: [] };
    for (const { title, status } of this.work.values()) {
      activity[status]++;
      if (activity.items.length < 3) activity.items.push({ title, status });
    }
    return activity;
  }

  async drain(signal: AbortSignal) {
    const abort = () => this.wake?.();
    signal.addEventListener('abort', abort, { once: true });
    try {
      while (this.tracked && !signal.aborted) {
        const emptyAndIdle = this.idle && !this.runningKind;
        if (emptyAndIdle && !this.earlyIdle && this.followups.size === 0) break;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const graceElapsed = await new Promise<boolean>(resolve => {
          this.wake = () => resolve(false);
          // A shell can exit while Claude stays idle. An autonomous result can also trail idle.
          if (emptyAndIdle && (this.earlyIdle === 'shell' || this.followups.size)) {
            timer = setTimeout(() => resolve(true), TaskLimits.BackgroundFollowupGraceMs);
          }
        });
        clearTimeout(timer);
        if (graceElapsed) {
          this.followupFailed ||= this.followups.size > 0;
          break;
        }
      }
      signal.throwIfAborted();
    } finally {
      this.wake = undefined;
      signal.removeEventListener('abort', abort);
    }
  }

  summary() {
    return Array.from(this.work.values())
      .filter(task => task.status !== 'running')
      .slice(-8)
      .map(task => `- ${task.title}（${BackgroundStatusLabel[task.status]}）${task.summary ? `，${task.summary}` : ''}`)
      .join('\n');
  }
}
