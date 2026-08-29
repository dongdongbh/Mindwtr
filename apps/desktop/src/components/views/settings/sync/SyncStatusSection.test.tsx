import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SyncStatusSection } from './SyncStatusSection';

const labels = new Proxy<Record<string, string>>({}, {
    get: (_target, key) => String(key),
});

const labelsWith = (overrides: Record<string, string>) => new Proxy(overrides, {
    get: (target, key) => target[String(key)] ?? String(key),
});

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function renderStatus(syncLastResultAt: string, overrides: Record<string, unknown> = {}) {
    return render(
        <SyncStatusSection
            {...({
                conflictCount: 0,
                isLoadingSnapshots: false,
                isRestoringSnapshot: false,
                isSyncTargetValid: true,
                isSyncing: false,
                lastSyncDisplay: 'Never',
                lastSyncError: null,
                lastSyncHistory: [],
                lastSyncStats: null,
                lastSyncStatus: null,
                onRestoreSnapshot: vi.fn(),
                onSyncNow: vi.fn(),
                onUpdateSyncPreferences: vi.fn(),
                snapshots: [],
                syncError: null,
                syncLastResult: 'success',
                syncLastResultAt,
                syncPreferences: {},
                syncQueued: false,
                t: labels,
                ...overrides,
            } as any)}
        />
    );
}

describe('SyncStatusSection', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('expires a recent sync result without waiting for another render', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-27T12:00:00.000Z'));
        const { getByText, queryByText } = renderStatus(new Date().toISOString());

        expect(getByText('lastSyncSuccess')).toBeInTheDocument();

        act(() => {
            vi.advanceTimersByTime(8001);
        });

        expect(queryByText('lastSyncSuccess')).not.toBeInTheDocument();
    });

    it('gives same-minute snapshots unique accessible names and disables them during sync', () => {
        const firstSnapshot = 'data.2026-07-31T12-00-00.123456789.1.snapshot.json';
        const secondSnapshot = 'data.2026-07-31T12-00-00.987654321.2.snapshot.json';
        const { getByRole, queryByText } = renderStatus(new Date().toISOString(), {
            isSyncing: true,
            snapshots: [firstSnapshot, secondSnapshot],
            t: labelsWith({
                recoverySnapshotsRestoreNamed: 'Restore snapshot {{snapshotName}}',
            }),
        });

        fireEvent.click(getByRole('button', { name: 'recoverySnapshots' }));

        expect(getByRole('button', { name: new RegExp(escapeRegex(firstSnapshot)) })).toBeDisabled();
        expect(getByRole('button', { name: new RegExp(escapeRegex(secondSnapshot)) })).toBeDisabled();
        expect(queryByText(firstSnapshot)).not.toBeInTheDocument();
        expect(queryByText(secondSnapshot)).not.toBeInTheDocument();
    });

    it('uses localized labels for sync history metadata', () => {
        const { getByRole, getByText, queryByText } = renderStatus(new Date().toISOString(), {
            lastSyncHistory: [{
                at: '2026-08-01T12:00:00.000Z',
                status: 'success',
                backend: 'webdav',
                type: 'manual',
                conflicts: 0,
                maxClockSkewMs: 0,
                timestampAdjustments: 0,
                details: 'uploaded 2 records',
            }],
            t: labelsWith({
                syncHistoryBackend: 'Source',
                syncHistoryType: 'Kind',
                syncHistoryDetails: 'Info',
            }),
        });

        fireEvent.click(getByRole('button', { name: 'syncHistory' }));

        const historyEntry = getByText(/Source: webdav/);
        expect(historyEntry).toHaveTextContent('Kind: manual');
        expect(historyEntry).toHaveTextContent('Info: uploaded 2 records');
        expect(queryByText(/Backend:|Type:|Details:/)).not.toBeInTheDocument();
    });

    it('shows GTD settings sync enabled by default and preserves an explicit opt-out', () => {
        const onUpdateSyncPreferences = vi.fn();
        const defaultRender = renderStatus(new Date().toISOString(), {
            onUpdateSyncPreferences,
        });

        fireEvent.click(defaultRender.getByRole('button', { name: /syncPreferences/ }));
        const defaultGtdSwitch = defaultRender.getByRole('switch', { name: 'syncPreferenceGtd' });
        expect(defaultGtdSwitch).toBeChecked();
        fireEvent.click(defaultGtdSwitch);
        expect(onUpdateSyncPreferences).toHaveBeenCalledWith({ gtd: false });
        defaultRender.unmount();

        const optedOutRender = renderStatus(new Date().toISOString(), {
            syncPreferences: { gtd: false },
        });
        fireEvent.click(optedOutRender.getByRole('button', { name: /syncPreferences/ }));
        expect(optedOutRender.getByRole('switch', { name: 'syncPreferenceGtd' })).not.toBeChecked();
    });
});
