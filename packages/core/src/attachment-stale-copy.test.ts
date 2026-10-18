import { describe, expect, it, vi } from 'vitest';
import type { AppData, Attachment } from './types';
import { runAttachmentTransferLifecycle } from './attachment-transfer';
import { assertNoPendingAttachmentContentReplacements, sanitizeAppDataForRemote } from './sync-helpers';
import { mergeAppData } from './sync';
import { consoleLogger, setLogger, type LogPayload } from './logger';
import { toAttachments } from './entity-sync-schema';

// The old file of a remote attachment version the merge chose, but this device has not installed yet. The merge marks it
// (staleContentHash, device-local) with the hash of the bytes this device holds; a prepare pass that finds exactly those bytes
// leaves them for the download instead of uploading them over the newer version. Every other mismatch stays this device's own
// edit (c2-review P2-2; stale-review P1-1, P2-1, P2-2).

const OLD = 'a'.repeat(64);
const NEW = 'b'.repeat(64);
const EDIT = 'c'.repeat(64);
const BACKUP = 'd'.repeat(64);
const AT = '2026-01-01T00:00:00.000Z';
const LATER = '2026-01-02T00:00:00.000Z';

const base = (over: Partial<Attachment>): Attachment => ({
    id: 'att-1', kind: 'file', title: 'f.txt', uri: '/managed/att-1.txt', cloudKey: 'attachments/att-1.txt',
    localStatus: 'available', createdAt: AT, updatedAt: AT,
    ...over,
} as Attachment);

type Disk = { hash: string; stat: { mtimeMs: number; size: number } };

const pass = (attachment: Attachment, phase: 'prepare' | 'post-merge', disk: Disk, extra: {
    onDownload?: ReturnType<typeof vi.fn>;
    onUpload?: ReturnType<typeof vi.fn>;
    afterDownload?: () => void;
} = {}) => {
    const onDownload = extra.onDownload ?? vi.fn(async () => { extra.afterDownload?.(); return true; });
    return runAttachmentTransferLifecycle({
        attachmentsById: new Map([[attachment.id, attachment]]),
        getLocalFilePresence: async () => 'present',
        onUpload: extra.onUpload ?? vi.fn(async () => true),
        onUploadError: vi.fn(),
        onDownload: onDownload as never,
        onDownloadError: vi.fn(),
        deferUploads: phase === 'prepare',
        contentChangePhase: phase,
        getLocalFileStat: async () => ({ ...disk.stat }),
        computeLocalFileHash: async () => disk.hash,
        createUploadSnapshot: async () => ({
            sourcePath: '/private/snap', fileHash: disk.hash, stat: { ...disk.stat }, dispose: async () => undefined,
        }),
        requireUploadSnapshot: true,
    });
};

const docWith = (attachment: Attachment): AppData => ({
    tasks: [{ id: 't1', title: 't', status: 'next', tags: [], contexts: [], createdAt: AT, updatedAt: AT, rev: 1, revBy: 'a',
        attachments: [attachment] } as never],
    projects: [], sections: [], areas: [], people: [], settings: {},
} as unknown as AppData);
const attachmentOf = (data: AppData): Attachment => data.tasks[0].attachments![0];

describe('a remote attachment version merged but not installed yet', () => {
    it('is marked by the merge with the bytes this device holds, and the mark never leaves the device', () => {
        // This device recorded its file (OLD); another device's newer version (NEW, contentRev 2) wins the merge.
        const local = docWith(base({ fileHash: OLD, contentRev: 1, contentMtimeMs: 1000, contentSize: 10 }));
        const incoming = docWith(base({ fileHash: NEW, contentRev: 2, uri: '', localStatus: undefined, updatedAt: LATER }));
        const merged = attachmentOf(mergeAppData(local, incoming));
        expect(merged).toMatchObject({ fileHash: NEW, contentRev: 2, staleContentHash: OLD });
        expect(merged.contentMtimeMs).toBeUndefined();
        expect(attachmentOf(sanitizeAppDataForRemote(docWith(merged))).staleContentHash).toBeUndefined();
        // A merge that keeps this device's identity leaves no mark.
        expect(attachmentOf(mergeAppData(local, docWith(base({ fileHash: OLD, contentRev: 1, uri: '' })))).staleContentHash).toBeUndefined();
    });

    it('is not uploaded as this device\'s own edit by the next prepare pass; the post-merge pass installs over exactly it', async () => {
        const winner = base({ fileHash: NEW, contentRev: 2, staleContentHash: OLD });
        const disk: Disk = { hash: OLD, stat: { mtimeMs: 1000, size: 10 } };
        const lines: LogPayload[] = [];
        setLogger((payload) => { lines.push(payload); });
        let afterPrepare: Attachment;
        try {
            afterPrepare = (await pass(winner, 'prepare', disk)).patches.get('att-1') ?? winner;
        } finally { setLogger(consoleLogger); }
        expect(afterPrepare.pendingContentUpload).toBeUndefined();
        expect(afterPrepare).toMatchObject({ fileHash: NEW, contentRev: 2 });
        expect(lines.filter((line) => line.context?.releaseCheck === 'v1.3.7/attachment-remote-winner-pending')
            .map((line) => line.context?.attachmentId)).toEqual(['att-1']);
        const onDownload = vi.fn(async () => { disk.hash = NEW; return true; });
        const installed = (await pass(afterPrepare, 'post-merge', disk, { onDownload })).patches.get('att-1')!;
        expect(onDownload).toHaveBeenCalledWith(expect.objectContaining({ fileHash: NEW }), { kind: 'present', sha256: OLD });
        // The install records the stat, which clears the mark.
        expect(installed.staleContentHash).toBeUndefined();
        expect(installed.contentMtimeMs).toBe(1000);
    });

    it('A: a restored backup without recorded stats records the disk bytes and uploads them (stale-review P1-1)', async () => {
        const disk: Disk = { hash: EDIT, stat: { mtimeMs: 2000, size: 20 } };
        const restored = base({ fileHash: BACKUP, contentRev: 5, pendingContentUpload: true });
        const prepared = (await pass(restored, 'prepare', disk)).patches.get('att-1') ?? restored;
        expect(prepared).toMatchObject({ fileHash: EDIT, pendingContentUpload: true, contentMtimeMs: 2000 });
        const onUpload = vi.fn(async () => true);
        const posted = (await pass(prepared, 'post-merge', disk, { onUpload })).patches.get('att-1') ?? prepared;
        expect(onUpload).toHaveBeenCalledTimes(1);
        expect(() => assertNoPendingAttachmentContentReplacements(docWith(posted))).not.toThrow();
    });

    it('B: an edit saved right after the winner was installed stays this device\'s edit (stale-review P2-1)', async () => {
        const disk: Disk = { hash: OLD, stat: { mtimeMs: 1000, size: 10 } };
        const winner = base({ fileHash: NEW, contentRev: 2, staleContentHash: OLD });
        const installed = (await pass(winner, 'post-merge', disk, {
            afterDownload: () => { disk.hash = EDIT; disk.stat = { mtimeMs: 3000, size: 30 }; },
        })).patches.get('att-1') ?? winner;
        expect(installed.contentMtimeMs).toBeUndefined();
        const prepared = (await pass(installed, 'prepare', disk)).patches.get('att-1') ?? installed;
        expect(prepared).toMatchObject({ fileHash: EDIT, contentRev: 3, pendingContentUpload: true });
    });

    it('C: an in-place edit from before recorded stats existed is still this device\'s edit (stale-review P2-2)', async () => {
        const disk: Disk = { hash: EDIT, stat: { mtimeMs: 3000, size: 30 } };
        const legacy = base({ fileHash: OLD });
        const prepared = (await pass(legacy, 'prepare', disk)).patches.get('att-1') ?? legacy;
        expect(prepared).toMatchObject({ fileHash: EDIT, pendingContentUpload: true });
    });

    it('a later edit of the not-yet-installed file is this device\'s edit again', async () => {
        const disk: Disk = { hash: EDIT, stat: { mtimeMs: 3000, size: 30 } };
        const winner = base({ fileHash: NEW, contentRev: 2, staleContentHash: OLD });
        const prepared = (await pass(winner, 'prepare', disk)).patches.get('att-1') ?? winner;
        expect(prepared).toMatchObject({ fileHash: EDIT, contentRev: 3, pendingContentUpload: true });
        expect(prepared.staleContentHash).toBeUndefined();
    });

    it('survives this device\'s own storage (the attachments column) and nothing else', () => {
        expect(toAttachments([base({ fileHash: NEW, staleContentHash: OLD.toUpperCase() })])?.[0].staleContentHash).toBe(OLD);
        expect(toAttachments([base({ fileHash: NEW, staleContentHash: 'not-a-hash' })])?.[0].staleContentHash).toBeUndefined();
    });

    it('never applies to this device\'s own pending upload, even with a leftover mark', async () => {
        const disk: Disk = { hash: EDIT, stat: { mtimeMs: 2000, size: 20 } };
        const pending = base({ fileHash: BACKUP, contentRev: 5, pendingContentUpload: true, staleContentHash: EDIT });
        const prepared = (await pass(pending, 'prepare', disk)).patches.get('att-1') ?? pending;
        expect(prepared).toMatchObject({ fileHash: EDIT, pendingContentUpload: true, contentMtimeMs: 2000 });
    });
});

describe('the mark across merges (stale-review2)', () => {
    const Y = 'e'.repeat(64);
    const T3 = '2026-01-03T00:00:00.000Z';
    const docAt = (attachment: Attachment, updatedAt: string): AppData => {
        const data = docWith(attachment);
        (data.tasks[0] as { updatedAt: string }).updatedAt = updatedAt;
        return data;
    };
    // What another device publishes: stripped of every device-local field.
    const remote = (attachment: Attachment, updatedAt = LATER): AppData => sanitizeAppDataForRemote(docAt(attachment, updatedAt));
    const merge = (localRow: Attachment, incoming: AppData): Attachment => attachmentOf(mergeAppData(docWith(localRow), incoming));

    it('two remote winners in a row keep the first mark while the disk still holds the old bytes (N4)', async () => {
        const local = base({ fileHash: OLD, contentRev: 1, contentMtimeMs: 1000, contentSize: 10 });
        const first = merge(local, remote(base({ fileHash: NEW, contentRev: 2 })));
        const disk: Disk = { hash: OLD, stat: { mtimeMs: 1000, size: 10 } };
        const skipped = (await pass(first, 'prepare', disk)).patches.get('att-1') ?? first;
        const second = merge(skipped, remote(base({ fileHash: Y, contentRev: 3 }), T3));
        expect(second).toMatchObject({ fileHash: Y, contentRev: 3, staleContentHash: OLD });
        const prepared = (await pass(second, 'prepare', disk)).patches.get('att-1') ?? second;
        expect(prepared.pendingContentUpload).toBeUndefined();
        expect(prepared.contentRev).toBe(3);
    });

    it('a same-device merge whose result carries a recorded stat sets no mark, so a later winner never uploads the installed bytes (N1)', async () => {
        // Reconcile of this device's own two copies (#964): the newer one already installed NEW and recorded its stat.
        const sqlite = base({ fileHash: OLD, contentRev: 1, contentMtimeMs: 1000, contentSize: 10 });
        const reconciled = merge(sqlite, docAt(base({ fileHash: NEW, contentRev: 2, contentMtimeMs: 5000, contentSize: 50 }), LATER));
        expect(reconciled).toMatchObject({ fileHash: NEW, contentMtimeMs: 5000 });
        expect(reconciled.staleContentHash).toBeUndefined();
        const next = merge(reconciled, remote(base({ fileHash: Y, contentRev: 3 }), T3));
        expect(next.staleContentHash).toBe(NEW);
        const disk: Disk = { hash: NEW, stat: { mtimeMs: 5000, size: 50 } };
        const prepared = (await pass(next, 'prepare', disk)).patches.get('att-1') ?? next;
        expect(prepared.pendingContentUpload).toBeUndefined();
        expect(prepared.contentRev).toBe(3);
    });

    it('a successful install clears the mark even when its stat is not recorded (N2)', async () => {
        const winner = base({ fileHash: NEW, contentRev: 2, staleContentHash: OLD });
        const disk: { hash: string; stat: { mtimeMs: number; size: number } } = { hash: OLD, stat: { mtimeMs: 1000, size: 10 } };
        // The installed file's stat is not readable right after the install.
        let statReadable = true;
        const installed = (await runAttachmentTransferLifecycle({
            attachmentsById: new Map([[winner.id, winner]]),
            getLocalFilePresence: async () => 'present',
            onUpload: vi.fn(async () => true),
            onUploadError: vi.fn(),
            onDownload: vi.fn(async () => { disk.hash = NEW; statReadable = false; return true; }),
            onDownloadError: vi.fn(),
            contentChangePhase: 'post-merge',
            getLocalFileStat: async () => (statReadable ? { ...disk.stat } : null),
            computeLocalFileHash: async () => disk.hash,
        })).patches.get('att-1') ?? winner;
        expect(installed.contentMtimeMs).toBeUndefined();
        expect(installed.staleContentHash).toBeUndefined();
        // A merge before the next prepare marks the installed bytes, so prepare leaves them for the next download.
        const next = merge(installed, remote(base({ fileHash: Y, contentRev: 3 }), T3));
        expect(next.staleContentHash).toBe(NEW);
        disk.stat = { mtimeMs: 5000, size: 50 };
        const prepared = (await pass(next, 'prepare', disk)).patches.get('att-1') ?? next;
        expect(prepared.pendingContentUpload).toBeUndefined();
    });

    it('a download adopted from its target clears the mark like an install, even when its stat is not recorded (D9b W7 + N2)', async () => {
        const winner = base({ fileHash: NEW, contentRev: 2, staleContentHash: OLD, uri: '' });
        const disk = { hash: NEW, stat: { mtimeMs: 1000, size: 10 } };
        const onDownload = vi.fn(async () => true);
        const adopted = (await runAttachmentTransferLifecycle({
            attachmentsById: new Map([[winner.id, winner]]),
            getLocalFilePresence: async () => 'present',
            onUpload: vi.fn(async () => true),
            onUploadError: vi.fn(),
            onDownload,
            onDownloadError: vi.fn(),
            adoptExistingDownload: async (attachment) => { attachment.uri = '/managed/att-1.txt'; return true; },
            contentChangePhase: 'post-merge',
            getLocalFileStat: async () => null,
            computeLocalFileHash: async () => disk.hash,
        })).patches.get('att-1') ?? winner;
        expect(onDownload).not.toHaveBeenCalled();
        expect(adopted.contentMtimeMs).toBeUndefined();
        expect(adopted.staleContentHash).toBeUndefined();
        const next = merge(adopted, remote(base({ fileHash: Y, contentRev: 3 }), T3));
        expect(next.staleContentHash).toBe(NEW);
        const prepared = (await pass(next, 'prepare', disk)).patches.get('att-1') ?? next;
        expect(prepared.pendingContentUpload).toBeUndefined();
    });

    it('a merge with no recorded stat still marks the local identity, which only matches exactly those bytes (N3)', async () => {
        const local = base({ fileHash: OLD, contentRev: 1 });
        const merged = merge(local, remote(base({ fileHash: NEW, contentRev: 2 })));
        expect(merged.staleContentHash).toBe(OLD);
        const prepared = (await pass(merged, 'prepare', { hash: OLD, stat: { mtimeMs: 1000, size: 10 } })).patches.get('att-1') ?? merged;
        expect(prepared.pendingContentUpload).toBeUndefined();
        const edited = (await pass(merged, 'prepare', { hash: EDIT, stat: { mtimeMs: 3000, size: 30 } })).patches.get('att-1') ?? merged;
        expect(edited).toMatchObject({ fileHash: EDIT, contentRev: 3, pendingContentUpload: true });
    });
});
