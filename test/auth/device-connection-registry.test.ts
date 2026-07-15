import { describe, expect, it } from "vitest";

import { InMemoryDeviceConnectionRegistry } from "../../src/auth/device-connection-registry.js";

describe("InMemoryDeviceConnectionRegistry", () => {
  it("closes only the revoked device's active sockets", () => {
    const registry = new InMemoryDeviceConnectionRegistry();
    const closed: Array<{
      code: number | undefined;
      data: string | undefined;
    }> = [];
    const socket = {
      close(code?: number, data?: string): void {
        closed.push({ code, data });
      },
    };
    registry.add("device-a", socket);
    registry.add("device-b", {
      close(): void {
        throw new Error("The other device must remain connected.");
      },
    });

    registry.closeDeviceConnections("device-a");
    registry.closeDeviceConnections("device-a");

    expect(closed).toEqual([{ code: 4003, data: "Device session revoked." }]);
  });
});
