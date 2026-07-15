import type { DeviceConnectionRegistry } from "./device-auth-service.js";

export type DeviceWebSocket = {
  close(code?: number, data?: string): void;
};

const DEVICE_REVOKED_CLOSE_CODE = 4_003;
const DEVICE_REVOKED_CLOSE_REASON = "Device session revoked.";

/** Tracks authenticated device sockets so revocation takes effect immediately. */
export class InMemoryDeviceConnectionRegistry
  implements DeviceConnectionRegistry
{
  private readonly connections = new Map<string, Set<DeviceWebSocket>>();

  public add(deviceId: string, socket: DeviceWebSocket): () => void {
    const deviceConnections = this.connections.get(deviceId) ?? new Set();
    deviceConnections.add(socket);
    this.connections.set(deviceId, deviceConnections);

    return () => this.remove(deviceId, socket);
  }

  public closeDeviceConnections(deviceId: string): void {
    const deviceConnections = this.connections.get(deviceId);
    if (deviceConnections === undefined) {
      return;
    }

    this.connections.delete(deviceId);
    for (const socket of deviceConnections) {
      socket.close(DEVICE_REVOKED_CLOSE_CODE, DEVICE_REVOKED_CLOSE_REASON);
    }
  }

  private remove(deviceId: string, socket: DeviceWebSocket): void {
    const deviceConnections = this.connections.get(deviceId);
    if (deviceConnections === undefined) {
      return;
    }

    deviceConnections.delete(socket);
    if (deviceConnections.size === 0) {
      this.connections.delete(deviceId);
    }
  }
}
