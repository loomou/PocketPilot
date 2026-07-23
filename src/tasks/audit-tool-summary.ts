/**
 * Produces a controlled, metadata-only tool identifier for approval audit
 * rows. The output is either the bare tool name or `<toolName>:<identifier>`,
 * where the identifier is a stable enumerated value (a Skill command name).
 *
 * This function must never read fields that can contain user content: Bash
 * command strings, file paths, file contents, prompts, model output, URLs, or
 * search patterns. Only allow-listed identifier fields are consulted, and even
 * those are character-filtered and length-bounded so no free text can leak
 * into the audit table.
 */

const MAX_IDENTIFIER_LENGTH = 64;
const IDENTIFIER_ALLOWED_CHARACTERS = /[^A-Za-z0-9._:-]/g;

/** Allow-listed identifier fields for Skill tools, in priority order. */
const SKILL_IDENTIFIER_KEYS = ["command", "skill", "name"] as const;

export function summarizeToolForAudit(
  toolName: string,
  input: Record<string, unknown>,
): string {
  if (toolName === "Skill") {
    const identifier = extractIdentifier(input, SKILL_IDENTIFIER_KEYS);
    return identifier === undefined ? "Skill" : `Skill:${identifier}`;
  }

  // MCP tools (mcp__*) already encode the server/tool in their name, and every
  // other tool exposes only its name. Never inspect their input.
  return toolName;
}

function extractIdentifier(
  input: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value !== "string") {
      continue;
    }
    const sanitized = sanitizeIdentifier(value);
    if (sanitized.length > 0) {
      return sanitized;
    }
  }
  return undefined;
}

function sanitizeIdentifier(value: string): string {
  return value
    .replace(IDENTIFIER_ALLOWED_CHARACTERS, "")
    .slice(0, MAX_IDENTIFIER_LENGTH);
}
