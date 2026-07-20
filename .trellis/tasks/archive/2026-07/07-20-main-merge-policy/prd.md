# Record main merge-only policy

## Goal

Record the project-wide hard rule that `main` receives changes only through
branch merges. Future contributors and AI assistants must see the rule before
committing repository changes.

## Background

The preceding task was committed directly on `main`. The project owner has
clarified that this is forbidden even when the changes are otherwise complete
and verified.

## Requirements

- Add a project-wide instruction outside the Trellis-managed block in
  `AGENTS.md`, so a future `trellis update` does not overwrite it.
- Forbid direct commits on `main`.
- Require contributors to create or switch to a non-`main` branch before
  committing.
- State that `main` receives changes only through a branch merge.
- Apply the rule to future work; do not rewrite existing Git history.

## Acceptance Criteria

- [x] `AGENTS.md` contains the merge-only `main` policy outside the managed
      Trellis block.
- [x] The instruction explicitly forbids direct commits on `main`.
- [x] The instruction explicitly requires a non-`main` branch before commit.
- [x] The instruction explicitly says `main` accepts changes only through a
      branch merge.
- [x] This task is committed on a non-`main` branch.

## Out of Scope

- Git hooks, server-side branch protection, CI enforcement, and repository-host
  settings.
- Rewriting or reverting earlier commits made directly on `main`.
