# Local admin workspace authorization

## Goal

Allow the desktop operator to manage explicit local workspace authorization roots from the local-admin Configuration page, so mobile clients can discover and use only currently authorized, currently available directories for Claude Code work.

## Background

PocketPilot already stores task settings in `tasks.workspaceRoots`, exposes authenticated workspace discovery through `GET /v1/workspaces`, and checks requested Claude working directories against configured roots. The current local-admin UI edits the roots as newline-separated text. This task replaces that raw editor with a dedicated authorization workflow while retaining the existing task-settings record and explicit Save/Discard model.

## Requirements

### R1. Configuration surface

- Add two tabs inside Configuration: General and Authorized directories.
- Keep listener/mobile URL/concurrency fields in General.
- Put workspace authorization management in Authorized directories and remove the competing newline textarea.
- Render configured roots in a table with Path, Status, Scope/Coverage, and Actions.
- Add/remove operations update only the existing configuration draft until the operator presses Save; Discard restores the last saved configuration.
- Preserve the active tab, draft, modal inputs, and loaded directory data when the locale changes.

### R2. Built-in directory browser

- Add a PocketPilot-hosted modal directory browser; do not use browser upload inputs or an operating-system-native picker.
- Let the browser navigate every filesystem root and directory accessible to the Agent process, including Windows drives, mounted volumes, deep paths, and accessible UNC shares.
- Provide virtual root/home shortcuts, directory rows, parent/breadcrumb navigation, and an absolute-path address bar.
- Treat typed paths as navigation input only. The backend must verify that a path is absolute, exists, is a directory, is accessible, and resolves to a canonical real path before it can enter the draft.
- Return directory-navigation metadata only. Never return files, file contents, or remote `/v1` filesystem-browsing APIs.
- Bound directory results and tell the UI when a listing is truncated.

### R3. Canonical root identity and table state

- Persist and display the canonical real path for every newly authorized available directory.
- Treat canonical aliases, including symlink/junction aliases and Windows case variants, as exact duplicates.
- Do not let later symlink/junction retargeting silently move an existing authorization to another real directory.
- Allow explicit parent and child roots simultaneously. Keep both rows and both mobile shortcuts; indicate when an available row is already covered by another available configured root.
- Removing a parent must not remove an explicitly configured child.
- Allow filesystem/volume roots such as `C:\`, `D:\`, `/`, and UNC share roots only after a dedicated high-risk confirmation, and retain a visible high-risk marker in the table.

### R4. Unavailable saved roots

- If a previously saved root becomes missing, inaccessible, or no longer resolves to its saved canonical identity, retain the saved row and mark it unavailable.
- An unavailable row must not authorize Claude work and must be omitted from mobile workspace discovery.
- Unavailable rows must not block saving unrelated configuration changes when they are unchanged.
- Never silently delete or rewrite an unavailable row. The operator may restore access or remove it explicitly.
- When the saved canonical directory becomes available again, it automatically returns to effective authorization and mobile discovery without another configuration save.
- A newly added unavailable or non-directory path must be rejected rather than persisted.

### R5. Save and discovery contracts

- Keep `tasks.workspaceRoots` in the existing task-runtime settings record as the single persistent source of truth; do not add a parallel authorization store.
- Keep the existing explicit configuration save workflow and `PUT /admin/configuration/tasks` ownership; do not autosave additions or removals.
- Saving must canonicalize available roots, retain only unchanged previously saved unavailable roots, reject exact canonical duplicates, and preserve explicit nested roots and list order.
- `GET /v1/workspaces` must return only currently available configured roots, using their canonical saved paths. It returns every explicit nested row and returns an empty array when no configured root is currently available.

### R6. Runtime authorization and revocation

- Continue to authorize an existing canonical working directory when it is equal to or contained by at least one currently available configured root, using path-component boundaries rather than string prefixes.
- Deny missing paths and paths that escape through traversal, aliases, relative resolution, symlinks/junctions, case tricks, or equivalent representations.
- After a root-removal save commits successfully, a task whose cwd is no longer covered must be denied for new task/session creation, attachment, resumption, SDK-session activation, and every new SDK user message.
- Do not force-kill a Claude turn already executing when the save commits. Let that turn stream and reach its normal idle/completion boundary; after that, no continuation is admitted unless the cwd is authorized again.
- Keep historical task/session records. Revocation does not terminalize or delete them.
- Continue to allow interruption, close, and resolution of an approval already associated with the executing turn.
- Coordinate root-policy commits and authorization admissions so that once a save response succeeds, no later admission can use a removed root. Do not hold the coordination lane for the duration of a Claude turn.

### R7. Local security, validation, and localization

- Expose directory browse/inspection operations only on the loopback local-admin application.
- Require the existing exact-origin and CSRF protection for unsafe directory operations and validate all request/response payloads with Zod.
- Return stable safe errors; do not expose raw filesystem exception details.
- Add complete Simplified Chinese and English resources through the existing locale registry/messages contract. Paths, directory names, server codes, and other opaque values must remain untranslated.

## Constraints

- A browser cannot supply a trusted backend-usable absolute directory path through standard upload/directory inputs.
- The local administration console remains desktop-only and loopback-only.
- Workspace-root admission is a Claude cwd policy, not a complete operating-system filesystem sandbox.
- The existing configuration save performs separate validated runtime-settings and task-settings writes; this task does not introduce a new cross-record transaction or parallel settings owner.
- There is no mobile client implementation in this repository; mobile behavior is represented by `/v1` routes, OpenAPI, and tests.

## Out of Scope

- Arbitrary host filesystem browsing from mobile clients.
- Mobile browsing of descendants beneath an authorized root; the mobile selector continues to receive explicit configured root shortcuts only.
- Per-user or per-device workspace authorization.
- Force-stopping an already executing Claude turn solely because a root was removed.
- Claiming that cwd admission prevents every possible Claude Code filesystem access.

## Acceptance Criteria

- [ ] AC1: Configuration shows General and Authorized directories tabs; the latter contains the authorization table and the former no longer contains a workspace-roots textarea. (R1)
- [ ] AC2: Add, cancel, remove, Save, and Discard operate through the existing draft/dirty/busy model, and a restart reloads the saved roots. (R1, R5)
- [ ] AC3: Locale switching immediately translates the new UI without remounting Configuration or losing the active tab, draft, modal input, or loaded listing. (R1, R7)
- [ ] AC4: The built-in browser supports roots/home, parent/breadcrumb navigation, direct absolute-path navigation, deep/UNC paths where accessible, directories-only results, and a visible truncated state. (R2)
- [ ] AC5: Browser and inspection endpoints never return files or file contents, are absent from the remote listener, and reject invalid origin, CSRF, and malformed payloads. (R2, R7)
- [ ] AC6: New roots are saved/displayed canonically; exact aliases are rejected; explicit nested roots remain separate shortcuts; coverage metadata and parent-removal behavior are correct. (R3, R5)
- [ ] AC7: Authorizing a filesystem/volume root requires a dedicated confirmation and the saved row remains visibly marked high risk. (R3)
- [ ] AC8: A saved root that becomes unavailable remains removable and visible locally, does not block unrelated saves, is omitted from `/v1/workspaces`, authorizes no work, and automatically returns to discovery/authorization when its original canonical identity is accessible again. (R4, R5)
- [ ] AC9: A newly added missing, inaccessible, relative, or non-directory path is rejected with actionable safe feedback and does not corrupt saved settings. (R2, R4, R7)
- [ ] AC10: `/v1/workspaces` returns all and only currently available explicit configured roots, including nested rows, and returns `[]` when none are effective. (R5)
- [ ] AC11: Working-directory authorization rejects outside-root and representation-escape attempts while accepting existing canonical descendants on component boundaries. (R6)
- [ ] AC12: After successful removal save, new create/attach/resume/activate/message admissions for uncovered tasks fail, while an already executing turn may finish and historical task records remain. (R6)
- [ ] AC13: A concurrency test proves the save/admission linearization rule: after the save response succeeds, no operation admitted afterward can use the removed root. (R6)
- [ ] AC14: Relevant backend, local-admin, OpenAPI, security-boundary, Windows canonical-path, localization, and regression tests pass. (R1-R7)
