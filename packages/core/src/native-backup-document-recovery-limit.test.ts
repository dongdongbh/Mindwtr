import { strToU8 } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import { bytesToBase64 } from './base64-bytes';
import { formatI18nTemplate, getTranslator } from './i18n';
import { buildNativeBackupDocumentFailure, prepareNativeBackupDocument } from './native-backup-document';
import type { NativeReceiptSqliteAdapter } from './native-request-receipts';
import type { AppData } from './types';

// The 128 MiB backup cap, scaled down so a small library passes it.
vi.mock('./backup-transfer', async (importOriginal) => ({ ...await importOriginal<typeof import('./backup-transfer')>(), MAX_BACKUP_SOURCE_BYTES: 64 * 1024 }));

const AT = '2026-10-04T12:00:00.000Z';
const t = (key: string, params?: Record<string, number | string>) => formatI18nTemplate(getTranslator('en')(key), params ?? {});

describe('an import over a library whose recovery snapshot passes the backup cap (D1c step 0)', () => {
    it('fails with a size limit in its toast, not an unreadable export', async () => {
        const library: AppData = { tasks: Array.from({ length: 100 }, (_, index) => ({ id: `task-${index}`, title: `Task ${index}`,
            status: 'next' as const, contexts: [], tags: [], description: 'd'.repeat(1024), createdAt: AT, updatedAt: AT, rev: 1 })),
        projects: [], sections: [], areas: [], people: [], settings: {} };
        const adapter = { getData: async () => library, libraryBytes: async () => 0 } as unknown as NativeReceiptSqliteAdapter;
        const prepared = prepareNativeBackupDocument(adapter, { requestId: '11111111-1111-4111-8111-111111111111', mode: 'csv',
            snapshotName: 'data.2026-10-04T12-00-00.000.snapshot.json', text: bytesToBase64(strToU8('Title\nImported')),
            metadata: { fileName: 'tasks.csv', lastModified: Date.parse(AT), appVersion: '1.3.7' } });
        // iOS shows this exact capacity reason (CoreModel.backupControlledFailure), so the code and words stay.
        await expect(prepared).rejects.toThrow('INVALID_INPUT: Recovery snapshot exceeds 128 MiB');
        const error = await prepared.catch((reason: Error) => reason.message);
        for (const operation of ['csv', 'todoist', 'ticktick', 'dgt', 'omnifocus']) {
            expect(buildNativeBackupDocumentFailure(operation, error as string, t, 12).message).toBe(t('settings.importDiagnostics.limitExceeded'));
        }
        expect(buildNativeBackupDocumentFailure('dgt', 'INVALID_INPUT: DGT source exceeds 16 MiB', t, 12).message).toBe(t('settings.importDiagnostics.limitExceeded'));
        expect(buildNativeBackupDocumentFailure('csv', 'INVALID_INPUT: Prepared backup plan exceeds 512 MiB', t, 12).message).toBe(t('settings.importDiagnostics.limitExceeded'));
        // Only core's own capacity reasons: a host's read error that happens to end the same way is still an unreadable export.
        for (const other of ['Cannot open document called report exceeds 3 KiB', 'SAVE_FAILED: report exceeds 16 MiB',
            'INVALID_INPUT: report exceeds 16 MiB', 'INVALID_INPUT: CSV source exceeds 16 MiB.', 'TOO_LARGEX: CSV source exceeds 16 MiB']) {
            expect(buildNativeBackupDocumentFailure('csv', other, t, 12).message).toBe(t('settings.importDiagnostics.cannotRead'));
        }
        // A backup's failure keeps its own words, as before.
        expect(buildNativeBackupDocumentFailure('merge', error as string, t, 12).message).toBe('Recovery snapshot exceeds 128 MiB');
    });
});
