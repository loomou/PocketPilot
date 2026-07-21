# Design: Codex thread management

## Summary

Extend the provider conversation REST surface so mobile clients can search and
manage Codex threads with native IDs. List gains archived/search filters. New
REST mutations cover fork/archive/unarchive/delete. Fork creates/reuses a
PocketPilot task for the new thread. Delete of a currently bound non-terminal
task thread closes that task after native delete. Capability discovery publishes
a closed `threadManagement` descriptor.

## Architecture and boundaries

```
Mobile REST
  -> AgentRuntimeManager (authorize workspace)
      -> Provider adapter conversation APIs
          -> CodexAppServerBridge native thread/* calls
          -> TaskRepository create/reuse/close as needed
  <- TaskOperationResult or conversation page
```

Boundaries:

- **Common types/routes/runtime manager**: provider-neutral list filters and
  mutation entrypoints.
- **Codex adapter**: native `thread/list|fork|archive|unarchive|delete`,
  authorization, response projection, task side effects.
- **Claude adapter**: deny or empty capability; no fake success.
- **Agent WebSocket**: unchanged for these lifecycle mutations.
- **Docs/OpenAPI/tests**: advertise only implemented ops.

## Contracts

### Capability discovery

```ts
threadManagement?: {
  listFilters: {
    archived: true;
    searchTerm: true;
  };
  fork: true;
  archive: true;
  unarchive: true;
  delete: true;
}
```

Sanitizer admits only these closed keys/values. Unknown keys drop. Claude
publishes `{}`.

### List filters

`GET /v1/providers/{providerId}/conversations`

Existing query plus:

| Query | Type | Notes |
|---|---|---|
| `searchTerm` | optional string | Pass through to native `thread/list.searchTerm` after length bounds |
| `archived` | optional `true` / `false` | Omit/null means native default (both) |

Continue:

- authorize workspace
- fixed safe source kinds for Codex
- post-filter rows to authorized workspace
- preserve native row identity except path hygiene if needed

### Mutation routes

All mutations require auth + body:

```ts
{
  operationId: uuid,
  workspace: string,
  workspaceRiskAccepted: boolean,
  confirm?: boolean // required true for archive/delete
}
```

| Route | Native | Task side effect | Confirm |
|---|---|---|---|
| `POST .../conversations/{conversationId}/fork` | `thread/fork` `{ threadId }` | create/reuse task for new thread; return that task | no |
| `POST .../conversations/{conversationId}/archive` | `thread/archive` | none auto-close | yes |
| `POST .../conversations/{conversationId}/unarchive` | `thread/unarchive` | none | no |
| `POST .../conversations/{conversationId}/delete` | `thread/delete` | if a non-terminal task is bound to this thread, close it after native success | yes |

Response family:

- Fork: `TaskOperationResult`-compatible with action `created` or a reviewed new
  action such as `forked` if the action enum is extended cleanly.
- Archive/unarchive: closed result containing at least
  `{ action, nativeConversationId, archived }` and, when a bound non-terminal
  task exists, optional task snapshot without implying it was closed.
- Delete: `{ action: "deleted", nativeConversationId, task?: closedTask }`.

Prefer extending `taskOperationActionSchema` only when the result still fits
“task metadata only” idempotency storage. If archive/unarchive do not always
have a task, use a dedicated closed conversation-management result schema for
those ops rather than forcing a fake task.

### Authorization / validation

1. Authorize workspace through existing runtime manager path.
2. `requireAuthorizedThread(workspace, conversationId)` before mutation.
3. Fork:
   - send only `{ threadId }`
   - reject any path/cwd fork params from remote clients
   - authorize the returned forked thread before creating a task
4. Archive/delete require `confirm === true`; otherwise `400`/`403` with a clear
   code such as `CONFIRMATION_REQUIRED` or reuse an existing validation error
   style consistent with the codebase.
5. After native delete success, find non-terminal task by provider conversation
   id and close it through the existing task close path if present.

### Projection / hygiene

- Do not return absolute `cwd`, instruction `sourcePath`, or other host paths
  from fork/list/read responses beyond existing safe projection rules.
- Prefer returning task transport metadata + native conversation id rather than
  raw App Server thread objects when those objects are path-heavy.
- If a native row must be returned, strip path-bearing fields first.

## Data flow

### Fork

1. REST validates body + confirm not required.
2. Adapter authorizes source thread.
3. Native `thread/fork` with `threadId`.
4. Parse new thread; authorize it under the same workspace.
5. Create/reuse non-terminal task for new thread id.
6. Return task operation result for the **new** task/thread.

### Archive / unarchive

1. Validate body; archive requires confirm.
2. Authorize thread.
3. Native archive/unarchive.
4. Return closed management result. Existing bound tasks remain unless client
   closes them.

### Delete

1. Validate body + confirm.
2. Authorize thread.
3. Native delete.
4. If non-terminal bound task exists, close it.
5. Return deleted result, including closed task snapshot when applicable.

### List

1. Authorize workspace.
2. Native `thread/list` with existing safe params plus optional
   `searchTerm`/`archived`.
3. Filter to authorized workspace.
4. Return page.

## Compatibility

- Existing create/attach/close semantics remain.
- Clients that only list without filters behave as today.
- Agent WebSocket method allowlist does not gain archive/delete/fork in this
  batch.
- Claude remains without thread-management mutations.

## Trade-offs

1. **REST vs Agent WS**
   - REST matches current conversation ownership and works for non-current
     threads without attach-first.
2. **Delete closes task; archive does not**
   - Delete removes the native conversation, so keeping an active task would be
     misleading.
   - Archive is reversible; auto-close would be surprising.
3. **Fork creates task**
   - One round-trip to start using the forked conversation on mobile.
   - Slightly more server-side magic than “fork then attach”, accepted by D3.

## Rollback

- Feature is route/allowlist gated. Emergency rollback removes the new routes
  and capability keys; existing list/create/attach remain.
- No DB migration beyond optional new operation action enum values if chosen.
- No destructive live tests required for merge; if added later, they need
  cleanup design.

## Test matrix

- List: searchTerm, archived true/false, unauthorized workspace.
- Fork: authorized success + task returned; path fork rejected; unauthorized
  thread rejected; path fields omitted.
- Archive/unarchive: confirm required for archive; bound task remains.
- Delete: confirm required; bound task closed; unbound delete succeeds without
  task.
- Capability/OpenAPI: closed `threadManagement` for Codex, empty for Claude.
- Docs: EN/ZH mobile + App Server guides.
