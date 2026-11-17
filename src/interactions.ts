/** 用户输入请求独立于任务队列；普通回复仅回答所属会话的待处理表单。 */
import { randomUUID } from 'node:crypto';
import type { AgentQuestion, QuestionAnswer } from './types.ts';
import { object } from './agent-state.ts';

type Pending = { key: string; question: AgentQuestion; answers: Record<string, unknown>; skipped: Set<string>; settle(answer: QuestionAnswer): void };
type Notify = (text: string, id: string) => Promise<boolean | string>;
const values = (schema: Record<string, unknown>): unknown[] | undefined => {
  if (Array.isArray(schema.enum)) return schema.enum;
  const variants = schema.oneOf ?? schema.anyOf;
  return Array.isArray(variants) ? variants.map(v => object(v).const) : undefined;
};
function valid(value: unknown, s: Record<string, unknown>): boolean {
  const choices = values(s); if (choices && !choices.includes(value)) return false;
  if (s.type === 'string' || (!s.type && choices)) {
    if (typeof value !== 'string') return false;
    if (typeof s.minLength === 'number' && Array.from(value).length < s.minLength) return false;
    if (typeof s.maxLength === 'number' && Array.from(value).length > s.maxLength) return false;
    return true;
  }
  if (s.type === 'boolean') return typeof value === 'boolean';
  if (s.type === 'number' || s.type === 'integer') return typeof value === 'number' && Number.isFinite(value)
    && (s.type !== 'integer' || Number.isInteger(value))
    && (typeof s.minimum !== 'number' || value >= s.minimum) && (typeof s.maximum !== 'number' || value <= s.maximum);
  if (s.type === 'array') return Array.isArray(value) && value.every(v => typeof v === 'string' && valid(v, { type: 'string', ...object(s.items) }))
    && (typeof s.minItems !== 'number' || value.length >= s.minItems) && (typeof s.maxItems !== 'number' || value.length <= s.maxItems)
    && (!s.uniqueItems || new Set(value).size === value.length);
  return false;
}
function supported(s: Record<string, unknown>): boolean {
  // Fail closed on constraints this chat form renderer cannot validate.
  if (s.pattern || s.format || s.not || s.allOf || s.$ref || s.exclusiveMinimum !== undefined || s.exclusiveMaximum !== undefined || s.multipleOf !== undefined) return false;
  if (s.type === 'array') return supported({ type: 'string', ...object(s.items) });
  return ['string', 'number', 'integer', 'boolean'].includes(String(s.type)) || (!s.type && !!values(s));
}
function customField(question: AgentQuestion, key: string) {
  const props = question.requestedSchema.properties;
  const schema = object(props[key]);
  return values(schema.type === 'array' ? object(schema.items) : schema)
    && object(props[`${key}_custom`]).type === 'string'
    && !question.requestedSchema.required?.includes(`${key}_custom`) ? `${key}_custom` : undefined;
}
function formFields(question: AgentQuestion) {
  const props = question.requestedSchema.properties;
  const companions = new Set(Object.keys(props).map(key => customField(question, key)).filter(Boolean));
  return Object.keys(props).filter(key => !companions.has(key));
}
function remaining(p: Pending) {
  return formFields(p.question).filter(key => !p.skipped.has(key) && !Object.hasOwn(p.answers, key)
    && !(customField(p.question, key) && Object.hasOwn(p.answers, customField(p.question, key)!)));
}
function selection(input: string, schema: Record<string, unknown>): unknown {
  const choices = values(schema);
  if (!choices) return input;
  const variants = schema.oneOf ?? schema.anyOf;
  // Exact values take precedence over numbered shortcuts (e.g. a literal numeric label).
  const matches = choices.filter((value, index) => String(value) === input
    || (Array.isArray(variants) && object(variants[index]).title === input));
  if (matches.length === 1) return matches[0];
  if (!matches.length && /^[1-9]\d*$/.test(input) && Number(input) <= choices.length) return choices[Number(input) - 1];
  throw new Error('Invalid selection');
}
function parseField(question: AgentQuestion, key: string, input: string): Record<string, unknown> {
  const schema = object(question.requestedSchema.properties[key]);
  const custom = customField(question, key);
  if (custom && /^其他[:：]/.test(input)) return { [custom]: input.replace(/^其他[:：]\s*/, '') };
  if (custom) {
    // Preserve exact enum labels even when they contain our note syntax.
    const choiceSchema = schema.type === 'array' ? object(schema.items) : schema;
    let exact = false;
    try { selection(input, choiceSchema); exact = true; } catch { /* Try the explicit note syntax. */ }
    const note = !exact && /^(.*?)\s*(?:[,，;；]\s*|\s+)(?:备注|说明)[:：]\s*([\s\S]+)$/.exec(input);
    if (note) {
      const selected = parseField(question, key, note[1].trim());
      if (!Object.hasOwn(selected, key) || !note[2].trim()) throw new Error('Invalid selection with note');
      return { ...selected, [custom]: [selected[custom], note[2].trim()].filter(Boolean).join('；') };
    }
  }
  if (schema.type === 'array') {
    if (input.startsWith('[')) return { [key]: JSON.parse(input) };
    const items = object(schema.items);
    // A label may itself contain commas; match it before interpreting separators.
    try { if (values(items)) return { [key]: [selection(input, items)] }; } catch { /* Multi-selection below. */ }
    const tokens = input.split(/[,，、\n]/).map(s => s.trim()).filter(Boolean);
    if (custom && tokens.length > 1 && !tokens.some(token => /^\d+$/.test(token) || /^其他[:：]/.test(token))) {
      const hasChoice = tokens.some(token => { try { selection(token, items); return true; } catch { return false; } });
      if (!hasChoice) return { [custom]: input };
    }
    const picks: unknown[] = []; const notes: string[] = [];
    for (const token of tokens) {
      if (custom && /^其他[:：]/.test(token)) notes.push(token.replace(/^其他[:：]\s*/, ''));
      else {
        try { picks.push(selection(token, items)); }
        catch (error) { if (!custom || tokens.length > 1 || /^\d+$/.test(token)) throw error; notes.push(token); }
      }
    }
    return { ...(picks.length ? { [key]: picks } : {}), ...(custom && notes.length ? { [custom]: notes.join('；') } : {}) };
  }
  if (values(schema)) {
    try { return { [key]: selection(input, schema) }; }
    catch (error) { if (!custom || /^\d+$/.test(input)) throw error; return { [custom]: input }; }
  }
  if (schema.type === 'boolean') {
    if (['是', '确认', '同意', 'true', 'yes'].includes(input.toLowerCase())) return { [key]: true };
    if (['否', '拒绝', '不同意', 'false', 'no'].includes(input.toLowerCase())) return { [key]: false };
    throw new Error('Invalid boolean');
  }
  return { [key]: schema.type === 'number' || schema.type === 'integer' ? JSON.parse(input) : input };
}
function render(question: AgentQuestion, id: string, current = formFields(question)[0]) {
  const fields = formFields(question).map(key => {
    const raw = question.requestedSchema.properties[key];
    const s = object(raw); const choiceSchema = s.type === 'array' ? object(s.items) : s;
    const choices = values(choiceSchema); const variants = choiceSchema.oneOf ?? choiceSchema.anyOf;
    const details = Array.isArray(variants) ? variants.map(object).map((v, i) => `${i + 1}. ${String(v.title ?? v.const)}${v.description ? `：${v.description}` : ''}`).join('\n') : choices?.map((v, i) => `${i + 1}. ${String(v)}`).join('\n');
    return `${key === current ? '【当前回答】' : ''}${key}：${String(s.title ?? s.type ?? '')}${s.description ? `\n${s.description}` : ''}${details ? `\n选项：\n${details}` : ''}${s.type === 'array' ? '\n可多选，用逗号分隔编号或选项文字。' : ''}${customField(question, key) ? '\n也可直接输入自定义回答，或用“其他：内容”。' : ''}${question.requestedSchema.required?.includes(key) ? '\n必填' : ''}`;
  }).join('\n\n');
  return `Claude 需要你回答：${question.message}\n\n${fields}\n\n直接回复当前项的选项文字、编号或回答即可，无需复制命令；可用“2 备注：补充说明”同时提交选项和说明。\n多项按顺序回答，完成后核对并回复“提交”；可用“修改 字段名 回答”修改，“跳过本项”跳过非必填项。\n若同时有多个提问请求，请回复对应提问消息，或用 /answer 指定编号。\n/answer ${id} <回答或 JSON 对象>\n/skip ${id} 跳过整个提问；/questions 重新查看。等待上限 10 分钟，任务总时限仍生效。`;
}
function draft(p: Pending, id: string) {
  const summary = Object.entries(p.answers).map(([key, value]) => `${key}：${Array.isArray(value) ? value.join('、') : String(value)}`).join('\n');
  const skipped = [...p.skipped].map(key => `${key}：已跳过`).join('\n');
  const next = remaining(p)[0];
  return `${[summary, skipped].filter(Boolean).join('\n')}\n\n${next ? `下一项请直接回复：\n\n${render(p.question, id, next)}`
    : `请核对以上回答，回复“提交”继续；“修改 字段名 回答”修改。\n/answer ${id} <回答或 JSON 对象>；/skip ${id} 跳过整个提问。`}`;
}
export class Interactions {
  private pending = new Map<string, Pending>();
  private references = new Map<string, string>();
  matches(key: string, replyTo?: string) { return !!replyTo && this.references.has(JSON.stringify([key, replyTo])); }
  target(key: string, replyTo?: string) {
    const reference = replyTo && this.references.get(JSON.stringify([key, replyTo]));
    if (reference) return reference;
    const requests = [...this.pending].filter(([, p]) => p.key === key);
    return requests.length === 1 ? requests[0][0] : undefined;
  }
  has(key: string, id: string) { return this.pending.get(id)?.key === key; }
  async notify(key: string, id: string, text: string, notify: Notify) {
    const reference = await notify(text, randomUUID());
    if (typeof reference === 'string') {
      this.references.set(JSON.stringify([key, reference]), id);
      // Keep bounded tombstones so a late answer cannot silently start new work.
      while (this.references.size > 1024) {
        const oldest = [...this.references].find(([, value]) => !this.pending.has(value));
        this.references.delete(oldest?.[0] ?? this.references.keys().next().value!);
      }
    }
    return reference;
  }
  count(key: string) { return [...this.pending.values()].filter(p => p.key === key).length; }
  list(key: string) { return [...this.pending.entries()].filter(([, p]) => p.key === key).map(([id, p]) => ({ id, text: Object.keys(p.answers).length || p.skipped.size ? draft(p, id) : render(p.question, id) })); }
  text(key: string) { return this.list(key).map(item => item.text).join('\n\n') || '当前没有等待回答的问题。'; }
  reply(key: string, input: string, replyTo?: string): string | undefined {
    const id = replyTo && this.references.get(JSON.stringify([key, replyTo]));
    if (id) return this.answer(key, id, input);
    const pending = [...this.pending.entries()].filter(([, p]) => p.key === key);
    if (!pending.length) return;
    if (pending.length > 1) return '当前有多个提问请求，请用 /questions 查看，再用 /answer <编号> <回答> 指定一个；本条未加入任务队列。';
    return this.answer(key, pending[0][0], input);
  }
  ask(key: string, question: AgentQuestion, signal: AbortSignal | undefined, notify: Notify): Promise<QuestionAnswer> {
    const entries = Object.entries(question.requestedSchema.properties);
    if (signal?.aborted || this.pending.size >= 8 || entries.length > 20 || !entries.length || JSON.stringify(question).length > 32000 || entries.some(([k, s]) => ['__proto__', 'constructor', 'prototype'].includes(k) || !supported(object(s)))) return Promise.resolve({ action: 'cancel' });
    const id = randomUUID();
    return new Promise(resolve => {
      const abort = () => settle({ action: 'cancel' });
      const timer = setTimeout(abort, 10 * 60 * 1000); timer.unref?.();
      const settle = (answer: QuestionAnswer) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer); signal?.removeEventListener('abort', abort); resolve(answer);
      };
      this.pending.set(id, { key, question, answers: {}, skipped: new Set(), settle });
      signal?.addEventListener('abort', abort, { once: true });
      void this.notify(key, id, render(question, id), notify).then(ok => { if (!ok) abort(); }, abort);
    });
  }
  answer(key: string, id: string, input: string) {
    const p = this.pending.get(id); if (!p || p.key !== key) return '问题不存在、已过期或无权回答。';
    try {
      const properties = p.question.requestedSchema.properties;
      let content: Record<string, unknown>;
      const json = input.trim().startsWith('{');
      if (json) content = object(JSON.parse(input));
      else if (input.trim() === '提交' && formFields(p.question).length > 1) content = p.answers;
      else {
        const edit = /^修改\s+(\S+)\s+([\s\S]+)$/.exec(input.trim());
        const key = edit ? edit[1] : remaining(p)[0];
        if (!key || !formFields(p.question).includes(key)) return `请指定有效字段修改，或回复“提交”。\n${draft(p, id)}`;
        const value = edit ? edit[2].trim() : input.trim();
        if (value === '跳过本项') {
          if (p.question.requestedSchema.required?.includes(key)) return '该项必填，不能跳过；请回答当前项。';
          delete p.answers[key]; const companion = customField(p.question, key); if (companion) delete p.answers[companion];
          p.skipped.add(key);
          if (formFields(p.question).length === 1) { p.settle({ action: 'accept', content: {} }); return '已跳过本项，Claude 将继续处理。'; }
          return draft(p, id);
        }
        const patch = parseField(p.question, key, value);
        if (!Object.keys(patch).length || Object.entries(patch).some(([k, v]) => !valid(v, object(properties[k]))
          || (k === customField(p.question, key) && !String(v).trim()))) return '回答无效：请检查当前项的类型、范围或选项；本条未加入队列。';
        if (p.question.requestedSchema.required?.includes(key) && !Object.hasOwn(patch, key)) return '回答无效：当前项必须选择一个给定选项，不能只提交自定义内容。';
        delete p.answers[key]; const companion = customField(p.question, key); if (companion) delete p.answers[companion];
        p.skipped.delete(key); Object.assign(p.answers, patch);
        const next = remaining(p)[0];
        if (next || formFields(p.question).length > 1) return `已记录。\n${draft(p, id)}`;
        content = p.answers;
      }
      if ((p.question.requestedSchema.required ?? []).some(k => !Object.hasOwn(content, k))
        || Object.entries(content).some(([k, v]) => !Object.hasOwn(properties, k) || !valid(v, object(properties[k])))) return '回答无效：请检查必填字段、类型和选项；问题仍在等待。';
      p.settle({ action: 'accept', content: content as NonNullable<QuestionAnswer['content']> }); return '回答已提交，Claude 将继续处理。';
    } catch { return '回答无效：请使用合法的回答或 JSON 对象；问题仍在等待。'; }
  }
  skip(key: string, id: string) {
    const p = this.pending.get(id); if (!p || p.key !== key) return '问题不存在、已过期或无权回答。';
    p.settle({ action: 'decline' }); return '已跳过该问题。';
  }
  cancel(key: string) { for (const p of [...this.pending.values()]) if (p.key === key) p.settle({ action: 'cancel' }); }
}
