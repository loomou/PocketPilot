# Logging Guidelines

## Scope

These rules apply to CLI/process output and every future Agent logger. The
current listener runtime uses concise foreground CLI output for the bound remote
health URL and local-admin URL; it deliberately does not enable Fastify's
request logger yet.

## Current Runtime Output

- `agent start` may print listener addresses after successful binding.
- `agent stop` is quiet on success and prints only a stable corrective error on
  failure.
- Successful `agent rekey` prints only the migrated record count; successful
  `agent reset` prints only a completion statement. Neither command prints key
  values, encrypted envelopes, database paths, or deleted record contents.
- Fastify application factories use `logger: false`. Do not turn on request
  logging ad hoc; introduce one configured logger when task/auth event logging
  is implemented.

## Required Future Structured Fields

When the configured logger is added, every process/security record must use a
stable event name and may include timestamp, task ID, device ID, listener kind,
operation, and result. It must not infer a user or task identifier from prompt
content.

## Never Log

- `AGENT_MASTER_KEY`, encryption envelopes, refresh/access credentials,
  runtime-control tokens, CSRF tokens, pairing secrets, or device proofs.
- Dotenv file contents, parsed dotenv maps, secret-bearing source lines, or
  rejected environment values.
- Prompts, assistant output, tool input/output, Claude configuration, API keys,
  or raw HTTP authorization headers.
- Full persisted setting JSON, because later settings may gain sensitive fields.

## Process Events

Log only safe lifecycle facts when structured logging exists: secure startup
passed, listener bind failure, listener started/stopped, local stop accepted,
and shutdown complete. A log line must never make an unauthenticated remote
request appear authorized or successful.
