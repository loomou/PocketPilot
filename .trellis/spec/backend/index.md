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
| [Claude Agent SDK Contracts](./claude-sdk-contracts.md) | Streaming-session, control, approval, and event boundaries | Established |
| [Directory Structure](./directory-structure.md) | Module organization and file layout | Established |
| [Database Guidelines](./database-guidelines.md) | SQLite, encryption, retention, and migration contracts | Established |
| [Device Authentication and Pairing Contracts](./device-auth-contracts.md) | QR pairing, device proof, credential rotation, and revocation | Established |
| [Error Handling](./error-handling.md) | Error types, handling strategies | Established |
| [Process and Listener Runtime Contracts](./process-runtime-contracts.md) | Manual start/stop, listener isolation, local CSRF, and shutdown | Established |
| [Quality Guidelines](./quality-guidelines.md) | Code standards, forbidden patterns | Established |
| [Logging Guidelines](./logging-guidelines.md) | Structured logging, log levels | Established |

---

## Pre-Development Checklist

Before modifying the TypeScript Agent, read `bootstrap-contracts.md`,
`directory-structure.md`, `quality-guidelines.md`, and `error-handling.md`.
When modifying Claude Agent SDK integration, also read
`claude-sdk-contracts.md`; when modifying storage or encrypted Agent data, also
read `database-guidelines.md`. When modifying listener setup, start/stop, or
local-admin HTTP boundaries, also read `process-runtime-contracts.md` and
`logging-guidelines.md`. When modifying pairing, credentials, remote auth, or
device-bound WebSockets, also read `device-auth-contracts.md`.

---

**Language**: All documentation should be written in **English**.
