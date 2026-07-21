# Claude Code session lifecycle and SDK message research

## Goal

Document when Claude Code / Claude Agent SDK creates a new `sessionId` and which raw SDK message types can be returned to a PocketPilot client.

## Confirmed Facts

- The official Agent SDK agent-loop documentation defines the beginning of a session as: receive a prompt, then emit a `SystemMessage` with subtype `init` containing session metadata.
- The official session documentation says a first `query({ prompt })` creates a fresh session, and the session ID is exposed on the init `SystemMessage` and final result.
- The official SDK API does not expose an operation for creating an empty persisted session independently of a prompt/query.
- A blank composer is therefore application UI state, not yet a resumable Claude session. The first submitted user message starts the Query/session lifecycle.
- PocketPilot's `taskId` can exist before a Claude `sessionId`; the two identifiers have different lifecycles.
- The installed `@anthropic-ai/claude-agent-sdk` is version `0.3.210` and exposes a large `SDKMessage` union. Many operational events use `type: "system"` and are distinguished by `subtype`.
- With `includePartialMessages: true`, the SDK additionally emits `type: "stream_event"` messages containing raw Claude API stream events. The official stream order is `message_start`, content block start/delta/stop, `message_delta`, `message_stop`, then the complete assistant message.

## Requirements

- Base the conclusion primarily on official Claude Code / Agent SDK documentation.
- Distinguish empty UI state, SDK Query startup, Claude `sessionId`, and persisted transcript visibility.
- Treat local SDK behavior only as supporting evidence, not the source of the contract.
- Provide a representative wire example for every installed `SDKMessage` variant and distinguish transcript content from progress/diagnostic events.

## Acceptance Criteria

- [x] Cite the official session-management documentation.
- [x] Cite the official agent-loop event ordering.
- [x] State whether an empty conversation has a Claude `sessionId`.
- [x] Explain the consequence for PocketPilot without changing product code.
- [x] Enumerate the installed SDK message variants and give a wire example for each.
- [x] Explain the nested `assistant.message.content[]` block types and raw stream-event nesting.

## Out of Scope

- Modifying PocketPilot session/task behavior.
- Changing the mobile API or conversation UI.

## Completion Note (2026-07-21)

Research deliverables and acceptance criteria are complete. No product code
changes were required. Archiving as a finished planning/research task.
