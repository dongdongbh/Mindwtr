import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import {
    getToken,
    isAuthorizedToken,
    tokenToKey,
    toRateLimitRoute,
    type AllowedAuthTokens,
} from './server-auth';
import { isGeneratedCaptureTokenShape, lookupCaptureToken, type TokenScope } from './server-capture-tokens';
import { errorResponse, logInfo } from './server-config';
import type { RateLimiter } from './server-rate-limit';
import { createRequestAbortError } from './server-storage';

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


    initializeNamespace: (filePath: string) => Promise<void> | void;
    runWithNamespaceAdmission: <T>(handler: () => Promise<T>, signal?: AbortSignal) => Promise<T>;


    guardMethods?: (method: string) => boolean;


    acceptsCaptureTokens?: boolean;


    readBodyBeforeAdmission?: (req: Request, signal: AbortSignal) => Promise<unknown> | undefined;
};

const defaultGuardMethods = (method: string): boolean => method !== 'GET' && method !== 'HEAD';


export function normalizeRequestPathname(url: URL): string {
    return url.pathname.replace(/\/+$/, '') || '/';
}


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


export async function withNamespace(
    req: Request,
    url: URL,
    cfg: ServerConfig,
    handler: (ctx: { key: string; filePath: string; scope: TokenScope; body?: Promise<unknown> }) => Promise<Response | null>,
    signal?: AbortSignal,
): Promise<Response | null> {
    const token = getToken(req);
    if (!token) return cfg.unauthorizedResponse(req);
    let key: string;
    let scope: TokenScope;
    const captureToken = lookupCaptureToken(cfg.dataDir, token);
    if (captureToken) {
        if (!cfg.acceptsCaptureTokens || req.method !== 'POST') return errorResponse('Capture-only token', 403);

        if (cfg.allowedAuthTokens && !cfg.allowedAuthTokens.keys.has(captureToken.namespaceKey)) {
            return cfg.unauthorizedResponse(req, token);
        }

        if (!namespaceExists(cfg.dataDir, captureToken.namespaceKey)) return errorResponse('Capture token namespace missing', 403);
        key = captureToken.namespaceKey;
        scope = 'capture';
    } else {


        if (!cfg.allowedAuthTokens && isGeneratedCaptureTokenShape(token)) {
            logInfo('Unmapped capture credential refused in any-token mode', {
                outcome: 'refused',
                releaseCheck: 'v1.3.1/capture-token-revocation',
            });
            return cfg.unauthorizedResponse(req, token);
        }
        if (!isAuthorizedToken(token, cfg.allowedAuthTokens)) return cfg.unauthorizedResponse(req, token);
        key = tokenToKey(token);
        scope = 'full';
    }
    const pathname = normalizeRequestPathname(url);
    const rateKey = `${key}:${req.method}:${toRateLimitRoute(pathname)}`;
    const rateLimitResponse = cfg.rateLimiter.check(rateKey, cfg.maxPerWindow);
    if (rateLimitResponse) return rateLimitResponse;
    const bodyAbort = new AbortController();
    const body = cfg.readBodyBeforeAdmission?.(
        req,
        signal ? AbortSignal.any([signal, bodyAbort.signal]) : bodyAbort.signal,
    );


    void body?.catch(() => undefined);
    let bodyHandedOff = false;
    try {
        const refusal = await admitNamespaceWrite(cfg, key, scope, req.method, signal);
        if (refusal) return refusal;
        const filePath = join(cfg.dataDir, `${key}.json`);
        bodyHandedOff = true;
        return await handler({ key, filePath, scope, body });
    } finally {
        if (!bodyHandedOff && body) {

            bodyAbort.abort(createRequestAbortError('Request refused before its body was read'));
        }
    }
}

async function admitNamespaceWrite(
    cfg: ServerConfig,
    key: string,
    scope: TokenScope,
    method: string,
    signal?: AbortSignal,
): Promise<Response | null> {
    const guardMethods = cfg.guardMethods ?? defaultGuardMethods;
    if (scope === 'full' && guardMethods(method)) {
        if (!cfg.allowedAuthTokens && !namespaceExists(cfg.dataDir, key)) {
            const admissionResponse = await cfg.runWithNamespaceAdmission(async (): Promise<Response | null> => {


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
    return null;
}
