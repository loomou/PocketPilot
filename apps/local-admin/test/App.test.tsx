import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "../src/App";

describe("App", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
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
    expect(screen.getByText("C:\\code")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Authorized directories" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Pair a mobile device" }),
    ).toBeInTheDocument();
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

  it("approves the active QR code only after clicking and preserves edits", async () => {
    const pairing = {
      expiresAt: Date.now() + 5 * 60 * 1_000,
      pairingId: "00000000-0000-4000-8000-000000000030",
      qrPayload: {
        agentId: "00000000-0000-4000-8000-000000000031",
        baseUrl: "https://agent.example.test",
        expiresAt: Date.now() + 5 * 60 * 1_000,
        pairingId: "00000000-0000-4000-8000-000000000030",
        version: 1,
      },
    } as const;
    const approvedDevice = {
      createdAt: Date.now(),
      displayName: "New phone",
      id: "00000000-0000-4000-8000-000000000032",
      revokedAt: null,
    } as const;
    const fetchMock = installFetchMock(
      new Map<string, ResponseOverride>([
        ["POST /admin/pairings", pairing],
        [`POST /admin/pairings/${pairing.pairingId}/approve`, approvedDevice],
      ]),
    );
    render(<App />);

    const capacity = await screen.findByLabelText("Concurrent task capacity");
    fireEvent.change(capacity, { target: { value: "9" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate QR" }));
    expect(
      await screen.findByAltText("PocketPilot device pairing QR code"),
    ).toBeInTheDocument();

    const mobileCode = screen.getByLabelText("Mobile code");
    const approveButton = screen.getByRole("button", { name: "Approve" });
    expect(approveButton).toBeDisabled();
    expect(
      fetchMock.mock.calls.some(
        (call) => requestPath(call[0]) === "/admin/pairings/pending",
      ),
    ).toBe(false);

    fireEvent.change(mobileCode, { target: { value: "65a43-21" } });
    expect(mobileCode).toHaveValue("654321");
    expect(approveButton).toBeEnabled();
    expect(
      fetchMock.mock.calls.some(
        (call) =>
          requestPath(call[0]) ===
          `/admin/pairings/${pairing.pairingId}/approve`,
      ),
    ).toBe(false);

    fireEvent.click(approveButton);
    expect(
      await screen.findByText("Device pairing approved."),
    ).toBeInTheDocument();

    expect(screen.getByDisplayValue("9")).toBeInTheDocument();
    expect(screen.getByText("New phone")).toBeInTheDocument();
    expect(screen.queryByLabelText("Mobile code")).not.toBeInTheDocument();
    expect(
      screen.queryByAltText("PocketPilot device pairing QR code"),
    ).not.toBeInTheDocument();

    const approvalRequest = fetchMock.mock.calls.find(
      (call) =>
        requestPath(call[0]) === `/admin/pairings/${pairing.pairingId}/approve`,
    );
    expect(approvalRequest?.[1]?.method).toBe("POST");
    expect(JSON.parse(String(approvalRequest?.[1]?.body))).toEqual({
      verificationCode: "654321",
    });
    expect(
      new Headers(approvalRequest?.[1]?.headers).get(
        "x-pocketpilot-csrf-token",
      ),
    ).toBe("csrf-token");
  });

  it("keeps the QR and code after a rejected approval", async () => {
    const pairing = {
      expiresAt: Date.now() + 5 * 60 * 1_000,
      pairingId: "00000000-0000-4000-8000-000000000040",
      qrPayload: {
        agentId: "00000000-0000-4000-8000-000000000041",
        baseUrl: "https://agent.example.test",
        expiresAt: Date.now() + 5 * 60 * 1_000,
        pairingId: "00000000-0000-4000-8000-000000000040",
        version: 1,
      },
    } as const;
    const fetchMock = installFetchMock(
      new Map<string, ResponseOverride>([
        ["POST /admin/pairings", pairing],
        [
          `POST /admin/pairings/${pairing.pairingId}/approve`,
          () =>
            jsonResponse(
              {
                code: "PAIRING_VERIFICATION_CODE_MISMATCH",
                message: "The pairing verification code does not match.",
              },
              409,
            ),
        ],
      ]),
    );
    render(<App />);

    await screen.findByDisplayValue("https://agent.example.test");
    fireEvent.click(screen.getByRole("button", { name: "Generate QR" }));
    expect(
      await screen.findByAltText("PocketPilot device pairing QR code"),
    ).toBeInTheDocument();
    const mobileCode = screen.getByLabelText("Mobile code");
    fireEvent.change(mobileCode, { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    expect(
      await screen.findByText("The pairing verification code does not match."),
    ).toBeInTheDocument();
    expect(
      screen.getByAltText("PocketPilot device pairing QR code"),
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue("123456")).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.filter(
        (call) =>
          requestPath(call[0]) ===
          `/admin/pairings/${pairing.pairingId}/approve`,
      ),
    ).toHaveLength(1);
  });

  it("clears the previous code when a new QR replaces it", async () => {
    const pairings = [
      {
        expiresAt: Date.now() + 5 * 60 * 1_000,
        pairingId: "00000000-0000-4000-8000-000000000050",
        qrPayload: {
          agentId: "00000000-0000-4000-8000-000000000051",
          baseUrl: "https://agent.example.test",
          expiresAt: Date.now() + 5 * 60 * 1_000,
          pairingId: "00000000-0000-4000-8000-000000000050",
          version: 1,
        },
      },
      {
        expiresAt: Date.now() + 5 * 60 * 1_000,
        pairingId: "00000000-0000-4000-8000-000000000052",
        qrPayload: {
          agentId: "00000000-0000-4000-8000-000000000053",
          baseUrl: "https://agent.example.test",
          expiresAt: Date.now() + 5 * 60 * 1_000,
          pairingId: "00000000-0000-4000-8000-000000000052",
          version: 1,
        },
      },
    ] as const;
    let pairingCallCount = 0;
    const fetchMock = installFetchMock(
      new Map<string, ResponseOverride>([
        ["POST /admin/pairings", () => pairings[pairingCallCount++]],
      ]),
    );
    render(<App />);

    await screen.findByDisplayValue("https://agent.example.test");
    fireEvent.click(screen.getByRole("button", { name: "Generate QR" }));
    await screen.findByLabelText("Mobile code");
    await vi.waitFor(() =>
      expect(screen.getByRole("button", { name: "Generate QR" })).toBeEnabled(),
    );
    fireEvent.change(screen.getByLabelText("Mobile code"), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Generate QR" }));

    await vi.waitFor(() => expect(pairingCallCount).toBe(2));
    await vi.waitFor(() =>
      expect(screen.getByLabelText("Mobile code")).toHaveValue(""),
    );
    expect(
      fetchMock.mock.calls.filter(
        (call) => requestPath(call[0]) === "/admin/pairings/pending",
      ),
    ).toHaveLength(0);
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

  it("adds a picker-selected directory without saving staged capacity", async () => {
    const addedSnapshot = {
      directories: [
        ...snapshot.authorizedDirectories.directories,
        {
          nonTerminalRuntimeCount: 0,
          path: "D:\\new-project",
          status: "available",
          volumeRoot: false,
        },
      ],
      revision: 1,
    } as const;
    const fetchMock = installFetchMock(
      new Map<string, unknown>([
        [
          "POST /admin/authorized-directories/pick",
          {
            expiresAt: 1_900_000_000_000,
            path: "D:\\new-project",
            selectionId: "00000000-0000-4000-8000-000000000020",
            status: "selected",
            volumeRoot: false,
          },
        ],
        [
          "POST /admin/authorized-directories",
          {
            removedRedundantPaths: [],
            result: "added",
            selectedPath: "D:\\new-project",
            snapshot: addedSnapshot,
          },
        ],
      ]),
    );
    render(<App />);

    const capacity = await screen.findByLabelText("Concurrent task capacity");
    fireEvent.change(capacity, { target: { value: "9" } });
    fireEvent.click(screen.getByRole("button", { name: "Add directory" }));

    expect(await screen.findByText("D:\\new-project")).toBeInTheDocument();
    expect(screen.getByDisplayValue("9")).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(
        (call) =>
          requestPath(call[0]) === "/admin/configuration/tasks" &&
          call[1]?.method === "PUT",
      ),
    ).toBe(false);
  });

  it("removes a confirmed directory through its current revision", async () => {
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    const fetchMock = installFetchMock(
      new Map<string, unknown>([
        [
          "POST /admin/authorized-directories/remove",
          {
            removedPath: "C:\\code",
            snapshot: { directories: [], revision: 1 },
            stoppedTaskCount: 0,
          },
        ],
      ]),
    );
    render(<App />);

    await screen.findByText("C:\\code");
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    expect(
      await screen.findByText(
        "Directory authorization removed. 0 open sessions were stopped.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText("C:\\code")).not.toBeInTheDocument();
    const removal = fetchMock.mock.calls.find(
      (call) => requestPath(call[0]) === "/admin/authorized-directories/remove",
    );
    expect(JSON.parse(String(removal?.[1]?.body))).toEqual({
      expectedNonTerminalRuntimeCount: 0,
      path: "C:\\code",
      revision: 0,
      runtimeStopAccepted: true,
    });
  });
});

type ResponseOverride =
  | unknown
  | Response
  | (() => unknown | Response | Promise<unknown | Response>);

function installFetchMock(overrides = new Map<string, ResponseOverride>()) {
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
      const methodPath = `${init?.method ?? "GET"} ${path}`;
      const selectedResponse = overrides.has(methodPath)
        ? overrides.get(methodPath)
        : overrides.has(path)
          ? overrides.get(path)
          : responses.get(path);
      const response =
        typeof selectedResponse === "function"
          ? await selectedResponse()
          : selectedResponse;
      if (response instanceof Response) return response;
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
    tasks: { concurrentTaskCapacity: 5 },
  },
  authorizedDirectories: {
    directories: [
      {
        nonTerminalRuntimeCount: 0,
        path: "C:\\code",
        status: "available",
        volumeRoot: false,
      },
    ],
    revision: 0,
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
  ["/admin/devices", snapshot.devices],
  ["/admin/audits", snapshot.audits],
  ["/admin/authorized-directories", snapshot.authorizedDirectories],
]);
