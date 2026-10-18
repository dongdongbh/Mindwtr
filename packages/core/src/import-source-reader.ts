// Shared file-reading frontend for the third-party importers (OmniFocus, Todoist, TickTick,
// DGT). Every importer used to hand-write its own copy of "sniff bytes -> unzip or decode ->
// sanitize -> split CSV into rows/header index" — this module owns that once. Per-format parse
// logic (what a row/record MEANS) stays in each importer; only the byte/CSV mechanics move here.
import { inflateSync, strFromU8 } from 'fflate';

const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04];

export type ImportSourceLimitCode =
    | 'input-too-large'
    | 'text-too-large'
    | 'archive-entry-too-large'
    | 'archive-expanded-too-large'
    | 'archive-too-many-entries'
    | 'archive-too-many-checklist-items'
    | 'archive-too-many-entities'
    | 'archive-too-many-rows'
    | 'checklist-too-many-items'
    | 'csv-cell-too-large'
    | 'csv-too-many-columns'
    | 'csv-too-many-rows';

export type ImportCsvLimits = {
    maxCellChars: number;
    maxColumns: number;
    maxRows: number;
};

export type ImportSourceLimits = {
    maxArchiveEntries: number;
    maxArchiveEntryBytes: number;
    maxArchiveExpandedBytes: number;
    maxInputBytes: number;
    maxTextBytes: number;
};

export type ImportArchiveBudgetLimits = {
    maxChecklistItems: number;
    maxEntities: number;
    maxRows: number;
};

const MEBIBYTE = 1024 * 1024;

export const DEFAULT_IMPORT_CSV_LIMITS: Readonly<ImportCsvLimits> = {
    maxCellChars: MEBIBYTE,
    maxColumns: 256,
    maxRows: 100_000,
};

export const DEFAULT_IMPORT_CHECKLIST_ITEM_LIMIT = 1_000;

// These are archive-wide ceilings. Per-entry CSV limits still protect the parser, while this
// budget prevents many individually valid entries from multiplying retained records/checklists.
export const DEFAULT_IMPORT_ARCHIVE_BUDGET_LIMITS: Readonly<ImportArchiveBudgetLimits> = {
    maxChecklistItems: 100_000,
    maxEntities: 100_000,
    maxRows: 100_000,
};

export const DEFAULT_IMPORT_SOURCE_LIMITS: Readonly<ImportSourceLimits> = {
    maxArchiveEntries: 128,
    maxArchiveEntryBytes: 8 * MEBIBYTE,
    maxArchiveExpandedBytes: 16 * MEBIBYTE,
    maxInputBytes: 16 * MEBIBYTE,
    maxTextBytes: 8 * MEBIBYTE,
};

const formatLimit = (bytes: number): string => `${Math.max(1, Math.floor(bytes / MEBIBYTE))} MB`;

export class ImportSourceLimitError extends Error {
    readonly code: ImportSourceLimitCode;

    constructor(code: ImportSourceLimitCode, message: string) {
        super(message);
        this.name = 'ImportSourceLimitError';
        this.code = code;
    }
}

export type ImportArchiveBudget = {
    consumeChecklistItems: (count: number) => void;
    consumeEntities: (count: number) => void;
    consumeRows: (count?: number) => void;
};

export const createImportArchiveBudget = (
    limits: Readonly<ImportArchiveBudgetLimits> = DEFAULT_IMPORT_ARCHIVE_BUDGET_LIMITS,
): ImportArchiveBudget => {
    let checklistItems = 0;
    let entities = 0;
    let rows = 0;
    const consume = (
        count: number,
        current: number,
        maximum: number,
        code: ImportSourceLimitCode,
        noun: string,
    ): number => {
        const next = current + Math.max(0, count);
        if (next > maximum) {
            throw new ImportSourceLimitError(
                code,
                `The CSV files contain too many ${noun} across the archive. Keep exports to ${maximum} ${noun} or fewer.`,
            );
        }
        return next;
    };
    return {
        consumeChecklistItems: (count) => {
            checklistItems = consume(count, checklistItems, limits.maxChecklistItems, 'archive-too-many-checklist-items', 'checklist items');
        },
        consumeEntities: (count) => {
            entities = consume(count, entities, limits.maxEntities, 'archive-too-many-entities', 'records');
        },
        consumeRows: (count = 1) => {
            rows = consume(count, rows, limits.maxRows, 'archive-too-many-rows', 'rows');
        },
    };
};

export const assertImportSourceFileSize = (
    size: number | null | undefined,
    limits: Readonly<ImportSourceLimits> = DEFAULT_IMPORT_SOURCE_LIMITS,
): void => {
    if (typeof size !== 'number' || !Number.isFinite(size) || size <= limits.maxInputBytes) return;
    throw new ImportSourceLimitError(
        'input-too-large',
        `The selected import file is too large. Choose a file no larger than ${formatLimit(limits.maxInputBytes)}.`,
    );
};

export const assertImportChecklistItemCount = (
    value: string,
    maxItems = DEFAULT_IMPORT_CHECKLIST_ITEM_LIMIT,
): number => {
    let itemCount = 0;
    let hasContent = false;
    const finishItem = (): void => {
        if (!hasContent) return;
        itemCount += 1;
        hasContent = false;
        if (itemCount > maxItems) {
            throw new ImportSourceLimitError(
                'checklist-too-many-items',
                `A checklist contains too many items. Keep each checklist to ${maxItems} items or fewer.`,
            );
        }
    };
    for (const character of value) {
        if (character === '|' || character === '\r' || character === '\n') {
            finishItem();
        } else if (!/\s/u.test(character)) {
            hasContent = true;
        }
    }
    finishItem();
    return itemCount;
};

const assertTextSize = (
    size: number,
    limits: Readonly<ImportSourceLimits>,
): void => {
    if (size <= limits.maxTextBytes) return;
    throw new ImportSourceLimitError(
        'text-too-large',
        `The selected import data is too large. Choose an export no larger than ${formatLimit(limits.maxTextBytes)}.`,
    );
};

export const basename = (value: string): string => {
    const parts = String(value || '').split(/[\\/]/u);
    return parts[parts.length - 1] || value;
};

export const toImportBytes = (value?: ArrayBuffer | Uint8Array | null): Uint8Array | null => {
    if (!value) return null;
    return value instanceof Uint8Array ? value : new Uint8Array(value);
};

export const isZipBytes = (bytes: Uint8Array): boolean =>
    bytes.length >= ZIP_SIGNATURE.length && ZIP_SIGNATURE.every((byte, index) => bytes[index] === byte);

// Every importer's non-UTF-8 fallback is identical; OmniFocus additionally sniffs a UTF-16 BOM
// before falling back to this for the rest, so it keeps its own richer decoder that calls this
// one for the shared tail.
export const decodeTextBytes = (bytes: Uint8Array): string => {
    try {
        return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    } catch {
        return strFromU8(bytes, true);
    }
};

export const sanitizeCsvText = (raw: string): string => String(raw || '').replace(/^\uFEFF/u, '');

export const sanitizeJsonText = (raw: string): string => String(raw || '').replace(/^\uFEFF/u, '').trim();

export const detectDelimiter = (text: string, fallback = ','): string => {
    const firstLine = sanitizeCsvText(text)
        .split(/\r?\n/u)
        .find((line) => line.trim().length > 0);
    if (!firstLine) return fallback;
    const commaCount = (firstLine.match(/,/gu) || []).length;
    const semicolonCount = (firstLine.match(/;/gu) || []).length;
    return semicolonCount > commaCount ? ';' : ',';
};

export const parseCsvRows = (
    text: string,
    delimiter: string,
    limits: Readonly<ImportCsvLimits> = DEFAULT_IMPORT_CSV_LIMITS,
    archiveBudget?: ImportArchiveBudget,
    recordNumbers?: number[],
): { hasUnclosedQuote: boolean; rows: string[][] } => {
    const rows: string[][] = [];
    let currentRow: string[] = [];
    let currentCell = '';
    let inQuotes = false;
    let recordNumber = 0;

    const appendCharacter = (character: string): void => {
        if (currentCell.length >= limits.maxCellChars) {
            throw new ImportSourceLimitError(
                'csv-cell-too-large',
                `A CSV cell is too large. Keep each cell to ${limits.maxCellChars} characters or fewer.`,
            );
        }
        currentCell += character;
    };

    const finishCell = (): void => {
        if (currentRow.length >= limits.maxColumns) {
            throw new ImportSourceLimitError(
                'csv-too-many-columns',
                `A CSV row contains too many columns. Keep each row to ${limits.maxColumns} columns or fewer.`,
            );
        }
        currentRow.push(currentCell);
        currentCell = '';
    };

    const finishRow = (): void => {
        recordNumber += 1;
        if (currentCell.length === 0 && currentRow.every((cell) => cell.length === 0)) {
            currentRow = [];
            return;
        }
        finishCell();
        if (rows.length >= limits.maxRows) {
            throw new ImportSourceLimitError(
                'csv-too-many-rows',
                `The CSV contains too many rows. Keep exports to ${limits.maxRows} rows or fewer.`,
            );
        }
        archiveBudget?.consumeRows();
        rows.push(currentRow);
        recordNumbers?.push(recordNumber);
        currentRow = [];
    };

    for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        const next = text[index + 1];
        if (inQuotes) {
            if (char === '"') {
                if (next === '"') {
                    appendCharacter('"');
                    index += 1;
                } else {
                    inQuotes = false;
                }
            } else {
                appendCharacter(char);
            }
            continue;
        }

        if (char === '"') {
            inQuotes = true;
            continue;
        }
        if (char === delimiter) {
            finishCell();
            continue;
        }
        if (char === '\r' || char === '\n') {
            if (char === '\r' && next === '\n') {
                index += 1;
            }
            finishRow();
            continue;
        }
        appendCharacter(char);
    }

    finishRow();
    if (rows.length === 0 && text.length === 0) rows.push(['']);

    return {
        rows,
        hasUnclosedQuote: inQuotes,
    };
};

// Local-time formatting shared by importers that preserve an offset-less datetime as-is instead
// of normalizing it through UTC (OmniFocus, Mindwtr CSV) — pure format mechanics, which is what
// this module exists to own (see header comment).
export const pad = (value: number, width = 2): string => String(value).padStart(width, '0');

export const formatLocalDate = (date: Date): string =>
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

export const formatLocalDateTime = (date: Date): string => (
    `${formatLocalDate(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
);

export const normalizeHeaderCell = (value: string): string => value.trim().toUpperCase();

export const buildHeaderIndex = (headerRow: string[]): Map<string, number> => {
    const index = new Map<string, number>();
    headerRow.forEach((cell, cellIndex) => {
        const normalized = normalizeHeaderCell(cell);
        if (normalized && !index.has(normalized)) {
            index.set(normalized, cellIndex);
        }
    });
    return index;
};

export const getCell = (row: string[], headerIndex: Map<string, number>, key: string): string => {
    const index = headerIndex.get(key);
    if (index === undefined) return '';
    return String(row[index] ?? '').trim();
};

// Same concept in OmniFocus and DGT: normalize a free-text context name to Mindwtr's `@name`
// convention. (Not the same as OmniFocus's/DGT's *own* `normalizeContexts`/`normalizeTags`
// functions, which parse an entire CSV token list or a whole JSON array respectively — those
// happen to share a name across formats but do genuinely different things, so they stay local.)
export const normalizeContextName = (value: string): string | undefined => {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    return trimmed.startsWith('@') ? trimmed : `@${trimmed}`;
};

// Trim + dedupe case-insensitively, keeping the first-seen casing. Every importer had its own
// copy of this (some under a different local name, e.g. OmniFocus's `dedupeCaseInsensitive`).
export const dedupeStrings = (values: Array<string | undefined>): string[] => {
    const seen = new Set<string>();
    const result: string[] = [];
    values.forEach((value) => {
        const trimmed = String(value || '').trim();
        if (!trimmed) return;
        const normalized = trimmed.toLowerCase();
        if (seen.has(normalized)) return;
        seen.add(normalized);
        result.push(trimmed);
    });
    return result;
};

export const joinDescription = (parts: Array<string | undefined>): string | undefined => {
    const normalized = parts.map((part) => String(part || '').trim()).filter(Boolean);
    return normalized.length > 0 ? normalized.join('\n\n') : undefined;
};

// Every importer's warning list is built from its own counters and its own message strings —
// only this "if count > 0, push singular/plural" shape was byte-identical across all four.
export const appendWarning = (warnings: string[], count: number, singular: string, plural = singular): void => {
    if (count <= 0) return;
    warnings.push(count === 1 ? singular : plural.replace('{count}', String(count)));
};

export type ImportSourceInput = {
    bytes?: ArrayBuffer | Uint8Array | null;
    fileName: string;
    text?: string | null;
};

export type ImportArchiveEntry = { entryBytes: Uint8Array; entryName: string };

export type ReadImportSourceResult =
    | { entries: ImportArchiveEntry[]; fileName: string; kind: 'archive' }
    | { fileName: string; kind: 'text'; text: string };

const ZIP_LOCAL_HEADER = 0x04034b50;
const ZIP_CENTRAL_HEADER = 0x02014b50;
const ZIP_END_RECORD = 0x06054b50;
const readU16 = (bytes: Uint8Array, at: number): number => bytes[at] | (bytes[at + 1] << 8);
const readU32 = (bytes: Uint8Array, at: number): number => (readU16(bytes, at) | (readU16(bytes, at + 2) << 16)) >>> 0;
// No file content or name in the message: the error can reach a toast and a stored result.
const damagedArchive = (): never => {
    throw new Error('The selected archive is damaged or uses an unsupported ZIP feature.');
};

type ZipCentralEntry = {
    compressedSize: number; flags: number; localOffset: number; method: number; name: string; nameBytes: Uint8Array; size: number;
};

/**
 * A ZIP's entries, reading only sizes the data itself proves. The central directory's sizes are checked against each local
 * header (unless a data descriptor follows the data), every entry's bytes lie apart from every other's (one local entry listed
 * twice is refused), the count and size budgets run on those checked sizes before anything is inflated, a STORE entry is
 * exactly its size, and a DEFLATE entry is inflated into a buffer one byte larger than declared and refused unless exactly the
 * declared size came out. fflate's own unzip trusted the declared sizes: a forged header imported part of a file, or one entry
 * many times over the budget. Encrypted, ZIP64 and multi-disk archives are refused.
 */
const readZipEntries = (bytes: Uint8Array, limits: Readonly<ImportSourceLimits>): ImportArchiveEntry[] => {
    let end = -1;
    for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at -= 1) {
        if (readU32(bytes, at) === ZIP_END_RECORD) { end = at; break; }
    }
    if (end < 0) damagedArchive();
    const count = readU16(bytes, end + 10);
    const directorySize = readU32(bytes, end + 12);
    const directoryStart = readU32(bytes, end + 16);
    if (readU16(bytes, end + 4) !== 0 || readU16(bytes, end + 6) !== 0 || readU16(bytes, end + 8) !== count
        || count === 0xffff || directoryStart + directorySize > end) damagedArchive();
    const central: ZipCentralEntry[] = [];
    let expandedBytes = 0;
    let at = directoryStart;
    for (let index = 0; index < count; index += 1) {
        if (index + 1 > limits.maxArchiveEntries) {
            throw new ImportSourceLimitError(
                'archive-too-many-entries',
                `The selected archive contains too many files. Choose one with no more than ${limits.maxArchiveEntries} entries.`,
            );
        }
        if (at + 46 > directoryStart + directorySize || readU32(bytes, at) !== ZIP_CENTRAL_HEADER) damagedArchive();
        const flags = readU16(bytes, at + 8);
        const method = readU16(bytes, at + 10);
        const compressedSize = readU32(bytes, at + 20);
        const size = readU32(bytes, at + 24);
        const nameLength = readU16(bytes, at + 28);
        const localOffset = readU32(bytes, at + 42);
        const nameBytes = bytes.subarray(at + 46, at + 46 + nameLength);
        if ((flags & 1) !== 0 || (method !== 0 && method !== 8)
            || compressedSize === 0xffffffff || size === 0xffffffff || localOffset === 0xffffffff) damagedArchive();
        if (size > limits.maxArchiveEntryBytes) {
            throw new ImportSourceLimitError(
                'archive-entry-too-large',
                `An archive entry is too large. Choose an export whose files are no larger than ${formatLimit(limits.maxArchiveEntryBytes)} each.`,
            );
        }
        expandedBytes += size;
        if (expandedBytes > limits.maxArchiveExpandedBytes) {
            throw new ImportSourceLimitError(
                'archive-expanded-too-large',
                `The selected archive expands to too much data. Choose an export no larger than ${formatLimit(limits.maxArchiveExpandedBytes)} when unpacked.`,
            );
        }
        central.push({ compressedSize, flags, localOffset, method, name: strFromU8(nameBytes, (flags & 0x800) === 0), nameBytes, size });
        at += 46 + nameLength + readU16(bytes, at + 30) + readU16(bytes, at + 32);
    }
    if (at !== directoryStart + directorySize) damagedArchive();
    const spans = central.map((entry) => {
        const header = entry.localOffset;
        if (header + 30 > directoryStart || readU32(bytes, header) !== ZIP_LOCAL_HEADER) damagedArchive();
        const nameLength = readU16(bytes, header + 26);
        const dataStart = header + 30 + nameLength + readU16(bytes, header + 28);
        const localName = bytes.subarray(header + 30, header + 30 + nameLength);
        if (readU16(bytes, header + 8) !== entry.method || nameLength !== entry.nameBytes.length
            || localName.some((byte, index) => byte !== entry.nameBytes[index])) damagedArchive();
        if ((readU16(bytes, header + 6) & 8) === 0
            && (readU32(bytes, header + 18) !== entry.compressedSize || readU32(bytes, header + 22) !== entry.size)) damagedArchive();
        const dataEnd = dataStart + entry.compressedSize;
        if (dataEnd > directoryStart) damagedArchive();
        return { entry, header, dataStart, dataEnd };
    });
    const ordered = [...spans].sort((left, right) => left.header - right.header);
    for (let index = 1; index < ordered.length; index += 1) {
        if (ordered[index].header < ordered[index - 1].dataEnd) damagedArchive();
    }
    // fflate's unzip kept the last entry of a repeated name; so does this.
    const entries = new Map<string, Uint8Array>();
    for (const { entry, dataStart, dataEnd } of spans) {
        const data = bytes.subarray(dataStart, dataEnd);
        let entryBytes: Uint8Array;
        if (entry.method === 0) {
            if (entry.compressedSize !== entry.size) damagedArchive();
            entryBytes = data.slice();
        } else {
            try {
                entryBytes = inflateSync(data, { out: new Uint8Array(entry.size + 1) });
            } catch {
                return damagedArchive();
            }
            if (entryBytes.length !== entry.size) damagedArchive();
        }
        entries.set(entry.name, entryBytes);
    }
    return [...entries].map(([entryName, entryBytes]) => ({ entryName, entryBytes }));
};

// Bytes -> either a decoded single-file text blob or the raw entries of a ZIP archive. Each
// importer still walks `entries` itself and owns its own per-entry extension/counter logic
// (nested zip, wrong extension, invalid parse) since the exact warning message and which
// extension is expected (.csv vs .json) differs per format; this only removes the byte-sniffing
// and generic UTF-8 decode that were duplicated verbatim in all four parsers.
export const readImportSource = (
    input: ImportSourceInput,
    decodeText: (bytes: Uint8Array) => string = decodeTextBytes,
    limits: Readonly<ImportSourceLimits> = DEFAULT_IMPORT_SOURCE_LIMITS,
): ReadImportSourceResult => {
    const fileName = basename(input.fileName);
    const bytes = toImportBytes(input.bytes);
    assertImportSourceFileSize(bytes?.byteLength, limits);
    if (bytes && isZipBytes(bytes)) return { kind: 'archive', fileName, entries: readZipEntries(bytes, limits) };
    if (bytes) assertTextSize(bytes.byteLength, limits);
    const text = input.text ?? (bytes ? decodeText(bytes) : '');
    if (text.length > limits.maxTextBytes) assertTextSize(text.length, limits);
    if (!bytes || input.text != null) {
        assertTextSize(new TextEncoder().encode(text).byteLength, limits);
    }
    return { kind: 'text', fileName, text };
};
