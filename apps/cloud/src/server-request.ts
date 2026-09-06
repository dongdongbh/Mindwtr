import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import {
    getToken,
    isAuthorizedToken,
    tokenToKey,
    toRateLimitRoute,
    type AllowedAuthTokens,
} from './server-auth';
import { lookupCaptureToken, type TokenScope } from './server-capture-tokens';
import { errorResponse } from './server-config';
import type { RateLimiter } from './server-rate-limit';

const TOKEN_NAMESPACE_FILE_PATTERN = /^([a-f0-9]{64})\.json$/;
const TOKEN_NAMESPACE_DIR_PATTERN = /^[a-f0-9]{64}$/;

function namespaceExists(dataDir: string, key: string): boolean {
    return existsSync(join(dataDir, `${key}.json`)) || existsSync(join(dataDir, key));
}

function countTokenNamespaces(dataDir: string): number {
    const namespaces = new Set<string>();
    for (const entry of readdirSync(dataDir, { withFileTypes: true })) {
        if (entry.isFile()) {
            const match = entry.name.match(TOKEN_NAMESPACE_FILE_PATTERN);
            if (match?.[1]) namespaces.add(match[1]);
        } else if (entry.isDirectory() && TOKEN_NAMESPACE_DIR_PATTERN.test(entry.name)) {
            namespaces.add(entry.name);
        }
    }
    return namespaces.size;
}

export type ServerConfig = {
    allowedAuthTokens: AllowedAuthTokens | null;
    dataDir: string;
    maxAnyTokenNamespaces: number;
    rateLimiter: RateLimiter;
    maxPerWindow: number;
    unauthorizedResponse: (req: Request, token?: string | null) => Response;
    /**
     * Reserves a new namespace while admission is locked. Routes that cannot
     * create a namespace may deliberately provide a no-op.
     */
    initializeNamespace: (filePath: string) => Promise<void> | void;
    runWithNamespaceAdmission: <T>(handler: () => Promise<T>, signal?: AbortSignal) => Promise<T>;
    /**
     * Which HTTP methods on this route must pass the namespace write cap before the
     * handler runs. Defaults to every method except GET/HEAD (i.e. every write).
     * Override only when a route's writes are known not to create a new namespace
     * (see /v1/attachments/:path DELETE, which never mutates without an existing file).
     */
    guardMethods?: (method: string) => boolean;
    /**
     * Set only on POST /v1/capture: a capture-only token (#1178) authenticates
     * there as its owner's namespace and is refused with 403 on every other route.
     */
    acceptsCaptureTokens?: boolean;
};

const defaultGuardMethods = (method: string): boolean => method !== 'GET' && method !== 'HEAD';

/** Strips a trailing slash the same way for every route; the one normalization both server.ts's dispatch and withNamespace's rate-limit key must agree on. */
export function normalizeRequestPathname(url: URL): string {
    return url.pathname.replace(/\/+$/, '') || '/';
}

/**
 * The namespace write cap: in "any token" mode (no allowlist configured), a token
 * that hasn't written data yet may only do so while the server is under
 * maxAnyTokenNamespaces total namespaces. Exported so admission can recheck the
 * cap after acquiring the process-safe global lock.
 */
export function ensureNamespaceWriteAllowed(cfg: Pick<ServerConfig, 'allowedAuthTokens' | 'dataDir' | 'maxAnyTokenNamespaces'>, key: string): Response | null {
    if (cfg.allowedAuthTokens) return null;
    if (namespaceExists(cfg.dataDir, key)) return null;
    if (cfg.maxAnyTokenNamespaces <= 0) {
        return errorResponse('Token namespace creation is disabled', 403);
    }
    if (countTokenNamespaces(cfg.dataDir) >= cfg.maxAnyTokenNamespaces) {
        return errorResponse('Token namespace limit reached', 403);
    }
    return null;
}

/**
 * The auth + rate-limit + namespace-cap preamble every namespaced route needs, in
 * one place so a new write route can't skip the namespace guard by omission (the
 * bug this replaces: /v1/attachments/orphans copied the preamble by hand and
 * dropped the guard). `handler` runs only once all checks pass; its return value
 * is passed straight through. Returns Response | null to leave room for a future
 * caller that wants "not my route" fall-through semantics; none of today's callers
 * use it.
 */
export async function withNamespace(
    req: Request,
    url: URL,
    cfg: ServerConfig,
    handler: (ctx: { key: string; filePath: string; scope: TokenScope }) => Promise<Response | null>,
    signal?: AbortSignal,
): Promise<Response | null> {
    const token = getToken(req);
    if (!token) return cfg.unauthorizedResponse(req);
    let key: string;
    let scope: TokenScope;
    const captureToken = lookupCaptureToken(cfg.dataDir, token);
    if (captureToken) {
        if (!cfg.acceptsCaptureTokens || req.method !== 'POST') return errorResponse('Capture-only token', 403);
        // A capture token lives only as long as its owner's full token is allowlisted...
        if (cfg.allowedAuthTokens && !cfg.allowedAuthTokens.keys.has(captureToken.namespaceKey)) {
            return cfg.unauthorizedResponse(req, token);
        }
        // ...and its namespace exists: it must never create one or pass admission.
        if (!namespaceExists(cfg.dataDir, captureToken.namespaceKey)) return errorResponse('Capture token namespace missing', 403);
        key = captureToken.namespaceKey;
        scope = 'capture';
    } else {
        if (!isAuthorizedToken(token, cfg.allowedAuthTokens)) return cfg.unauthorizedResponse(req, token);
        key = tokenToKey(token);
        scope = 'full';
    }
    const pathname = normalizeRequestPathname(url);
    const rateKey = `${key}:${req.method}:${toRateLimitRoute(pathname)}`;
    const rateLimitResponse = cfg.rateLimiter.check(rateKey, cfg.maxPerWindow);
    if (rateLimitResponse) return rateLimitResponse;
    const guardMethods = cfg.guardMethods ?? defaultGuardMethods;
    if (scope === 'full' && guardMethods(req.method)) {
        if (!cfg.allowedAuthTokens && !namespaceExists(cfg.dataDir, key)) {
            const admissionResponse = await cfg.runWithNamespaceAdmission(async (): Promise<Response | null> => {
                // Recheck after taking the process-safe global lock. Write routes
                // reserve a valid empty document here, keeping the lock window short:
                // untrusted request bodies are read and validated after admission.
                const namespaceResponse = ensureNamespaceWriteAllowed(cfg, key);
                if (namespaceResponse) return namespaceResponse;
                const filePath = join(cfg.dataDir, `${key}.json`);
                if (!namespaceExists(cfg.dataDir, key)) {
                    await cfg.initializeNamespace(filePath);
                }
                return null;
            }, signal);
            if (admissionResponse) return admissionResponse;
        } else {
            const namespaceResponse = ensureNamespaceWriteAllowed(cfg, key);
            if (namespaceResponse) return namespaceResponse;
        }
    }
    const filePath = join(cfg.dataDir, `${key}.json`);
    return handler({ key, filePath, scope });
}
