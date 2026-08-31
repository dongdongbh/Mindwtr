import {
    AREA_NAME_MAX_LENGTH,
    LIST_PAGE_MAX_LIMIT,
} from '../../../packages/core/src/shared-api-write-limits';

export type CloudRuntimeEnvironment = Readonly<Record<string, string | undefined>>;

export type CloudRuntimeConfig = Readonly<{
    port: number;
    rateWindowMs: number;
    rateMax: number;
    attachmentRateMax: number;
    maxBodyBytes: number;
    maxAttachmentBytes: number;
    anyTokenMaxNamespaces: number;
    rateCleanupMs: number;
    requestTimeoutMs: number;
    slowRequestMs: number;
    maxTaskTitleLength: number;
    maxTaskQuickAddLength: number;
    maxAreaNameLength: number;
    maxItemsPerCollection: number;
    listDefaultLimit: number;
    listMaxLimit: number;
    rateMaxKeys: number;
    authFailureRateMax: number;
}>;

export type CloudRuntimeConfigOverrides = Partial<Record<
    | 'port'
    | 'rateWindowMs'
    | 'rateMax'
    | 'attachmentRateMax'
    | 'maxBodyBytes'
    | 'maxAttachmentBytes'
    | 'anyTokenMaxNamespaces'
    | 'rateCleanupMs'
    | 'requestTimeoutMs'
    | 'slowRequestMs',
    unknown
>>;

type NumericEnvironmentRule = Readonly<{
    key: string;
    minimum: number;
    maximum?: number;
}>;

const NUMERIC_ENVIRONMENT_RULES = [
    { key: 'PORT', minimum: 0, maximum: 65_535 },
    { key: 'MINDWTR_CLOUD_RATE_WINDOW_MS', minimum: 1 },
    { key: 'MINDWTR_CLOUD_RATE_MAX', minimum: 1 },
    { key: 'MINDWTR_CLOUD_ATTACHMENT_RATE_MAX', minimum: 1 },
    { key: 'MINDWTR_CLOUD_MAX_BODY_BYTES', minimum: 1 },
    { key: 'MINDWTR_CLOUD_MAX_ATTACHMENT_BYTES', minimum: 1 },
    { key: 'MINDWTR_CLOUD_ANY_TOKEN_MAX_NAMESPACES', minimum: 0 },
    { key: 'MINDWTR_CLOUD_RATE_CLEANUP_MS', minimum: 1 },
    { key: 'MINDWTR_CLOUD_REQUEST_TIMEOUT_MS', minimum: 1 },
    { key: 'MINDWTR_CLOUD_SLOW_REQUEST_MS', minimum: 0 },
    { key: 'MINDWTR_CLOUD_MAX_TASK_TITLE_LENGTH', minimum: 1 },
    { key: 'MINDWTR_CLOUD_MAX_TASK_QUICK_ADD_LENGTH', minimum: 1 },
    { key: 'MINDWTR_CLOUD_MAX_AREA_NAME_LENGTH', minimum: 1 },
    { key: 'MINDWTR_CLOUD_MAX_ITEMS_PER_COLLECTION', minimum: 1 },
    { key: 'MINDWTR_CLOUD_LIST_DEFAULT_LIMIT', minimum: 1 },
    { key: 'MINDWTR_CLOUD_LIST_MAX_LIMIT', minimum: 1 },
    { key: 'MINDWTR_CLOUD_RATE_MAX_KEYS', minimum: 1 },
    { key: 'MINDWTR_CLOUD_AUTH_FAILURE_RATE_MAX', minimum: 1 },
] as const satisfies readonly NumericEnvironmentRule[];

export const CLOUD_NUMERIC_ENVIRONMENT_KEYS = Object.freeze(
    NUMERIC_ENVIRONMENT_RULES.map((rule) => rule.key),
);

const parseInteger = (
    rawValue: unknown,
    label: string,
    minimum: number,
    maximum = Number.MAX_SAFE_INTEGER,
): number => {
    const value = typeof rawValue === 'number'
        ? rawValue
        : typeof rawValue === 'string' && /^\d+$/.test(rawValue.trim())
            ? Number(rawValue.trim())
            : Number.NaN;
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
        const range = maximum === Number.MAX_SAFE_INTEGER
            ? `an integer greater than or equal to ${minimum}`
            : `an integer from ${minimum} through ${maximum}`;
        throw new Error(`Invalid ${label}: expected ${range}.`);
    }
    return value;
};

const validateNumericEnvironment = (env: CloudRuntimeEnvironment): void => {
    for (const rule of NUMERIC_ENVIRONMENT_RULES) {
        const rawValue = env[rule.key];
        if (rawValue === undefined) continue;
        parseInteger(
            rawValue,
            rule.key,
            rule.minimum,
            'maximum' in rule ? rule.maximum : undefined,
        );
    }
};

const resolveInteger = (
    env: CloudRuntimeEnvironment,
    overrides: CloudRuntimeConfigOverrides,
    overrideKey: keyof CloudRuntimeConfigOverrides,
    environmentKey: string,
    fallback: number,
    minimum: number,
    maximum?: number,
): number => {
    const override = overrides[overrideKey];
    if (override !== undefined) {
        return parseInteger(override, String(overrideKey), minimum, maximum);
    }
    const environmentValue = env[environmentKey];
    return environmentValue === undefined
        ? fallback
        : parseInteger(environmentValue, environmentKey, minimum, maximum);
};

/**
 * Resolves every public numeric cloud control before startup can construct
 * storage resources or bind a network listener. Environment validation is
 * unconditional, so a programmatic override cannot hide a malformed deployed
 * value that would take effect on a later restart.
 */
export const resolveCloudRuntimeConfig = (
    env: CloudRuntimeEnvironment = process.env,
    overrides: CloudRuntimeConfigOverrides = {},
): CloudRuntimeConfig => {
    validateNumericEnvironment(env);

    const rateMax = resolveInteger(
        env,
        overrides,
        'rateMax',
        'MINDWTR_CLOUD_RATE_MAX',
        120,
        1,
    );

    return Object.freeze({
        port: resolveInteger(env, overrides, 'port', 'PORT', 8787, 0, 65_535),
        rateWindowMs: resolveInteger(
            env,
            overrides,
            'rateWindowMs',
            'MINDWTR_CLOUD_RATE_WINDOW_MS',
            60_000,
            1,
        ),
        rateMax,
        attachmentRateMax: resolveInteger(
            env,
            overrides,
            'attachmentRateMax',
            'MINDWTR_CLOUD_ATTACHMENT_RATE_MAX',
            rateMax,
            1,
        ),
        maxBodyBytes: resolveInteger(
            env,
            overrides,
            'maxBodyBytes',
            'MINDWTR_CLOUD_MAX_BODY_BYTES',
            2_000_000,
            1,
        ),
        maxAttachmentBytes: resolveInteger(
            env,
            overrides,
            'maxAttachmentBytes',
            'MINDWTR_CLOUD_MAX_ATTACHMENT_BYTES',
            50_000_000,
            1,
        ),
        anyTokenMaxNamespaces: resolveInteger(
            env,
            overrides,
            'anyTokenMaxNamespaces',
            'MINDWTR_CLOUD_ANY_TOKEN_MAX_NAMESPACES',
            32,
            0,
        ),
        rateCleanupMs: resolveInteger(
            env,
            overrides,
            'rateCleanupMs',
            'MINDWTR_CLOUD_RATE_CLEANUP_MS',
            60_000,
            1,
        ),
        requestTimeoutMs: resolveInteger(
            env,
            overrides,
            'requestTimeoutMs',
            'MINDWTR_CLOUD_REQUEST_TIMEOUT_MS',
            30_000,
            1,
        ),
        slowRequestMs: resolveInteger(
            env,
            overrides,
            'slowRequestMs',
            'MINDWTR_CLOUD_SLOW_REQUEST_MS',
            1_000,
            0,
        ),
        maxTaskTitleLength: parseInteger(
            env.MINDWTR_CLOUD_MAX_TASK_TITLE_LENGTH ?? 500,
            'MINDWTR_CLOUD_MAX_TASK_TITLE_LENGTH',
            1,
        ),
        maxTaskQuickAddLength: parseInteger(
            env.MINDWTR_CLOUD_MAX_TASK_QUICK_ADD_LENGTH ?? 2_000,
            'MINDWTR_CLOUD_MAX_TASK_QUICK_ADD_LENGTH',
            1,
        ),
        maxAreaNameLength: parseInteger(
            env.MINDWTR_CLOUD_MAX_AREA_NAME_LENGTH ?? AREA_NAME_MAX_LENGTH,
            'MINDWTR_CLOUD_MAX_AREA_NAME_LENGTH',
            1,
        ),
        maxItemsPerCollection: parseInteger(
            env.MINDWTR_CLOUD_MAX_ITEMS_PER_COLLECTION ?? 50_000,
            'MINDWTR_CLOUD_MAX_ITEMS_PER_COLLECTION',
            1,
        ),
        listDefaultLimit: parseInteger(
            env.MINDWTR_CLOUD_LIST_DEFAULT_LIMIT ?? 200,
            'MINDWTR_CLOUD_LIST_DEFAULT_LIMIT',
            1,
        ),
        listMaxLimit: parseInteger(
            env.MINDWTR_CLOUD_LIST_MAX_LIMIT ?? LIST_PAGE_MAX_LIMIT,
            'MINDWTR_CLOUD_LIST_MAX_LIMIT',
            1,
        ),
        rateMaxKeys: parseInteger(
            env.MINDWTR_CLOUD_RATE_MAX_KEYS ?? 10_000,
            'MINDWTR_CLOUD_RATE_MAX_KEYS',
            1,
        ),
        authFailureRateMax: parseInteger(
            env.MINDWTR_CLOUD_AUTH_FAILURE_RATE_MAX ?? 30,
            'MINDWTR_CLOUD_AUTH_FAILURE_RATE_MAX',
            1,
        ),
    });
};
