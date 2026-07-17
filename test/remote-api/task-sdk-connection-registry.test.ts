import { describe, expect, it, vi } from "vitest";

import { InMemoryTaskSdkConnectionRegistry } from "../../src/remote-api/task-sdk-connection-registry.js";

describe("InMemoryTaskSdkConnectionRegistry", () => {
  it("closes only sockets for the terminalized task", () => {
    const registry = new InMemoryTaskSdkConnectionRegistry();
    const first = { close: vi.fn() };
    const second = { close: vi.fn() };
    registry.add("task-a", first);
    registry.add("task-b", second);

    registry.closeTaskConnections("task-a");

    expect(first.close).toHaveBeenCalledWith(4_009, "TASK_SESSION_UNAVAILABLE");
    expect(second.close).not.toHaveBeenCalled();
  });
});
