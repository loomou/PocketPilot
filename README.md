# PocketPilot

PocketPilot is a Windows-first, self-hosted Agent that lets a user control Claude Code sessions on their own computer from a mobile client.

The mobile frontend and connectivity setup are intentionally outside this repository's first implementation scope. See the planning artifacts in `.trellis/tasks/07-15-mobile-claude-code-backend/` for the agreed backend design.

## Development

Use Node.js 24 and pnpm 11.7 or later within the declared major version.

```powershell
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

The current bootstrap exposes `agent start`, `agent stop`, `agent rekey`, and
`agent reset`, but deliberately fails them closed until the secure runtime and
storage layers are implemented.
