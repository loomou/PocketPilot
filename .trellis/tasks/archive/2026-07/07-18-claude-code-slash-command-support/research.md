# Research - Claude Code Slash Commands

## Local Evidence

Research used the installed `@anthropic-ai/claude-agent-sdk@0.3.210` and the
current project workspace on 2026-07-18.

- `Query.supportedCommands()` returns `SlashCommand[]` with `name`,
  `description`, `argumentHint`, and optional `aliases`.
- `SDKControlInitializeResponse.commands` is the initial structured catalog.
- `system/commands_changed` carries the full current catalog with REPLACE
  semantics. The SDK declaration explicitly says `supportedCommands()` remains
  the stale initialization list after a mid-session change.
- Raw SDK output already includes `system/informational`,
  `system/local_command_output`, `system/compact_boundary`, and
  `system/conversation_reset`; PocketPilot must transport these unchanged.
- `claude -p "/help" --no-session-persistence` returned
  `"/help isn't available in this environment."` without a model turn. CLI
  documentation or `/help` is therefore not a valid command source for SDK
  sessions.
- Initializing a real SDK Query in this workspace returned 51 commands. The
  list proves that availability is workspace/configuration dependent and mixes
  built-ins with project/user/plugin commands.

## Observed Command Groups

### Conversation and context

- `compact` - summarize current context; emits SDK compact boundary/result data.
- `context` - show structured/current context usage.
- `usage` (`cost`, `stats`) - show local usage/cost information.
- `clear` (`reset`, `new`) - start a new Claude session. The user decided this
  is the same-working-directory **New conversation** action, not a generic
  command-menu item.
- `rename` (`name`), `recap`, `goal`, and `insights` - session metadata or
  session-analysis operations.

### Existing structured controls

- `model`, `effort`, and `fast` overlap settings/control concepts. PocketPilot
  already has structured model and effort controls; fast mode is not currently
  exposed.
- `config` (`settings`) and `mcp` mutate or manage local Claude configuration.
  They are broader than the existing composer controls.
- `reload-skills` refreshes the source that contributes to the command catalog.

### Code and workflow commands

- `init`, `review`, `security-review`, `code-review`, `simplify`, `verify`,
  `doctor`, `run`, `deep-research`, and project-specific Trellis commands.
- User/project skills and plugin commands are the primary reason not to
  hardcode a PocketPilot list. Their names and arguments can change without an
  Agent release.

### UI-local, internal, or poor quick-action candidates

- `color` changes the terminal prompt bar and has no equivalent mobile value.
- `heapdump` writes a diagnostic file to the computer desktop.
- `__remote-workflow` is explicitly internal/server-session-oriented.
- `agents` is reported as removed in this environment.
- `design-consent` and `design-revoke` change access consent and should not be
  promoted as casual quick actions.

These categories are presentation guidance, not an execution security
boundary: a paired user can already type raw slash syntax into the SDK message
composer. Claude Code remains authoritative for whether a command executes.

## Verified MVP Panel Contracts

A non-persistent live initialization of the pinned SDK returned these exact
command shapes for the approved frontend panel:

- `compact`: `<optional custom summarization instructions>`.
- `context`: no arguments.
- `usage`: no arguments; aliases `cost` and `stats`.
- `rename`: `[name]`; alias `name`.
- `recap`: no arguments.
- `review`: `[pr number]`; the SDK description distinguishes GitHub pull-request
  review from working-diff `/code-review`.
- `security-review`: no arguments; reviews pending changes on the current
  branch.
- `code-review`:
  `[low|medium|high|xhigh|max|ultra] [--fix] [--comment] [<target>]`.

The `code-review` metadata states that `--fix` applies findings to the working
tree, `--comment` posts inline PR comments, and `ultra` runs a deep cloud
multi-agent review requiring claude.ai account access. These are materially
higher-impact options than an ordinary text argument. The approved MVP panel
therefore exposes only default/`low`/`medium`/`high`/`xhigh`/`max` effort and an
optional target. `ultra`, `--fix`, and `--comment` remain available only through
manually typed raw slash input.

## Repository Evidence

- PocketPilot has no mobile implementation in this repository; it defines the
  remote API contract that a mobile client consumes.
- `GET /v1/tasks/{taskId}/composer-options` currently returns models,
  permission modes, and effort only.
- `ClaudeSdkSession.initialize()` already obtains the complete
  `SDKControlInitializeResponse`, but `TaskManager` discards
  `initialization.commands` when building composer options.
- The raw task SDK WebSocket already forwards every `SDKMessage`, so
  `commands_changed` and command output need no new event wrapper.
- Existing runtime policy accepts later raw SDK messages while a task is
  executing or awaiting approval and preserves `priority`/`shouldQuery`.
  Command-panel output must use that same path; it is not a new PocketPilot
  control tier and receives no idle-only restriction.
- The SDK defines `conversation_reset` with `new_conversation_id` and explicitly
  requires the surface to mount a fresh transcript and clear its cached title.
  PocketPilot currently persists `message.session_id` generically and has no
  special reset/adoption path.
- `POST /v1/sessions` already creates an empty-history runtime for an authorized
  workspace. It remains necessary when there is no active Query to clear.
- `TaskManager.createClaudeConversation()` generates a PocketPilot `taskId`
  with `randomUUID()`. The task row, raw SDK URL, scheduler, approval state,
  replay/audit ownership, and SDK session reference all use that identity.
  Existing submission logic already reuses it across multiple user turns, so
  it is a runtime/control handle rather than a transcript identifier.
- `TaskManager.consumeSessionEvents()` currently forwards
  `conversation_reset` unchanged and does not rotate or terminalize the task.
  Keeping that behavior matches the raw SDK boundary: the mobile transcript
  changes at `new_conversation_id`, while the task-owned Query, WebSockets,
  approvals, scheduler, and control events remain attached to the same
  runtime.

## Recommended Product Boundary

1. Keep the first slash-command catalog in the frontend as an explicit fixed
   subset selected from the researched SDK command surface.
2. Preserve raw `system/commands_changed` on the existing SDK WebSocket, but do
   not add a backend command catalog API or make the MVP menu depend on it.
3. Submit slash syntax as an ordinary raw `SDKUserMessage`; do not add a command
   execution endpoint or server-side parser.
4. Render the approved fixed entries in a Command button panel. Each entry
   shows the command description and argument hint, collects any required
   argument, and constructs the raw slash string. Existing model/mode/effort
   buttons remain the primary structured controls.
5. Reserve `/clear` and its aliases for the same-workspace New conversation
   action. Send it through the existing raw SDK input, keep `taskId` and the
   Query alive, and require the mobile client to mount a fresh transcript at
   the unchanged SDK `conversation_reset` event's `new_conversation_id`.
6. Defer dynamic SDK command discovery, backend filtering policy, and
   project-specific command enumeration until a later product task.

## Scope Decision

The mobile conversation frontend is being developed outside this repository.
The current Agent already satisfies the required raw SDK transport,
execution-time admission, scheduling-field passthrough, output delivery, and
conversation-reset behavior. Therefore this Trellis task is a lightweight
planning/research record only: it requires no Agent implementation,
`design.md`, `implement.md`, or `task.py start` in this repository.
