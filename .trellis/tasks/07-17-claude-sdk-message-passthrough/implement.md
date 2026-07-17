# Implementation Plan — Claude SDK Message Passthrough

## Preconditions

- Remote conversation messages use the pinned SDK's exact `SDKUserMessage` and
  `SDKMessage` JSON shapes.
- Raw SDK and PocketPilot control traffic use separate WebSockets.
- Active-turn replay uses optional SDK `uuid` anchors and never changes SDK
  message bodies.
- Tool approvals preserve serializable `CanUseTool` arguments and complete
  `PermissionResult` values.
- SDK input scheduling, including `priority` and `shouldQuery`, is SDK-owned.
- The correction lands directly in the unpublished `/v1`; no compatibility
  normalized stream or `/v2` is required.

## Ordered Work

1. **Lock the raw SDK adapter contract**
   - Change `ClaudeSdkSession.events()` to yield every `SDKMessage` from Query
     unchanged while still observing `session_id`.
   - Remove `normalizeSdkMessage()` from the runtime path and delete its module
     if it has no remaining consumer.
   - Add deep-equality tests for user, assistant, partial, result, system, tool,
     and an open/future SDK message variant.

2. **Separate internal SDK and control event ownership**
   - Refactor the active-turn journal to publish/subscribe raw SDK messages and
     PocketPilot control envelopes through separate methods.
   - Keep one internal storage order, encrypted overflow, 256 MiB budget, and
     existing cleanup behavior.
   - Maintain active-turn SDK UUID lookup in memory and implement known,
     missing, and unknown `afterUuid` replay behavior.
   - Prove every SDK replay/live subscriber receives the original object and
     every control subscriber receives no SDK message.

3. **Accept raw SDK input in the task runtime**
   - Replace the string-instruction task operation with SDK user-message
     submission that has no PocketPilot `operationId` or result-cache row.
   - Preserve every required/optional/unknown SDK field and write the original
     message to the long-lived input stream.
   - Accept later messages while executing or awaiting approval; preserve SDK
     arrival order and scheduling fields.
   - Handle idle querying versus `shouldQuery: false`, capacity reservation,
     interrupted/terminal rejection, session resume, metadata-only auditing,
     and task-state observation from raw SDK outputs.

4. **Add the task-specific raw SDK WebSocket**
   - Register `GET /v1/tasks/:taskId/sdk` with Bearer authentication,
     task lookup, optional `afterUuid`, and device connection registration.
   - Subscribe raw output immediately on connect, then parse client text frames
     through a non-mutating SDK user-message transport guard.
   - Submit valid messages unchanged; close with stable documented codes for
     authentication, task availability, invalid JSON/message, and closed SDK
     input.
   - Test live bidirectional delivery, replay, multiple task isolation,
     revocation closure, invalid input, and absence of PocketPilot wrappers.

5. **Restrict `/v1/events` to control traffic**
   - Keep its subscribe/subscribed/error protocol and control replay semantics.
   - Remove all SDK conversation publication and schemas from the control
     stream.
   - Keep task-state, approval, replay-limit, and lifecycle messages explicitly
     typed as PocketPilot controls.

6. **Proxy complete SDK tool approvals**
   - Derive serializable request types from `Parameters<CanUseTool>` and remove
     only `signal` at the network boundary.
   - Publish every remaining SDK callback field without renaming.
   - Change the approval HTTP body to carry the complete SDK
     `PermissionResult` plus PocketPilot `operationId`.
   - Forward the result unchanged to the deferred callback and retain abort,
     replacement, interrupt, close, and shutdown cancellation tests.

7. **Remove the obsolete instruction/normalization API**
   - Remove `/v1/tasks/:taskId/instruction` and its documentation-only service
     stub.
   - Remove obsolete normalized event types, examples, tests, and README/spec
     claims.
   - Ensure there is exactly one remote route for SDK conversation input and
     one raw output path.

8. **Regenerate integration documentation**
   - Document both WebSockets in OpenAPI 3.1 `x-websocket` extensions.
   - Identify the exact pinned SDK npm package/version as the message contract
     owner without hand-maintaining the SDK union in Zod.
   - Document `afterUuid`, replay fallback, close codes, control isolation, and
     the complete approval contract.
   - Regenerate deterministic `dist/openapi/mobile-v1.json` and update expected
     path/security/operation assertions.

9. **Run focused and full verification**
   - Run Biome lint and strict TypeScript checks.
   - Run SDK session/input/permission tests, task manager/journal tests, raw SDK
     WebSocket integration tests, control WebSocket tests, auth revocation
     tests, and OpenAPI tests.
   - Run the complete Vitest and local-admin suites.
   - Run `pnpm build`, generate OpenAPI twice and compare hashes, inspect the
     tarball, and run the Windows packed-release smoke test.
   - Inspect logs, SQLite, OpenAPI examples, and error bodies for conversation
     content or credential leakage.

10. **Update executable Trellis specs**
    - Replace normalized-event requirements in Claude SDK and task-runtime
      contracts with raw passthrough and SDK-owned scheduling.
    - Record raw/control WebSocket separation, UUID replay, approval proxying,
      close-code behavior, storage boundaries, and release checks.
    - Ensure backend indexes route future SDK message changes to all applicable
      specs.

## Validation Matrix

| Area | Required assertions |
| --- | --- |
| SDK output | All Query messages, including user/open variants, reach the raw socket with deep equality and no wrapper. |
| SDK input | Valid `SDKUserMessage` values, including missing UUID and scheduling fields, reach the same task input stream unchanged. |
| Scheduling | Executing/approval-waiting tasks accept SDK input; SDK owns `priority` and `shouldQuery`. |
| Isolation | Raw socket emits no control frame; control socket emits no SDK conversation message; tasks/devices do not cross-deliver. |
| Replay | Known UUID resumes after that message; absent/unknown UUID replays the active turn from its beginning; raw frames contain no cursor. |
| Approval | Every serializable callback field and complete `PermissionResult` round-trip unchanged; local abort signal remains local. |
| Security | Bearer authentication, revocation close `4003`, task availability, safe close reasons, and no message logging/persistence. |
| Documentation | `/v1` exposes the new raw path, removes instruction/normalized claims, identifies SDK version, and stays local-only for Swagger. |
| Packaging | Deterministic OpenAPI and packed Windows runtime contain the corrected contract and pass the release smoke test. |

## Risk and Rollback Points

| Risk | Mitigation / rollback |
| --- | --- |
| Runtime guard strips SDK upgrade fields | Validate without reconstructing; submit the original parsed object and deep-equality test unknown optional fields. |
| State machine still rejects active-turn input | Add executing and approval-waiting regressions before removing the HTTP instruction route. |
| Raw and control subscribers receive duplicates/crossed data | Separate journal APIs and assert negative delivery in both directions. |
| UUID anchor missing or no longer retained | Replay the current active turn from its beginning; do not fabricate a cursor in the SDK body. |
| Overflow refactor corrupts transient records | Keep existing AES-GCM context and cleanup; test memory/overflow round-trips before route integration. |
| Approval proxy loses new SDK fields | Derive types from SDK callback/result types and preserve the original serializable objects. |
| Breaking `/v1` leaves two message protocols | Remove the old instruction/normalized route and assert the exact path/operation set. |
| Raw message content leaks into logs/audits | Metadata-only audit assertions and repository-wide credential/content scans. |

## Review Gates

- Do not start implementation until the user reviews `prd.md`, `design.md`, and
  this plan.
- After the journal refactor, run focused replay/encryption tests before route
  work.
- After route work, prove raw/control negative isolation before deleting the old
  normalized path.
- Before commit, run the complete Trellis quality check and Windows release
  smoke test.
