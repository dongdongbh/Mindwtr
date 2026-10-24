import { isTaskFinished } from './task-status';
import type { AppSettings, Project, Task, TaxonomyCatalog, TaxonomyCatalogEntry } from './types';

export type TaxonomyCatalogKind = 'context' | 'tag';
const field = (kind: TaxonomyCatalogKind) => kind === 'context' ? 'contexts' : 'tags';

export function normalizeTaxonomyToken(kind: TaxonomyCatalogKind, value: string): string {
    if (typeof value !== 'string' || value.length > 500) return '';
    for (let index = 0; index < value.length; index += 1)
        if (value.charCodeAt(index) < 32 || value.charCodeAt(index) === 127) return '';
    const label = value.trim().replace(/^[@#＠＃]+/, '').trim();
    const token = label ? `${kind === 'context' ? '@' : '#'}${label}` : '';
    return token.length <= 500 ? token : '';
}

const identity = (kind: TaxonomyCatalogKind, value: string) => normalizeTaxonomyToken(kind, value).toLowerCase();
const stamp = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export function isTaxonomyCatalog(value: unknown): value is TaxonomyCatalog {
    if (!record(value) || Object.keys(value).some((name) => name !== 'contexts' && name !== 'tags')) return false;
    return (['context', 'tag'] as const).every((kind) => {
        const rows = value[field(kind)];
        if (rows === undefined) return true;
        return Array.isArray(rows) && rows.every((row) => record(row)
            && Object.keys(row).every((name) => ['token', 'rev', 'revBy', 'updatedAt', 'deletedAt'].includes(name))
            && typeof row.token === 'string' && normalizeTaxonomyToken(kind, row.token) === row.token
            && Number.isSafeInteger(row.rev) && Number(row.rev) >= 1
            && typeof row.revBy === 'string' && row.revBy.length > 0 && row.revBy.length <= 500
            && stamp(row.updatedAt) && (row.deletedAt === undefined || stamp(row.deletedAt)))
            && new Set(rows.map((row) => identity(kind, row.token))).size === rows.length;
    });
}

const winner = (left: TaxonomyCatalogEntry, right: TaxonomyCatalogEntry): TaxonomyCatalogEntry => {
    if (left.rev !== right.rev) return left.rev > right.rev ? left : right;
    const time = Date.parse(left.updatedAt) - Date.parse(right.updatedAt);
    if (time) return time > 0 ? left : right;
    if (Boolean(left.deletedAt) !== Boolean(right.deletedAt)) return left.deletedAt ? left : right;
    const leftTie = JSON.stringify([left.revBy, left.token, left.deletedAt ?? '']);
    const rightTie = JSON.stringify([right.revBy, right.token, right.deletedAt ?? '']);
    return leftTie >= rightTie ? left : right;
};

/** Omission is not deletion: older clients do not know this settings field. */
export function mergeTaxonomyCatalog(local: TaxonomyCatalog | undefined, incoming: TaxonomyCatalog | undefined): TaxonomyCatalog | undefined {
    const validLocal = isTaxonomyCatalog(local) ? local : undefined;
    const validIncoming = isTaxonomyCatalog(incoming) ? incoming : undefined;
    if (!validLocal && !validIncoming) return undefined;
    const result: TaxonomyCatalog = {};
    for (const kind of ['context', 'tag'] as const) {
        const name = field(kind);
        if (validLocal?.[name] === undefined && validIncoming?.[name] === undefined) continue;
        const byName = new Map<string, TaxonomyCatalogEntry>();
        for (const row of [...(validLocal?.[name] ?? []), ...(validIncoming?.[name] ?? [])]) {
            const name = identity(kind, row.token); const before = byName.get(name);
            byName.set(name, before ? winner(before, row) : row);
        }
        result[name] = [...byName.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, row]) => row);
    }
    return result;
}

export function getSavedTaxonomyTokens(settings: AppSettings, kind: TaxonomyCatalogKind): string[] {
    return isTaxonomyCatalog(settings.taxonomy)
        ? (settings.taxonomy[field(kind)] ?? []).filter((row) => !row.deletedAt).map((row) => row.token) : [];
}

type TaxonomyWrite = { kind: TaxonomyCatalogKind; token: string; deviceId: string; now: string;
    deleted?: boolean; replaceCase?: boolean; onlyIfMissing?: boolean };

const writeTaxonomyTokens = (settings: AppSettings, writes: readonly TaxonomyWrite[]): AppSettings => {
    if (!writes.length) return settings;
    const catalog = settings.taxonomy ?? {};
    if (!isTaxonomyCatalog(catalog)) throw new Error('Saved contexts and tags have an unsupported value');
    const groups = new Map<TaxonomyCatalogKind, Map<string, TaxonomyCatalogEntry>>();
    let changed = false;
    for (const write of writes) {
        const token = normalizeTaxonomyToken(write.kind, write.token);
        if (!token) throw new Error(`Invalid ${write.kind} name`);
        let rows = groups.get(write.kind);
        if (!rows) {
            rows = new Map((catalog[field(write.kind)] ?? []).map((row) => [identity(write.kind, row.token), row]));
            groups.set(write.kind, rows);
        }
        const id = token.toLowerCase(); const before = rows.get(id);
        if (before && (write.onlyIfMissing || Boolean(before.deletedAt) === Boolean(write.deleted)
            && (!write.replaceCase || before.token === token))) continue;
        if (typeof write.deviceId !== 'string' || !write.deviceId || write.deviceId.length > 500 || !stamp(write.now))
            throw new Error('Saved value requires valid revision metadata');
        const rev = (before?.rev ?? 0) + 1;
        if (!Number.isSafeInteger(rev)) throw new Error('Saved value revision is exhausted');
        rows.set(id, { token, rev, revBy: write.deviceId, updatedAt: write.now,
            ...(write.deleted ? { deletedAt: write.now } : {}) });
        changed = true;
    }
    if (!changed) return settings;
    const taxonomy = { ...catalog };
    for (const [kind, rows] of groups)
        taxonomy[field(kind)] = [...rows.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, row]) => row);
    return { ...settings, taxonomy };
};

export function addSavedTaxonomyToken(settings: AppSettings, kind: TaxonomyCatalogKind, token: string,
    deviceId: string, now: string, deleted = false, replaceCase = false): AppSettings {
    return writeTaxonomyTokens(settings, [{ kind, token, deviceId, now, deleted, replaceCase }]);
}

export function planTaxonomyCatalogChange(catalogue: TaxonomyCatalog | null, kind: TaxonomyCatalogKind,
    action: 'create' | 'rename' | 'delete', name: string, to: string | null, deviceId: string, now: string): TaxonomyCatalog {
    const settings: AppSettings = { ...(catalogue === null ? {} : { taxonomy: catalogue }) };
    return writeTaxonomyTokens(settings, [
        { kind, token: name, deviceId, now, deleted: action !== 'create' },
        ...(action === 'rename' && to !== null ? [{ kind, token: to, deviceId, now, replaceCase: true }] : []),
    ]).taxonomy!;
}

/**
 * Retain a token only when this write can make it unused: removed from the row, or the row leaves the lists
 * that read tokens (deleted; for a task also entering Done, which the Contexts pickers skip, or Archived, which
 * the visible task list skips). New tokens are written too. Other writes never touch settings.
 */
const tokenWrites = (kind: TaxonomyCatalogKind, before: readonly string[], after: readonly string[], leaves: boolean,
    deviceId: string, now: string): TaxonomyWrite[] => {
    const writes: TaxonomyWrite[] = [];
    const previous = new Set(before.map((token) => identity(kind, token)));
    const next = new Set(leaves ? [] : after.map((token) => identity(kind, token)));
    for (const token of before) {
        const normalized = normalizeTaxonomyToken(kind, token);
        if (normalized && !next.has(normalized.toLowerCase())) writes.push({ kind, token: normalized, deviceId, now, onlyIfMissing: true });
    }
    for (const token of after) {
        const normalized = normalizeTaxonomyToken(kind, token);
        if (normalized && !previous.has(normalized.toLowerCase())) writes.push({ kind, token: normalized, deviceId, now });
    }
    return writes;
};

const taskTaxonomyWrites = (settings: AppSettings, before: Task | undefined, after: Task): TaxonomyWrite[] => {
    const leaves = Boolean(before) && (Boolean(after.deletedAt) && !before!.deletedAt
        || isTaskFinished(after) && !isTaskFinished(before)
        || after.status === 'archived' && before!.status !== 'archived');
    return (['context', 'tag'] as const).flatMap((kind) => tokenWrites(kind, before?.[field(kind)] ?? [],
        after.deletedAt ? [] : after[field(kind)] ?? [], leaves, after.revBy ?? settings.deviceId!, after.updatedAt));
};

const projectTaxonomyWrites = (settings: AppSettings, before: Project | undefined, after: Project): TaxonomyWrite[] =>
    tokenWrites('tag', before?.tagIds ?? [], after.deletedAt ? [] : after.tagIds ?? [], Boolean(after.deletedAt && !before?.deletedAt),
        after.revBy ?? settings.deviceId!, after.updatedAt);

/** Only newly assigned values can restore a removed catalogue entry. */
export function retainTaskTaxonomy(settings: AppSettings, before: Task | undefined, after: Task): AppSettings {
    return writeTaxonomyTokens(settings, taskTaxonomyWrites(settings, before, after));
}

export function retainProjectTaxonomy(settings: AppSettings, before: Project | undefined, after: Project): AppSettings {
    return writeTaxonomyTokens(settings, projectTaxonomyWrites(settings, before, after));
}

export function retainTaxonomyEffects(settings: AppSettings,
    tasks: readonly { before?: Task | null; after: Task }[],
    projects: readonly { before?: Project | null; after: Project }[] = []): AppSettings {
    const writes: TaxonomyWrite[] = [];
    const seen = new Set<string>();
    const collect = (write: TaxonomyWrite) => {
        const id = `${write.kind}:${write.token.toLowerCase()}:${Boolean(write.onlyIfMissing)}`;
        if (!seen.has(id)) { seen.add(id); writes.push(write); }
    };
    for (const { before, after } of tasks) {
        for (const write of taskTaxonomyWrites(settings, before ?? undefined, after)) collect(write);
    }
    for (const { before, after } of projects) {
        for (const write of projectTaxonomyWrites(settings, before ?? undefined, after)) collect(write);
    }
    return writeTaxonomyTokens(settings, writes);
}

/** An explicit backup replacement outranks current entries, including removed values. */
export function prepareRestoredTaxonomyCatalog(restored: TaxonomyCatalog | undefined, previous: TaxonomyCatalog | undefined,
    now: string, deviceId: string): TaxonomyCatalog | undefined {
    if (restored === undefined && previous === undefined) return undefined;
    if (restored !== undefined && !isTaxonomyCatalog(restored) || previous !== undefined && !isTaxonomyCatalog(previous))
        throw new Error('Saved contexts and tags have an unsupported value');
    const result: TaxonomyCatalog = {};
    for (const kind of ['context', 'tag'] as const) {
        const name = field(kind);
        if (restored?.[name] === undefined && previous?.[name] === undefined) continue;
        const restoredByName = new Map((restored?.[name] ?? []).map((row) => [identity(kind, row.token), row]));
        const previousByName = new Map((previous?.[name] ?? []).map((row) => [identity(kind, row.token), row]));
        result[name] = [...new Set([...restoredByName.keys(), ...previousByName.keys()])].sort().map((id) => {
            const row = restoredByName.get(id); const before = previousByName.get(id);
            const rev = Math.max(row?.rev ?? 0, before?.rev ?? 0) + 1;
            if (!Number.isSafeInteger(rev)) throw new Error('Saved value revision is exhausted');
            return { token: row?.token ?? before!.token, rev, revBy: deviceId, updatedAt: now,
                ...(!row || row.deletedAt ? { deletedAt: now } : {}) };
        });
    }
    return result;
}
