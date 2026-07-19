# Official Claude session lifecycle evidence

## Sources

1. Claude Agent SDK, "Work with sessions"
   - https://platform.claude.com/docs/en/agent-sdk/sessions
2. Claude Agent SDK, "How the agent loop works"
   - https://platform.claude.com/docs/en/agent-sdk/agent-loop
3. Claude Agent SDK, "Streaming Input"
   - https://platform.claude.com/docs/en/agent-sdk/streaming-vs-single-mode

## Official contract

The session guide defines a session as the conversation history accumulated while the agent works. It says the history contains the prompt, tool calls, tool results, and responses, and is persisted automatically unless persistence is disabled.

The TypeScript session example describes the first `query({ prompt: ... })` call as creating a fresh session. The same page says the session ID is available on the final result and, earlier in TypeScript, on the init `SystemMessage`.

The agent-loop guide gives the ordering explicitly:

1. Receive prompt.
2. Yield a `SystemMessage` with subtype `init` containing session metadata.
3. Evaluate the prompt and continue the agent loop.
4. Yield a result containing the session ID.

The streaming-input guide likewise models a long-lived session as an async input stream whose generator first yields an `SDKUserMessage`. It does not define an empty-session creation operation.

## Conclusion

Opening a blank conversation/composer does not, by itself, create a Claude session under the documented SDK contract. A fresh Claude session begins when the first user input starts the agent query. At that point the SDK assigns a `session_id` and exposes it in the init event before the model response.

Consequently, application state may exist before Claude session state:

- Before first send: workspace selection, composer settings, and a PocketPilot runtime/task handle may exist, but there is no Claude conversation history to resume.
- On first send: start the new SDK Query with the user's first message; capture `system/init.session_id` as the Claude session ID.
- After persistence: the transcript can be listed and resumed by that session ID.

The official documentation does not separately guarantee the exact filesystem write instant or the UI refresh timing of Claude Code's `/resume` picker. Those are implementation details. Its documented lifecycle still begins with the first prompt, not with rendering an empty conversation screen.
