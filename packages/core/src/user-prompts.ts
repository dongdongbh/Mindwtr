import type { SupportPromptSettings } from './types';

const DAY_MS = 24 * 60 * 60 * 1000;
const PROMPT_DAY_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export const PROMPT_COORDINATOR_COOLDOWN_MS = 7 * DAY_MS;
export const STORE_REVIEW_MIN_DAYS_SINCE_FIRST_SEEN = 14;
export const STORE_REVIEW_MIN_ACTIVE_DAYS = 7;
export const STORE_REVIEW_ATTEMPT_COOLDOWN_MS = 90 * DAY_MS;
export const DONATION_PROMPT_MIN_DAYS_SINCE_FIRST_SEEN = 30;
export const DONATION_PROMPT_MIN_ACTIVE_DAYS = 21;
// One cooldown from the last time the notice was shown, whether or not the user
// clicked support: a click is not proof of a donation, and twice a year is fine.
export const DONATION_PROMPT_REPEAT_COOLDOWN_MS = 183 * DAY_MS;
export const UPDATE_REMINDER_CHECK_INTERVAL_MS = DAY_MS;
export const UPDATE_REMINDER_MIN_DAYS_SINCE_FIRST_SEEN = 7;
export const UPDATE_REMINDER_MIN_ACTIVE_DAYS = 2;
export const UPDATE_REMINDER_PATCH_GRACE_MS = 21 * DAY_MS;

export type UserPromptPlatform = 'ios' | 'android' | 'desktop' | 'web' | 'unknown';

export type UserPromptState = {
    firstSeenAt?: string;
    firstSeenDayKey?: string;
    activeDayKeys?: string[];
    lastInterruptivePromptAt?: string;
    storeReview?: {
        lastAttemptAt?: string;
    };
    donation?: {
        askedEver?: boolean;
        lastShownAt?: string;
        /** Legacy install-local field; no longer read. */
        lastActionAt?: string;
    };
    update?: {
        dismissedVersion?: string;
        lastCheckedAt?: string;
        lastShownAt?: string;
    };
};

export type StoreReviewPromptInput = {
    nowMs: number;
    platform: UserPromptPlatform;
    promptState: UserPromptState | null | undefined;
    recentNegativeSignal?: boolean;
    storeReviewAvailable: boolean;
};

export type DonationPromptInput = {
    nowMs: number;
    promptState: UserPromptState | null | undefined;
    /** settings.supportPrompt: the cooldown shared by every install on the dataset (#1237). */
    supportPrompt?: SupportPromptSettings | null;
    donationAllowed: boolean;
};

export type UpdateReminderCheckInput = {
    nowMs: number;
    promptState: UserPromptState | null | undefined;
    updateReminderAllowed: boolean;
};

export type UpdateReminderPromptInput = {
    nowMs: number;
    promptState: UserPromptState | null | undefined;
    updateReminderAllowed: boolean;
    currentVersion: string;
    latestVersion: string;
    latestReleasedAt?: string | null;
};

export function getPromptLocalDayKey(nowMs: number): string {
    const date = new Date(nowMs);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function getPromptLocalDayIndex(nowMs: number): number {
    const date = new Date(nowMs);
    return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS);
}

function parsePromptDayKey(value: string | null | undefined): number | null {
    if (!value) return null;
    const match = PROMPT_DAY_KEY_PATTERN.exec(value);
    if (!match) return null;
    const year = Number.parseInt(match[1], 10);
    const month = Number.parseInt(match[2], 10);
    const day = Number.parseInt(match[3], 10);
    const ms = Date.UTC(year, month - 1, day);
    const date = new Date(ms);
    if (
        date.getUTCFullYear() !== year
        || date.getUTCMonth() !== month - 1
        || date.getUTCDate() !== day
    ) {
        return null;
    }
    return Math.floor(ms / DAY_MS);
}

function parseTimeMs(value: string | null | undefined): number | null {
    if (!value) return null;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
}

function getPromptLocalDayKeyFromTime(value: string | null | undefined): string | null {
    const thenMs = parseTimeMs(value);
    if (thenMs === null) return null;
    return getPromptLocalDayKey(thenMs);
}

function normalizePromptDayKeys(values: string[] | null | undefined): string[] {
    const seen = new Set<string>();
    const keys: string[] = [];
    for (const value of values ?? []) {
        if (parsePromptDayKey(value) === null || seen.has(value)) continue;
        seen.add(value);
        keys.push(value);
    }
    return keys;
}

function countActiveDaysThroughNow(values: string[] | null | undefined, nowMs: number): number {
    const todayIndex = getPromptLocalDayIndex(nowMs);
    return normalizePromptDayKeys(values).filter((key) => {
        const dayIndex = parsePromptDayKey(key);
        return dayIndex !== null && dayIndex <= todayIndex;
    }).length;
}

function countActiveDaysSinceDay(
    values: string[] | null | undefined,
    nowMs: number,
    startDayIndex: number,
): number {
    const todayIndex = getPromptLocalDayIndex(nowMs);
    return normalizePromptDayKeys(values).filter((key) => {
        const dayIndex = parsePromptDayKey(key);
        return dayIndex !== null && dayIndex >= startDayIndex && dayIndex <= todayIndex;
    }).length;
}

function daysSinceFirstSeen(promptState: UserPromptState | null | undefined, nowMs: number): number | null {
    const firstSeenDayKey = promptState?.firstSeenDayKey
        ?? getPromptLocalDayKeyFromTime(promptState?.firstSeenAt);
    const firstSeenDayIndex = parsePromptDayKey(firstSeenDayKey);
    if (firstSeenDayIndex === null) return null;
    return getPromptLocalDayIndex(nowMs) - firstSeenDayIndex;
}

function isCooldownElapsed(value: string | null | undefined, nowMs: number, cooldownMs: number): boolean {
    const thenMs = parseTimeMs(value);
    if (thenMs === null) return true;
    return nowMs - thenMs >= cooldownMs;
}

type ParsedVersion = {
    major: number;
    minor: number;
    patch: number;
};

function parseComparableVersion(value: string): ParsedVersion | null {
    const match = value.trim().replace(/^v/i, '').match(/\d+(?:\.\d+){0,3}/);
    if (!match) return null;
    const [major = 0, minor = 0, patch = 0] = match[0]
        .split('.')
        .map((part) => Number.parseInt(part, 10));
    if (![major, minor, patch].every(Number.isFinite)) return null;
    return { major, minor, patch };
}

export function comparePromptVersions(currentVersion: string, latestVersion: string): number {
    const current = parseComparableVersion(currentVersion);
    const latest = parseComparableVersion(latestVersion);
    if (!current || !latest) return currentVersion.trim().localeCompare(latestVersion.trim());
    const currentParts = [current.major, current.minor, current.patch];
    const latestParts = [latest.major, latest.minor, latest.patch];
    for (let index = 0; index < latestParts.length; index += 1) {
        const diff = currentParts[index] - latestParts[index];
        if (diff !== 0) return diff > 0 ? 1 : -1;
    }
    return 0;
}

function isMeaningfullyBehindUpdate(
    currentVersion: string,
    latestVersion: string,
    latestReleasedAt: string | null | undefined,
    nowMs: number,
): boolean {
    if (comparePromptVersions(currentVersion, latestVersion) >= 0) return false;
    const current = parseComparableVersion(currentVersion);
    const latest = parseComparableVersion(latestVersion);
    if (!current || !latest) return true;
    if (latest.major > current.major || latest.minor > current.minor) return true;
    const latestReleasedMs = parseTimeMs(latestReleasedAt);
    return latestReleasedMs !== null && nowMs - latestReleasedMs >= UPDATE_REMINDER_PATCH_GRACE_MS;
}

export function recordPromptActivity(
    promptState: UserPromptState | null | undefined,
    nowMs: number,
): UserPromptState {
    const nowIso = new Date(nowMs).toISOString();
    const todayKey = getPromptLocalDayKey(nowMs);
    const existingKeys = normalizePromptDayKeys(promptState?.activeDayKeys);
    const nextKeys = existingKeys.includes(todayKey)
        ? existingKeys
        : [...existingKeys, todayKey].slice(-180);
    const firstSeenDayKey = promptState?.firstSeenDayKey
        ?? getPromptLocalDayKeyFromTime(promptState?.firstSeenAt)
        ?? nextKeys[0]
        ?? todayKey;

    return {
        ...(promptState ?? {}),
        activeDayKeys: nextKeys,
        firstSeenAt: promptState?.firstSeenAt ?? nowIso,
        firstSeenDayKey,
    };
}

export function shouldAttemptStoreReviewPrompt({
    nowMs,
    platform,
    promptState,
    recentNegativeSignal = false,
    storeReviewAvailable,
}: StoreReviewPromptInput): boolean {
    if (!storeReviewAvailable) return false;
    if (recentNegativeSignal) return false;
    if (platform !== 'ios' && platform !== 'android') return false;

    const firstSeenDayCount = daysSinceFirstSeen(promptState, nowMs);
    if (firstSeenDayCount === null || firstSeenDayCount < STORE_REVIEW_MIN_DAYS_SINCE_FIRST_SEEN) {
        return false;
    }

    const activeDayCount = countActiveDaysThroughNow(promptState?.activeDayKeys, nowMs);
    if (activeDayCount < STORE_REVIEW_MIN_ACTIVE_DAYS) return false;

    if (!isCooldownElapsed(
        promptState?.storeReview?.lastAttemptAt,
        nowMs,
        STORE_REVIEW_ATTEMPT_COOLDOWN_MS,
    )) {
        return false;
    }

    return isCooldownElapsed(
        promptState?.lastInterruptivePromptAt,
        nowMs,
        PROMPT_COORDINATOR_COOLDOWN_MS,
    );
}

export function recordStoreReviewPromptAttempt(
    promptState: UserPromptState | null | undefined,
    nowMs: number,
): UserPromptState {
    const nowIso = new Date(nowMs).toISOString();
    return {
        ...(promptState ?? {}),
        lastInterruptivePromptAt: nowIso,
        storeReview: {
            ...(promptState?.storeReview ?? {}),
            lastAttemptAt: nowIso,
        },
    };
}

function latestTimeMs(...values: Array<string | null | undefined>): number | null {
    let latest: number | null = null;
    for (const value of values) {
        const ms = parseTimeMs(value);
        if (ms !== null && (latest === null || ms > latest)) latest = ms;
    }
    return latest;
}

export function shouldShowDonationPrompt({
    nowMs,
    promptState,
    supportPrompt,
    donationAllowed,
}: DonationPromptInput): boolean {
    if (!donationAllowed) return false;

    // The install-local record and the synced one describe the same ask; the
    // newest timestamp on either side starts the cooldown.
    const donationLastShownMs = latestTimeMs(promptState?.donation?.lastShownAt, supportPrompt?.lastShownAt);
    let activeDayCount: number;

    if (donationLastShownMs !== null) {
        if (nowMs - donationLastShownMs < DONATION_PROMPT_REPEAT_COOLDOWN_MS) return false;
        activeDayCount = countActiveDaysSinceDay(
            promptState?.activeDayKeys,
            nowMs,
            getPromptLocalDayIndex(donationLastShownMs) + 1,
        );
    } else {
        if (promptState?.donation?.askedEver === true) return false;

        const firstSeenDayCount = daysSinceFirstSeen(promptState, nowMs);
        if (firstSeenDayCount === null || firstSeenDayCount < DONATION_PROMPT_MIN_DAYS_SINCE_FIRST_SEEN) {
            return false;
        }

        activeDayCount = countActiveDaysThroughNow(promptState?.activeDayKeys, nowMs);
    }

    if (activeDayCount < DONATION_PROMPT_MIN_ACTIVE_DAYS) return false;

    return isCooldownElapsed(
        promptState?.lastInterruptivePromptAt,
        nowMs,
        PROMPT_COORDINATOR_COOLDOWN_MS,
    );
}

export function recordDonationPromptShown(
    promptState: UserPromptState | null | undefined,
    nowMs: number,
): UserPromptState {
    const nowIso = new Date(nowMs).toISOString();
    return {
        ...(promptState ?? {}),
        lastInterruptivePromptAt: nowIso,
        donation: {
            ...(promptState?.donation ?? {}),
            askedEver: true,
            lastShownAt: nowIso,
        },
    };
}

export function withSupportPromptShown(
    current: SupportPromptSettings | null | undefined,
    nowMs: number,
): SupportPromptSettings {
    return { ...(current ?? {}), lastShownAt: new Date(nowMs).toISOString() };
}

export function shouldCheckUpdateReminder({
    nowMs,
    promptState,
    updateReminderAllowed,
}: UpdateReminderCheckInput): boolean {
    if (!updateReminderAllowed) return false;
    return isCooldownElapsed(
        promptState?.update?.lastCheckedAt,
        nowMs,
        UPDATE_REMINDER_CHECK_INTERVAL_MS,
    );
}

export function recordUpdateReminderChecked(
    promptState: UserPromptState | null | undefined,
    nowMs: number,
): UserPromptState {
    return {
        ...(promptState ?? {}),
        update: {
            ...(promptState?.update ?? {}),
            lastCheckedAt: new Date(nowMs).toISOString(),
        },
    };
}

export function shouldShowUpdateReminder({
    nowMs,
    promptState,
    updateReminderAllowed,
    currentVersion,
    latestVersion,
    latestReleasedAt,
}: UpdateReminderPromptInput): boolean {
    if (!updateReminderAllowed) return false;
    if (!isMeaningfullyBehindUpdate(currentVersion, latestVersion, latestReleasedAt, nowMs)) return false;

    const dismissedVersion = promptState?.update?.dismissedVersion;
    if (dismissedVersion && comparePromptVersions(dismissedVersion, latestVersion) >= 0) return false;

    const firstSeenDayCount = daysSinceFirstSeen(promptState, nowMs);
    if (firstSeenDayCount === null || firstSeenDayCount < UPDATE_REMINDER_MIN_DAYS_SINCE_FIRST_SEEN) {
        return false;
    }

    const activeDayCount = countActiveDaysThroughNow(promptState?.activeDayKeys, nowMs);
    if (activeDayCount < UPDATE_REMINDER_MIN_ACTIVE_DAYS) return false;

    return isCooldownElapsed(
        promptState?.lastInterruptivePromptAt,
        nowMs,
        PROMPT_COORDINATOR_COOLDOWN_MS,
    );
}

export function recordUpdateReminderShown(
    promptState: UserPromptState | null | undefined,
    nowMs: number,
): UserPromptState {
    const nowIso = new Date(nowMs).toISOString();
    return {
        ...(promptState ?? {}),
        lastInterruptivePromptAt: nowIso,
        update: {
            ...(promptState?.update ?? {}),
            lastShownAt: nowIso,
        },
    };
}

export function recordUpdateReminderDismissed(
    promptState: UserPromptState | null | undefined,
    latestVersion: string,
): UserPromptState {
    return {
        ...(promptState ?? {}),
        update: {
            ...(promptState?.update ?? {}),
            dismissedVersion: latestVersion.trim(),
        },
    };
}

// ---- The prompt state the mobile apps keep on the device (RN's AsyncStorage) ----

/** The device's prompt state: first seen, active days, the store review's and the other prompts' last times. */
export const LOCAL_USER_PROMPT_STATE_KEY = 'mindwtr:local-user-prompts:v1';

type PromptStorage = {
    getItem: (key: string) => Promise<string | null>;
    setItem: (key: string, value: string) => Promise<void>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export async function readLocalUserPromptState(storage: PromptStorage): Promise<UserPromptState> {
    const raw = await storage.getItem(LOCAL_USER_PROMPT_STATE_KEY);
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw);
        return isRecord(parsed) ? parsed as UserPromptState : {};
    } catch {
        return {};
    }
}

export async function writeLocalUserPromptState(storage: PromptStorage, promptState: UserPromptState): Promise<void> {
    await storage.setItem(LOCAL_USER_PROMPT_STATE_KEY, JSON.stringify(promptState));
}

export async function updateLocalUserPromptState(
    storage: PromptStorage,
    updater: (promptState: UserPromptState) => UserPromptState,
): Promise<UserPromptState> {
    const current = await readLocalUserPromptState(storage);
    const next = updater(current);
    await writeLocalUserPromptState(storage, next);
    return next;
}

/** Today counts as an active day (at first paint). */
export async function recordLocalPromptActivity(storage: PromptStorage, nowMs = Date.now()): Promise<UserPromptState> {
    return updateLocalUserPromptState(storage, (promptState) => recordPromptActivity(promptState, nowMs));
}

/**
 * After a positive moment (a finished Weekly Review): whether to ask the store for its review sheet now. A build that may ask
 * (`buildEligible`: a store build) asks when the store has a review action and the prompt state passes the gate; the attempt
 * is stored before the host asks, so a sheet the store never shows still starts the cooldown.
 */
export async function attemptStoreReviewAfterPositiveMoment(input: {
    buildEligible: boolean;
    platform: UserPromptPlatform;
    storage: PromptStorage;
    hasNativeReviewAction: () => Promise<boolean>;
    nowMs: number;
}): Promise<boolean> {
    if (!input.buildEligible) return false;

    const [promptState, storeReviewAvailable] = await Promise.all([
        readLocalUserPromptState(input.storage),
        input.hasNativeReviewAction(),
    ]);

    if (!shouldAttemptStoreReviewPrompt({
        nowMs: input.nowMs,
        platform: input.platform,
        promptState,
        storeReviewAvailable,
    })) {
        return false;
    }

    await updateLocalUserPromptState(input.storage, (current) => recordStoreReviewPromptAttempt(current, input.nowMs));
    return true;
}
