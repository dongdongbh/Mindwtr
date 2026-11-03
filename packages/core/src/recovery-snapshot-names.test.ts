import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
    buildRecoverySnapshotFileName,
    formatRecoverySnapshotLabel,
    RECOVERY_SNAPSHOT_FILE_PATTERN,
    recoverySnapshotNamesToPrune,
    sortRecoverySnapshotNames,
} from './recovery-snapshot-names';


describe('recovery snapshot names (mobile parity)', () => {
    const tz = process.env.TZ;
    afterEach(() => { process.env.TZ = tz; });

    it('names an instant as mobile does, with the clash number before the suffix', () => {
        const at = new Date('2026-08-09T12:34:05.123Z');
        expect(buildRecoverySnapshotFileName(at)).toBe('data.2026-08-09T12-34-05.123.snapshot.json');
        expect(buildRecoverySnapshotFileName(at, 2)).toBe('data.2026-08-09T12-34-05.123.2.snapshot.json');
        expect(RECOVERY_SNAPSHOT_FILE_PATTERN.test('data.pending.snapshot.tmp')).toBe(false);
    });

    it('orders newest first by instant, then by clash number, and leaves other names out', () => {
        const names = [
            'data.2026-08-09T12-34-05.snapshot.json',
            'notes.txt',
            'data.2026-08-09T12-34-05.123.1.snapshot.json',
            'data.2026-08-10T00-00-00.000.snapshot.json',
            'data.2026-08-09T12-34-05.123.snapshot.json',
            'data.pending.snapshot.tmp',
        ];
        expect(sortRecoverySnapshotNames(names)).toEqual([
            'data.2026-08-10T00-00-00.000.snapshot.json',
            'data.2026-08-09T12-34-05.123.1.snapshot.json',
            'data.2026-08-09T12-34-05.123.snapshot.json',
            'data.2026-08-09T12-34-05.snapshot.json',
        ]);
    });

    it('prunes all but the five newest', () => {
        const names = Array.from({ length: 7 }, (_, day) => `data.2026-08-0${day + 1}T00-00-00.000.snapshot.json`);
        expect(recoverySnapshotNamesToPrune(names)).toEqual([
            'data.2026-08-02T00-00-00.000.snapshot.json',
            'data.2026-08-01T00-00-00.000.snapshot.json',
        ]);
    });

    it('never prunes a protected name, which takes one of the five places', () => {
        const future = Array.from({ length: 5 }, (_, day) => `data.2027-01-0${day + 1}T00-00-00.000.snapshot.json`);
        const written = 'data.2026-08-09T12-34-05.123.snapshot.json';
        expect(recoverySnapshotNamesToPrune([...future, written], [written, 'data.2020-01-01T00-00-00.000.snapshot.json']))
            .toEqual(['data.2027-01-01T00-00-00.000.snapshot.json']);
    });

    it('labels a snapshot by its local date and minute; another name stays as it is', () => {
        process.env.TZ = 'UTC';
        const label = formatRecoverySnapshotLabel('data.2026-08-09T12-34-05.123.1.snapshot.json');
        const at = new Date('2026-08-09T12:34:05.123Z');
        expect(label).toBe(`${at.toLocaleDateString()} ${at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
        expect(formatRecoverySnapshotLabel('unrecognized.snapshot.json')).toBe('unrecognized.snapshot.json');
    });

    it('imports nothing, so the capture path loads no import parser', () => {
        const source = readFileSync(new URL('./recovery-snapshot-names.ts', import.meta.url), 'utf8');
        expect(source).not.toMatch(/^import /mu);
    });
});
