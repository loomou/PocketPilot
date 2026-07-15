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
| [Database Guidelines](./database-guidelines.md) | ORM patterns, queries, migrations | Deferred until persistence work |
| [Error Handling](./error-handling.md) | Error types, handling strategies | Deferred until runtime errors exist |
| [Quality Guidelines](./quality-guidelines.md) | Code standards, forbidden patterns | Established |
| [Logging Guidelines](./logging-guidelines.md) | Structured logging, log levels | Deferred until the Agent runtime |

---

## Pre-Development Checklist

Before modifying the TypeScript Agent, read `bootstrap-contracts.md`,
`directory-structure.md`, and `quality-guidelines.md`. When modifying Claude
Agent SDK integration, also read `claude-sdk-contracts.md`. Update deferred
guides only when their matching implementation layer is introduced.

---

**Language**: All documentation should be written in **English**.
