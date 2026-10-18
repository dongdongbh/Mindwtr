// check-data-device.mjs's expected import (pass D1b): core's own result of importing a fixture into the library the phone
// had just before. It loads a copy of the phone's database through core's store, then runs core's importer (parseImportSource
// and applyImportSource, as the native backup document does) over the in-memory snapshot. Run with bun:
//   bun apps/android-native/scripts/data-import-expected.ts <a copy of the phone's mindwtr.db> <importer> <fixture file> <run>
// Prints the live tasks whose title starts `d1` and ends with <run>: `[{ "title", "status", "project" }]`, sorted by title.
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { applyImportSource, parseImportSource, type ImportPickerSourceId } from '../../../packages/core/src/import-runner';
import { openScratchSqlite } from '../../../packages/core/src/screen-parity.replay';
import { SqliteAdapter } from '../../../packages/core/src/sqlite-adapter';
import { setStorageAdapter, useTaskStore } from '../../../packages/core/src/store';
import { getInMemoryAppDataSnapshot } from '../../../packages/core/src/sync-client-helpers';

const [database, importer, fixture, run] = process.argv.slice(2) as [string, ImportPickerSourceId, string, string];
const sql = openScratchSqlite(database);
try {
    setStorageAdapter(new SqliteAdapter(sql.client));
    // A recovery load reads the rows as they are: no maintenance writes into the copy.
    await useTaskStore.getState().fetchData({ throwOnError: true, recoveryLoad: true });
    const parsed = parseImportSource(importer, { bytes: readFileSync(fixture), fileName: basename(fixture) }) as {
        parsedData?: unknown; parsedProjects?: unknown; valid: boolean;
    };
    if (!parsed.valid) throw new Error(`core refused the ${importer} fixture`);
    const source = importer === 'todoist' ? parsed.parsedProjects : parsed.parsedData;
    const { data } = applyImportSource(importer, getInMemoryAppDataSnapshot(), source as never);
    const projects = new Map(data.projects.map((project) => [project.id, project.title]));
    const rows = data.tasks
        .filter((task) => !task.deletedAt && task.title.startsWith('d1') && task.title.endsWith(run))
        .map((task) => ({ title: task.title, status: task.status, project: task.projectId ? projects.get(task.projectId) ?? null : null }))
        .sort((left, right) => left.title.localeCompare(right.title));
    process.stdout.write(JSON.stringify(rows));
} finally {
    sql.close();
}
