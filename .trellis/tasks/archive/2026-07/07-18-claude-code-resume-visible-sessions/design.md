# Design - Claude Code resume-visible PocketPilot sessions

## Scope and Boundary

This change adjusts only the provenance supplied when PocketPilot creates a new
Claude Agent SDK Query. It does not change the mobile API, task/session identity,
raw SDK transport, history format, storage schema, authorization policy, or
Claude session files.

The pinned SDK internally defaults an absent `CLAUDE_CODE_ENTRYPOINT` to
`sdk-ts`. For a new PocketPilot conversation, the session adapter will instead
pass a copied child environment containing:

```text
CLAUDE_CODE_ENTRYPOINT=pocketpilot
```

`pocketpilot` truthfully identifies the creating host. It is deliberately not
`cli`, and the parent `process.env` is never mutated.

## Query Construction Rules

`openClaudeSdkSession()` owns the rule because it is the single production
Query factory boundary:

```text
options.resume is undefined
  -> new conversation
  -> Options.env = { ...process.env, CLAUDE_CODE_ENTRYPOINT: "pocketpilot" }

options.resume is a session ID
  -> existing conversation
  -> omit Options.env override
  -> Options.resume = original session ID
```

This keeps the decision out of TaskManager and ensures every new-conversation
caller has the same provenance. Existing terminal-created and PocketPilot
sessions continue through their original SDK session ID. No `forkSession`, new
session ID, or mutation API is used during attachment.

## Data Flow

```text
PocketPilot create conversation
  -> TaskManager creates idle session-centric task (sdkSessionId=null)
  -> openClaudeSdkSession({ cwd })
  -> child Query env includes entrypoint=pocketpilot
  -> raw system/init supplies new sdkSessionId
  -> SDK persists one Claude-owned session
  -> listSessions({ includeProgrammatic:false }) contains sdkSessionId

PocketPilot select existing conversation
  -> TaskManager validates catalog/workspace
  -> openClaudeSdkSession({ cwd, resume:sdkSessionId })
  -> no PocketPilot entrypoint override
  -> same session/history continues
  -> existing terminal visibility remains unchanged
```

## Visibility Contract

For the pinned SDK, `includeProgrammatic: false` is the documented equivalent
of terminal `/resume` filtering. A new PocketPilot session must appear in both
the inclusive SDK catalog and the terminal-parity filtered catalog. After
TaskManager resumes and adds a turn, the same ID must still appear in the
filtered catalog.

This test locks an installed-runtime behavior because
`CLAUDE_CODE_ENTRYPOINT` is not currently a documented public SDK setting. An
SDK/Claude Code upgrade must not proceed if the live visibility assertion
fails.

## Existing Sessions

- Terminal-created sessions: attach and resume the same ID; no reclassification.
- New PocketPilot sessions after this change: terminal-visible with entrypoint
  `pocketpilot`.
- Legacy PocketPilot `sdk-ts` sessions: remain available through PocketPilot's
  `includeProgrammatic:true` catalog and remain hidden from terminal `/resume`.
- No migration, transcript parsing, or private metadata rewrite.

## Tests

### Offline

- New Query receives a copied environment with the PocketPilot entrypoint.
- The copied environment retains inherited values and does not mutate
  `process.env`.
- Resume Query contains the original `Options.resume` and no PocketPilot env
  override.
- Existing wrapper forwarding, raw messages, controls, and close behavior stay
  unchanged.

### Live

Extend the developer-configured `pnpm test:sdk:live` scenario:

1. Create the marked session through the production wrapper.
2. Prove its ID appears with `includeProgrammatic:false` in the supplied cwd.
3. Resume the same ID through production TaskManager and complete the third
   turn.
4. Prove the same ID still appears with `includeProgrammatic:false` and its
   history remains readable.

Assertions remain metadata-only and never print prompts, model output, local
paths, credentials, or Claude settings.

## Compatibility and Rollback

There is no Agent database or API migration. Rollback removes the new child
environment override and visibility assertions; sessions created while the
feature was active remain ordinary Claude-owned sessions. The package remains
pinned until the live contract passes against an intended SDK/CLI upgrade.

