import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAutoSyncController } from '../../../../packages/core/src/auto-sync-controller';
import {
    isDesktopSyncRuntimeActive,
    logDesktopAutoSyncTrace,
    resolveVisibilitySyncAction,
    shouldHandleDesktopManualSyncShortcut,
} from './desktop-sync-runtime';

describe('desktop sync runtime helpers', () => {
    afterEach(() => vi.useRealTimers());

    it('keeps the actual periodic controller running while hidden, with editor and disposal gates intact', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        let active = true;
        let editing = false;
        let visibility: DocumentVisibilityState = 'visible';
        const writeLog = vi.fn();
        const performSync = vi.fn(async () => ({ success: true }));
        const controller = createAutoSyncController({
            performSync,
            flushPendingSave: async () => undefined,
            reportError: vi.fn(),
            isRuntimeActive: () => isDesktopSyncRuntimeActive(active),
            shouldPauseWindowSync: () => editing,
            hasPendingLocalChanges: () => false,
            logInfo: (message, extra) => logDesktopAutoSyncTrace(message, extra, visibility, writeLog),
        });
        const changeVisibility = (next: DocumentVisibilityState) => {
            visibility = next;
            const action = resolveVisibilitySyncAction(visibility);
            if (action === 'focus') controller.handleFocus();
            if (action === 'blur') controller.handleBlur();
        };

        changeVisibility('hidden');
        await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
        expect(performSync).toHaveBeenCalledTimes(1);
        expect(writeLog).toHaveBeenCalledWith('Auto sync periodic fired', {
            scope: 'sync', force: true, extra: {
                releaseCheck: 'v1.3.7/windowless-sync', documentVisibility: 'hidden',
                delayMs: '900000', latenessMs: '0', runtimeActive: 'true', editorPause: 'false', outcome: 'requested',
            },
        });

        editing = true;
        changeVisibility('visible');
        changeVisibility('hidden');
        await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
        expect(performSync).toHaveBeenCalledTimes(1);
        expect(writeLog).toHaveBeenCalledWith('Auto sync periodic fired', expect.objectContaining({
            extra: expect.objectContaining({ documentVisibility: 'hidden', outcome: 'editor-paused' }),
        }));

        editing = false;
        await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
        expect(performSync).toHaveBeenCalledTimes(2);
        active = false;
        controller.dispose();
        const receiptCount = writeLog.mock.calls.length;
        expect(vi.getTimerCount()).toBe(0);
        await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
        expect(performSync).toHaveBeenCalledTimes(2);
        expect(writeLog).toHaveBeenCalledTimes(receiptCount);
    });

    it('forces only safe heartbeat and lifecycle projections, leaving ordinary traces on their logging gate', () => {
        const writeLog = vi.fn();
        logDesktopAutoSyncTrace('Auto sync run complete', {
            source: 'periodic', success: 'false', error: 'private transport error', unexpected: 'private task text',
        }, 'hidden', writeLog);
        expect(writeLog).toHaveBeenCalledWith('Auto sync run complete', {
            scope: 'sync', extra: {
                source: 'periodic', success: 'false', error: 'private transport error', unexpected: 'private task text',
            },
        });
        expect(writeLog).toHaveBeenLastCalledWith('Auto sync run complete', {
            scope: 'sync', force: true, extra: {
                releaseCheck: 'v1.3.7/windowless-sync', documentVisibility: 'hidden', source: 'periodic', success: 'false',
            },
        });
        for (const phase of ['start', 'visibility', 'dispose']) {
            logDesktopAutoSyncTrace('Desktop auto sync lifecycle', { phase, runtimeActive: 'true', error: 'private' }, 'visible', writeLog);
            expect(writeLog).toHaveBeenLastCalledWith('Desktop auto sync lifecycle', {
                scope: 'sync', force: true, extra: {
                    releaseCheck: 'v1.3.7/windowless-sync', documentVisibility: 'visible', phase, runtimeActive: 'true',
                },
            });
        }
        for (const source of ['focus', 'blur', 'data-change', 'manual']) {
            const extra = { source, success: 'true', error: '' };
            logDesktopAutoSyncTrace('Auto sync run complete', extra, 'visible', writeLog);
            expect(writeLog).toHaveBeenLastCalledWith('Auto sync run complete', { scope: 'sync', extra });
        }
        logDesktopAutoSyncTrace('Auto sync trigger', { source: 'periodic' }, 'hidden', writeLog);
        expect(writeLog).toHaveBeenLastCalledWith('Auto sync trigger', { scope: 'sync', extra: { source: 'periodic' } });
    });

    it('keeps auto sync active for the browser/PWA shell while the app is active', () => {
        expect(isDesktopSyncRuntimeActive(true)).toBe(true);
    });

    it('pauses sync after the app shell is disposed', () => {
        expect(isDesktopSyncRuntimeActive(false)).toBe(false);
    });

    it('maps tab visibility changes onto existing focus and blur sync hooks', () => {
        expect(resolveVisibilitySyncAction('visible')).toBe('focus');
        expect(resolveVisibilitySyncAction('hidden')).toBe('blur');
    });

    it('allows the manual sync shortcut in browser/PWA when the target is not editable', () => {
        expect(shouldHandleDesktopManualSyncShortcut({
            isEditableTarget: false,
            isShortcut: true,
        })).toBe(true);
    });

    it('ignores manual sync shortcuts inside editable controls', () => {
        expect(shouldHandleDesktopManualSyncShortcut({
            isEditableTarget: true,
            isShortcut: true,
        })).toBe(false);
        expect(shouldHandleDesktopManualSyncShortcut({
            isEditableTarget: false,
            isShortcut: false,
        })).toBe(false);
    });
});
