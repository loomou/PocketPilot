# Frontend Development Guidelines

> Best practices for frontend development in this project.

---

## Overview

This directory records conventions for the local-only PocketPilot configuration UI.

---

## Guidelines Index

| Guide | Description | Status |
|-------|-------------|--------|
| [Local Admin Application Contracts](./scaffold-contracts.md) | Browser API, configuration, directory authorization, pairing, device, and audit UI contract | Established |
| [Directory Structure](./directory-structure.md) | Module organization and file layout | Established |
| [Component Guidelines](./component-guidelines.md) | Component patterns, props, composition | Established |
| [Hook Guidelines](./hook-guidelines.md) | Effect, callback, and data-fetching patterns | Established |
| [State Management](./state-management.md) | Local form, server snapshot, and transient action state | Established |
| [Quality Guidelines](./quality-guidelines.md) | Code standards, forbidden patterns | Established |
| [Type Safety](./type-safety.md) | Type patterns, validation | Established |
| [Internationalization](./i18n-guidelines.md) | Locale registry, state preservation, opaque values, notices, and formatting | Established |

---

## Pre-Development Checklist

Before editing `apps/local-admin`, read `scaffold-contracts.md`,
`directory-structure.md`, `component-guidelines.md`, `quality-guidelines.md`,
and `type-safety.md`. Functional page changes must also read
`hook-guidelines.md` and `state-management.md`.

---

**Language**: All documentation should be written in **English**.
