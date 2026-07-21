import { afterEach, describe, expect, it, vi } from "vitest";

import {
  browseDirectories,
  inspectDirectories,
  LocalAdminApiError,
  saveTaskSettings,
} from "../src/api/local-admin";

describe("local-admin API client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("validates directory browse and inspection payloads", async () => {
    const fetchMock = vi.fn(
      async (
        input: RequestInfo | URL,
        _init?: RequestInit,
      ): Promise<Response> => {
        const path = requestPath(input);
        return jsonResponse(
          path.endsWith("/browse")
            ? {
                currentPath: "/work",
                entries: [
                  {
                    accessible: true,
                    name: "alpha",
                    path: "/work/alpha",
                    root: false,
                  },
                ],
                parentPath: "/",
                truncated: false,
              }
            : [
                {
                  canonicalPath: "/work",
                  configuredPath: "/work",
                  highRisk: false,
                  status: "available",
                },
              ],
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      browseDirectories("csrf-token", "/work"),
    ).resolves.toMatchObject({
      currentPath: "/work",
      entries: [{ name: "alpha" }],
    });
    await expect(inspectDirectories("csrf-token", ["/work"])).resolves.toEqual([
      {
        canonicalPath: "/work",
        configuredPath: "/work",
        highRisk: false,
        status: "available",
      },
    ]);

    for (const [, init] of fetchMock.mock.calls) {
      expect(new Headers(init?.headers).get("x-pocketpilot-csrf-token")).toBe(
        "csrf-token",
      );
    }
  });

  it("rejects malformed successful directory responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ entries: "bad" })),
    );

    await expect(browseDirectories("csrf-token")).rejects.toMatchObject({
      code: "LOCAL_ADMIN_RESPONSE_INVALID",
    });
  });

  it("preserves safe non-2xx API errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          {
            code: "DIRECTORY_NOT_ACCESSIBLE",
            message: "The directory cannot be listed.",
          },
          422,
        ),
      ),
    );

    await expect(browseDirectories("csrf-token", "/missing")).rejects.toEqual(
      new LocalAdminApiError(
        "DIRECTORY_NOT_ACCESSIBLE",
        "The directory cannot be listed.",
      ),
    );
  });

  it("keeps high-risk confirmations out of the task settings response type", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        jsonResponse({
          concurrentTaskCapacity: 2,
          workspaceRoots: ["/"],
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      saveTaskSettings(
        "csrf-token",
        { concurrentTaskCapacity: 2, workspaceRoots: ["/"] },
        ["/"],
      ),
    ).resolves.toEqual({
      concurrentTaskCapacity: 2,
      workspaceRoots: ["/"],
    });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      concurrentTaskCapacity: 2,
      workspaceRoots: ["/"],
      confirmedHighRiskRoots: ["/"],
    });
  });
});

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
