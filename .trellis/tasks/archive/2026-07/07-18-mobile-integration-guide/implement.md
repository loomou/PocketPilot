# Implementation plan - Mobile integration implementation guide

## Ordered Checklist

1. **Freeze the evidence inventory**
   - Regenerate or inspect `dist/openapi/mobile-v1.json`.
   - Record every mobile method/path, operation ID, authentication requirement,
     response status, and both `x-websocket` extensions.
   - Re-read exact auth, workspace/session, task, approval, history, replay,
     error, and close-code owners before drafting examples.

2. **Write the canonical English guide**
   - Create `docs/mobile-integration-guide.en.md` with the section architecture
     from `design.md`.
   - Add the identity/state/endpoint/error/close-code/command tables.
   - Add all required Mermaid sequences and adjacent textual steps.
   - Add minimal synthetic HTTP, WebSocket, SDK, approval, command, and reset
     examples validated against current contracts.
   - Link to local Swagger, raw/package OpenAPI, and the pinned SDK package.

3. **Verify English against source**
   - Cross-check every path and operation against generated OpenAPI.
   - Cross-check schemas/examples against production Zod types and tests.
   - Cross-check state, priority, replay, history, task identity, approval,
     control ordering, command, and reset claims against source/SDK evidence.
   - Remove duplicated schema prose and any platform-specific advice.

4. **Create the strict Chinese translation**
   - Create `docs/mobile-integration-guide.zh-CN.md` with identical structure.
   - Translate explanatory prose and diagram labels only.
   - Preserve all technical identifiers, code/JSON, synthetic values, and links.

5. **Link both guides from README**
   - Add labeled English and Simplified Chinese links under Mobile API
     Documentation.
   - Keep Swagger/OpenAPI text authoritative for executable schemas.

6. **Run bilingual and content checks**
   - Compare heading hierarchy, code/Mermaid blocks, tables, endpoint and
     identifier sets, commands, states, errors, close codes, and links.
   - Scan both guides for real secrets, machine paths, credentials, or copied
     transcript/tool content.
   - Run `git diff --check` and inspect the complete documentation diff.

7. **Run repository validation**
   - `pnpm lint`
   - `pnpm typecheck`
   - `pnpm test`
   - `pnpm build`
   - Confirm build does not introduce unexplained generated OpenAPI drift.

8. **Final review gate**
   - Read English top-to-bottom as a mobile implementer.
   - Read Chinese against English section-by-section.
   - Verify every PRD acceptance criterion and report any residual assumptions.

## High-Risk Files and Rollback Points

- `README.md`: preserve existing runtime and Swagger instructions; add links
  only near the current Mobile API Documentation section.
- `docs/mobile-integration-guide.en.md`: canonical source; correct it first.
- `docs/mobile-integration-guide.zh-CN.md`: never land without parity.
- `dist/openapi/mobile-v1.json`: verification input/output, not an intentional
  hand-edited deliverable.

Rollback removes both guides and both README links as one unit. Do not roll back
unrelated generated or user changes.

## Validation Commands

```powershell
git diff --check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Additional structural/parity checks may be run as read-only PowerShell or Node
scripts during verification; they do not need to become permanent repository
tooling unless the documentation maintenance burden proves recurring.
