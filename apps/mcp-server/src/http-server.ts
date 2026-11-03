import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { ValidationError } from './errors.js';
import { parseBooleanFlag, readFlagValue, readStringFlag, type FlagEnv, type FlagMap } from './flags.js';

export const DEFAULT_HTTP_HOST = '127.0.0.1';
export const DEFAULT_HTTP_PORT = 8722;


export const MIN_HTTP_TOKEN_LENGTH = 16;
export const RECOMMENDED_HTTP_TOKEN_LENGTH = 20;
export const MAX_HTTP_BODY_BYTES = 1024 * 1024;

export const AUTH_FAILURE_RATE_MAX = 30;
export const AUTH_FAILURE_WINDOW_MS = 60_000;

const AUTH_FAILURE_MAX_KEYS = 5_000;

export type HttpServerConfig = {
  host: string;
  port: number;
  token: string;

  weakTokenWarning?: string;
};

const parseHttpPort = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new ValidationError(
      `Invalid --http-port/MINDWTR_MCP_HTTP_PORT: "${raw}" (must be an integer between 1 and 65535)`
    );
  }
  return parsed;
};


export const resolveHttpConfig = (flags: FlagMap, env: FlagEnv = process.env): HttpServerConfig | undefined => {
  const explicitHttp = parseBooleanFlag(readFlagValue(flags, 'http') ?? env.MINDWTR_MCP_HTTP, 'http');
  const host = readStringFlag(flags, 'http-host', 'httpHost') ?? env.MINDWTR_MCP_HTTP_HOST;
  const portRaw = readStringFlag(flags, 'http-port', 'httpPort') ?? env.MINDWTR_MCP_HTTP_PORT;
  const token = readStringFlag(flags, 'http-token', 'httpToken') ?? env.MINDWTR_MCP_HTTP_TOKEN;

  const httpEnabled = explicitHttp ?? Boolean(host || portRaw || token);
  if (!httpEnabled) return undefined;

  if (!token || token.length < MIN_HTTP_TOKEN_LENGTH) {
    throw new ValidationError(
      `HTTP mode requires --http-token (or MINDWTR_MCP_HTTP_TOKEN) of at least ${MIN_HTTP_TOKEN_LENGTH} characters. ` +
      'Generate one with: openssl rand -hex 32'
    );
  }

  return {
    host: host || DEFAULT_HTTP_HOST,
    port: parseHttpPort(portRaw) ?? DEFAULT_HTTP_PORT,
    token,
    ...(token.length < RECOMMENDED_HTTP_TOKEN_LENGTH ? {
      weakTokenWarning: `--http-token is ${token.length} characters; ${RECOMMENDED_HTTP_TOKEN_LENGTH}+ is recommended. Generate a stronger one with: openssl rand -hex 32`,
    } : {}),
  };
};


export const isAuthorizedBearerToken = (
  authorizationHeader: string | undefined | null,
  expectedToken: string,
): boolean => {
  if (!authorizationHeader) return false;
  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader);
  if (!match) return false;
  const provided = match[1]!.trim();
  if (!provided) return false;
  const providedDigest = createHash('sha256').update(provided).digest();
  const expectedDigest = createHash('sha256').update(expectedToken).digest();
  return timingSafeEqual(providedDigest, expectedDigest);
};

type BodyReadResult =
  | { status: 'ok'; body: Buffer }
  | { status: 'too-large' }
  | { status: 'error' };

const readRequestBody = (req: IncomingMessage, maxBytes: number): Promise<BodyReadResult> =>
  new Promise((resolveBody) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (result: BodyReadResult) => {
      if (settled) return;
      settled = true;
      resolveBody(result);
    };
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {


        finish({ status: 'too-large' });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish({ status: 'ok', body: Buffer.concat(chunks) }));
    req.on('error', () => finish({ status: 'error' }));


    req.on('close', () => finish({ status: 'error' }));
  });

const parseJsonBody = (buffer: Buffer): { ok: true; value: unknown } | { ok: false } => {
  if (buffer.length === 0) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(buffer.toString('utf8')) };
  } catch {
    return { ok: false };
  }
};

const sendJson = (res: ServerResponse, status: number, payload: Record<string, unknown>) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
};

export type HttpMcpDeps = {
  createServer: () => McpServer;
  token: string;
  maxBodyBytes?: number;
  logError?: (message: string, error?: unknown) => void;

  host?: string;

  now?: () => number;
};

type AuthFailureWindow = { count: number; resetAt: number };


const createAuthFailureThrottle = (now: () => number) => {
  const windows = new Map<string, AuthFailureWindow>();

  return (keys: string[]): number | null => {
    const nowMs = now();
    let retryAfterSeconds: number | null = null;
    for (const key of keys) {
      const existing = windows.get(key);
      const window = existing && nowMs < existing.resetAt
        ? existing
        : { count: 0, resetAt: nowMs + AUTH_FAILURE_WINDOW_MS };
      window.count += 1;
      if (!windows.has(key) && windows.size >= AUTH_FAILURE_MAX_KEYS) {
        for (const [candidate, state] of windows) {
          if (nowMs > state.resetAt) windows.delete(candidate);
        }
        if (windows.size >= AUTH_FAILURE_MAX_KEYS) {
          windows.delete(windows.keys().next().value as string);
        }
      }
      windows.set(key, window);
      if (window.count > AUTH_FAILURE_RATE_MAX) {
        retryAfterSeconds = Math.max(retryAfterSeconds ?? 0, Math.ceil((window.resetAt - nowMs) / 1000));
      }
    }
    return retryAfterSeconds;
  };
};

const digest = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 32);

const authFailureKeys = (req: IncomingMessage): string[] => {
  const address = req.socket.remoteAddress;
  const authHeader = req.headers.authorization;
  const presented = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  return [
    `auth-failure:ip:${address || 'unknown'}`,
    ...(presented ? [`auth-failure:token:${digest(presented)}`] : []),
  ];
};


export const isAllowedOrigin = (origin: string | undefined, host: string): boolean => {
  if (!origin) return true;
  try {
    return new URL(origin).hostname === host;
  } catch {
    return false;
  }
};

const handleMcpPost = async (
  req: IncomingMessage,
  res: ServerResponse,
  deps: Required<HttpMcpDeps>,
  throttle: (keys: string[]) => number | null,
) => {
  const originHeader = req.headers.origin;
  const origin = Array.isArray(originHeader) ? originHeader[0] : originHeader;
  if (!isAllowedOrigin(origin, deps.host)) {
    sendJson(res, 403, { error: 'forbidden_origin' });
    return;
  }

  const authHeader = req.headers.authorization;
  const authHeaderValue = Array.isArray(authHeader) ? authHeader[0] : authHeader;
  if (!isAuthorizedBearerToken(authHeaderValue, deps.token)) {
    const retryAfterSeconds = throttle(authFailureKeys(req));
    if (retryAfterSeconds !== null) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(retryAfterSeconds) });
      res.end(JSON.stringify({ error: 'rate_limit_exceeded', retryAfterSeconds }));
      return;
    }
    res.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }

  const mcpServer = deps.createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    void transport.close().catch(() => {});
    void mcpServer.close().catch(() => {});
  };


  if (res.closed) {
    cleanup();
    return;
  }
  res.on('close', cleanup);

  const bodyResult = await readRequestBody(req, deps.maxBodyBytes);
  if (bodyResult.status === 'too-large') {
    cleanup();
    sendJson(res, 413, { error: 'payload_too_large' });
    return;
  }
  if (bodyResult.status === 'error') {
    cleanup();
    sendJson(res, 400, { error: 'bad_request' });
    return;
  }

  const parsedBody = parseJsonBody(bodyResult.body);
  if (!parsedBody.ok) {
    cleanup();
    sendJson(res, 400, { error: 'invalid_json' });
    return;
  }

  try {
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, parsedBody.value);
  } catch (error) {
    deps.logError('HTTP MCP request failed', error);
    if (!res.headersSent) {
      sendJson(res, 500, { error: 'internal_error' });
    }
    cleanup();
  }
};


export const createHttpRequestListener = (deps: HttpMcpDeps) => {
  const resolvedDeps: Required<HttpMcpDeps> = {
    createServer: deps.createServer,
    token: deps.token,
    maxBodyBytes: deps.maxBodyBytes ?? MAX_HTTP_BODY_BYTES,
    logError: deps.logError ?? (() => {}),
    host: deps.host ?? DEFAULT_HTTP_HOST,
    now: deps.now ?? Date.now,
  };
  const throttle = createAuthFailureThrottle(resolvedDeps.now);

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (url.pathname === '/healthz') {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'text/plain', Allow: 'GET' });
        res.end('method not allowed');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }

    if (url.pathname === '/mcp') {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'POST' });
        res.end(JSON.stringify({ error: 'method_not_allowed' }));
        return;
      }
      await handleMcpPost(req, res, resolvedDeps, throttle);
      return;
    }

    sendJson(res, 404, { error: 'not_found' });
  };
};


export const createMindwtrHttpServer = (deps: HttpMcpDeps): Server => {
  const listener = createHttpRequestListener(deps);
  const logError = deps.logError ?? (() => {});
  return createServer((req, res) => {
    void listener(req, res).catch((error) => {
      logError('Unhandled HTTP MCP error', error);
      if (!res.headersSent) {
        sendJson(res, 500, { error: 'internal_error' });
      } else {
        res.end();
      }
    });
  });
};


export const startHttpServer = (server: Server, config: HttpServerConfig): Promise<void> =>
  new Promise((resolveListen, reject) => {
    const onError = (error: unknown) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolveListen();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(config.port, config.host);
  });
