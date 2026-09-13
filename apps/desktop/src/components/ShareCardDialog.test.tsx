import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ShareCardDialog } from './ShareCardDialog';

const exportMocks = vi.hoisted(() => ({
    renderSvgToPng: vi.fn(async () => new Blob(['png'], { type: 'image/png' })),
    saveShareCardPng: vi.fn(async () => true),
    copyShareCardPng: vi.fn(async () => undefined),
}));

vi.mock('../lib/share-card-export', () => ({
    canCopyShareCardPng: () => false,
    copyShareCardPng: exportMocks.copyShareCardPng,
    renderSvgToPng: exportMocks.renderSvgToPng,
    saveShareCardPng: exportMocks.saveShareCardPng,
}));

const translations: Record<string, string> = {
    'shareCard.title': 'My weekly reflection',
    'shareCard.privacy': 'Only the date and the note you write are included.',
    'shareCard.reflectionLabel': 'What are you taking into next week?',
    'shareCard.reflectionPlaceholder': 'A thought, a decision, or something to make space for.',
    'shareCard.defaultHint': 'The preview starts with a suggested reflection. Write your own to make it yours.',
    'shareCard.styleLabel': 'Card style',
    'shareCard.styleReflection': 'Reflection',
    'shareCard.styleMinimal': 'Minimal',
    'shareCard.styleRipple': 'Ripple',
    'shareCard.preview': 'Image preview',
    'shareCard.save': 'Save image…',
    'shareCard.copy': 'Copy image',
    'shareCard.copied': 'Image copied',
    'shareCard.saved': 'Image saved',
    'shareCard.error': 'Could not create the image. Please try again.',
    'shareCard.close': 'Close',
    'shareCard.generating': 'Preparing image…',
    'shareCard.reviewTitle': 'Weekly review',
    'shareCard.reviewBody': 'A little space to think.',
    'shareCard.qrLabel': 'Download Mindwtr',
};
const t = (key: string) => translations[key] ?? key;

const previewSvg = () => {
    const src = screen.getByRole('img', { name: 'Image preview' }).getAttribute('src') ?? '';
    return decodeURIComponent(src.slice(src.indexOf(',') + 1));
};

describe('ShareCardDialog', () => {
    beforeEach(() => {
        exportMocks.renderSvgToPng.mockReset().mockResolvedValue(new Blob(['png'], { type: 'image/png' }));
        exportMocks.saveShareCardPng.mockReset().mockResolvedValue(true);
        exportMocks.copyShareCardPng.mockReset().mockResolvedValue(undefined);
    });

    it('starts with the frozen review date, an empty note, and the fixed download QR', () => {
        render(<ShareCardDialog onClose={vi.fn()} reviewDate="September 12, 2026" t={t} />);

        expect(screen.getByText('Only the date and the note you write are included.')).toBeInTheDocument();
        expect(screen.getByLabelText('What are you taking into next week?')).toHaveValue('');
        expect(screen.getByText('The preview starts with a suggested reflection. Write your own to make it yours.')).toBeInTheDocument();
        expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Reflection' })).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getByRole('img', { name: 'Image preview' }).parentElement).toHaveStyle({
            backgroundColor: '#f7fbfc',
        });
        expect(previewSvg()).toContain('Weekly review');
        expect(previewSvg()).toContain('September 12, 2026');
        expect(previewSvg()).toContain('https://mindwtr.app/get?ref=share');
    });

    it('exports exactly the current preview with the personal reflection', async () => {
        render(<ShareCardDialog onClose={vi.fn()} reviewDate="September 12, 2026" t={t} />);
        fireEvent.change(screen.getByLabelText('What are you taking into next week?'), {
            target: { value: 'Protect two quiet mornings.' },
        });
        expect(screen.queryByText('The preview starts with a suggested reflection. Write your own to make it yours.')).not.toBeInTheDocument();
        const currentPreview = previewSvg();

        fireEvent.click(screen.getByRole('button', { name: 'Save image…' }));

        await waitFor(() => expect(exportMocks.saveShareCardPng).toHaveBeenCalledTimes(1));
        expect(currentPreview).toContain('Protect two quiet mornings.');
        expect(exportMocks.renderSvgToPng).toHaveBeenCalledWith(currentPreview);
        expect(exportMocks.saveShareCardPng).toHaveBeenCalledWith(
            expect.objectContaining({ type: 'image/png' }),
            'review',
            'Save image…',
        );
        expect(screen.getByRole('status')).toHaveTextContent('Image saved');
    });

    it('shows a calm recoverable error when PNG creation fails', async () => {
        exportMocks.renderSvgToPng.mockRejectedValueOnce(new Error('canvas failed'));
        render(<ShareCardDialog onClose={vi.fn()} reviewDate="September 12, 2026" t={t} />);

        fireEvent.click(screen.getByRole('button', { name: 'Save image…' }));

        expect(await screen.findByRole('alert')).toHaveTextContent('Could not create the image. Please try again.');
        expect(screen.getByRole('button', { name: 'Save image…' })).toBeEnabled();
    });

    it('locks the reflection while exporting so the captured preview stays exact', async () => {
        let finishRendering: ((png: Blob) => void) | undefined;
        exportMocks.renderSvgToPng.mockImplementationOnce(
            () => new Promise((resolve) => {
                finishRendering = resolve;
            }),
        );
        render(<ShareCardDialog onClose={vi.fn()} reviewDate="September 12, 2026" t={t} />);

        const note = screen.getByLabelText('What are you taking into next week?');
        fireEvent.change(note, { target: { value: 'Keep Friday clear.' } });
        fireEvent.click(screen.getByRole('button', { name: 'Save image…' }));

        expect(note).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Reflection' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Minimal' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Ripple' })).toBeDisabled();
        expect(screen.getAllByRole('button', { name: 'Close' })).toEqual([
            expect.objectContaining({ disabled: true }),
            expect.objectContaining({ disabled: true }),
        ]);

        finishRendering?.(new Blob(['png'], { type: 'image/png' }));
        await waitFor(() => expect(note).toBeEnabled());
    });

    it('caps the reflection at 140 Unicode code points and resets it on remount', () => {
        const first = render(<ShareCardDialog onClose={vi.fn()} reviewDate="September 12, 2026" t={t} />);
        const note = screen.getByLabelText('What are you taking into next week?');
        fireEvent.change(note, { target: { value: `${'a'.repeat(139)}🙂extra` } });
        const reflectionPreview = previewSvg();
        fireEvent.click(screen.getByRole('button', { name: 'Minimal' }));
        expect(screen.getByRole('img', { name: 'Image preview' }).parentElement).toHaveStyle({
            backgroundColor: '#f7fbfc',
        });
        fireEvent.click(screen.getByRole('button', { name: 'Ripple' }));
        expect(note).toHaveValue(`${'a'.repeat(139)}🙂`);
        expect(screen.getByText('140/140')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Ripple' })).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getByRole('img', { name: 'Image preview' }).parentElement).toHaveStyle({
            backgroundColor: '#102e52',
        });
        expect(previewSvg()).not.toBe(reflectionPreview);
        first.unmount();

        render(<ShareCardDialog onClose={vi.fn()} reviewDate="September 12, 2026" t={t} />);
        expect(screen.getByLabelText('What are you taking into next week?')).toHaveValue('');
        expect(screen.getByRole('button', { name: 'Reflection' })).toHaveAttribute('aria-pressed', 'true');
    });
});
