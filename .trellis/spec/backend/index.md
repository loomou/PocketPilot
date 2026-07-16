# Backend Development Guidelines

> Best practices for backend development in this project.

---

## Overview

This directory records the conventions for the PocketPilot TypeScript Agent.

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Bootstrap Contracts](./bootstrap-contracts.md) | Current CLI and HTTP bootstrap boundaries | Established |
| [Environment Configuration Contracts](./environment-configuration-contracts.md) | Allowlisted cwd dotenv loading and bootstrap validation | Established |
| [Mobile API Documentation Contracts](./api-documentation-contracts.md) | OpenAPI generation, local Swagger delivery, and WebSocket documentation | Established |
| [Claude Agent SDK Contracts](./claude-sdk-contracts.md) | Streaming-session, control, approval, and event boundaries | Established |
| [Directory Structure](./directory-structure.md) | Module organization and file layout | Established |
| [Database Guidelines](./database-guidelines.md) | SQLite, encryption, retention, and migration contracts | Established |
| [Device Authentication and Pairing Contracts](./device-auth-contracts.md) | QR pairing, device proof, credential rotation, and revocation | Established |
| [Error Handling](./error-handling.md) | Error types, handling strategies | Established |
| [Process and Listener Runtime Contracts](./process-runtime-contracts.md) | Manual start/stop, listener isolation, local CSRF, and shutdown | Established |
| [Quality Guidelines](./quality-guidelines.md) | Code standards, forbidden patterns | Established |
| [Task Runtime Contracts](./task-runtime-contracts.md) | Persistent task lifecycle, control priority, workspace policy, and recovery | Established |
| [Logging Guidelines](./logging-guidelines.md) | Structured logging, log levels | Established |
| [Local Administration Contracts](./local-admin-contracts.md) | Local configuration APIs, static assets, audits, and isolation | Established |

---

## Pre-Development Checklist

Before modifying the TypeScript Agent, read `bootstrap-contracts.md`,
`directory-structure.md`, `quality-guidelines.md`, and `error-handling.md`.
When modifying dotenv, environment variables, CLI environment wiring, or
bootstrap listener settings, also read `environment-configuration-contracts.md`.
When modifying a remote route/schema, the task-event WebSocket contract,
Swagger delivery, or package documentation assets, also read
`api-documentation-contracts.md`.
When modifying Claude Agent SDK integration, also read
`claude-sdk-contracts.md`; when modifying storage or encrypted Agent data, also
read `database-guidelines.md`. When modifying listener setup, start/stop, or
local-admin HTTP boundaries, also read `process-runtime-contracts.md` and
`logging-guidelines.md` plus `local-admin-contracts.md`. When modifying pairing,
credentials, remote auth, or device-bound WebSockets, also read
`device-auth-contracts.md`.
When modifying task state, SDK task lifecycles, workspace policy, capacity,
idempotency, or task recovery, also read `task-runtime-contracts.md`.

---

**Language**: All documentation should be written in **English**.
