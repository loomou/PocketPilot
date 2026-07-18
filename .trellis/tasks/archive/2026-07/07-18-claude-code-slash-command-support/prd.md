# Claude Code slash command support

## Goal

Record the verified Claude Code/Agent SDK contract that the separately developed
PocketPilot mobile frontend will use for its first fixed Command panel, and
confirm that the computer-side Agent in this repository requires no code or API
change.

## Background

- This repository contains the computer-side Agent and local administration UI,
  not the mobile conversation frontend. The mobile implementation is being
  developed separately and is outside this task's delivery scope.
- The Agent already transports raw `SDKUserMessage` and `SDKMessage` objects in
  both directions over `/v1/tasks/{taskId}/sdk`. It does not parse or normalize
  slash commands.
- The pinned `@anthropic-ai/claude-agent-sdk@0.3.210` exposes dynamic command
  metadata through `supportedCommands()`, initialization, and raw
  `system/commands_changed` messages. The mobile MVP deliberately uses a fixed
  frontend list; dynamic discovery is deferred.
- PocketPilot `taskId` is a runtime/control handle for a long-lived SDK Query,
  not a Claude transcript identifier. It can span multiple turns and
  `conversation_reset` boundaries.
- The SDK emits raw `conversation_reset.new_conversation_id` for `/clear` and
  fresh-conversation flows. The mobile client owns the resulting transcript and
  title reset while the existing `taskId`, Query, sockets, approvals, scheduler,
  audit ownership, and control stream remain active.

## Requirements

### Repository Boundary

- Do not add a slash-command catalog endpoint, backend command registry,
  command-specific parser, schema migration, or new control event in this
  repository.
- Preserve raw `SDKUserMessage` input and raw `SDKMessage` output unchanged.
  SDK command availability, parsing, errors, queuing, and execution remain
  Claude-owned.
- Preserve raw `system/commands_changed`, `system/informational`,
  `system/local_command_output`, `system/compact_boundary`, and
  `conversation_reset` messages without adding PocketPilot wrappers.

### Mobile Command Contract

- The separately developed mobile frontend owns a Command button that opens a
  fixed panel, shows the selected command's description and argument UI, and
  sends the resulting slash text through the ordinary raw SDK message path.
- The first panel contains exactly these eight primary commands:
  `/compact`, `/context`, `/usage`, `/rename`, `/recap`, `/review`,
  `/security-review`, and `/code-review`.
- Do not duplicate aliases as panel rows: `/cost` and `/stats` alias `/usage`;
  `/name` aliases `/rename`.
- Use the pinned SDK command shapes:
  - `/compact` accepts optional custom summarization instructions.
  - `/context`, `/usage`, `/recap`, and `/security-review` take no arguments.
  - `/rename` accepts an optional conversation name.
  - `/review` accepts an optional GitHub pull-request number.
  - `/code-review` accepts optional effort (`low`, `medium`, `high`, `xhigh`, or
    `max`) and an optional target.
- The `/code-review` panel does not expose `ultra`, `--fix`, or `--comment`.
  These SDK-supported values remain available through manually typed raw input.
- The fixed panel is a discoverability aid, not an execution allowlist. Any
  manually typed slash command still passes to Claude unchanged.
- Panel submissions use the same admission and ordering contract as ordinary
  composer input. They can be submitted while the task is idle, executing, or
  awaiting approval; PocketPilot does not add an idle-only gate or rewrite SDK
  `priority` and `shouldQuery`.

### New Conversation

- `/clear`, `/reset`, and `/new` do not appear in the Command panel. They map to
  the dedicated same-workspace New conversation action.
- With an active Query, New conversation sends `/clear` through the raw SDK
  input and lets Claude Code emit `conversation_reset`; PocketPilot does not
  emulate the reset or generate a replacement `taskId`.
- The mobile frontend mounts an empty transcript under
  `new_conversation_id`, clears the cached title, and leaves the prior Claude
  conversation available for resume.
- Without an active Query, the existing workspace-scoped `POST /v1/sessions`
  entry point remains the way to create a fresh runtime with Claude defaults.

## Acceptance Criteria

- [x] The pinned SDK's command names, descriptions, aliases, and argument hints
      for the eight approved commands have been verified through a
      non-persistent live initialization.
- [x] The fixed panel command set, parameter restrictions, alias handling, and
      manually typed fallback are recorded without introducing a backend
      command allowlist.
- [x] Existing repository evidence confirms that raw command input is accepted
      while idle, executing, or awaiting approval and that SDK scheduling fields
      remain unchanged.
- [x] `/clear` and `conversation_reset` are specified without conflating
      PocketPilot `taskId` with Claude conversation identity.
- [x] The current Agent transport already satisfies the required mobile
      contract; no production code, API documentation, migration, or regression
      test change is required in this repository.

## Out of Scope

- Implementing or testing the mobile Command panel in this repository.
- Dynamic mobile command discovery through `Query.supportedCommands()` or
  `commands_changed`.
- Reimplementing Claude Code command parsing, handlers, or result formatting.
- Exposing local Claude settings, credentials, filesystem enumeration, shell
  execution, or another remote administration surface.
- Starting an implementation phase for this planning-only task.
