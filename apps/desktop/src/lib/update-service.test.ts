import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkForUpdates,
  findPortableZipAsset,
  getFlatpakInstallChannel,
  MS_STORE_UPDATES_URL,
  normalizeInstallSource,
  UPDATE_RATE_LIMIT_MESSAGE,
  UpdateRateLimitedError,
} from "./update-service";
import tauriConfig from "../../src-tauri/tauri.conf.json";

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const atomResponse = (tags: string[], status = 200): Response =>
  new Response(
    `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom">${tags
      .map(
        (tag) =>
          `<entry><id>tag:github.com,2008:Repository/1/${tag}</id><link type="text/html" rel="alternate" href="https://github.com/dongdongbh/Mindwtr/releases/tag/${tag}"/><title>${tag}</title></entry>`,
      )
      .join("")}</feed>`,
    { status, headers: { "Content-Type": "application/atom+xml" } },
  );

const originalFetch = globalThis.fetch;
const originalUserAgent = navigator.userAgent;

describe("update-service channel selection", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
    Object.defineProperty(window.navigator, "userAgent", {
      configurable: true,
      value: originalUserAgent,
    });
  });

  it("keeps mac app store installs on app store version even if github is newer", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("itunes.apple.com/lookup")) {
        return jsonResponse({
          results: [
            {
              version: "1.1.0",
              trackViewUrl: "https://apps.apple.com/app/mindwtr/id6758597144",
            },
          ],
        });
      }
      if (
        url.includes("api.github.com/repos/dongdongbh/Mindwtr/releases/latest")
      ) {
        return jsonResponse({
          tag_name: "v1.9.0",
          html_url: "https://github.com/dongdongbh/Mindwtr/releases/tag/v1.9.0",
          body: "latest notes",
          assets: [],
        });
      }
      return jsonResponse({}, 404);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await checkForUpdates("1.0.0", {
      installSource: "mac-app-store",
    });

    expect(result.hasUpdate).toBe(true);
    expect(result.source).toBe("app-store");
    expect(result.latestVersion).toBe("1.1.0");
    expect(result.sourceFallback).toBe(false);
  });

  it("falls back to github when managed source lookup fails", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("itunes.apple.com/lookup")) {
        return jsonResponse({}, 500);
      }
      if (
        url.includes("api.github.com/repos/dongdongbh/Mindwtr/releases/latest")
      ) {
        return jsonResponse({
          tag_name: "v1.2.0",
          html_url: "https://github.com/dongdongbh/Mindwtr/releases/tag/v1.2.0",
          body: "latest notes",
          assets: [],
        });
      }
      return jsonResponse({}, 404);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await checkForUpdates("1.0.0", {
      installSource: "mac-app-store",
    });

    expect(result.hasUpdate).toBe(true);
    expect(result.source).toBe("github-release");
    expect(result.latestVersion).toBe("1.2.0");
  });

  it("keeps homebrew installs on homebrew version even if github is newer", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("formulae.brew.sh/api/cask/mindwtr.json")) {
        return jsonResponse({ version: "1.1.0" });
      }
      if (
        url.includes("api.github.com/repos/dongdongbh/Mindwtr/releases/latest")
      ) {
        return jsonResponse({
          tag_name: "v1.9.0",
          html_url: "https://github.com/dongdongbh/Mindwtr/releases/tag/v1.9.0",
          body: "latest notes",
          assets: [],
        });
      }
      return jsonResponse({}, 404);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await checkForUpdates("1.0.0", {
      installSource: "homebrew",
    });

    expect(result.hasUpdate).toBe(true);
    expect(result.source).toBe("homebrew");
    expect(result.latestVersion).toBe("1.1.0");
    expect(result.sourceFallback).toBe(false);
  });

  it("checks mindwtr AUR package for source installs", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (
        /aur\.archlinux\.org\/rpc\/\?v=5&type=info&arg%5B%5D=mindwtr(?:$|&)/.test(
          url,
        )
      ) {
        return jsonResponse({ results: [{ Version: "1.2.0-2" }] });
      }
      if (
        url.includes("api.github.com/repos/dongdongbh/Mindwtr/releases/latest")
      ) {
        return jsonResponse({
          tag_name: "v1.9.0",
          html_url: "https://github.com/dongdongbh/Mindwtr/releases/tag/v1.9.0",
          body: "latest notes",
          assets: [],
        });
      }
      return jsonResponse({}, 404);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await checkForUpdates("1.0.0", {
      installSource: "aur-source",
    });

    expect(result.hasUpdate).toBe(true);
    expect(result.source).toBe("aur");
    expect(result.releaseUrl).toBe(
      "https://aur.archlinux.org/packages/mindwtr",
    );
    expect(result.latestVersion).toBe("1.2.0");
  });

  it("checks mindwtr-bin AUR package for binary installs", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (
        /aur\.archlinux\.org\/rpc\/\?v=5&type=info&arg%5B%5D=mindwtr-bin(?:$|&)/.test(
          url,
        )
      ) {
        return jsonResponse({ results: [{ Version: "1.3.0-1" }] });
      }
      if (
        url.includes("api.github.com/repos/dongdongbh/Mindwtr/releases/latest")
      ) {
        return jsonResponse({
          tag_name: "v1.9.0",
          html_url: "https://github.com/dongdongbh/Mindwtr/releases/tag/v1.9.0",
          body: "latest notes",
          assets: [],
        });
      }
      return jsonResponse({}, 404);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await checkForUpdates("1.0.0", { installSource: "aur-bin" });

    expect(result.hasUpdate).toBe(true);
    expect(result.source).toBe("aur");
    expect(result.releaseUrl).toBe(
      "https://aur.archlinux.org/packages/mindwtr-bin",
    );
    expect(result.latestVersion).toBe("1.3.0");
  });

  it("normalizes scoop and chocolatey installs", () => {
    expect(normalizeInstallSource("scoop")).toBe("scoop");
    expect(normalizeInstallSource("SCOOP")).toBe("scoop");
    expect(normalizeInstallSource("chocolatey")).toBe("chocolatey");
    expect(normalizeInstallSource("choco")).toBe("chocolatey");
  });

  it("reports the GitHub release for scoop manual checks without a bucket lookup", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (
        url.includes("api.github.com/repos/dongdongbh/Mindwtr/releases/latest")
      ) {
        return jsonResponse({
          tag_name: "v1.9.0",
          html_url: "https://github.com/dongdongbh/Mindwtr/releases/tag/v1.9.0",
          body: "latest notes",
          assets: [],
        });
      }
      return jsonResponse({}, 404);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await checkForUpdates("1.0.0", { installSource: "scoop" });

    expect(result.hasUpdate).toBe(true);
    expect(result.source).toBe("github-release");
    expect(result.latestVersion).toBe("1.9.0");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("pins chocolatey installs to the Chocolatey package version", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("community.chocolatey.org/api/v2/Packages()")) {
        return new Response(
          "<feed><entry><id>http://community.chocolatey.org/api/v2/Packages(Id='mindwtr',Version='1.1.0')</id></entry></feed>",
          { status: 200 },
        );
      }
      if (
        url.includes("api.github.com/repos/dongdongbh/Mindwtr/releases/latest")
      ) {
        return jsonResponse({
          tag_name: "v1.9.0",
          html_url: "https://github.com/dongdongbh/Mindwtr/releases/tag/v1.9.0",
          body: "latest notes",
          assets: [],
        });
      }
      return jsonResponse({}, 404);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await checkForUpdates("1.0.0", {
      installSource: "chocolatey",
    });

    expect(result.hasUpdate).toBe(true);
    expect(result.source).toBe("chocolatey");
    expect(result.latestVersion).toBe("1.1.0");
    expect(result.releaseUrl).toBe(
      "https://community.chocolatey.org/packages/mindwtr",
    );
  });

  it("normalizes flatpak branch installs while keeping the branch available for UI display", () => {
    expect(normalizeInstallSource("flatpak:test")).toBe("flatpak");
    expect(normalizeInstallSource("flatpak:master")).toBe("flatpak");
    expect(getFlatpakInstallChannel("flatpak:test")).toBe("test");
    expect(getFlatpakInstallChannel("flatpak:master")).toBe("master");
  });

  it("prefers the portable zip asset for portable windows installs", async () => {
    Object.defineProperty(window.navigator, "userAgent", {
      configurable: true,
      value: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (
        url.includes("api.github.com/repos/dongdongbh/Mindwtr/releases/latest")
      ) {
        return jsonResponse({
          tag_name: "v1.2.0",
          html_url: "https://github.com/dongdongbh/Mindwtr/releases/tag/v1.2.0",
          body: "latest notes",
          assets: [
            {
              name: "mindwtr_1.2.0_x64-setup.exe",
              browser_download_url:
                "https://example.com/mindwtr_1.2.0_x64-setup.exe",
            },
            {
              name: "mindwtr_1.2.0_windows_x64_portable.zip",
              browser_download_url:
                "https://example.com/mindwtr_1.2.0_windows_x64_portable.zip",
            },
          ],
        });
      }
      return jsonResponse({}, 404);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await checkForUpdates("1.0.0", {
      installSource: "portable",
    });

    expect(result.downloadUrl).toBe(
      "https://example.com/mindwtr_1.2.0_windows_x64_portable.zip",
    );
    expect(normalizeInstallSource("portable")).toBe("portable");
  });

  it("uses Microsoft Store availability instead of GitHub for Microsoft Store installs", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (
        url.includes("api.github.com/repos/dongdongbh/Mindwtr/releases/latest")
      ) {
        return jsonResponse({
          tag_name: "v9.9.9",
          html_url: "https://github.com/dongdongbh/Mindwtr/releases/tag/v9.9.9",
          body: "github notes",
          assets: [],
        });
      }
      return jsonResponse({}, 404);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await checkForUpdates("1.0.0", {
      installSource: "microsoft-store",
      microsoftStoreUpdateProvider: vi.fn().mockResolvedValue({
        hasUpdate: false,
        latestVersion: null,
      }),
    });

    expect(result.hasUpdate).toBe(false);
    expect(result.source).toBe("microsoft-store");
    expect(result.latestVersion).toBe("1.0.0");
    expect(result.releaseUrl).toBe(MS_STORE_UPDATES_URL);
    expect(result.downloadUrl).toBeNull();
  });

  it("allows the Microsoft Store updates page through the Tauri shell scope", () => {
    const openScope = tauriConfig.plugins.shell.open;

    expect(new RegExp(openScope).test(MS_STORE_UPDATES_URL)).toBe(true);
  });

  it("prefers explicitly windows-named portable assets when multiple portable zips exist", () => {
    const asset = findPortableZipAsset([
      { name: "mindwtr_1.2.0_portable.zip", url: "https://example.com/generic.zip" },
      {
        name: "mindwtr_1.2.0_windows_x64_portable.zip",
        url: "https://example.com/windows.zip",
      },
    ]);

    expect(asset?.name).toBe("mindwtr_1.2.0_windows_x64_portable.zip");
  });

  it("falls back to the releases.atom feed when the GitHub API is rate-limited (newer version)", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("api.github.com/repos/dongdongbh/Mindwtr/releases/latest")) {
        return jsonResponse({}, 403);
      }
      if (url.includes("github.com/dongdongbh/Mindwtr/releases.atom")) {
        return atomResponse(["v1.9.0", "v1.8.0"]);
      }
      return jsonResponse({}, 404);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await checkForUpdates("1.0.0", {
      installSource: "github-release",
    });

    expect(result.hasUpdate).toBe(true);
    expect(result.latestVersion).toBe("1.9.0");
    expect(result.source).toBe("github-release");
    expect(result.releaseNotes).toBe("");
    expect(result.assets).toEqual([]);
    expect(result.downloadUrl).toBeNull();
    expect(result.releaseUrl).toBe(
      "https://github.com/dongdongbh/Mindwtr/releases/tag/v1.9.0",
    );
  });

  it("falls back to the releases.atom feed when rate-limited (already up to date)", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("api.github.com/repos/dongdongbh/Mindwtr/releases/latest")) {
        return jsonResponse({}, 429);
      }
      if (url.includes("github.com/dongdongbh/Mindwtr/releases.atom")) {
        return atomResponse(["v1.0.0"]);
      }
      return jsonResponse({}, 404);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await checkForUpdates("1.0.0", {
      installSource: "github-release",
    });

    expect(result.hasUpdate).toBe(false);
    expect(result.releaseNotes).toBe("");
    expect(result.assets).toEqual([]);
    expect(result.downloadUrl).toBeNull();
  });

  it("does not consult the atom feed when the GitHub API succeeds", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("api.github.com/repos/dongdongbh/Mindwtr/releases/latest")) {
        return jsonResponse({
          tag_name: "v1.9.0",
          html_url: "https://github.com/dongdongbh/Mindwtr/releases/tag/v1.9.0",
          body: "latest notes",
          assets: [],
        });
      }
      return jsonResponse({}, 404);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await checkForUpdates("1.0.0", {
      installSource: "github-release",
    });

    expect(result.hasUpdate).toBe(true);
    expect(result.releaseNotes).toBe("latest notes");
    expect(
      fetchMock.mock.calls.some((call) =>
        String(call[0]).includes("releases.atom"),
      ),
    ).toBe(false);
  });

  it("surfaces a calm rate-limit message when both the API and the atom feed are rate-limited", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("api.github.com/repos/dongdongbh/Mindwtr/releases/latest")) {
        return jsonResponse({}, 403);
      }
      if (url.includes("github.com/dongdongbh/Mindwtr/releases.atom")) {
        return atomResponse([], 429);
      }
      return jsonResponse({}, 404);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      checkForUpdates("1.0.0", { installSource: "github-release" }),
    ).rejects.toMatchObject(
      expect.objectContaining({
        message: UPDATE_RATE_LIMIT_MESSAGE,
      }),
    );
    await expect(
      checkForUpdates("1.0.0", { installSource: "github-release" }),
    ).rejects.toBeInstanceOf(UpdateRateLimitedError);
  });

  it("leaves non-403 GitHub API errors unchanged (no atom fallback attempted)", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("api.github.com/repos/dongdongbh/Mindwtr/releases/latest")) {
        return jsonResponse({}, 500);
      }
      return jsonResponse({}, 404);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      checkForUpdates("1.0.0", { installSource: "github-release" }),
    ).rejects.toThrow("GitHub API error: 500");
    expect(
      fetchMock.mock.calls.some((call) =>
        String(call[0]).includes("releases.atom"),
      ),
    ).toBe(false);
  });
});
