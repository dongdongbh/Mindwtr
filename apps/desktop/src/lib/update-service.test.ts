import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkForUpdates,
  findPortableZipAsset,
  getFlatpakInstallChannel,
  normalizeInstallSource,
} from "./update-service";

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

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
});
