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

export function getClientIp(req: Request, trustProxyHeaders = false): string {
    if (!trustProxyHeaders) return 'unknown';
    const forwarded = req.headers.get('x-forwarded-for');
    if (forwarded) {
        const first = forwarded.split(',')[0]?.trim();
        if (first) return first;
    }
    const cfIp = req.headers.get('cf-connecting-ip')?.trim();
    if (cfIp) return cfIp;
    const realIp = req.headers.get('x-real-ip')?.trim();
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
        requestIpAddress?: string | null;
        token?: string | null;
        authHeader?: string | null;
    } = {},
): string {
    const trustedProxyIp = normalizeRateLimitIdentity(getClientIp(req, options.trustProxyHeaders));
    if (trustedProxyIp) {
        return `auth-failure:ip:${trustedProxyIp}`;
    }

    const requestIpAddress = normalizeRateLimitIdentity(options.requestIpAddress);
    if (requestIpAddress) {
        return `auth-failure:ip:${requestIpAddress}`;
    }

    const token = normalizeRateLimitIdentity(options.token);
    if (token) {
        return `auth-failure:token:${tokenToKey(token)}`;
    }

    const authHeader = normalizeRateLimitIdentity(options.authHeader);
    if (authHeader) {
        return `auth-failure:header:${tokenToKey(authHeader)}`;
    }

    return 'auth-failure:unknown';
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

export function resolveAllowedAuthTokensFromEnv(env: Record<string, string | undefined>): Set<string> | null {
    const values = [
        env.MINDWTR_CLOUD_AUTH_TOKENS,
        env.MINDWTR_CLOUD_TOKEN,
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
