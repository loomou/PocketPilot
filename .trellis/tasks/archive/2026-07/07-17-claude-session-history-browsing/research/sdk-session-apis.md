# Installed SDK Session APIs

Sources:

- installed `@anthropic-ai/claude-agent-sdk@0.3.210` TypeScript declarations
- bundled Claude Code `2.1.210` (`manifest.json`, build commit
  `88e9fbf39bf4efa5bca44549b7fd9461628657e6c`)
- official [Model configuration](https://code.claude.com/docs/en/model-config)
- official [Permission modes](https://code.claude.com/docs/en/permission-modes)
- official [Agent SDK TypeScript reference](https://platform.claude.com/docs/en/agent-sdk/typescript)

## Discovery

```ts
listSessions(options?: {
  dir?: string;
  limit?: number;
  offset?: number;
  includeWorktrees?: boolean;
  includeProgrammatic?: boolean;
}): Promise<SDKSessionInfo[]>;
```

- With `dir`, the SDK scopes discovery to that project and, by default, its git
  worktrees.
- `includeWorktrees` defaults to `true`. This can cross the selected authorized
  root, so PocketPilot must set it to `false` unless every returned worktree is
  separately canonicalized and authorized.
- `includeProgrammatic` defaults to `true`; it includes SDK/headless and daemon
  sessions. The user's requirement says every session, so the MVP should keep
  these unless product review narrows the catalog.
- `limit` and `offset` provide SDK-owned pagination.

`SDKSessionInfo` contains `sessionId`, `summary`, `lastModified`, and optional
`fileSize`, `customTitle`, `firstPrompt`, `gitBranch`, `cwd`, `tag`, and
`createdAt`.

## History

```ts
getSessionInfo(sessionId, { dir? }): Promise<SDKSessionInfo | undefined>;

getSessionMessages(sessionId, {
  dir?: string;
  limit?: number;
  offset?: number;
  includeSystemMessages?: boolean;
}): Promise<SessionMessage[]>;
```

`getSessionMessages` returns the conversation chain in chronological order.
`includeSystemMessages` defaults to `false`. `SessionMessage` is SDK-owned and
contains:

```ts
{
  type: "user" | "assistant" | "system";
  uuid: string;
  session_id: string;
  message: unknown;
  parent_tool_use_id: string | null;
  parent_agent_id: string | null;
}
```

An empty array alone cannot distinguish an empty/missing session. Validate the
selected ID first with `getSessionInfo(sessionId, { dir })`.

### Long-history behavior in the installed SDK

Inspection of bundled SDK `0.3.210` confirms that local
`getSessionMessages()`:

1. locates and reads the transcript;
2. parses entries and reconstructs the active parent-UUID conversation chain;
3. filters user/assistant and optional system messages;
4. only then applies `offset`/`limit` with an array slice.

Consequences:

- SDK pagination bounds the HTTP response, network traffic, JSON decoding on
  the mobile device, and UI rendering, but it does not avoid the Agent-side
  full-file read/chain reconstruction for each request.
- The SDK returns messages chronologically and has no reverse/latest-page
  option, total-count API, streaming history iterator, or UUID cursor.
- A desktop-style screen should initially return only the most recent bounded
  page and prepend older pages as the user scrolls upward. PocketPilot may use
  an out-of-band `beforeUuid` cursor after obtaining the SDK array, while
  preserving every returned `SessionMessage` unchanged.
- A missing cursor after the SDK chain changes must produce a stable stale
  cursor response so the client can reload the latest page; never add cursor
  fields to SDK messages.
- Repeated older-page requests necessarily repeat SDK parsing unless
  PocketPilot retains a full transient transcript. The latter would increase
  memory/privacy risk and create a second in-memory transcript, so the MVP
  should prefer stateless reads and accept the cost of user-initiated older
  page loads.

History browsing is not model context replay. Continuation uses
`Options.resume`; PocketPilot must never concatenate historical messages into a
new prompt. Claude Code owns transcript compaction and context-window behavior
exactly as it does on the computer.

## Continuation

`query({ options: { resume: sessionId }, prompt: AsyncIterable<SDKUserMessage> })`
continues the selected Claude session. PocketPilot already forwards a persisted
task `sdkSessionId` to `Options.resume`, but its task-creation API cannot yet
bind an arbitrary SDK-discovered session.

The current task table does not enforce uniqueness on `sdk_session_id`, so the
design must prevent two non-terminal PocketPilot tasks from opening the same
Claude session concurrently.

## Composer Controls

The same pinned SDK exposes the desktop-style controls required by the
conversation composer:

- `Query.supportedModels()` returns `ModelInfo[]`. Each model can report
  `supportsEffort` and `supportedEffortLevels`, whose declared values are
  `low`, `medium`, `high`, `xhigh`, and `max`.
- `Query.setModel(model)` changes the live model.
- `Query.setPermissionMode(mode)` changes the live Claude Code permission mode.
  The pinned contract declares `default`, `acceptEdits`, `bypassPermissions`,
  `plan`, `dontAsk`, and `auto`; PocketPilot already exposes this installed-SDK
  capability rather than requiring the client to own the list.
- `Options.effort` applies an `EffortLevel` when a Query is opened.
- `Query.applyFlagSettings(settings)` is explicitly documented as a supported
  mid-session settings update in streaming-input mode.
- There is no direct `Query.setEffort()` method. Although `EffortLevel` and
  per-model discovery can include `max`, the generated
  `Settings.effortLevel` member only declares `low`, `medium`, `high`, or
  `xhigh`. `setMaxThinkingTokens()` is deprecated and controls thinking
  configuration, not named effort, so it is not a valid substitute.

Claude Code and the SDK define one consistent mid-session behavior:

- `/model <name>` switches the current session immediately. The next response
  uses the new model; the picker may ask for confirmation when prior output
  exists because the full history must be read without the old prompt cache.
- Claude Code modes switch during a session. The CLI cycles them with
  `Shift+Tab`; Desktop uses the selector beside Send. SDK hosts use
  `setPermissionMode()`.
- `/effort <level>` changes the current session, and SDK hosts use
  `applyFlagSettings({ effortLevel })`.
- The SDK reference says `setModel()`, `setPermissionMode()`, and
  `applyFlagSettings()` modify the running Query without restarting it. These
  settings are applied on the next turn, so an in-flight turn is not rewritten.
- Claude Code itself owns validation and fallback. An unrecognized model is
  rejected and the current model remains active. An effort unsupported by the
  selected model falls back according to Claude Code's documented rules.

The official SDK reference states that `applyFlagSettings().effortLevel`
accepts an effort-level name, which includes model-advertised `max`, even though
the generated `Settings` type reserves persisted settings to
`low`/`medium`/`high`/`xhigh`. This is a declaration/runtime boundary, not a
reason to restart the Query. Implement it behind a narrow SDK compatibility
adapter and contract-test it against bundled Claude Code `2.1.210`.

`ultracode` appears in Claude Code's `/effort` menu but is a session setting,
not a model effort level. The official TypeScript guidance is to call
`applyFlagSettings({ ultracode: true })`; it must not be mislabeled as a value
from `ModelInfo.supportedEffortLevels`.

`resolveSettings({ cwd })` is also a public (alpha) SDK API. It resolves the
same user/project/local/managed settings cascade that a Query sees and can
provide the configured starting `model`, `effortLevel`, and
`permissions.defaultMode`. The resumed Query's emitted `system/init` message is
authoritative for its actual model and permission mode; later `system/status`
messages can also report permission-mode changes.

PocketPilot therefore should forward selector changes immediately through
these live SDK controls, wait for their success or error, and let the next turn
consume the updated state. It should not defer a private bundle of controls to
the Send action, restart the Query, implement its own effort fallback, or write
Claude settings files itself.

Claude Code surface restrictions are distinct from SDK capabilities. The CLI's
normal cycle contains `default`, `acceptEdits`, and `plan`; `auto` and
`bypassPermissions` appear only when enabled, and `dontAsk` is start/config
only. Claude.ai Remote Control intentionally exposes only Manual, Accept edits,
and Plan for local sessions. PocketPilot is an SDK host rather than that
Claude.ai product surface, so it should retain the existing rule of reporting
the pinned SDK `PermissionMode` contract and forwarding the selected value to
`setPermissionMode()`. It must not copy Claude.ai's three-mode product allowlist
or claim that an SDK-declared mode is usable when Claude Code rejects it under
the current account or managed policy.

## Boundary

These public SDK functions read Claude's local session storage internally.
PocketPilot should call them rather than locating or parsing `~/.claude`
JSONL. Session and message results remain SDK-owned transient response data and
must not be copied into PocketPilot persistence or logs.

## Workspace Bootstrap Capability Matrix

The SDK exposes different information before and after a Query exists. A
workspace-selection response must not pretend that Query-scoped state is
available from a directory alone.

### Available from an authorized directory without starting a Query

- `listSessions()` provides each session's ID, display summary/title, first
  prompt, created/modified times, final git branch, cwd, tag, and local file
  size when available.
- `resolveSettings({ cwd })` can resolve the same settings cascade Claude Code
  sees. Only an allowlisted projection such as configured model,
  `permissions.defaultMode`, and `effortLevel` is appropriate for a remote
  composer default; the full settings object can contain unrelated or
  sensitive machine configuration and must not be returned.
- PocketPilot already knows its pinned SDK/protocol version and SDK-declared
  permission-mode values.
- The existing new-task path can be hidden behind a session-centric "New
  conversation" entry so a workspace with no history is still usable.

The SDK does not provide a general workspace file tree or git-status API at
this stage. PocketPilot should not compensate by automatically scanning and
uploading directory contents.

### Available only after attaching/starting a Query

- The raw SDK `system/init` message reports the actual `cwd`, selected model,
  permission mode, Claude Code version, tools, MCP server summary, slash
  command names, output style, skills, plugins, fast-mode state, and protocol
  capabilities.
- `supportedModels()` returns the selectable model catalog and each model's
  effort capabilities.
- `supportedCommands()` returns command/skill names, descriptions, argument
  hints, and aliases for composer autocomplete.
- `supportedAgents()` returns selectable/available agent names, descriptions,
  and model overrides.
- `mcpServerStatus()` returns integration status and tool metadata.
- `getContextUsage()` and background-task/status controls can support later
  diagnostics, but they are live-session status rather than workspace-picker
  data. Context usage can contain memory-file paths and should not be returned
  wholesale without a separately reviewed privacy projection.

`accountInfo()` can expose email, organization, subscription, token source, and
provider. Full account data, raw MCP configuration/error text, plugin paths,
environment variables, credentials, file contents, and the complete Claude
settings cascade are not appropriate default remote payloads.

The SDK also supports session rename, tag, delete, fork, and subagent-history
operations. Those are explicit later actions, not data that should be bundled
into the initial workspace response.
