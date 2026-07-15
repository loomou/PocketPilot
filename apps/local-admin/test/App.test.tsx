import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "../src/App";

describe("App", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders loaded configuration, pairing, device, and audit data", async () => {
    installFetchMock();
    render(<App />);

    expect(
      screen.getByRole("heading", { name: "Agent configuration" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByDisplayValue("https://agent.example.test"),
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue("C:\\code")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Pair a mobile device" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Pixel 9")).toBeInTheDocument();
    expect(screen.getByText("My phone")).toBeInTheDocument();
    expect(screen.getByText("task.created")).toBeInTheDocument();
    expect(screen.getByText("127.0.0.1:43183")).toBeInTheDocument();
  });

  it("sends both configuration writes with the CSRF token", async () => {
    const fetchMock = installFetchMock();
    render(<App />);

    await screen.findByDisplayValue("https://agent.example.test");
    fireEvent.click(screen.getByRole("button", { name: "Save configuration" }));

    expect(
      await screen.findByText(
        "Configuration saved. Listener changes apply on next start.",
      ),
    ).toBeInTheDocument();
    const writes = fetchMock.mock.calls.filter(
      (call) => call[1]?.method === "PUT",
    );
    expect(writes).toHaveLength(2);
    for (const call of writes) {
      const headers = new Headers(call[1]?.headers);
      expect(headers.get("x-pocketpilot-csrf-token")).toBe("csrf-token");
      expect(headers.get("content-type")).toBe("application/json");
    }
    expect(
      screen.getByRole("button", { name: "Save configuration" }),
    ).toBeEnabled();
  });

  it("rejects an invalid local API response before rendering its data", async () => {
    installFetchMock(
      new Map([["/admin/configuration", { runtime: "not-an-object" }]]),
    );
    render(<App />);

    expect(
      await screen.findByText("The local Agent returned an invalid response."),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText("Pair a mobile device")).not.toBeInTheDocument();
  });
});

function installFetchMock(overrides = new Map<string, unknown>()) {
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const path = requestPath(input);
      if (init?.method === "PUT") {
        return jsonResponse(
          path.endsWith("/runtime")
            ? snapshot.configuration.runtime
            : snapshot.configuration.tasks,
        );
      }
      const response = overrides.has(path)
        ? overrides.get(path)
        : responses.get(path);
      if (response === undefined) {
        return jsonResponse(
          { code: "NOT_FOUND", message: "No mocked response." },
          404,
        );
      }
      return jsonResponse(response);
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function requestPath(input: RequestInfo | URL): string {
  if (input instanceof Request) return new URL(input.url).pathname;
  return new URL(String(input), "http://127.0.0.1:43183").pathname;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status,
  });
}

const snapshot = {
  audits: [
    {
      deviceId: null,
      id: "00000000-0000-4000-8000-000000000004",
      occurredAt: 1_700_000_000_000,
      operation: "task.created",
      result: "success",
      taskId: null,
    },
  ],
  configuration: {
    runtime: {
      mobileBaseUrl: "https://agent.example.test",
      remoteListener: { host: "127.0.0.1", port: 43_182 },
    },
    tasks: { concurrentTaskCapacity: 5, workspaceRoots: ["C:\\code"] },
  },
  csrf: { token: "csrf-token" },
  devices: [
    {
      createdAt: 1_700_000_000_000,
      displayName: "My phone",
      id: "00000000-0000-4000-8000-000000000003",
      revokedAt: null,
    },
  ],
  pairings: [
    {
      deviceDisplayName: "Pixel 9",
      expiresAt: 1_900_000_000_000,
      pairingId: "00000000-0000-4000-8000-000000000002",
      verificationCode: "321654",
    },
  ],
  status: {
    localAdminListener: { host: "127.0.0.1", port: 43_183 },
    mobileBaseUrl: "https://agent.example.test",
    remoteListener: { host: "127.0.0.1", port: 43_182 },
    status: "running",
  },
} as const;

const responses = new Map<string, unknown>([
  ["/admin/csrf", snapshot.csrf],
  ["/admin/configuration", snapshot.configuration],
  ["/admin/status", snapshot.status],
  ["/admin/pairings/pending", snapshot.pairings],
  ["/admin/devices", snapshot.devices],
  ["/admin/audits", snapshot.audits],
]);
