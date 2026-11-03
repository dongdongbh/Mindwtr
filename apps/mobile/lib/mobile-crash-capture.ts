import { sanitizeForLog } from '@mindwtr/core';

export const LOCAL_FATAL_CRASH_MAX_BYTES = 16 * 1024;

const CRASH_DIRECTORY_NAME = 'logs';
const CRASH_FILE_NAME = 'mindwtr-fatal-js-crash.json';
const MAX_MESSAGE_CHARS = 320;
const MAX_STACK_SOURCE_CHARS = 32_768;
const MAX_STACK_FRAMES = 16;
const MAX_FRAME_CHARS = 360;
const MAX_METADATA_CHARS = 64;
const STANDARD_EXCEPTION_NAMES = new Set([
  'AggregateError',
  'Error',
  'EvalError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TypeError',
  'URIError',
]);

export type LocalFatalCrashMetadata = {
  appVersion?: string;
  buildVersion?: string;
  platform?: string;
};

export type RetainedFatalCrashEntry = {
  ts: string;
  level: 'error';
  scope: 'fatal-recovery';
  message: string;
  stack?: string;
  context: {
    platform: string;
    appVersion?: string;
    buildVersion?: string;
    exceptionType: string;
  };
};

export type RetainedFatalCrashSnapshot = {
  entry: RetainedFatalCrashEntry;
  identity: string;
};

export type LocalFatalCrashCapture = {
  capture: (error: unknown) => void;
  clear: () => void;
  clearIfUnchanged: (identity: string) => boolean;
  getPath: () => string | null;
  read: () => RetainedFatalCrashEntry | null;
  readSnapshot: () => RetainedFatalCrashSnapshot | null;
  readText: () => string | null;
};

export type LocalFatalCrashStorage = {
  clearTextSync: () => void;
  getPath: () => string | null;
  readTextSync: () => string | null;
  writeTextSync: (value: string) => void;
};

type ExpoDirectory = {
  create: (options?: { idempotent?: boolean; intermediates?: boolean }) => void;
  delete?: () => void;
  exists: boolean;
  uri: string;
};

type ExpoFile = {
  delete: () => void;
  exists: boolean;
  textSync: () => string;
  uri: string;
  write: (value: string) => void;
};

type ExpoFileSystemModule = {
  Directory: new (...uris: (string | ExpoDirectory)[]) => ExpoDirectory;
  File: new (...uris: (string | ExpoDirectory)[]) => ExpoFile;
  Paths: { document?: { uri?: string } };
};

type Sanitizer = (value: unknown) => string;

const utf8ByteLength = (value: string): number => {
  try {
    return new TextEncoder().encode(value).byteLength;
  } catch {


    return value.length * 4;
  }
};

const boundedUtf16Prefix = (value: string, maxCodeUnits: number): string => {
  const limit = Math.max(0, Math.min(value.length, Math.floor(maxCodeUnits)));
  if (limit === value.length) return value;
  let end = limit;
  if (end > 0) {
    const lastCodeUnit = value.charCodeAt(end - 1);
    if (lastCodeUnit >= 0xD800 && lastCodeUnit <= 0xDBFF) end -= 1;
  }
  return value.slice(0, end);
};

const readStringProperty = (value: unknown, property: 'message' | 'name' | 'stack'): string | undefined => {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return undefined;
  try {
    const candidate = (value as Record<string, unknown>)[property];
    return typeof candidate === 'string' ? candidate : undefined;
  } catch {
    return undefined;
  }
};

const safeSanitize = (value: string, sanitizer: Sanitizer): string | undefined => {
  try {
    const sanitized = sanitizer(value);
    return typeof sanitized === 'string' ? sanitized : undefined;
  } catch {
    return undefined;
  }
};

const sanitizeMetadataValue = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  const bounded = boundedUtf16Prefix(value, MAX_METADATA_CHARS);
  return /^[A-Za-z0-9._+()-]+$/.test(bounded) ? bounded : undefined;
};

const technicalExceptionType = (error: unknown): string => {
  const rawName = readStringProperty(error, 'name');
  if (rawName && rawName.length <= 32 && STANDARD_EXCEPTION_NAMES.has(rawName)) {
    return rawName;
  }
  try {
    return error instanceof Error ? 'Error' : 'UnknownException';
  } catch {
    return 'UnknownException';
  }
};

const technicalMessage = (error: unknown, sanitizer: Sanitizer): string | undefined => {
  let raw = readStringProperty(error, 'message');
  if (!raw && typeof error === 'string') raw = error;
  if (!raw) return undefined;
  const message = boundedUtf16Prefix(raw, 2_000).replace(/[\r\n\t]+/g, ' ').trim();
  let shaped: string | undefined;
  const minifiedReactMatch = message.match(/^Minified React error #(\d{1,9})(?:\D|$)/i);

  if (/^Cannot read propert(?:y|ies) of (?:undefined|null)/i.test(message)) {
    const target = /undefined/i.test(message) ? 'undefined' : 'null';
    shaped = `Cannot read properties of ${target} (property omitted)`;
  } else if (/^Cannot set propert(?:y|ies) of (?:undefined|null)/i.test(message)) {
    const target = /undefined/i.test(message) ? 'undefined' : 'null';
    shaped = `Cannot set properties of ${target} (property omitted)`;
  } else if (/^(?:undefined|null) is not an object/i.test(message)) {
    shaped = `${message.toLowerCase().startsWith('null') ? 'null' : 'undefined'} is not an object (expression omitted)`;
  } else if (/\bis not a function(?:\b|$)/i.test(message)) {
    shaped = 'Expression is not a function';
  } else if (/^Cannot access .+ before initialization$/i.test(message)) {
    shaped = 'Cannot access identifier before initialization';
  } else if (/^.+ is not defined$/i.test(message)) {
    shaped = 'Identifier is not defined';
  } else if (/^Cannot convert undefined or null to object$/i.test(message)) {
    shaped = 'Cannot convert undefined or null to object';
  } else if (/^Maximum call stack size exceeded$/i.test(message)) {
    shaped = 'Maximum call stack size exceeded';
  } else if (/^Too many re-renders/i.test(message)) {
    shaped = 'Too many React re-renders';
  } else if (/^Rendered (?:more|fewer) hooks than expected/i.test(message)) {
    shaped = message.toLowerCase().includes('more')
      ? 'Rendered more hooks than expected'
      : 'Rendered fewer hooks than expected';
  } else if (/^Invalid hook call/i.test(message)) {
    shaped = 'Invalid React hook call';
  } else if (minifiedReactMatch) {
    shaped = `Minified React error #${minifiedReactMatch[1]}`;
  } else if (/^Element type is invalid/i.test(message)) {
    shaped = 'React element type is invalid';
  } else if (/^Objects are not valid as a React child/i.test(message)) {
    shaped = 'Object is not valid as a React child';
  } else if (/^(?:JSON Parse error|Unexpected (?:token|end of JSON input))/i.test(message)) {
    shaped = 'JSON parse error';
  } else if (/^Network request failed$/i.test(message)) {
    shaped = 'Network request failed';
  } else if (/^(?:Out of memory|JavaScript heap out of memory)$/i.test(message)) {
    shaped = 'JavaScript out of memory';
  }

  if (!shaped) return undefined;
  return safeSanitize(boundedUtf16Prefix(shaped, MAX_MESSAGE_CHARS), sanitizer);
};

const safeFunctionName = (raw: string): string => {
  const candidate = raw
    .replace(/^\s*at\s+/, '')
    .replace(/\s*\($/, '')
    .replace(/@$/, '')
    .trim();
  if (!candidate) return '<anonymous>';
  if (candidate.length > 120) return '<anonymous>';
  if (/^(?:<anonymous>|anonymous|global|global code|native)$/i.test(candidate)) return candidate;
  if (/^(?:(?:async|new)\s+)?[A-Za-z_$][A-Za-z0-9_$]*(?:[.][A-Za-z_$<>][A-Za-z0-9_$<>]*|\[as [A-Za-z_$][A-Za-z0-9_$]*\])*$/.test(candidate)) {
    return candidate;
  }
  return '<anonymous>';
};

const safeSourceName = (raw: string): string | undefined => {
  const withoutPrefix = raw.replace(/^address at\s+/i, '').replace(/[)?]+$/, '');
  const withoutQuery = withoutPrefix.split(/[?#]/, 1)[0];
  const source = withoutQuery.split(/[\\/]/).pop()?.trim();
  if (!source) return undefined;
  if (/^index(?:\.(?:android|ios))?\.bundle$/i.test(source)) return source;
  if (/^[A-Za-z0-9_.-]{1,100}\.(?:js|jsx|ts|tsx)$/i.test(source)) return source;
  return undefined;
};

const technicalStack = (error: unknown, sanitizer: Sanitizer): string | undefined => {
  const rawStack = readStringProperty(error, 'stack');
  if (!rawStack) return undefined;

  const rawLines = boundedUtf16Prefix(rawStack, MAX_STACK_SOURCE_CHARS).split(/\r?\n/).slice(1);
  const frames: string[] = [];

  for (const rawLine of rawLines) {
    if (frames.length >= MAX_STACK_FRAMES) break;
    const line = boundedUtf16Prefix(rawLine, 1_000).trim();
    const locationMatch = line.match(/^(.*?)([^\s()].*):(\d{1,9}):(\d{1,9})\)?$/);
    if (!locationMatch) continue;
    const beforeLocation = locationMatch[1].trim();
    const sourceAndMaybeFunction = locationMatch[2].trim();
    let functionPart = beforeLocation;
    let sourcePart = sourceAndMaybeFunction;

    const parenthesisIndex = sourceAndMaybeFunction.lastIndexOf('(');
    if (parenthesisIndex >= 0) {
      functionPart = `${beforeLocation} ${sourceAndMaybeFunction.slice(0, parenthesisIndex)}`.trim();
      sourcePart = sourceAndMaybeFunction.slice(parenthesisIndex + 1);
    } else {
      const atIndex = sourceAndMaybeFunction.lastIndexOf('@');
      if (atIndex >= 0) {
        functionPart = `${beforeLocation} ${sourceAndMaybeFunction.slice(0, atIndex)}`.trim();
        sourcePart = sourceAndMaybeFunction.slice(atIndex + 1);
      }
    }

    const source = safeSourceName(sourcePart);
    if (!source) continue;
    const frame = `at ${safeFunctionName(functionPart)} (${source}:${locationMatch[3]}:${locationMatch[4]})`;
    const sanitized = safeSanitize(boundedUtf16Prefix(frame, MAX_FRAME_CHARS), sanitizer);
    if (sanitized) frames.push(sanitized);
  }

  return frames.length > 0 ? frames.join('\n') : undefined;
};

const safeTimestamp = (now: () => Date): string => {
  try {
    const timestamp = now().toISOString();
    return Number.isFinite(Date.parse(timestamp)) ? timestamp : new Date(0).toISOString();
  } catch {
    return new Date(0).toISOString();
  }
};

const buildEntry = (
  error: unknown,
  metadata: LocalFatalCrashMetadata,
  sanitizer: Sanitizer,
  now: () => Date,
): RetainedFatalCrashEntry => {
  const message = technicalMessage(error, sanitizer) ?? 'Fatal JavaScript error (message omitted for privacy)';
  const stack = technicalStack(error, sanitizer);
  const appVersion = sanitizeMetadataValue(metadata.appVersion);
  const buildVersion = sanitizeMetadataValue(metadata.buildVersion);
  const platform = sanitizeMetadataValue(metadata.platform) ?? 'unknown';
  return {
    ts: safeTimestamp(now),
    level: 'error',
    scope: 'fatal-recovery',
    message,
    ...(stack ? { stack } : {}),
    context: {
      platform,
      ...(appVersion ? { appVersion } : {}),
      ...(buildVersion ? { buildVersion } : {}),
      exceptionType: technicalExceptionType(error),
    },
  };
};

const serializeBoundedEntry = (entry: RetainedFatalCrashEntry): string => {
  const bounded: RetainedFatalCrashEntry = {
    ...entry,
    ...(entry.stack ? { stack: entry.stack } : {}),
  };
  let serialized = `${JSON.stringify(bounded)}\n`;
  while (utf8ByteLength(serialized) > LOCAL_FATAL_CRASH_MAX_BYTES && bounded.stack) {
    const frames = bounded.stack.split('\n');
    frames.pop();
    if (frames.length > 0) bounded.stack = frames.join('\n');
    else delete bounded.stack;
    serialized = `${JSON.stringify(bounded)}\n`;
  }
  if (utf8ByteLength(serialized) <= LOCAL_FATAL_CRASH_MAX_BYTES) return serialized;

  bounded.message = 'Fatal JavaScript error (details omitted for size)';
  delete bounded.stack;
  serialized = `${JSON.stringify(bounded)}\n`;
  return utf8ByteLength(serialized) <= LOCAL_FATAL_CRASH_MAX_BYTES
    ? serialized
    : `${JSON.stringify({
      ts: bounded.ts,
      level: 'error',
      scope: 'fatal-recovery',
      message: 'Fatal JavaScript error',
      context: {
        platform: 'unknown',
        exceptionType: 'UnknownException',
      },
    } satisfies RetainedFatalCrashEntry)}\n`;
};

const PERMITTED_FIXED_MESSAGES = new Set([
  'Cannot access identifier before initialization',
  'Cannot convert undefined or null to object',
  'Cannot read properties of null (property omitted)',
  'Cannot read properties of undefined (property omitted)',
  'Cannot set properties of null (property omitted)',
  'Cannot set properties of undefined (property omitted)',
  'Expression is not a function',
  'Fatal JavaScript error',
  'Fatal JavaScript error (details omitted for size)',
  'Fatal JavaScript error (message omitted for privacy)',
  'Identifier is not defined',
  'Invalid React hook call',
  'JSON parse error',
  'JavaScript out of memory',
  'Maximum call stack size exceeded',
  'Network request failed',
  'Object is not valid as a React child',
  'React element type is invalid',
  'Rendered fewer hooks than expected',
  'Rendered more hooks than expected',
  'Too many React re-renders',
  'null is not an object (expression omitted)',
  'undefined is not an object (expression omitted)',
]);

const canonicalStoredMessage = (value: unknown): string | null => {
  if (typeof value !== 'string' || value.length > MAX_MESSAGE_CHARS) return null;
  if (PERMITTED_FIXED_MESSAGES.has(value)) return value;
  return /^Minified React error #\d{1,9}$/.test(value) ? value : null;
};

const canonicalStoredStack = (value: unknown): string | undefined | null => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > MAX_STACK_FRAMES * (MAX_FRAME_CHARS + 1)) return null;
  const lines = value.split('\n');
  if (lines.length === 0 || lines.length > MAX_STACK_FRAMES) return null;
  const canonical: string[] = [];
  for (const line of lines) {
    const match = line.match(/^at (.{1,160}) \(([A-Za-z0-9_.-]{1,100}\.(?:bundle|js|jsx|ts|tsx)):(\d{1,9}):(\d{1,9})\)$/);
    if (!match) return null;
    const functionName = safeFunctionName(match[1]);
    const source = safeSourceName(match[2]);
    if (functionName !== match[1] || source !== match[2]) return null;
    canonical.push(`at ${functionName} (${source}:${match[3]}:${match[4]})`);
  }
  return canonical.join('\n');
};

const canonicalStoredExceptionType = (value: unknown): string => (
  typeof value === 'string' && value.length <= 32 && STANDARD_EXCEPTION_NAMES.has(value)
    ? value
    : 'UnknownException'
);

const parseRetainedEntry = (raw: string | null): RetainedFatalCrashEntry | null => {
  if (!raw || raw.length > LOCAL_FATAL_CRASH_MAX_BYTES || utf8ByteLength(raw) > LOCAL_FATAL_CRASH_MAX_BYTES) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<RetainedFatalCrashEntry> & Record<string, unknown>;
    const context = parsed.context && typeof parsed.context === 'object' && !Array.isArray(parsed.context)
      ? parsed.context as Record<string, unknown>
      : null;
    const message = canonicalStoredMessage(parsed.message);
    const stack = canonicalStoredStack(parsed.stack);
    if (parsed.level !== 'error'
      || parsed.scope !== 'fatal-recovery'
      || typeof parsed.ts !== 'string'
      || parsed.ts.length > 64
      || !Number.isFinite(Date.parse(parsed.ts))
      || !message
      || stack === null
      || !context
      || typeof context.platform !== 'string') {
      return null;
    }
    const appVersion = sanitizeMetadataValue(typeof context.appVersion === 'string' ? context.appVersion : undefined);
    const buildVersion = sanitizeMetadataValue(typeof context.buildVersion === 'string' ? context.buildVersion : undefined);
    return {
      ts: parsed.ts,
      level: 'error',
      scope: 'fatal-recovery',
      message,
      ...(stack ? { stack } : {}),
      context: {
        platform: sanitizeMetadataValue(context.platform) ?? 'unknown',
        ...(appVersion ? { appVersion } : {}),
        ...(buildVersion ? { buildVersion } : {}),
        exceptionType: canonicalStoredExceptionType(context.exceptionType),
      },
    };
  } catch {
    return null;
  }
};

export function createLocalFatalCrashCapture(
  storage: LocalFatalCrashStorage,
  metadata: LocalFatalCrashMetadata = {},
  options?: { now?: () => Date; sanitize?: Sanitizer },
): LocalFatalCrashCapture {
  const now = options?.now ?? (() => new Date());
  const sanitizer = options?.sanitize ?? sanitizeForLog;
  const readSnapshot = (): RetainedFatalCrashSnapshot | null => {
    const identity = storage.readTextSync();
    const entry = parseRetainedEntry(identity);
    return identity && entry ? { entry, identity } : null;
  };
  return {
    capture(error) {
      const entry = buildEntry(error, metadata, sanitizer, now);
      storage.writeTextSync(serializeBoundedEntry(entry));
    },
    clear() {
      storage.clearTextSync();
    },
    clearIfUnchanged(identity) {
      if (identity.length > LOCAL_FATAL_CRASH_MAX_BYTES) return false;
      const current = storage.readTextSync();
      if (current === null || current.length !== identity.length || current !== identity) return false;
      storage.clearTextSync();
      return true;
    },
    getPath() {
      return storage.getPath();
    },
    read() {
      return readSnapshot()?.entry ?? null;
    },
    readSnapshot,
    readText() {
      const entry = readSnapshot()?.entry;
      return entry ? serializeBoundedEntry(entry) : null;
    },
  };
}

const createExpoCrashStorage = (fileSystem: ExpoFileSystemModule): LocalFatalCrashStorage | null => {
  const documentUri = fileSystem.Paths.document?.uri;
  if (!documentUri) return null;
  const directory = new fileSystem.Directory(documentUri, CRASH_DIRECTORY_NAME);
  const file = new fileSystem.File(directory, CRASH_FILE_NAME);
  return {
    clearTextSync() {
      if (file.exists) file.delete();
    },
    getPath() {
      return file.exists ? file.uri : null;
    },
    readTextSync() {
      return file.exists ? file.textSync() : null;
    },
    writeTextSync(value) {
      if (!directory.exists) directory.create({ intermediates: true, idempotent: true });


      file.write(value);
    },
  };
};

export function createDefaultLocalFatalCrashCapture(
  metadata: LocalFatalCrashMetadata = {},
): LocalFatalCrashCapture | null {
  try {


    const fileSystem = require('expo-file-system') as ExpoFileSystemModule;
    const storage = createExpoCrashStorage(fileSystem);
    return storage ? createLocalFatalCrashCapture(storage, metadata) : null;
  } catch {
    return null;
  }
}
