import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppData } from "@mindwtr/core";

const invoke = vi.hoisted(() => vi.fn());
const logInfo = vi.hoisted(() => vi.fn());
const logWarn = vi.hoisted(() => vi.fn());
const logError = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("./runtime", () => ({ isTauriRuntime: () => true }));
vi.mock("./app-log", () => ({ logInfo, logWarn, logError }));

import {
  CloudKitAttachmentNotFoundError,
  fetchCloudKitAttachmentAsset,
  readRemoteCloudKit,
  writeRemoteCloudKit,
} from "./cloudkit-sync";

const CHANGE_TOKEN_KEY = "@mindwtr_cloudkit_change_token";
const RECORD_TYPES = {
  task: "MindwtrTask",
  project: "MindwtrProject",
  section: "MindwtrSection",
  area: "MindwtrArea",
  person: "MindwtrPerson",
  settings: "MindwtrSettings",
} as const;

const emptyChanges = (changeToken?: string) => ({
  records: {},
  deletedIDs: {},
  ...(changeToken ? { changeToken } : {}),
});

const fullFetchRecords: Record<string, Array<Record<string, unknown>>> = {
  [RECORD_TYPES.task]: [{ id: "task-1", title: "Remote task" }],
  [RECORD_TYPES.project]: [{ id: "project-1", title: "Remote project" }],
  [RECORD_TYPES.section]: [{ id: "section-1", title: "Remote section" }],
  [RECORD_TYPES.area]: [{ id: "area-1", name: "Remote area" }],
  [RECORD_TYPES.person]: [{ id: "person-1", name: "Remote person" }],
  [RECORD_TYPES.settings]: [
    { id: "settings", payload: { deviceId: "remote-device" } },
  ],
};

const installFullFetchMock = (nextToken = "token-after-full-fetch") => {
  invoke.mockImplementation(
    async (command: string, args?: Record<string, unknown>) => {
      if (command === "cloudkit_fetch_all_records") {
        return fullFetchRecords[String(args?.recordType)] ?? [];
      }
      if (command === "cloudkit_fetch_changes" && args?.changeToken === null) {
        return emptyChanges(nextToken);
      }
      throw new Error(`Unexpected CloudKit command: ${command}`);
    },
  );
};

describe("desktop CloudKit transport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    (
      window as unknown as { __TAURI_INTERNALS__: { invoke: typeof invoke } }
    ).__TAURI_INTERNALS__ = { invoke };
    Object.defineProperty(navigator, "platform", {
      configurable: true,
      value: "MacIntel",
    });
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      value: "Mindwtr macOS",
    });
  });

  it("performs the initial full fetch and establishes an incremental token", async () => {
    installFullFetchMock();

    const data = await readRemoteCloudKit();

    expect(data).toMatchObject({
      tasks: [{ id: "task-1" }],
      projects: [{ id: "project-1" }],
      sections: [{ id: "section-1" }],
      areas: [{ id: "area-1" }],
      people: [{ id: "person-1" }],
      settings: { deviceId: "remote-device" },
    });
    expect(
      invoke.mock.calls.filter(
        ([command]) => command === "cloudkit_fetch_all_records",
      ),
    ).toHaveLength(6);
    expect(invoke).toHaveBeenCalledWith("cloudkit_fetch_changes", {
      changeToken: null,
    });
    expect(localStorage.getItem(CHANGE_TOKEN_KEY)).toBe(
      "token-after-full-fetch",
    );
  });

  it("returns no data for an empty incremental response and advances the token", async () => {
    localStorage.setItem(CHANGE_TOKEN_KEY, "token-before");
    invoke.mockResolvedValue(emptyChanges("token-after"));

    await expect(readRemoteCloudKit()).resolves.toBeNull();

    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("cloudkit_fetch_changes", {
      changeToken: "token-before",
    });
    expect(localStorage.getItem(CHANGE_TOKEN_KEY)).toBe("token-after");
  });

  it("falls back to a full fetch when the incremental token expires", async () => {
    localStorage.setItem(CHANGE_TOKEN_KEY, "expired-token");
    invoke.mockImplementation(
      async (command: string, args?: Record<string, unknown>) => {
        if (
          command === "cloudkit_fetch_changes" &&
          args?.changeToken === "expired-token"
        ) {
          return { ...emptyChanges(), tokenExpired: true };
        }
        if (command === "cloudkit_fetch_all_records") {
          return fullFetchRecords[String(args?.recordType)] ?? [];
        }
        if (
          command === "cloudkit_fetch_changes" &&
          args?.changeToken === null
        ) {
          return emptyChanges("replacement-token");
        }
        throw new Error(`Unexpected CloudKit command: ${command}`);
      },
    );

    const data = await readRemoteCloudKit();

    expect(data?.tasks).toEqual([{ id: "task-1", title: "Remote task" }]);
    expect(localStorage.getItem(CHANGE_TOKEN_KEY)).toBe("replacement-token");
    expect(logInfo).toHaveBeenCalledWith(
      "CloudKit change token expired; doing full fetch",
      { scope: "cloudkit" },
    );
  });

  it("fans writes out by record type, deletes purged records, and preserves the token on conflict", async () => {
    localStorage.setItem(CHANGE_TOKEN_KEY, "stable-token");
    const data = {
      tasks: [{ id: "task-1", purgedAt: "2026-08-05T12:00:00.000Z" }],
      projects: [{ id: "project-1", purgedAt: "2026-08-05T12:00:00.000Z" }],
      sections: [{ id: "section-1" }],
      areas: [{ id: "area-1" }],
      people: [{ id: "person-1" }],
      settings: { deviceId: "desktop-device" },
    } as unknown as AppData;
    invoke.mockImplementation(
      async (command: string, args?: Record<string, unknown>) => {
        if (command === "cloudkit_save_records") {
          return {
            conflictIDs:
              args?.recordType === RECORD_TYPES.task ? ["task-1"] : [],
          };
        }
        if (command === "cloudkit_delete_records") return true;
        throw new Error(`Unexpected CloudKit command: ${command}`);
      },
    );

    await writeRemoteCloudKit(data);

    const savedRecordTypes = invoke.mock.calls
      .filter(([command]) => command === "cloudkit_save_records")
      .map(([, args]) => args.recordType);
    const deletedRecords = invoke.mock.calls
      .filter(([command]) => command === "cloudkit_delete_records")
      .map(([, args]) => args);
    expect(savedRecordTypes).toEqual(Object.values(RECORD_TYPES));
    expect(deletedRecords).toEqual([
      { recordType: RECORD_TYPES.task, recordIds: ["task-1"] },
      { recordType: RECORD_TYPES.project, recordIds: ["project-1"] },
    ]);
    expect(
      invoke.mock.calls.some(
        ([command]) => command === "cloudkit_fetch_changes",
      ),
    ).toBe(false);
    expect(localStorage.getItem(CHANGE_TOKEN_KEY)).toBe("stable-token");
    expect(logWarn).toHaveBeenCalledWith(
      "CloudKit save had 1 conflicts (will resolve on next sync)",
      expect.objectContaining({ scope: "cloudkit" }),
    );
  });

  it("advances the token after a conflict-free write", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "cloudkit_save_records") return { conflictIDs: [] };
      if (command === "cloudkit_fetch_changes")
        return emptyChanges("token-after-write");
      throw new Error(`Unexpected CloudKit command: ${command}`);
    });
    const data = {
      tasks: [{ id: "task-1" }],
      projects: [],
      sections: [],
      areas: [],
      people: [],
      settings: {},
    } as unknown as AppData;

    await writeRemoteCloudKit(data);

    expect(invoke).toHaveBeenCalledWith("cloudkit_fetch_changes", {
      changeToken: null,
    });
    expect(localStorage.getItem(CHANGE_TOKEN_KEY)).toBe("token-after-write");
  });

  it.each([
    "attachment-record-not-found",
    "attachment-asset-missing",
  ])("normalizes the structured terminal attachment error for %s", async (message) => {
    const nativeError = {
      code: "ERR_CLOUDKIT_ATTACHMENT_NOT_FOUND",
      message: `CloudKit error: ${message}`,
    };
    invoke.mockRejectedValue(nativeError);

    let thrown: unknown;
    try {
      await fetchCloudKitAttachmentAsset("attachment-1", "/tmp/staged-attachment");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(CloudKitAttachmentNotFoundError);
    expect(thrown).toMatchObject({
      code: "ERR_CLOUDKIT_ATTACHMENT_NOT_FOUND",
      message: `CloudKit error: ${message}`,
      cause: nativeError,
    });
  });

  it("preserves transient attachment fetch failures without terminal normalization", async () => {
    const transientError = {
      message: "CloudKit error: network unavailable",
    };
    invoke.mockRejectedValue(transientError);

    await expect(
      fetchCloudKitAttachmentAsset("attachment-1", "/tmp/staged-attachment"),
    ).rejects.toBe(transientError);
  });
});
