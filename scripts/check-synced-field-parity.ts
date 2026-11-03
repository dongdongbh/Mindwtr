#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';


import {
    TASK_SQLITE_COLUMNS,
    TASK_SQLITE_MIGRATION_COLUMNS,
    TASK_SYNC_FIELD_SCHEMA,
    TASK_SYNC_SCHEMA_FIXTURE,
} from '../packages/core/src/task-sync-schema';
import { PROJECT_SYNC_FIELD_SCHEMA } from '../packages/core/src/project-sync-schema';
import { SECTION_SYNC_FIELD_SCHEMA } from '../packages/core/src/section-sync-schema';
import { AREA_SYNC_FIELD_SCHEMA } from '../packages/core/src/area-sync-schema';
import { PERSON_SYNC_FIELD_SCHEMA } from '../packages/core/src/person-sync-schema';
import {
    normalizeTaskForContentComparison,
    TASK_CONTENT_COMPARISON_EXCLUDED_KEYS,
} from '../packages/core/src/sync-signatures';
import { CLOUD_TASK_PATCH_ALLOWED_PROP_KEYS } from '../apps/cloud/src/server-config';


import { TASK_WRITE_FIELD_EXCLUSIONS } from '../apps/mcp-server/src/task-write-field-exclusions';
import cloudKitProductionSchema from '../packages/core/src/cloudkit-production-schema.json';


const RELEASE_GATE = process.argv.includes('--release-gate');

type Entity = 'task' | 'project' | 'section' | 'area' | 'person';
type Surface = 'cloud' | 'sqlite';

const expectedTaskCloudFields = TASK_SYNC_FIELD_SCHEMA
    .filter((field) => field.cloudKit !== null)
    .map((field) => field.name);
const expectedTaskSqliteFields = Array.from(new Set(
    TASK_SYNC_FIELD_SCHEMA
        .map((field) => field.sqliteColumn)
        .filter((column): column is string => column !== null),
));


const expectedCloudFields = (schema: readonly { name: string; cloudSynced: boolean }[]): string[] =>
    schema.filter((field) => field.cloudSynced).map((field) => field.name);
const expectedSqliteFields = (schema: readonly { sqliteColumn: string | null }[]): string[] => Array.from(new Set(
    schema
        .map((field) => field.sqliteColumn)
        .filter((column): column is string => column !== null),
));

const EXPECTED: Record<Entity, Record<Surface, string[]>> = {
    task: {
        cloud: expectedTaskCloudFields,
        sqlite: expectedTaskSqliteFields,
    },
    project: {
        cloud: expectedCloudFields(PROJECT_SYNC_FIELD_SCHEMA),
        sqlite: expectedSqliteFields(PROJECT_SYNC_FIELD_SCHEMA),
    },
    section: {
        cloud: expectedCloudFields(SECTION_SYNC_FIELD_SCHEMA),
        sqlite: expectedSqliteFields(SECTION_SYNC_FIELD_SCHEMA),
    },
    area: {
        cloud: expectedCloudFields(AREA_SYNC_FIELD_SCHEMA),
        sqlite: expectedSqliteFields(AREA_SYNC_FIELD_SCHEMA),
    },
    person: {
        cloud: expectedCloudFields(PERSON_SYNC_FIELD_SCHEMA),
        sqlite: expectedSqliteFields(PERSON_SYNC_FIELD_SCHEMA),
    },
};

const PATHS = {
    coreTypes: 'packages/core/src/types.ts',
    coreSqliteSchema: 'packages/core/src/sqlite-schema.ts',


    desktopRustStorage: 'apps/desktop/src-tauri/src/storage.rs',
    swiftMapper: 'apps/mobile/modules/cloudkit-sync/ios/CloudKitRecordMapper.swift',
    objcMapper: 'apps/desktop/src-tauri/src/macos_cloudkit_bridge.m',
    mcpQueries: 'apps/mcp-server/src/queries.ts',
};

const read = (path: string) => readFileSync(path, 'utf8');

const unique = (fields: string[], label: string): string[] => {
    const seen = new Set<string>();
    const duplicates = fields.filter((field) => {
        if (seen.has(field)) return true;
        seen.add(field);
        return false;
    });
    if (duplicates.length > 0) {
        throw new Error(`${label} has duplicate fields: ${Array.from(new Set(duplicates)).join(', ')}`);
    }
    return fields;
};

const parseCreateTableColumns = (source: string, table: string): string[] => {
    const match = source.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`));
    if (!match) throw new Error(`Could not find CREATE TABLE for ${table}.`);
    return unique(match[1]
        .split('\n')
        .map((line) => line.trim().replace(/,$/, ''))
        .filter(Boolean)
        .map((line) => line.split(/\s+/)[0])
        .filter((name) => !name.startsWith('FOREIGN') && !name.startsWith('PRIMARY')),
    `CREATE TABLE ${table}`);
};

const parseRustInsertColumns = (source: string, table: string): string[] => {
    const match = source.match(new RegExp(`INSERT OR REPLACE INTO ${table} \\(([^)]*)\\) VALUES`));
    if (!match) throw new Error(`Could not find Rust INSERT columns for ${table}.`);
    return unique(match[1].split(',').map((column) => column.trim()).filter(Boolean), `Rust INSERT ${table}`);
};

const parseFtsTableColumnLists = (source: string, table: string): string[][] => {
    const pattern = new RegExp(
        `CREATE VIRTUAL TABLE IF NOT EXISTS ${table} USING fts5\\(([\\s\\S]*?)\\n\\s*\\)`,
        'g',
    );
    return Array.from(source.matchAll(pattern), (match, index) => unique(
        match[1]
            .split('\n')
            .map((line) => line.trim().replace(/,$/, ''))
            .filter((line) => Boolean(line) && !line.includes('='))
            .map((line) => line.split(/\s+/)[0]),
        `${table} definition ${index + 1}`,
    ));
};

const compareFtsTableDefinitions = (
    label: string,
    actualDefinitions: string[][],
    expected: string[],
): string[] => {
    if (actualDefinitions.length === 0) return [`${label}: missing definition`];
    return actualDefinitions.flatMap((actual, index) => compareSet(
        `${label} definition ${index + 1}`,
        actual,
        expected,
    ));
};

const normalizeSql = (sql: string): string => sql
    .replace(/;?\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();

const parseFtsTriggers = (source: string): Map<string, string[]> => {
    const triggers = new Map<string, string[]>();
    const pattern = /CREATE TRIGGER IF NOT EXISTS ([A-Za-z0-9_]+)\s+[\s\S]*?\bEND\b;?/g;
    for (const match of source.matchAll(pattern)) {
        if (!match[0].includes('_fts')) continue;
        const definitions = triggers.get(match[1]) ?? [];
        definitions.push(normalizeSql(match[0]));
        triggers.set(match[1], definitions);
    }
    return triggers;
};

const compareFtsTriggers = (
    label: string,
    actual: Map<string, string[]>,
    expected: Map<string, string[]>,
): string[] => {
    const failures: string[] = [];
    for (const [name, expectedDefinitions] of expected) {
        if (expectedDefinitions.length !== 1) {
            failures.push(`core SQLite ${name} trigger: expected one definition, got ${expectedDefinitions.length}`);
            continue;
        }
        const expectedSql = expectedDefinitions[0];
        const actualDefinitions = actual.get(name) ?? [];
        if (actualDefinitions.length === 0) {
            failures.push(`${label} ${name} trigger: missing definition`);
            continue;
        }
        actualDefinitions.forEach((actualSql, index) => {
            if (actualSql !== expectedSql) {
                failures.push(`${label} ${name} trigger definition ${index + 1} differs from core`);
            }
        });
    }
    for (const name of actual.keys()) {
        if (!expected.has(name)) failures.push(`${label} ${name} trigger: unexpected definition`);
    }
    return failures;
};


const parseForeignKeyReferences = (source: string, table: string): Record<string, string> => {
    const match = source.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`));
    if (!match) throw new Error(`Could not find CREATE TABLE for ${table}.`);
    const references: Record<string, string> = {};
    for (const line of match[1].split('\n')) {
        const columnMatch = line.trim().match(/^(\w+)\s+TEXT(?:\s+NOT NULL)?\s+REFERENCES\s+(\w+)\(/);
        if (columnMatch) references[columnMatch[1]] = columnMatch[2];
    }
    return references;
};

const compareForeignKeys = (
    label: string,
    actual: Record<string, string>,
    expected: Record<string, string>
): string[] => Object.entries(expected)
    .filter(([column, table]) => actual[column] !== table)
    .map(([column, table]) => `${label}: expected "${column} REFERENCES ${table}(id)", got ${
        actual[column] ? `REFERENCES ${actual[column]}(id)` : 'no REFERENCES clause'
    }`);


const REQUIRED_SQLITE_PRAGMAS = [
    'PRAGMA journal_mode = WAL;',
    'PRAGMA foreign_keys = ON;',
    'PRAGMA busy_timeout = 5000;',
    'PRAGMA temp_store = MEMORY;',
];

const compareRequiredPragmas = (label: string, source: string): string[] => REQUIRED_SQLITE_PRAGMAS
    .filter((pragma) => !source.includes(pragma))
    .map((pragma) => `${label}: missing "${pragma}"`);

const compareDesktopRequiredPragmas = (label: string, source: string): string[] => {
    const failures = compareRequiredPragmas(label, source)
        .filter((failure) => !failure.includes('PRAGMA busy_timeout = 5000;'));
    const configuresBusyTimeout = source.includes('const SQLITE_BUSY_TIMEOUT_MS: u64 = 5_000;')
        && source.includes('busy_timeout(Duration::from_millis(SQLITE_BUSY_TIMEOUT_MS))');
    if (!configuresBusyTimeout) {
        failures.push(`${label}: missing 5000ms busy_timeout connection configuration`);
    }
    return failures;
};


const coreTaskUpdateColumns = (): string[] => unique(
    TASK_SQLITE_COLUMNS.filter((column) => column !== 'id'),
    'TASK_UPSERT_UPDATE_CLAUSE',
);

const coreTaskMigrationColumns = (): string[] => unique(
    TASK_SQLITE_MIGRATION_COLUMNS.map((entry) => entry.name),
    'ensureTaskColumns',
);

type ParsedTaskField = {
    name: string;
    nullability: 'required' | 'optional' | 'optional-nullable';
};

const parseTaskInterfaceFields = (source: string): ParsedTaskField[] => {
    const match = source.match(/export interface Task \{([\s\S]*?)\n\}/);
    if (!match) throw new Error('Could not find Task interface.');
    return match[1]
        .split('\n')
        .map((line) => line.replace(/\/\/.*$/, '').trim())
        .map((line) => line.match(/^([A-Za-z][A-Za-z0-9]*)(\?)?:\s*([^;]+);$/))
        .filter((entry): entry is RegExpMatchArray => entry !== null)
        .map((entry) => ({
            name: entry[1],
            nullability: entry[2]
                ? /\bnull\b/.test(entry[3])
                    ? 'optional-nullable' as const
                    : 'optional' as const
                : 'required' as const,
        }));
};

type NativeCloudFieldSpec = {
    jsKey: string;
    storageKey: string;
    kind: string;
};

const SWIFT_KIND_MAP: Record<string, string> = {
    string: 'string',
    date: 'date',
    jsonString: 'json-string',
    bool: 'boolean',
    int: 'integer',
    stringArray: 'string-array',
};

const OBJC_KIND_MAP: Record<string, string> = {
    String: 'string',
    Date: 'date',
    JsonString: 'json-string',
    Bool: 'boolean',
    Int: 'integer',
    StringArray: 'string-array',
};

const parseSwiftFieldSpecs = (source: string, entity: Entity): NativeCloudFieldSpec[] => {
    const name = `${entity}FieldSpecs`;
    const match = source.match(new RegExp(`private static let ${name}: \\[FieldSpec\\] = \\[([\\s\\S]*?)\\n {4}\\]`));
    if (!match) throw new Error(`Could not find Swift ${name}.`);
    const specs = Array.from(
        match[1].matchAll(/FieldSpec\(jsKey: "([^"]+)", ckKey: "([^"]+)", kind: \.([A-Za-z]+)\)/g),
        (entry) => ({
            jsKey: entry[1],
            storageKey: entry[2],
            kind: SWIFT_KIND_MAP[entry[3]] ?? entry[3],
        }),
    );
    unique(specs.map((spec) => spec.jsKey), `Swift ${name}`);
    unique(specs.map((spec) => spec.storageKey), `Swift ${name} storage keys`);
    return specs;
};

const parseSwiftRecordType = (source: string, entity: Entity): string => {
    const match = source.match(new RegExp(`static let ${entity}Type = "([^"]+)"`));
    if (!match) throw new Error(`Could not find Swift ${entity}Type.`);
    return match[1];
};

const parseObjcFieldSpecs = (source: string, entity: Entity): NativeCloudFieldSpec[] => {
    const name = `k${entity[0].toUpperCase()}${entity.slice(1)}Fields`;
    const match = source.match(new RegExp(`static const MWFieldSpec ${name}\\[\\] = \\{([\\s\\S]*?)\\n\\};`));
    if (!match) throw new Error(`Could not find ObjC ${name}.`);
    const specs = Array.from(
        match[1].matchAll(/\{"([^"]+)",\s*"([^"]+)",\s*MWFieldKind([A-Za-z]+)\}/g),
        (entry) => ({
            jsKey: entry[1],
            storageKey: entry[2],
            kind: OBJC_KIND_MAP[entry[3]] ?? entry[3],
        }),
    );
    unique(specs.map((spec) => spec.jsKey), `ObjC ${name}`);
    unique(specs.map((spec) => spec.storageKey), `ObjC ${name} storage keys`);
    return specs;
};

const assertSuperset = (label: string, actual: Iterable<string>, required: string[]): string[] => {
    const actualSet = new Set(actual);
    const missing = required.filter((field) => !actualSet.has(field));
    return missing.length > 0 ? [`${label} missing: ${missing.join(', ')}`] : [];
};

const compareSet = (label: string, actual: string[], expected: string[]): string[] => {
    const actualSet = new Set(actual);
    const expectedSet = new Set(expected);
    const missing = expected.filter((field) => !actualSet.has(field));
    const extra = actual.filter((field) => !expectedSet.has(field));
    if (missing.length === 0 && extra.length === 0) return [];
    const lines = [`${label}:`];
    if (missing.length > 0) lines.push(`  missing: ${missing.join(', ')}`);
    if (extra.length > 0) lines.push(`  extra: ${extra.join(', ')}`);
    return lines;
};

const compareNativeFieldMappings = (
    label: string,
    actual: NativeCloudFieldSpec[],
    expected: NativeCloudFieldSpec[],
): string[] => {
    const expectedByName = new Map(expected.map((field) => [field.jsKey, field]));
    const mismatches = actual
        .filter((field) => {
            const expectedField = expectedByName.get(field.jsKey);
            return expectedField
                && (field.storageKey !== expectedField.storageKey || field.kind !== expectedField.kind);
        })
        .map((field) => {
            const expectedField = expectedByName.get(field.jsKey)!;
            return `${field.jsKey} expected ${expectedField.storageKey}/${expectedField.kind}, got ${field.storageKey}/${field.kind}`;
        });
    return mismatches.length > 0 ? [`${label}:`, `  ${mismatches.join('; ')}`] : [];
};

const requireSourcePattern = (label: string, source: string, pattern: RegExp): string[] => (
    pattern.test(source) ? [] : [`${label} is not derived from the synced SQLite schema.`]
);

const compareTaskInterface = (source: string): string[] => {
    const actual = parseTaskInterfaceFields(source);
    unique(actual.map((field) => field.name), 'Task interface');
    const failures = compareSet(
        'core Task interface',
        actual.map((field) => field.name),
        TASK_SYNC_FIELD_SCHEMA.map((field) => field.name),
    );
    const actualByName = new Map(actual.map((field) => [field.name, field]));
    const mismatches = TASK_SYNC_FIELD_SCHEMA
        .filter((field) => actualByName.get(field.name)?.nullability !== field.nullability)
        .map((field) => {
            const actualNullability = actualByName.get(field.name)?.nullability ?? 'missing';
            return field.name + ' expected ' + field.nullability + ', got ' + actualNullability;
        });
    if (mismatches.length > 0) {
        failures.push('core Task interface nullability:');
        failures.push('  ' + mismatches.join('; '));
    }
    return failures;
};

const compareNativeTaskFieldSpecs = (
    label: string,
    actual: NativeCloudFieldSpec[],
): string[] => {
    const expected = TASK_SYNC_FIELD_SCHEMA.flatMap((field) => (
        field.cloudKit
            ? [{
                jsKey: field.name,
                storageKey: field.cloudKit.key,
                kind: field.cloudKit.kind,
            }]
            : []
    ));
    const failures = compareSet(
        label,
        actual.map((field) => field.jsKey),
        expected.map((field) => field.jsKey),
    );
    const actualByName = new Map(actual.map((field) => [field.jsKey, field]));
    const mismatches = expected
        .filter((field) => {
            const actualField = actualByName.get(field.jsKey);
            return actualField
                && (actualField.storageKey !== field.storageKey || actualField.kind !== field.kind);
        })
        .map((field) => {
            const actualField = actualByName.get(field.jsKey)!;
            return field.jsKey
                + ' expected ' + field.storageKey + '/' + field.kind
                + ', got ' + actualField.storageKey + '/' + actualField.kind;
        });
    if (mismatches.length > 0) {
        failures.push(label + ' storage mapping:');
        failures.push('  ' + mismatches.join('; '));
    }
    return failures;
};

const encodeNativeFixtureValue = (kind: string, value: unknown): unknown => {
    switch (kind) {
        case 'string':
        case 'date':
            return typeof value === 'string' ? value : undefined;
        case 'integer':
            return typeof value === 'number' ? Math.trunc(value) : undefined;
        case 'boolean':
            return typeof value === 'boolean' ? (value ? 1 : 0) : undefined;
        case 'string-array':
            return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
                ? [...value]
                : undefined;
        case 'json-string':
            return typeof value === 'string' ? value : JSON.stringify(value);
        default:
            return undefined;
    }
};

const decodeNativeFixtureValue = (kind: string, value: unknown): unknown => {
    switch (kind) {
        case 'boolean':
            return value === 1;
        case 'json-string':
            if (typeof value !== 'string') return undefined;
            try {
                return JSON.parse(value);
            } catch {
                return value;
            }
        default:
            return value;
    }
};

const fixtureValuesEqual = (actual: unknown, expected: unknown): boolean => (
    JSON.stringify(actual) === JSON.stringify(expected)
);

const compareNativeTaskFixtureRoundTrip = (
    label: string,
    specs: NativeCloudFieldSpec[],
): string[] => {
    const fixture = TASK_SYNC_SCHEMA_FIXTURE as unknown as Record<string, unknown>;
    const failures: string[] = [];
    const stored = new Map<string, unknown>();

    for (const spec of specs) {
        if (!Object.prototype.hasOwnProperty.call(fixture, spec.jsKey)) {
            failures.push(`  fixture missing ${spec.jsKey}`);
            continue;
        }
        const encoded = encodeNativeFixtureValue(spec.kind, fixture[spec.jsKey]);
        if (encoded === undefined) {
            failures.push(`  ${spec.jsKey} cannot encode as ${spec.kind}`);
            continue;
        }
        stored.set(spec.storageKey, encoded);
    }

    const roundTrip: Record<string, unknown> = { id: fixture.id };
    for (const spec of specs) {
        if (!stored.has(spec.storageKey)) continue;
        roundTrip[spec.jsKey] = decodeNativeFixtureValue(spec.kind, stored.get(spec.storageKey));
    }

    for (const field of TASK_SYNC_FIELD_SCHEMA.filter((entry) => entry.cloudKit !== null)) {
        if (!fixtureValuesEqual(roundTrip[field.name], fixture[field.name])) {
            failures.push(
                `  ${field.name} expected ${JSON.stringify(fixture[field.name])}, got ${JSON.stringify(roundTrip[field.name])}`,
            );
        }
    }

    return failures.length > 0 ? [label + ' fixture round-trip:', ...failures] : [];
};

const runCommand = (label: string, command: string, args: string[]): string[] => {
    const result = spawnSync(command, args, { encoding: 'utf8' });
    if (result.error) return [`${label}: ${result.error.message}`];
    if (result.status === 0) return [];

    const output = [result.stdout, result.stderr]
        .filter((value): value is string => Boolean(value?.trim()))
        .join('\n')
        .trim();
    return [`${label} failed${result.status === null ? '' : ` (exit ${result.status})`}:`, output || '  no output'];
};

const runNativeTaskMapperFixtureChecks = (): string[] => {
    if (process.platform !== 'darwin') return [];

    const fixturePath = resolve('packages/core/src/task-sync-schema.fixture.json');
    const fixtureFields = TASK_SYNC_FIELD_SCHEMA
        .filter((field) => field.cloudKit !== null)
        .map((field) => field.name);
    const temporaryDirectory = mkdtempSync(join(tmpdir(), 'mindwtr-task-mapper-'));
    const failures: string[] = [];

    try {
        const swiftBinary = join(temporaryDirectory, 'swift-task-mapper-check');
        const swiftCompileFailures = runCommand('compile Swift task mapper fixture', 'xcrun', [
            '--sdk', 'macosx', 'swiftc',
            resolve(PATHS.swiftMapper),
            resolve('scripts/swift-task-mapper-fixture-check.swift'),
            '-o', swiftBinary,
        ]);
        failures.push(...swiftCompileFailures);
        if (swiftCompileFailures.length === 0) {
            failures.push(...runCommand(
                'Swift task mapper fixture round-trip',
                swiftBinary,
                [fixturePath, ...fixtureFields],
            ));
        }

        const objcBinary = join(temporaryDirectory, 'objc-task-mapper-check');
        const objcCompileFailures = runCommand('compile Objective-C task mapper fixture', 'xcrun', [
            '--sdk', 'macosx', 'clang',
            '-fobjc-arc',
            '-fblocks',
            '-DMINDWTR_NATIVE_MAPPER_FIXTURE_CHECK',
            resolve(PATHS.objcMapper),
            resolve('scripts/objc-task-mapper-fixture-check.m'),
            '-framework', 'Foundation',
            '-framework', 'AppKit',
            '-framework', 'CloudKit',
            '-o', objcBinary,
        ]);
        failures.push(...objcCompileFailures);
        if (objcCompileFailures.length === 0) {
            failures.push(...runCommand(
                'Objective-C task mapper fixture round-trip',
                objcBinary,
                [fixturePath, ...fixtureFields],
            ));
        }
    } finally {
        rmSync(temporaryDirectory, { recursive: true, force: true });
    }

    return failures;
};


type CloudKitProductionRecord = {
    deployed: string[];
    pendingProduction: string[];
};

const checkCloudKitProductionSchema = (
    nativeFieldSpecs: Record<Entity, NativeCloudFieldSpec[]>,
    recordTypes: Record<Entity, string>,
): string[] => {
    const failures: string[] = [];
    const records = cloudKitProductionSchema.records as Record<string, CloudKitProductionRecord>;
    const expectedRecordTypes = new Set(Object.values(recordTypes));
    const staleRecordTypes = Object.keys(records).filter((recordType) => !expectedRecordTypes.has(recordType));
    if (staleRecordTypes.length > 0) {
        failures.push(`cloudkit-production-schema.json: stale record types: ${staleRecordTypes.join(', ')}`);
    }

    const pendingFields: string[] = [];
    for (const entity of Object.keys(recordTypes) as Entity[]) {
        const recordType = recordTypes[entity];
        const record = records[recordType];
        if (!record) {
            failures.push(`cloudkit-production-schema.json: missing record type ${recordType}`);
            continue;
        }

        const mappedKeys = nativeFieldSpecs[entity].map((field) => field.storageKey);
        const mappedKeySet = new Set(mappedKeys);
        const deployedSet = new Set(record.deployed);
        const pendingSet = new Set(record.pendingProduction);
        const qualified = (keys: string[]) => keys.map((key) => `${recordType}.${key}`).join(', ');

        const listedInBoth = record.deployed.filter((key) => pendingSet.has(key));
        if (listedInBoth.length > 0) {
            failures.push(`cloudkit-production-schema.json: keys listed in both deployed and pendingProduction: ${qualified(listedInBoth)}`);
        }

        const stale = [...record.deployed, ...record.pendingProduction].filter((key) => !mappedKeySet.has(key));
        if (stale.length > 0) {
            failures.push(`cloudkit-production-schema.json: keys no longer mapped in native CloudKit schemas (stale): ${qualified(stale)}`);
        }

        const unlisted = mappedKeys.filter((key) => !deployedSet.has(key) && !pendingSet.has(key));
        if (unlisted.length > 0) {
            failures.push(`cloudkit-production-schema.json: CloudKit-mapped fields missing from both lists: ${qualified(unlisted)}`);
        }

        pendingFields.push(...record.pendingProduction.map((key) => `${recordType}.${key}`));
    }

    if (pendingFields.length > 0) {
        const message = `CloudKit fields pending Production deployment: ${pendingFields.join(', ')}. `
            + 'Deploy them in the CloudKit Dashboard (Production container), then move them to '
            + '"deployed" in packages/core/src/cloudkit-production-schema.json.';
        if (RELEASE_GATE) {
            failures.push(message);
        } else {
            console.log(message);
        }
    }

    return failures;
};

const failures: string[] = [];

const coreTypes = read(PATHS.coreTypes);
const coreSqliteSchema = read(PATHS.coreSqliteSchema);
const desktopRustStorage = read(PATHS.desktopRustStorage);
const desktopRustProductionStorage = desktopRustStorage.split(/\n#\[cfg\(test\)\]\nmod tests\s*\{/)[0];
const swiftMapper = read(PATHS.swiftMapper);
const objcMapper = read(PATHS.objcMapper);
const mcpQueries = read(PATHS.mcpQueries);
const ENTITIES: Entity[] = ['task', 'project', 'section', 'area', 'person'];
const swiftFieldSpecs = Object.fromEntries(
    ENTITIES.map((entity) => [entity, parseSwiftFieldSpecs(swiftMapper, entity)]),
) as Record<Entity, NativeCloudFieldSpec[]>;
const cloudKitRecordTypes = Object.fromEntries(
    ENTITIES.map((entity) => [entity, parseSwiftRecordType(swiftMapper, entity)]),
) as Record<Entity, string>;
const objcFieldSpecs = Object.fromEntries(
    ENTITIES.map((entity) => [entity, parseObjcFieldSpecs(objcMapper, entity)]),
) as Record<Entity, NativeCloudFieldSpec[]>;
const swiftTaskFieldSpecs = swiftFieldSpecs.task;
const objcTaskFieldSpecs = objcFieldSpecs.task;

failures.push(...compareTaskInterface(coreTypes));


const syncSignatureComparableKeys = Object.keys(
    normalizeTaskForContentComparison(TASK_SYNC_SCHEMA_FIXTURE),
);
const syncSignatureExcludedKeys: readonly string[] = TASK_CONTENT_COMPARISON_EXCLUDED_KEYS;
const syncSignatureTaskFieldUnion = Array.from(new Set([
    ...syncSignatureComparableKeys,
    ...syncSignatureExcludedKeys,
]));


const SYNC_SIGNATURE_FIELD_UNION_EXCEPTIONS: string[] = [];
failures.push(...compareSet(
    'sync-signatures.ts task field union',
    syncSignatureTaskFieldUnion,
    TASK_SYNC_FIELD_SCHEMA
        .map((field) => field.name)
        .filter((name) => !SYNC_SIGNATURE_FIELD_UNION_EXCEPTIONS.includes(name)),
));


const requiredCloudTaskPatchFields = Array.from(new Set(
    TASK_SYNC_FIELD_SCHEMA
        .filter((field) => field.cloudWrite === 'create-patch' || field.cloudWrite === 'patch')
        .map((field) => field.name)
));
failures.push(...assertSuperset(
    'cloud CLOUD_TASK_PATCH_ALLOWED_PROP_KEYS',
    CLOUD_TASK_PATCH_ALLOWED_PROP_KEYS as Iterable<string>,
    requiredCloudTaskPatchFields,
));
failures.push(...compareSet('core TASK_SQLITE_COLUMNS', Array.from(TASK_SQLITE_COLUMNS), EXPECTED.task.sqlite));
failures.push(...compareSet(
    'core TASK_UPSERT_UPDATE_CLAUSE',
    coreTaskUpdateColumns(),
    EXPECTED.task.sqlite.filter((field) => field !== 'id'),
));
failures.push(...compareSet(
    'core ensureTaskColumns',
    coreTaskMigrationColumns(),
    EXPECTED.task.sqlite.filter((field) => !['id', 'title', 'status'].includes(field)),
));
failures.push(...compareNativeTaskFieldSpecs(
    'iOS CloudKit task fields',
    swiftTaskFieldSpecs,
));
failures.push(...compareNativeTaskFieldSpecs(
    'macOS CloudKit task fields',
    objcTaskFieldSpecs,
));
failures.push(...compareNativeTaskFixtureRoundTrip('iOS CloudKit task mapper', swiftTaskFieldSpecs));
failures.push(...compareNativeTaskFixtureRoundTrip('macOS CloudKit task mapper', objcTaskFieldSpecs));
failures.push(...runNativeTaskMapperFixtureChecks());
failures.push(...checkCloudKitProductionSchema(swiftFieldSpecs, cloudKitRecordTypes));


failures.push(...requireSourcePattern(
    'MCP task projection',
    mcpQueries,
    /const BASE_TASK_COLUMNS = \[\.\.\.TASK_SQLITE_COLUMNS\];/,
));
failures.push(...requireSourcePattern(
    'MCP project projection',
    mcpQueries,
    /const BASE_PROJECT_COLUMNS = \[\.\.\.PROJECT_SQLITE_COLUMNS\];/,
));


failures.push(...assertSuperset(
    'MCP TASK_WRITE_FIELD_EXCLUSIONS',
    TASK_SYNC_FIELD_SCHEMA
        .filter((field) => field.cloudWrite === 'create-patch' || field.cloudWrite === 'patch')
        .map((field) => field.name),
    Object.keys(TASK_WRITE_FIELD_EXCLUSIONS),
));

for (const entity of ENTITIES) {
    const table = entity === 'person' ? 'people' : `${entity}s`;


    const legacySqlite = entity === 'area'
        ? ['deletedAtBeforeProjectArchive', 'projectArchivedAt']
        : [];
    const expectedSqlite = [...EXPECTED[entity].sqlite, ...legacySqlite];

    failures.push(...compareSet(`core SQLite schema ${table}`, parseCreateTableColumns(coreSqliteSchema, table), expectedSqlite));
    failures.push(...compareSet(`desktop Rust schema ${table}`, parseCreateTableColumns(desktopRustStorage, table), expectedSqlite));
    failures.push(...compareSet(`desktop Rust storage INSERT ${table}`, parseRustInsertColumns(desktopRustStorage, table), expectedSqlite));

    failures.push(...compareForeignKeys(
        `desktop Rust schema ${table}`,
        parseForeignKeyReferences(desktopRustStorage, table),
        parseForeignKeyReferences(coreSqliteSchema, table)
    ));
}

failures.push(...compareRequiredPragmas('core SQLite schema', coreSqliteSchema));
    failures.push(...compareDesktopRequiredPragmas('desktop Rust schema', desktopRustStorage));

for (const table of ['tasks_fts', 'projects_fts']) {
    const coreDefinitions = parseFtsTableColumnLists(coreSqliteSchema, table);
    if (coreDefinitions.length !== 1) {
        failures.push(`core SQLite ${table} schema: expected one definition, got ${coreDefinitions.length}`);
        continue;
    }
    failures.push(...compareFtsTableDefinitions(
        `desktop Rust ${table} schema`,
        parseFtsTableColumnLists(desktopRustProductionStorage, table),
        coreDefinitions[0],
    ));
}

failures.push(...compareFtsTriggers(
    'desktop Rust',
    parseFtsTriggers(desktopRustProductionStorage),
    parseFtsTriggers(coreSqliteSchema),
));

for (const entity of ENTITIES) {
    const expectedCloud = EXPECTED[entity].cloud;
    const swiftSpecs = swiftFieldSpecs[entity];
    const objcSpecs = objcFieldSpecs[entity];

    failures.push(...compareSet(`iOS CloudKit ${entity} fields`, swiftSpecs.map((field) => field.jsKey), expectedCloud));
    failures.push(...compareSet(`macOS CloudKit ${entity} fields`, objcSpecs.map((field) => field.jsKey), expectedCloud));
    failures.push(...compareNativeFieldMappings(`native CloudKit ${entity} storage mapping`, objcSpecs, swiftSpecs));
}

if (failures.length > 0) {
    console.error('Synced field parity check failed. Update all schema/mapper field lists together.');
    console.error(failures.join('\n'));
    process.exit(1);
}

console.log('Synced field parity check passed.');
