# Enable Claude SDK streaming

## Goal

Enable real incremental Claude output in PocketPilot so the mobile client can
render text as the Agent SDK produces it instead of waiting for the complete
`assistant` message.

## Confirmed Facts

- `ClaudeSdkSession` already yields every `SDKMessage` unchanged, including
  `stream_event`.
- The Agent SDK emits raw partial events only when Query options include
  `includePartialMessages: true`.
- The WebSocket transport already forwards SDK messages without a PocketPilot
  wrapper; no mobile protocol change is required.
- The complete `assistant` message remains part of the SDK lifecycle and is the
  final authoritative content after partial events.

## Requirements

- Set `includePartialMessages: true` for every newly opened Claude SDK Query,
  including resumed sessions.
- Preserve the existing raw SDK message passthrough and long-lived input stream.
- Add a unit assertion that the Query factory receives the streaming option.
- Extend the opt-in live SDK contract to require raw stream events from both
  direct SDK and TaskManager paths.
- Keep the change scoped to SDK session construction and its tests; do not
  synthesize token animations or normalize SDK events.

## Acceptance Criteria

- [x] New and resumed Query options contain `includePartialMessages: true`.
- [x] Existing tests still prove `stream_event` objects reach callers unchanged.
- [x] The opt-in live contract fails if a real turn completes without a
  `stream_event`.
- [x] `pnpm lint`, `pnpm typecheck`, and `pnpm test` pass.
- [x] No API envelope, WebSocket message shape, or mobile-side behavior is
  changed.

## Validation Notes

- `pnpm build` also passes.
- `pnpm test:sdk:live` passes with a developer-provided absolute workspace and
  verifies raw `stream_event` delivery through both direct SDK and resumed
  TaskManager paths. The concrete local workspace remains process input and is
  not stored in the repository.

## Out Of Scope

- Mobile rendering or client-side delta-merging implementation.
- Replacing the SDK's final `assistant` message with a fabricated stream.
- Changes to session IDs, task lifecycle, controls, or transcript persistence.

## Completion Note (2026-07-21)

Implementation landed via `fix/enable-sdk-streaming` (`includePartialMessages:
true`, unit + live contract coverage) and was merged to main. Acceptance
criteria remain satisfied. Archiving this leftover planning entry.
