# Design - Mobile integration implementation guide

## Deliverables

| File | Ownership |
| --- | --- |
| `docs/mobile-integration-guide.en.md` | Canonical protocol/behavior guide |
| `docs/mobile-integration-guide.zh-CN.md` | Strict Simplified Chinese translation |
| `README.md` | Labeled links to both guides near Mobile API Documentation |

No production TypeScript, route, schema, migration, generated OpenAPI, or
mobile application file is changed by this task.

## Canonical/Translation Model

The English guide is written and verified first because production source,
OpenAPI, SDK declarations, error identifiers, and route tests use English. The
Chinese guide then mirrors the English structure.

Translation rules:

- Translate prose, headings, table descriptions, notes, and diagram labels.
- Preserve paths, operation IDs, JSON, code blocks, type/field/state/error names,
  close codes, command strings, and synthetic identifiers.
- Do not add examples, warnings, requirements, or recommendations to only one
  language.
- When a discrepancy appears, verify behavior against current source/OpenAPI,
  correct English, then synchronize Chinese.

## Guide Architecture

Both guides use the following section order:

1. Purpose, audience, versions, and sources of truth.
2. Non-negotiable boundaries and terminology/identity table.
3. Transport overview and end-to-end mobile flow.
4. Pairing, device proof, credential claim, refresh, and revocation.
5. Authorized workspaces and session discovery.
6. History pagination and history/live transcript ownership.
7. Internal task attachment/creation and task state model.
8. Raw SDK WebSocket protocol and reconnect.
9. PocketPilot control WebSocket protocol and reconnect.
10. Composer initialization, model/mode/effort ordering, and Send.
11. Approval lifecycle, interrupt, close, disconnect, and priority.
12. Fixed Command panel and raw slash submission.
13. Same-workspace New conversation and `conversation_reset`.
14. Error/close-code recovery matrix.
15. Security and data-handling boundaries.
16. Implementation sequences and mobile acceptance checklist.
17. OpenAPI/SDK references and compatibility notes.

The REST operation reference is a compact workflow table linking operation IDs
to purpose and sequence step. Request/response property detail remains in
OpenAPI; the guide includes only payloads needed to explain cross-operation
behavior.

## Diagrams and Examples

Use Mermaid `sequenceDiagram`/`stateDiagram-v2` blocks plus adjacent prose so
the guide remains usable in renderers that do not execute diagrams. Required
sequences:

1. Pair and claim credentials.
2. Refresh rotating credentials.
3. Open existing session with history, attachment, raw subscribe, activation,
   composer initialization, and Send.
4. Create new conversation with raw subscriber before activation.
5. History pagination plus live UUID deduplication.
6. Tool approval and resolution.
7. SDK/control reconnect with their independent cursors.
8. Control-before-Send ordering.
9. Interrupt/settle then `/clear`, followed by `conversation_reset` without
   task/socket rotation.

JSON examples are synthetic and minimal but valid against current runtime
schemas. Raw SDK examples remain unwrapped. Platform-neutral pseudocode shows
state transitions and ordering without choosing a mobile framework.

## Verification Design

### Contract accuracy

- Generate/read `dist/openapi/mobile-v1.json` and enumerate method/path,
  operation ID, authentication, and response status.
- Cross-check WebSocket frames and close codes against
  `task-event-routes.ts`, `task-sdk-routes.ts`, and
  `mobile-openapi.ts`.
- Cross-check states, approvals, errors, history, priority, and controls against
  task/auth sources plus their tests.
- Cross-check command argument hints and reset type against the pinned SDK and
  archived live research.

### Bilingual parity

Run a lightweight structural audit that compares:

- ordered heading levels/counts;
- fenced code block count and technical block content;
- Mermaid block count;
- endpoint path, operation ID, error/close code, task state, and command sets;
- table counts and row counts;
- relative-link targets.

Exact prose equality is neither expected nor useful. Technical inventories and
behavioral coverage must match.

### Repository quality

Run Markdown/link/content checks plus `pnpm lint`, `pnpm typecheck`,
`pnpm test`, and `pnpm build`. Inspect generated output only for unintended
drift; this task should not intentionally change OpenAPI.

## Compatibility and Maintenance

- Put a verification header in both guides naming Agent API `/v1`, SDK version
  `0.3.210`, and the generated OpenAPI locations.
- New/changed REST routes update OpenAPI first, then both guides only when the
  mobile workflow changes.
- SDK upgrades require rechecking raw message types, commands,
  `conversation_reset`, permission modes, model/effort capabilities, and close
  behavior before changing the documented version.
- Do not maintain copied exhaustive SDK unions in the guide.

## Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| Prose drifts from runtime | Link to OpenAPI and cite current source/test owners; verify examples |
| Chinese/English divergence | Canonical English workflow plus structural parity audit |
| Guide becomes an alternate schema | Keep REST field detail in generated OpenAPI |
| SDK frames are accidentally wrapped | Use raw examples and explicit wrong/correct warning |
| Identity values are conflated | One authoritative identity table and repeated sequence labels |
| `/clear` is treated as interrupt or task rotation | Dedicated interrupt/settle/reset sequence |
| Real secrets or paths leak into docs | Synthetic-only examples and content scan |
| Platform advice becomes stale | Protocol-only JSON/pseudocode; no mobile framework/library guidance |

## Rollback

This is documentation-only. Rollback removes the two guide files and README
links together. Never retain only one language version or revert generated
OpenAPI/production code as part of this task.
