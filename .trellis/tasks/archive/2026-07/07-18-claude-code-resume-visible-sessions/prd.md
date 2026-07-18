# Claude Code resume-visible PocketPilot sessions

## Goal

Make conversations created from PocketPilot behave like conversations created
from the Claude Code terminal: after creation in an authorized workspace, the
same persisted Claude session must be discoverable and resumable from Claude
Code's terminal `/resume` picker as well as from PocketPilot.

## Background

- PocketPilot currently creates a new conversation through the pinned Claude
  Agent SDK `query()` entrypoint.
- The SDK persists those conversations as programmatic/headless `sdk-ts`
  sessions.
- Claude Code's terminal `/resume` picker deliberately excludes programmatic
  sessions, while the SDK catalog can include them with
  `includeProgrammatic: true`.
- PocketPilot currently opts into programmatic sessions so its own catalog,
  history, attachment, and continuation paths work.
- The resulting session is persisted and usable through PocketPilot, but its
  absence from terminal `/resume` violates the product requirement that remote
  behavior match direct Claude Code usage.

## Requirements

- Investigate the pinned SDK and installed Claude Code public contracts for an
  officially supported way to create a terminal-visible session or control its
  entrypoint classification.
- PocketPilot-created conversations must remain ordinary Claude-owned sessions:
  one `sdkSessionId`, SDK-owned history, and continuation through `Options.resume`.
- A newly created PocketPilot session for workspace W must appear in Claude
  Code's terminal `/resume` picker when Claude Code is opened in W.
- The session must remain visible and resumable through PocketPilot's existing
  SDK catalog/history/task flow.
- Preserve raw SDK input/output passthrough, the long-lived Query contract,
  controls, approvals, task state, and authorized-workspace policy.
- Keep the implementation at the Agent SDK Query/child-environment boundary.
  Do not edit, rename, parse, or synthesize files under `~/.claude`, and do not
  spoof private transcript/session metadata.
- For a Query with no `resume`, pass the truthful PocketPilot process
  entrypoint so the newly created session participates in terminal `/resume`
  visibility. Do not label it as terminal `cli`.
- For a Query with `resume`, do not request a new classification or fork. Keep
  the selected session ID and its Claude-owned creation provenance unchanged.
- Keep existing terminal-created sessions attachable without changing their
  Claude-owned identity or visibility.
- Existing PocketPilot-created `sdk-ts` sessions remain available through
  PocketPilot but are not migrated or rewritten for terminal visibility.
- Add a real integration assertion for terminal visibility in addition to the
  existing SDK catalog/history assertions, using a developer-supplied workspace
  and no committed local path.

## Acceptance Criteria

- [x] Research identifies whether the pinned public SDK/CLI can create or
      reclassify a terminal-visible session, with evidence from installed types,
      runtime behavior, or official documentation.
- [x] A new PocketPilot conversation is listed by the same filtering semantics
      used by Claude Code terminal `/resume` for its workspace.
- [x] The same session ID remains usable through PocketPilot history and
      continuation after terminal visibility is established.
- [x] Existing session attachment, raw SDK transport, controls, task lifecycle,
      and workspace authorization do not regress.
- [x] Resuming a session that is already terminal-visible preserves the same
      session ID and remains visible after PocketPilot adds further turns.
- [x] A resume Query does not apply the new-conversation entrypoint override or
      fork the selected session.
- [x] No Claude private storage format or developer-specific workspace value is
      committed or modified directly.
- [x] Offline tests remain deterministic; real Claude Code verification remains
      explicit, bounded, and developer-configured.

## Out of Scope

- Editing Claude transcript files or global/project Claude settings to falsify
  session provenance.
- Reimplementing Claude Code's session store, transcript parser, or `/resume`
  picker.
- Changing visibility rules for sessions created by unrelated SDK applications.
