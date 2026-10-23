import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const gmail = vi.hoisted(() => ({
    getConfig: vi.fn(), labels: vi.fn(), connect: vi.fn(), cancel: vi.fn(), configure: vi.fn(), disconnect: vi.fn(), check: vi.fn(),
}));
vi.mock('../../../lib/gmail-capture', async (original) => ({
    ...(await original<typeof import('../../../lib/gmail-capture')>()),
    getGmailCaptureConfig: gmail.getConfig,
    getGmailCaptureLabels: gmail.labels,
    connectGmailCapture: gmail.connect,
    cancelGmailCapture: gmail.cancel,
    configureGmailCapture: gmail.configure,
    disconnectGmailCapture: gmail.disconnect,
    pollGmailCaptureNow: gmail.check,
}));

import { LanguageProvider } from '../../../contexts/language-context';
import { SettingsGmailCaptureSection } from './SettingsGmailCaptureSection';
import type { GmailCaptureConfig } from '../../../lib/gmail-capture';

const disconnected = (): GmailCaptureConfig => ({
    available: true, connected: false, account: null, accountId: null, labelId: null, enabled: false,
});
const connected = (): GmailCaptureConfig => ({
    ...disconnected(), connected: true, account: 'designated@example.test', accountId: 'mailbox-hash',
});
const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
};
const mount = () => {
    const showSaved = vi.fn();
    const view = render(<LanguageProvider><SettingsGmailCaptureSection isTauri showSaved={showSaved} /></LanguageProvider>);
    fireEvent.click(view.getByRole('button', { name: /^Gmail Connect Google/ }));
    return { ...view, showSaved };
};

beforeEach(() => {
    Object.values(gmail).forEach((mock) => mock.mockReset());
    gmail.getConfig.mockResolvedValue(disconnected());
    gmail.labels.mockResolvedValue([{ id: 'Label_1', name: 'Mindwtr' }, { id: 'Label_2', name: 'Work' }]);
    gmail.cancel.mockResolvedValue(undefined);
    gmail.disconnect.mockResolvedValue({ revoked: true });
});

describe('Gmail capture settings', () => {
    it('shows the whole-mailbox and task-data disclosure before browser connect', async () => {
        const view = mount();
        const connect = view.getByRole('button', { name: 'Connect Gmail' });
        await waitFor(() => expect(connect).toBeEnabled());
        expect(view.getByText(/Google grants read-only access to your whole mailbox/)).toHaveTextContent(/sync, backups, exports, or optional AI/);
        expect(gmail.connect).not.toHaveBeenCalled();
        gmail.connect.mockResolvedValue(connected());
        fireEvent.click(connect);
        await waitFor(() => expect(view.getByText('designated@example.test')).toBeInTheDocument());
        expect(view.getByRole('combobox', { name: 'Gmail label' })).toHaveValue('Label_1');
        expect(view.getByText('Capture is paused until you confirm a label.')).toBeInTheDocument();
        expect(gmail.configure).not.toHaveBeenCalled();
        expect(gmail.check).not.toHaveBeenCalled();
    });

    it('requires explicit label confirmation, preserves a failed draft, and only shows active after successful save', async () => {
        gmail.getConfig.mockResolvedValue({ ...connected(), enabled: true, labelId: 'Label_1' });
        gmail.configure.mockRejectedValueOnce({ kind: 'config', message: 'private-provider-response' })
            .mockResolvedValueOnce({ ...connected(), enabled: true, labelId: 'Label_2' });
        const view = mount();
        const select = await view.findByRole('combobox', { name: 'Gmail label' });
        await waitFor(() => expect(select).toHaveValue('Label_1'));
        expect(view.getByText('Capturing emails from the saved label.')).toBeInTheDocument();
        fireEvent.change(select, { target: { value: 'Label_2' } });
        expect(gmail.configure).not.toHaveBeenCalled();
        fireEvent.click(view.getByRole('button', { name: 'Start capture / save label' }));
        await waitFor(() => expect(view.getByRole('alert')).toHaveTextContent('Check your Gmail label and connection.'));
        expect(select).toHaveValue('Label_2');
        expect(view.showSaved).not.toHaveBeenCalled();
        expect(view.getByText('Capture is paused until you confirm a label.')).toBeInTheDocument();
        expect(view.getByRole('button', { name: 'Check now' })).toBeDisabled();
        fireEvent.click(view.getByRole('button', { name: 'Start capture / save label' }));
        await waitFor(() => expect(view.getByText('Capturing emails from the saved label.')).toBeInTheDocument());
        expect(gmail.configure).toHaveBeenLastCalledWith('Label_2', true);
        expect(view.showSaved).toHaveBeenCalledOnce();
        expect(view.queryByRole('alert')).toBeNull();
    });

    it('offers an empty choice when the suggested label does not exist and never creates one', async () => {
        gmail.getConfig.mockResolvedValue(connected());
        gmail.labels.mockResolvedValue([{ id: 'Label_2', name: 'Work' }]);
        const view = mount();
        const select = await view.findByRole('combobox', { name: 'Gmail label' });
        expect(select).toHaveValue('');
        expect(view.getByRole('button', { name: 'Start capture / save label' })).toBeDisabled();
        expect(view.getByText(/Create a label in Gmail first/)).toBeInTheDocument();
        expect(gmail.configure).not.toHaveBeenCalled();
    });

    it('cancels the pending connection and ignores its late completion', async () => {
        const connection = deferred<GmailCaptureConfig>();
        gmail.connect.mockReturnValue(connection.promise);
        const view = mount();
        const connect = view.getByRole('button', { name: 'Connect Gmail' });
        await waitFor(() => expect(connect).toBeEnabled());
        fireEvent.click(connect);
        fireEvent.click(await view.findByRole('button', { name: 'Cancel connection' }));
        await waitFor(() => expect(gmail.cancel).toHaveBeenCalledOnce());
        await act(async () => { connection.resolve(connected()); });
        expect(view.queryByText('designated@example.test')).toBeNull();
        expect(gmail.labels).not.toHaveBeenCalled();
        expect(view.getByRole('status')).toHaveTextContent('Gmail connection cancelled.');
    });

    it('disconnects during a pending label save and ignores its stale enabled result', async () => {
        gmail.getConfig.mockResolvedValue(connected());
        const save = deferred<GmailCaptureConfig>();
        gmail.configure.mockReturnValue(save.promise);
        gmail.disconnect.mockResolvedValue({ revoked: false });
        const view = mount();
        const start = await view.findByRole('button', { name: 'Start capture / save label' });
        await waitFor(() => expect(start).toBeEnabled());
        fireEvent.click(start);
        fireEvent.click(view.getByRole('button', { name: 'Disconnect Gmail' }));
        await waitFor(() => expect(gmail.disconnect).toHaveBeenCalledOnce());
        await act(async () => { save.resolve({ ...connected(), enabled: true, labelId: 'Label_1' }); });
        expect(view.queryByText('designated@example.test')).toBeNull();
        expect(view.queryByRole('combobox')).toBeNull();
        expect(view.getByRole('status')).toHaveTextContent(/Local credentials were removed/);
        expect(view.getByRole('status')).toHaveTextContent(/Google Account permissions/);
        expect(view.showSaved).toHaveBeenCalledOnce();
    });

    it('does not restore the previous account after a failed reconnect', async () => {
        gmail.getConfig.mockResolvedValue({ ...connected(), enabled: true, labelId: 'Label_1' });
        gmail.connect.mockRejectedValue({ kind: 'cancelled' });
        const view = mount();
        const reconnect = await view.findByRole('button', { name: 'Reconnect Gmail' });
        fireEvent.click(reconnect);
        await waitFor(() => expect(view.getByRole('alert')).toHaveTextContent('Gmail connection cancelled.'));
        expect(view.queryByText('designated@example.test')).toBeNull();
        expect(view.queryByRole('combobox')).toBeNull();
        expect(view.getByRole('button', { name: 'Connect Gmail' })).toBeEnabled();
    });
});
