import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App } from "../src/App";
import { I18nProvider } from "../src/lib/i18n/i18n-context";
import { localeStorageKey } from "../src/lib/i18n/locale-resolution";

describe("App", () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
    document.documentElement.lang = "";
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders the approved console views with loaded server data", async () => {
    installFetchMock();
    renderApp();

    expect(screen.getByRole("heading", { name: "总览" })).toBeInTheDocument();
    expect(await screen.findByText("127.0.0.1:43183")).toBeInTheDocument();
    expect(screen.getByText("Pixel 9")).toBeInTheDocument();
    expect(screen.getByText("task.created")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "配置" }));
    expect(
      await screen.findByDisplayValue("https://agent.example.test"),
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue("C:\\code")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "设备" }));
    expect(
      screen.getByRole("heading", { name: "配对新设备" }),
    ).toBeInTheDocument();
    expect(screen.getByText("My phone")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "审计记录" }));
    expect(screen.getByText("task.created")).toBeInTheDocument();
  });

  it("sends both configuration writes with the CSRF token", async () => {
    const fetchMock = installFetchMock();
    renderApp();

    await screen.findByText("127.0.0.1:43183");
    fireEvent.click(screen.getByRole("button", { name: "配置" }));
    const mobileBaseUrl = await screen.findByDisplayValue(
      "https://agent.example.test",
    );
    fireEvent.change(mobileBaseUrl, {
      target: { value: "https://updated.example.test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存配置" }));

    expect(
      await screen.findByText("配置已保存。监听器更改将在下次启动时生效。"),
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
      writes.map(([input, init]) => ({
        body: JSON.parse(String(init?.body)),
        path: requestPath(input),
      })),
    ).toEqual([
      {
        body: {
          mobileBaseUrl: "https://updated.example.test",
          remoteListener: { host: "127.0.0.1", port: 43_182 },
        },
        path: "/admin/configuration/runtime",
      },
      {
        body: { concurrentTaskCapacity: 5, workspaceRoots: ["C:\\code"] },
        path: "/admin/configuration/tasks",
      },
    ]);
    expect(
      screen.queryByText("存在尚未保存的配置更改。"),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "English" }));
    expect(
      await screen.findByText(
        "Configuration saved. Listener changes take effect the next time the Agent starts.",
      ),
    ).toBeInTheDocument();
  });

  it("renders English chrome while preserving opaque server values", async () => {
    installFetchMock();
    renderApp("en");

    expect(
      screen.getByRole("heading", { name: "Overview" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("127.0.0.1:43183")).toBeInTheDocument();
    expect(screen.getByText("task.created")).toBeInTheDocument();
    expect(document.documentElement.lang).toBe("en");

    fireEvent.click(screen.getByRole("button", { name: "Devices" }));
    expect(
      screen.getByText(
        "Pairing QR data is returned by the local Agent, expires after five minutes, and can register only one device. The browser does not construct or persist this data.",
      ),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Maintenance" }));
    expect(screen.getByText("agent rekey")).toBeInTheDocument();
    expect(
      screen.getByText("agent reset --confirm RESET_AGENT_DATA"),
    ).toBeInTheDocument();
  });

  it("formats timestamps with the active locale after switching", async () => {
    const timestampSpy = vi.spyOn(Date.prototype, "toLocaleString");
    installFetchMock();
    renderApp();

    await screen.findByText("127.0.0.1:43183");
    expect(timestampSpy).toHaveBeenCalledWith("zh-CN");

    timestampSpy.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "English" }));
    expect(timestampSpy).toHaveBeenCalledWith("en");
  });

  it("switches locale without losing the current configuration draft", async () => {
    installFetchMock();
    renderApp();

    await screen.findByText("127.0.0.1:43183");
    fireEvent.click(screen.getByRole("button", { name: "配置" }));
    const mobileBaseUrl = await screen.findByDisplayValue(
      "https://agent.example.test",
    );
    fireEvent.change(mobileBaseUrl, {
      target: { value: "https://draft.example.test" },
    });

    fireEvent.click(screen.getByRole("button", { name: "English" }));

    expect(
      screen.getByRole("heading", { name: "Configuration" }),
    ).toBeInTheDocument();
    expect(
      screen.getByDisplayValue("https://draft.example.test"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Unsaved configuration changes."),
    ).toBeInTheDocument();
    expect(document.documentElement.lang).toBe("en");
    expect(localStorage.getItem(localeStorageKey)).toBe("en");
    expect(
      screen.getByRole("group", { name: "Interface language" }),
    ).toBeInTheDocument();
  });

  it("rejects an invalid local API response before rendering its data", async () => {
    installFetchMock(
      new Map([["/admin/configuration", { runtime: "not-an-object" }]]),
    );
    renderApp();

    expect(
      await screen.findByText("本地 Agent 返回了无效响应。"),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.queryByText("Agent 状态")).not.toBeInTheDocument();
  });

  it("localizes client-owned request failures after locale changes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
    );
    renderApp();

    expect(
      await screen.findByText(
        "\u672c\u5730\u7ba1\u7406\u8bf7\u6c42\u5931\u8d25\u3002",
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "English" }));
    expect(
      await screen.findByText("The local administration request failed."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Failed to fetch")).not.toBeInTheDocument();
  });

  it("keeps unknown backend error messages opaque", async () => {
    installFetchMock(
      new Map<string, unknown | Response>([
        [
          "/admin/configuration",
          jsonResponse(
            {
              code: "CUSTOM_BACKEND_ERROR",
              message: "Server-owned diagnostic.",
            },
            400,
          ),
        ],
      ]),
    );
    renderApp("en");

    expect(
      await screen.findByText("Server-owned diagnostic."),
    ).toBeInTheDocument();
  });

  it("keeps unrecognized audit results opaque", async () => {
    installFetchMock(
      new Map([
        [
          "/admin/audits",
          [{ ...snapshot.audits[0], result: "successful-review" }],
        ],
      ]),
    );
    renderApp("en");

    await screen.findByText("127.0.0.1:43183");
    fireEvent.click(screen.getByRole("button", { name: "Audit records" }));
    expect(screen.getAllByText("successful-review")).not.toHaveLength(0);
    expect(screen.queryByText("Success")).not.toBeInTheDocument();
  });
});

function renderApp(locale: "en" | "zh-CN" = "zh-CN") {
  localStorage.setItem(localeStorageKey, locale);
  return render(
    <I18nProvider>
      <App />
    </I18nProvider>,
  );
}

function installFetchMock(overrides = new Map<string, unknown | Response>()) {
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
