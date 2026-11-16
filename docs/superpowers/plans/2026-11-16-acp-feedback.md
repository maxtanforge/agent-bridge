# ACP task feedback implementation plan

**Goal:** Default to streaming feedback driven by actual ACP events, with a five-second visible-feedback fallback and bounded cleanup.

**Architecture:** Keep the existing scheduler and ACP request lifetime. A task-local feedback controller owns stream scheduling and Typing; AgentState projects bounded tool/plan summaries. Question lifecycle contributes a waiting state. Explicit auto/background retain compatibility.

**Tech stack:** TypeScript, node:test, ACP, Feishu CardKit.

- [x] Add regression tests for silent startup, tool-only work, concurrent tools, questions, late events, failed delivery and final ordering; run them before implementation.
- [x] Add `src/task-feedback.ts`; connect it from `src/bridge.ts` and expose sanitized progress from `src/agent-state.ts` / `src/agent-features.ts`. Keep task completion governed by prompt stopReason and runtime cleanup.
- [x] Ensure `src/feishu-replies.ts` delivers one fallback acknowledgement when cards are unavailable and a deduplicated completion reminder for long streams. Preserve final result retrieval and delivery accounting.
- [x] Change config, environment and Compose defaults to stream; update usage, deployment, architecture and capability documentation. Preserve existing releases.md changes.
- [x] Run targeted tests, full tests, typecheck, build and bundle smoke. Review task cancellation, delivery ordering, event ownership and docs against code; record remaining deployment-only checks.

Acceptance: fast tasks produce only a final result; silent tasks produce status at the configured threshold; text/tool/plan updates merge into one card; waiting questions override activity; visible feedback removes Typing; final output follows pending progress and cannot be overwritten by late events. No new LLM, no inferred percent complete, no scheduler release at the notification threshold.

Verification: 209 tests passed, including installed Adapter negotiation; typecheck, build and bundle smoke passed. No real model or Feishu messages were sent. Terminal persistence failure now stops task admission, covered by a regression test.

Review follow-ups: dev pushes currently have no CI trigger (main and PR-to-main are covered); real Feishu card permissions, notifications, cancellation and Linux/Docker process lifecycle still require deployment validation. Native background processes are not tracked as independent Bridge tasks. Existing docs/releases.md changes were preserved.
