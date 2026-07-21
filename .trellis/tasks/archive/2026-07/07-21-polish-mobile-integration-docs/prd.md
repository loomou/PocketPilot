# Polish mobile integration docs for parity

## Goal

Rewrite and expand PocketPilot mobile integration docs so a client can implement the completed Claude/Codex parity surface end-to-end—discovery → history → thread lifecycle → native actions → status catalogs → reconnect—without reading source code.

## Background

Backend parity work is complete for:

- Capabilities: `attachments`, `nativeActions`, `statusCatalogs`, `threadManagement`, `historyFilters`, readiness statuses + stable `reasonCode`
- REST conversation lifecycle: list filters, create/attach, history, fork, archive/unarchive/delete (Codex confirm rules)
- History honesty: Claude honors `includeSystemMessages`; Codex rejects `true` with `HISTORY_FILTER_NOT_SUPPORTED`
- Codex Agent: subscribe-time `agent.checkpoint`; subsequent frames pure native; optional `afterCursor`
- Opt-in live suite: `pnpm test:codex:live`

Current docs lag in structure (general guide REST inventory incomplete; Codex guide section order/state machine still partially pre-checkpoint).

## Decisions

| # | Decision | Choice |
|---|----------|--------|
| 1 | Codex mobile guides | Full rewrite (en + zh-CN equivalent) |
| 2 | General mobile guides | Expand/restructure for multi-provider parity (en + zh-CN) |
| 3 | Outline style | Client-path narrative (not OpenAPI dump, not insert-only) |
| 4 | App-server protocol guide | Light cross-links only; not a full rewrite |
| 5 | Claude SDK message-types guide | Out of scope except cross-links |

## Target outlines

### Codex mobile guide (`docs/codex-mobile-integration-guide.{en,zh-CN}.md`)

1. Transport / auth / workspace
2. Discover readiness + capabilities (`reasonCode`, closed capability objects)
3. Conversation REST (list filters, create/attach, history + historyFilters, fork, archive/unarchive/delete + confirm)
4. Agent WebSocket (checkpoint first frame, pure native frames, allowed methods, native actions, status catalogs)
5. Approvals
6. Reconnect / `afterCursor` / checkpoint client rules
7. Recommended state machine
8. Errors and recovery
9. Claude differences matrix
10. Do / don’t

### General mobile guide (`docs/mobile-integration-guide.{en,zh-CN}.md`)

1. Shared auth / workspace / task model
2. Multi-provider discovery and readiness
3. Shared REST inventory (including fork/archive/unarchive/delete)
4. Agent WS vs control-events WS
5. Provider differences matrix (Claude vs Codex)
6. Capability-driven client checklist
7. Error recovery
8. Links to Codex-specific and Claude SDK guides

## Requirements

1. **Rewrite Codex mobile guides** using the client-path outline; keep factual parity with current code/contracts/OpenAPI.
2. **Expand general mobile guides** for multi-provider parity (not only a REST table patch), including capability checklist.
3. **Bilingual equivalence**: every material change lands in both en and zh-CN for that guide family.
4. **Honesty rules**: no invented endpoints/fields; OpenAPI remains field-level source of truth; closed capability shapes only.
5. **Cross-links**: general guide points to Codex guide for confirm semantics, checkpoint, native actions; Codex guide points back for shared auth/workspace.
6. **App-server guide**: only update pointers/cross-links if rewrite renames concepts; no full rewrite.
7. **Validation**: `pnpm test -- test/api-docs/mobile-openapi.test.ts` (and any doc-asserting tests) still pass.

## Acceptance Criteria

- [ ] Codex mobile en+zh rewritten to client-path outline and cover readiness, capabilities, REST lifecycle, actions, catalogs, checkpoint reconnect, state machine, errors, differences, do/don’t.
- [ ] General mobile en+zh restructured for multi-provider parity, including full REST inventory and capability-driven checklist.
- [ ] State machine / reconnect text no longer contradicts `agent.checkpoint` + optional `afterCursor`.
- [ ] Error tables include client-relevant codes such as `CONFIRMATION_REQUIRED` and `HISTORY_FILTER_NOT_SUPPORTED`.
- [ ] en/zh pairs are equivalent for edited guide families.
- [ ] No invented API behavior; OpenAPI/doc tests still pass.
- [ ] `codex-app-server-integration.en.md` remains protocol-oriented with only light cross-link updates if needed.

## Out of Scope

- New backend features (attachments upload, per-publish checkpoint, unreviewed safety notifications).
- Full rewrite of `docs/codex-app-server-integration.en.md`.
- Rewrite of `docs/claude-sdk-message-types.zh-CN.md`.
- README/marketing redesign.
- Committing generated OpenAPI JSON blobs beyond existing repo practice.

## Notes

- Docs-only; still complex (4 major markdown files + bilingual). Use design.md + implement.md + jsonl manifests.
- Prefer quoting current contracts/OpenAPI over inventing examples.
