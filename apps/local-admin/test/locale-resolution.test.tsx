import { afterEach, describe, expect, it, vi } from "vitest";

import {
  persistLocale,
  readPersistedLocale,
  resolveInitialLocale,
} from "../src/lib/i18n/locale-resolution";

describe("locale resolution", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("prefers a valid persisted locale", () => {
    expect(
      resolveInitialLocale({
        browserLanguages: ["zh-CN"],
        persistedLocale: "en",
      }),
    ).toBe("en");
  });

  it("matches registered Chinese browser language tags", () => {
    expect(
      resolveInitialLocale({
        browserLanguages: ["zh_Hans_CN"],
        persistedLocale: null,
      }),
    ).toBe("zh-CN");
  });

  it("uses English for an available non-Chinese browser language", () => {
    expect(
      resolveInitialLocale({
        browserLanguages: ["fr-FR"],
        persistedLocale: null,
      }),
    ).toBe("en");
  });

  it("uses Simplified Chinese when browser language is unavailable", () => {
    expect(
      resolveInitialLocale({ browserLanguages: [], persistedLocale: null }),
    ).toBe("zh-CN");
  });

  it("ignores an invalid persisted locale", () => {
    expect(
      resolveInitialLocale({
        browserLanguages: ["en-US"],
        persistedLocale: "invalid-locale",
      }),
    ).toBe("en");
  });

  it("keeps locale selection usable when storage is blocked", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });

    expect(readPersistedLocale()).toBeNull();
    expect(() => persistLocale("en")).not.toThrow();
  });
});
