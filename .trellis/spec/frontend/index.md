# Frontend Development Guidelines

> Best practices for frontend development in this project.

---

## Overview

This directory records conventions for the local-only PocketPilot configuration UI.

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Scaffold Contracts](./scaffold-contracts.md) | Early local-admin boundary and static UI contract | Established |
| [Directory Structure](./directory-structure.md) | Module organization and file layout | Established |
| [Component Guidelines](./component-guidelines.md) | Component patterns, props, composition | Established |
| [Hook Guidelines](./hook-guidelines.md) | Custom hooks, data fetching patterns | Deferred until local APIs exist |
| [State Management](./state-management.md) | Local state, global state, server state | Deferred until configuration data exists |
| [Quality Guidelines](./quality-guidelines.md) | Code standards, forbidden patterns | Established |
| [Type Safety](./type-safety.md) | Type patterns, validation | Established |

---

## Pre-Development Checklist

Before editing `apps/local-admin`, read `scaffold-contracts.md`,
`directory-structure.md`, `component-guidelines.md`, `quality-guidelines.md`,
and `type-safety.md`. Do not add local API clients or configuration state until
the localhost-only backend listener is implemented.

---

**Language**: All documentation should be written in **English**.
