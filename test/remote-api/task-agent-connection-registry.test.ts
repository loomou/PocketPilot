import { describe, expect, it, vi } from "vitest";

import { InMemoryTaskAgentConnectionRegistry } from "../../src/remote-api/task-agent-connection-registry.js";

describe("InMemoryTaskAgentConnectionRegistry", () => {
  it("closes only sockets for the terminalized task", () => {
    const registry = new InMemoryTaskAgentConnectionRegistry();
    const first = { close: vi.fn() };
    const second = { close: vi.fn() };
    registry.add("task-a", first);
    registry.add("task-b", second);

    registry.closeTaskConnections("task-a");

    expect(first.close).toHaveBeenCalledWith(4_009, "TASK_SESSION_UNAVAILABLE");
    expect(second.close).not.toHaveBeenCalled();
  });
});
