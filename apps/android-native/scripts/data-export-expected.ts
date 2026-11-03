


import { serializeBackupData } from '../../../packages/core/src/backup-transfer';
import { serializeMindwtrCsv } from '../../../packages/core/src/mindwtr-csv-export';
import { openScratchSqlite } from '../../../packages/core/src/screen-parity.replay';
import { SqliteAdapter } from '../../../packages/core/src/sqlite-adapter';
import { setStorageAdapter, useTaskStore } from '../../../packages/core/src/store';
import { getInMemoryAppDataSnapshot } from '../../../packages/core/src/sync-client-helpers';
import { serializeTaskNotesExport } from '../../../packages/core/src/tasknotes-export';

const sql = openScratchSqlite(process.argv[2]);
try {
    setStorageAdapter(new SqliteAdapter(sql.client));

    await useTaskStore.getState().fetchData({ throwOnError: true, recoveryLoad: true });
    const data = getInMemoryAppDataSnapshot();
    process.stdout.write(JSON.stringify({ json: serializeBackupData(data), csv: serializeMindwtrCsv(data), tasknotes: serializeTaskNotesExport(data).files }));
} finally {
    sql.close();
}
