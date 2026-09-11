import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { getEnglishSettingsLabels } from './labels';
import { SettingsFeedbackModal } from './SettingsFeedbackModal';

const t = getEnglishSettingsLabels();

const renderFeedbackModal = (props?: Partial<Parameters<typeof SettingsFeedbackModal>[0]>) => {
    const baseProps: Parameters<typeof SettingsFeedbackModal>[0] = {
        isConfigured: true,
        isOpen: true,
        onClose: vi.fn(),
        onOpenGitHub: vi.fn(),
        onSubmit: vi.fn().mockResolvedValue(undefined),
        t,
    };
    return render(<SettingsFeedbackModal {...baseProps} {...props} />);
};

describe('SettingsFeedbackModal', () => {
    it('uses category-specific message placeholders', () => {
        renderFeedbackModal();

        expect(screen.getByPlaceholderText(t.feedbackMessagePlaceholderBug)).toBeInTheDocument();
        expect(screen.getByRole('combobox', { name: t.feedbackWhere })).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: t.feedbackCategoryFeature }));

        expect(screen.getByPlaceholderText(t.feedbackMessagePlaceholderFeature)).toBeInTheDocument();
        expect(screen.queryByRole('combobox', { name: t.feedbackWhere })).not.toBeInTheDocument();
    });

    it('includes the selected bug location in the submitted message', async () => {
        const onSubmit = vi.fn().mockResolvedValue(undefined);
        renderFeedbackModal({ onSubmit });

        fireEvent.change(screen.getByRole('combobox', { name: t.feedbackWhere }), {
            target: { value: 'sync' },
        });
        fireEvent.change(screen.getByRole('textbox', { name: t.feedbackMessage }), {
            target: { value: 'CloudKit sync failed' },
        });
        fireEvent.click(screen.getByRole('button', { name: t.feedbackSubmit }));

        await waitFor(() => {
            expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
                category: 'bug',
                message: 'Where: Sync\n\nCloudKit sync failed',
            }));
        });
    });

    it.each([
        ['bug', t.feedbackCategoryBug, t.feedbackOpenGitHubIssue],
        ['feature', t.feedbackCategoryFeature, t.feedbackOpenGitHubIssue],
        ['other', t.feedbackCategoryOther, t.feedbackOpenGitHubDiscussion],
    ])('opens GitHub for %s without submitting or clearing the draft', (category, categoryLabel, linkLabel) => {
        const onOpenGitHub = vi.fn();
        const onClose = vi.fn();
        const onSubmit = vi.fn();
        renderFeedbackModal({ onOpenGitHub, onClose, onSubmit });
        const message = screen.getByRole('textbox', { name: t.feedbackMessage });
        fireEvent.change(message, { target: { value: 'Keep this draft' } });

        fireEvent.click(screen.getByRole('button', { name: categoryLabel }));
        expect(screen.getByText(t.feedbackGitHubDesc)).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: linkLabel }));

        expect(onOpenGitHub).toHaveBeenCalledExactlyOnceWith(category);
        expect(onClose).not.toHaveBeenCalled();
        expect(onSubmit).not.toHaveBeenCalled();
        expect(message).toHaveValue('Keep this draft');
    });

    it('routes unconfigured builds to GitHub issues', () => {
        const onOpenGitHub = vi.fn();
        renderFeedbackModal({ isConfigured: false, onOpenGitHub });

        expect(screen.getByText(t.feedbackUnavailableDesc)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: t.feedbackSubmit })).toBeDisabled();
        fireEvent.click(screen.getByRole('button', { name: t.feedbackOpenGitHubIssue }));

        expect(onOpenGitHub).toHaveBeenCalled();
    });
});
