import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { LanguageProvider } from '../contexts/language-context';
import { QuickAddModal } from './QuickAddModal';

const uploadTarget = vi.hoisted(() => vi.fn());

vi.mock('../lib/web-attachment-upload', async () => {
    const actual = await vi.importActual<typeof import('../lib/web-attachment-upload')>('../lib/web-attachment-upload');
    return { ...actual, getWebAttachmentUploadTarget: uploadTarget };
});
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => false) }));
vi.mock('@tauri-apps/api/event', () => ({ emitTo: vi.fn(async () => undefined), listen: vi.fn(async () => () => undefined) }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({ hide: vi.fn(async () => undefined) }) }));
vi.mock('@tauri-apps/plugin-fs', () => ({
    BaseDirectory: { Data: 'Data' },
    mkdir: vi.fn(async () => undefined),
    readFile: vi.fn(async () => new Uint8Array()),
    remove: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined),
}));
vi.mock('@tauri-apps/api/path', () => ({
    dataDir: vi.fn(async () => '/data'),
    join: vi.fn(async (...parts: string[]) => parts.join('/')),
}));

const openSyntaxHelp = async () => {
    render(
        <LanguageProvider>
            <QuickAddModal />
        </LanguageProvider>
    );
    await act(async () => {
        window.dispatchEvent(new CustomEvent('mindwtr:quick-add', { detail: {} }));
        await Promise.resolve();
    });
    const details = screen.getByText('Quick Add syntax help').closest('details') as HTMLDetailsElement;
    await act(async () => {
        details.open = true;
        fireEvent(details, new Event('toggle'));
        await Promise.resolve();
    });
};

describe('QuickAddModal paste hint (#1433)', () => {
    it('tells the web build it can paste images when self-hosted Cloud can take them', async () => {
        uploadTarget.mockResolvedValue({ url: 'https://cloud.example', generation: '1' });
        await openSyntaxHelp();
        await waitFor(() => expect(screen.getByText('Paste images or screenshots with Ctrl+V to attach them.')).toBeInTheDocument());
    });

    it('hides the hint where the web build cannot attach a pasted image', async () => {
        uploadTarget.mockRejectedValue(new Error('no cloud'));
        await openSyntaxHelp();
        await waitFor(() => expect(uploadTarget).toHaveBeenCalled());
        expect(screen.queryByText(/Paste images or screenshots/)).toBeNull();
    });
});
