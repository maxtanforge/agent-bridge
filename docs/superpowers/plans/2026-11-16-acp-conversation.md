# ACP Conversation Implementation Plan

> **For agentic workers:** Use subagent-driven-development for isolated tasks; keep the existing dev working tree and existing uncommitted changes. Publishing is handled separately after implementation review and user authorization.

**Goal:** Preserve conversation context and deliver ordinary follow-up input reliably through the installed ACP v1 adapter.

**Architecture:** Runtime owns the negotiated connection and session. Bridge owns the workspace lock, a bounded input buffer per active task, and the separate explicit task queue. Interactions owns structured request drafts. No additional model or gateway.

**Tech Stack:** TypeScript, Node test runner, SQLite, ACP SDK 2.6.0, Claude ACP 0.106.0.

## Tasks

- [x] Runtime lifecycle (`src/runtime.ts`, `test/runtime-lifecycle.test.ts`, dedicated stdio fixture): test multiple prompts within a task, process isolation across tasks, resume preference, load-only fallback, restoration failure without new-session fallback, negotiated close and cancellation. Implement capability-driven lifecycle, preserve owner/config boundaries, and validate tests. Review correction: defer cross-task warm reuse because ACP v1 prompt completion does not establish background quiescence; close before handoff and resume saved context on the next task.
- [x] Context retention (`src/store.ts`, `src/bridge.ts`, `test/session-idle.test.ts`): change idle tests to expect the same saved session after four hours and restart. Remove age-based binding deletion; retain legacy invalid-timestamp behavior. Every task closes resources before handoff, with idle cleanup retained as a fallback.
- [x] Ordered conversation input (`src/bridge.ts`, `src/agent-features.ts`, `src/types.ts`, `test/native-commands.test.ts`): test startup buffering, concurrent steer calls, promptRequired continuation, cancellation without replay, non-steering slash commands, attachments, full buffer and owner isolation. Add bounded per-active-task input state; drain serially; await in-flight steering before closing the task; continue only known-undelivered input in the same session.
- [x] Form drafts (`src/interactions.ts`, `test/interactions.test.ts`): add failing tests for `2 备注：说明`, multi-field review, explicit field edits and optional-field skip. Preserve existing single-question and JSON contracts; expose readable guidance without guessing semantic intent.
- [x] Documentation and review: align README, usage, design, capability and decision documents, including resource-only idle timeout, continuation receipts and form syntax. Review spec compliance then code quality. Run `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm test:bundle`; disclose that real model/Feishu validation is separate.

## Behavioral assertions

```ts
assert.deepEqual(openedSessions, [undefined, 'original-session']); // idle recycle preserves context
assert.equal(newSessionCallsAfterRestoreFailure, 0);
assert.deepEqual(deliveredInputs, ['first supplement', 'second supplement']);
assert.deepEqual(promptSessions, ['original-session', 'original-session']); // promptRequired only
assert.equal(retriesAfterUnknownSteerResult, 0);
assert.equal(steeredSlashCommands.length, 0);
assert.deepEqual(answer.content, { question_0: 'choice', question_0_custom: 'note' });
```

## Verification results

- Final review: all 263 tests passed, including the startup-buffer capacity regression.
- Typecheck, build, bundled startup smoke and whitespace checks passed.
- Independent review confirmed task-boundary process isolation and question-message correlation fixes. Repeated active-question reminders now retain at most 1024 reply references.
- No real Feishu delivery or model calls were used for acceptance; these remain deployment checks. Implementation and review completed on dev; merging and publishing follow the release workflow.
