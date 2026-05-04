import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { BEARER_TOKEN_PATTERN, logWarn } from './server-config';

export function getToken(req: Request): string | null {
    const auth = req.headers.get('authorization') || '';
    const match = auth.match(/^Bearer\s+(.+)$/i);
    if (!match) return null;
    const token = match[1].trim();
    if (!BEARER_TOKEN_PATTERN.test(token)) return null;
    return token;
}

export function tokenToKey(token: string): string {
    return createHash('sha256').update(token).digest('hex');
}

function normalizeProxyIp(value: string | null | undefined): string | null {
    const trimmed = String(value || '').trim();
    if (!trimmed || trimmed.toLowerCase() === 'unknown') return null;
    return trimmed.startsWith('::ffff:') ? trimmed.slice('::ffff:'.length) : trimmed;
}

export function parseTrustedProxyIps(rawValue?: string): Set<string> {
    return new Set(
        String(rawValue || '')
            .split(',')
            .map((item) => normalizeProxyIp(item))
            .filter((item): item is string => Boolean(item))
    );
}

type ClientIpOptions = boolean | {
    trustProxyHeaders?: boolean;
    requestIpAddress?: string | null;
    trustedProxyIps?: Set<string> | null;
};

const normalizeClientIpOptions = (options: ClientIpOptions) => (
    typeof options === 'boolean'
        ? { trustProxyHeaders: options, requestIpAddress: null, trustedProxyIps: null }
        : {
            trustProxyHeaders: options.trustProxyHeaders ?? false,
            requestIpAddress: options.requestIpAddress ?? null,
            trustedProxyIps: options.trustedProxyIps ?? null,
        }
);

export function getClientIp(req: Request, options: ClientIpOptions = false): string {
    const normalizedOptions = normalizeClientIpOptions(options);
    const trustProxyHeaders = normalizedOptions.trustProxyHeaders;
    if (!trustProxyHeaders) return 'unknown';
    const trustedProxyIps = normalizedOptions.trustedProxyIps;
    const requestIpAddress = normalizeProxyIp(normalizedOptions.requestIpAddress);
    if (!trustedProxyIps || trustedProxyIps.size === 0 || !requestIpAddress || !trustedProxyIps.has(requestIpAddress)) {
        return 'unknown';
    }
    const forwarded = req.headers.get('x-forwarded-for');
    if (forwarded) {
        const first = normalizeProxyIp(forwarded.split(',')[0]);
        if (first) return first;
    }
    const cfIp = normalizeProxyIp(req.headers.get('cf-connecting-ip'));
    if (cfIp) return cfIp;
    const realIp = normalizeProxyIp(req.headers.get('x-real-ip'));
    if (realIp) return realIp;
    return 'unknown';
}

function normalizeRateLimitIdentity(value: string | null | undefined): string | null {
    const normalized = String(value || '').trim();
    if (!normalized || normalized.toLowerCase() === 'unknown') return null;
    return normalized;
}

export function getAuthFailureRateKey(
    req: Request,
    options: {
        trustProxyHeaders?: boolean;
        trustedProxyIps?: Set<string> | null;
        requestIpAddress?: string | null;
    } = {},
): string {
    const trustedProxyIp = normalizeRateLimitIdentity(getClientIp(req, {
        trustProxyHeaders: options.trustProxyHeaders,
        requestIpAddress: options.requestIpAddress,
        trustedProxyIps: options.trustedProxyIps,
    }));
    if (trustedProxyIp) {
        return `auth-failure:ip:${trustedProxyIp}`;
    }

    const requestIpAddress = normalizeRateLimitIdentity(options.requestIpAddress);
    if (requestIpAddress) {
        return `auth-failure:ip:${requestIpAddress}`;
    }

    return 'auth-failure:ip:unknown';
}

export function getAuthFailureTokenRateKey(options: {
    token?: string | null;
    authHeader?: string | null;
} = {}): string | null {
    const token = normalizeRateLimitIdentity(options.token);
    if (token) {
        return `auth-failure:token:${tokenToKey(token)}`;
    }

    const authHeader = normalizeRateLimitIdentity(options.authHeader);
    if (authHeader) {
        return `auth-failure:header:${tokenToKey(authHeader)}`;
    }

    return null;
}

export function parseAllowedAuthTokens(rawValue?: string): Set<string> | null {
    const tokens = String(rawValue || '')
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
    return tokens.length > 0 ? new Set(tokens) : null;
}

export function parseBoolEnv(value: string | undefined): boolean {
    const normalized = String(value || '').trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function readOptionalEnvFile(env: Record<string, string | undefined>, fileVarName: string): string | null {
    const filePath = String(env[fileVarName] || '').trim();
    if (!filePath) return null;
    try {
        const raw = readFileSync(filePath, 'utf8').trim();
        return raw.length > 0 ? raw : null;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to read ${fileVarName}: ${message}`);
    }
}

export function resolveAllowedAuthTokensFromEnv(env: Record<string, string | undefined>): Set<string> | null {
    const values = [
        env.MINDWTR_CLOUD_AUTH_TOKENS,
        readOptionalEnvFile(env, 'MINDWTR_CLOUD_AUTH_TOKENS_FILE'),
        env.MINDWTR_CLOUD_TOKEN,
        readOptionalEnvFile(env, 'MINDWTR_CLOUD_TOKEN_FILE'),
    ]
        .map((value) => String(value || '').trim())
        .filter((value) => value.length > 0);
    if (values.length === 0) {
        if (parseBoolEnv(env.MINDWTR_CLOUD_ALLOW_ANY_TOKEN)) {
            logWarn('MINDWTR_CLOUD_ALLOW_ANY_TOKEN is enabled. Prefer MINDWTR_CLOUD_AUTH_TOKENS for stronger access control.');
            return null;
        }
        throw new Error(
            'Cloud auth is not configured. Set MINDWTR_CLOUD_AUTH_TOKENS (or legacy MINDWTR_CLOUD_TOKEN), or explicitly set MINDWTR_CLOUD_ALLOW_ANY_TOKEN=true to enable token namespace mode.'
        );
    }
    return parseAllowedAuthTokens(values.join(','));
}

export function isAuthorizedToken(token: string, allowedTokens: Set<string> | null): boolean {
    if (!allowedTokens) return true;
    return allowedTokens.has(token);
}

export function toRateLimitRoute(pathname: string): string {
    if (/^\/v1\/attachments\/.+/.test(pathname)) {
        return '/v1/attachments/:path';
    }
    if (/^\/v1\/tasks\/[^/]+\/(complete|archive)$/.test(pathname)) {
        return '/v1/tasks/:id/:action';
    }
    if (/^\/v1\/tasks\/[^/]+$/.test(pathname)) {
        return '/v1/tasks/:id';
    }
    return pathname;
}
