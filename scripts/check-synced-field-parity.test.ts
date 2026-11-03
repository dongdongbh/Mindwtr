import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';


const REPO_ROOT = join(import.meta.dir, '..');
const SCHEMA_PATH = join(REPO_ROOT, 'packages/core/src/cloudkit-production-schema.json');
const DESKTOP_RUST_STORAGE_PATH = join(REPO_ROOT, 'apps/desktop/src-tauri/src/storage.rs');
const SCRIPT_PATH = join(REPO_ROOT, 'scripts/check-synced-field-parity.ts');
const BUN_BIN = Bun.which('bun') || process.execPath;

const originalSchema = readFileSync(SCHEMA_PATH, 'utf8');
const originalDesktopRustStorage = readFileSync(DESKTOP_RUST_STORAGE_PATH, 'utf8');
type ProductionRecord = { deployed: string[]; pendingProduction: string[] };
type ProductionSchema = { records: Record<string, ProductionRecord> };


afterEach(() => {
    writeFileSync(SCHEMA_PATH, originalSchema);
    writeFileSync(DESKTOP_RUST_STORAGE_PATH, originalDesktopRustStorage);
});

const runCheck = (args: string[] = []) => (
    spawnSync(BUN_BIN, ['run', SCRIPT_PATH, ...args], { cwd: REPO_ROOT, encoding: 'utf8' })
);

const runCheckWithSchema = (schema: unknown, args: string[] = []) => {
    writeFileSync(SCHEMA_PATH, JSON.stringify(schema, null, 4) + '\n');
    try {
        return runCheck(args);
    } finally {
        writeFileSync(SCHEMA_PATH, originalSchema);
    }
};

const runCheckWithDesktopRustStorage = (source: string) => {
    writeFileSync(DESKTOP_RUST_STORAGE_PATH, source);
    try {
        return runCheck();
    } finally {
        writeFileSync(DESKTOP_RUST_STORAGE_PATH, originalDesktopRustStorage);
    }
};

const parseSchema = (): ProductionSchema => JSON.parse(originalSchema);

const markAllDeployed = (schema: ProductionSchema) => {
    for (const record of Object.values(schema.records)) {
        record.deployed = [...record.deployed, ...record.pendingProduction];
        record.pendingProduction = [];
    }
};

describe('CloudKit production schema gate', () => {
    test('passes on the current repo state without --release-gate', () => {
        const result = runCheck();
        expect(result.status).toBe(0);
    });

    test('fails when a CloudKit-mapped field is listed in neither deployed nor pendingProduction', () => {
        const schema = parseSchema();
        schema.records.MindwtrTask.deployed = schema.records.MindwtrTask.deployed.filter((key) => key !== 'title');
        const result = runCheckWithSchema(schema);
        expect(result.status).toBe(1);
        expect(result.stdout + result.stderr).toContain('missing from both lists');
        expect(result.stdout + result.stderr).toContain('MindwtrTask.title');
    });

    test('fails when a key is listed in both deployed and pendingProduction', () => {
        const schema = parseSchema();
        schema.records.MindwtrTask.pendingProduction.push('title');
        const result = runCheckWithSchema(schema);
        expect(result.status).toBe(1);
        expect(result.stdout + result.stderr).toContain('listed in both deployed and pendingProduction');
    });

    test('fails when a listed key no longer exists in its CloudKit record schema', () => {
        const schema = parseSchema();
        schema.records.MindwtrPerson.deployed.push('notARealCloudKitKey');
        const result = runCheckWithSchema(schema);
        expect(result.status).toBe(1);
        expect(result.stdout + result.stderr).toContain('stale');
        expect(result.stdout + result.stderr).toContain('MindwtrPerson.notARealCloudKitKey');
    });

    test('requires every synced CloudKit record type to be classified', () => {
        const schema = parseSchema();
        delete schema.records.MindwtrArea;
        const result = runCheckWithSchema(schema);
        expect(result.status).toBe(1);
        expect(result.stdout + result.stderr).toContain('missing record type MindwtrArea');
    });

    test('records project taskSortBy as deployed in Production', () => {
        const schema = parseSchema();
        expect(schema.records.MindwtrProject.deployed).toContain('taskSortBy');
        expect(schema.records.MindwtrProject.pendingProduction).not.toContain('taskSortBy');
    });

    test('--release-gate fails while pendingProduction is non-empty', () => {
        const schema = parseSchema();
        markAllDeployed(schema);
        schema.records.MindwtrTask.deployed = schema.records.MindwtrTask.deployed.filter((key) => key !== 'title');
        schema.records.MindwtrTask.pendingProduction.push('title');
        const result = runCheckWithSchema(schema, ['--release-gate']);
        expect(result.status).toBe(1);
        expect(result.stdout + result.stderr).toContain('pending Production deployment');
        expect(result.stdout + result.stderr).toContain('MindwtrTask.title');
    });

    test('--release-gate passes once pendingProduction is empty', () => {
        const schema = parseSchema();
        markAllDeployed(schema);
        const result = runCheckWithSchema(schema, ['--release-gate']);
        expect(result.status).toBe(0);
    });
});

describe('desktop Rust FTS parity', () => {
    test('fails when per-connection SQLite busy timeout configuration drifts', () => {
        const source = originalDesktopRustStorage.replace(
            'busy_timeout(Duration::from_millis(SQLITE_BUSY_TIMEOUT_MS))',
            'busy_timeout(Duration::from_millis(1))',
        );
        expect(source).not.toBe(originalDesktopRustStorage);

        const result = runCheckWithDesktopRustStorage(source);

        expect(result.status).toBe(1);
        expect(result.stdout + result.stderr).toContain('5000ms busy_timeout connection configuration');
    });

    test('fails when a task FTS schema omits a core column', () => {
        const source = originalDesktopRustStorage.replace(
            "  assignedTo,\n  content=''",
            "  content=''",
        );
        expect(source).not.toBe(originalDesktopRustStorage);

        const result = runCheckWithDesktopRustStorage(source);

        expect(result.status).toBe(1);
        expect(result.stdout + result.stderr).toContain('desktop Rust tasks_fts schema');
        expect(result.stdout + result.stderr).toContain('assignedTo');
    });

    test('fails when a task FTS trigger omits a core value mapping', () => {
        const source = originalDesktopRustStorage.replace(
            "coalesce(new.location, '')",
            "''",
        );
        expect(source).not.toBe(originalDesktopRustStorage);

        const result = runCheckWithDesktopRustStorage(source);

        expect(result.status).toBe(1);
        expect(result.stdout + result.stderr).toContain('desktop Rust tasks_ai trigger');
    });
});
