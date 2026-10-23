import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getEnglishI18nValue } from '@mindwtr/core';
import type { GmailCaptureConfig } from '@mindwtr/core/gmail-capture';
import { GmailCaptureSection } from './gmail-capture-section';

const gmail = vi.hoisted(() => ({
    status: vi.fn(), labels: vi.fn(), connect: vi.fn(), cancel: vi.fn(), configure: vi.fn(), disconnect: vi.fn(), check: vi.fn(),
}));
vi.mock('@/lib/gmail-capture', async () => {
    const core = await import('@mindwtr/core/gmail-capture');
    return {
        getGmailCaptureConfig: gmail.status, getGmailCaptureLabels: gmail.labels,
        connectGmailCapture: gmail.connect, cancelGmailCapture: gmail.cancel,
        configureGmailCapture: gmail.configure, disconnectGmailCapture: gmail.disconnect, pollGmailCaptureNow: gmail.check,
        getGmailCaptureStatus: () => ({ lastPollAt: null, lastImportCount: 0, lastError: null, terminal: false }),
        subscribeGmailCaptureStatus: () => () => undefined,
        toGmailCaptureError: core.toGmailCaptureError, gmailCaptureErrorTranslation: core.gmailCaptureErrorTranslation,
    };
});
vi.mock('@/hooks/use-theme-colors', () => ({ useThemeColors: () => ({
    bg: '#fff', cardBg: '#fff', border: '#ccc', text: '#000', secondaryText: '#555', tint: '#00f', warning: '#b50',
}) }));
vi.mock('./settings.hooks', () => ({ useSettingsLocalization: () => ({ t: (key: string) => getEnglishI18nValue(key) ?? key }) }));

const disconnected = (): GmailCaptureConfig => ({ available: true, connected: false, account: null, accountId: null, labelId: null, enabled: false });
const connected = (): GmailCaptureConfig => ({ ...disconnected(), connected: true, account: 'designated@example.test', accountId: 'mailbox' });
const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
};
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
const press = async (tree: renderer.ReactTestRenderer, id: string) => {
    await act(async () => { tree.root.findByProps({ testID: id }).props.onPress(); await settle(); });
};
const mount = async () => {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => { tree = renderer.create(<GmailCaptureSection />); await settle(); });
    await press(tree, 'gmail-expand');
    return tree;
};

beforeEach(() => {
    Object.values(gmail).forEach((mock) => mock.mockReset());
    gmail.status.mockResolvedValue(disconnected());
    gmail.labels.mockResolvedValue([{ id: 'one', name: 'Mindwtr' }, { id: 'two', name: 'Work' }]);
    gmail.connect.mockResolvedValue(connected());
    gmail.cancel.mockResolvedValue(undefined);
    gmail.disconnect.mockResolvedValue({ revoked: true });
});

describe('RN Gmail settings', () => {
    it('discloses whole-mailbox access and requires an explicit save after suggesting an existing label', async () => {
        const tree = await mount();
        expect(JSON.stringify(tree.toJSON())).toContain('Google grants read-only access to your whole mailbox');
        expect(JSON.stringify(tree.toJSON())).toContain('sync, backups, exports, or optional AI');
        await press(tree, 'gmail-connect');
        expect(tree.root.findByProps({ testID: 'gmail-label-picker' }).props.description).toBe('Mindwtr');
        expect(gmail.configure).not.toHaveBeenCalled();
        expect(gmail.check).not.toHaveBeenCalled();
        gmail.configure.mockResolvedValue({ ...connected(), labelId: 'one', enabled: true });
        await press(tree, 'gmail-save');
        expect(gmail.configure).toHaveBeenCalledWith('one', true);
        expect(tree.root.findByProps({ testID: 'gmail-enabled-status' }).props.children).toBe('Capturing emails from the saved label.');
        act(() => tree.unmount());
    });

    it('pauses visible capture on a failed label save while preserving the selected draft', async () => {
        gmail.status.mockResolvedValue({ ...connected(), labelId: 'one', enabled: true });
        gmail.configure.mockRejectedValue({ kind: 'network', message: 'private-provider-response' });
        const tree = await mount();
        await press(tree, 'gmail-label-picker');
        await press(tree, 'gmail-label-two');
        expect(gmail.configure).not.toHaveBeenCalled();
        await press(tree, 'gmail-save');
        expect(tree.root.findByProps({ testID: 'gmail-enabled-status' }).props.children).toBe('Capture is paused until you confirm a label.');
        expect(tree.root.findByProps({ testID: 'gmail-check' }).props.disabled).toBe(true);
        expect(tree.root.findByProps({ testID: 'gmail-label-picker' }).props.description).toBe('Work');
        expect(tree.root.findByProps({ testID: 'gmail-error' }).props.children).toContain('temporarily unreachable');
        expect(JSON.stringify(tree.toJSON())).not.toContain('private-provider-response');
        act(() => tree.unmount());
    });

    it('ignores a late connection result after cancellation', async () => {
        const connection = deferred<GmailCaptureConfig>();
        gmail.connect.mockReturnValue(connection.promise);
        const tree = await mount();
        await press(tree, 'gmail-connect');
        await press(tree, 'gmail-cancel');
        await act(async () => { connection.resolve(connected()); await settle(); });
        expect(gmail.cancel).toHaveBeenCalledOnce();
        expect(gmail.labels).not.toHaveBeenCalled();
        expect(tree.root.findAllByProps({ testID: 'gmail-label-picker' })).toHaveLength(0);
        expect(tree.root.findByProps({ testID: 'gmail-notice' }).props.children).toBe('Gmail connection cancelled.');
        act(() => tree.unmount());
    });

    it('disconnects during save and ignores its stale enabled result', async () => {
        gmail.status.mockResolvedValue(connected());
        const save = deferred<GmailCaptureConfig>();
        gmail.configure.mockReturnValue(save.promise);
        gmail.disconnect.mockResolvedValue({ revoked: false });
        const tree = await mount();
        await press(tree, 'gmail-save');
        await press(tree, 'gmail-disconnect');
        await act(async () => { save.resolve({ ...connected(), labelId: 'one', enabled: true }); await settle(); });
        expect(tree.root.findAllByProps({ testID: 'gmail-label-picker' })).toHaveLength(0);
        expect(tree.root.findByProps({ testID: 'gmail-notice' }).props.children).toContain('Google Account permissions');
        expect(JSON.stringify(tree.toJSON())).not.toContain('designated@example.test');
        act(() => tree.unmount());
    });

    it('offers no browser action when the native capability or build gate is unavailable', async () => {
        gmail.status.mockResolvedValue({ ...disconnected(), available: false });
        const tree = await mount();
        expect(JSON.stringify(tree.toJSON())).toContain('Gmail capture is unavailable in this build.');
        expect(tree.root.findAllByProps({ testID: 'gmail-connect' })).toHaveLength(0);
        expect(gmail.connect).not.toHaveBeenCalled();
        act(() => tree.unmount());
    });
});
