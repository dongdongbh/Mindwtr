import { fireEvent, render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { getEnglishSettingsLabels } from './labels';
import { SettingsGtdPage } from './SettingsGtdPage';
import { useUiStore } from '../../../store/ui-store';

describe('SettingsGtdPage', () => {
    it('saves Board, Priorities, and Time estimates as independent optional features', async () => {
        const updateSettings = vi.fn().mockResolvedValue(undefined);
        const labels = {
            ...getEnglishSettingsLabels(),
            featureBoard: 'Board',
            featureBoardDesc: 'Show the Board view in navigation.',
        };

        const { getByRole } = render(
            <SettingsGtdPage
                t={labels}
                language="en"
                settings={{ features: { board: false, priorities: false, timeEstimates: false } }}
                updateSettings={updateSettings}
                showSaved={vi.fn()}
                autoArchiveDays={7}
                areas={[]}
            />
        );

        fireEvent.click(getByRole('button', { name: /features/i }));
        fireEvent.click(getByRole('switch', { name: 'Board' }));
        fireEvent.click(getByRole('switch', { name: 'Priorities' }));
        fireEvent.click(getByRole('switch', { name: 'Time estimates' }));

        await waitFor(() => {
            expect(updateSettings).toHaveBeenNthCalledWith(1, {
                features: { board: true, priorities: false, timeEstimates: false },
            });
            expect(updateSettings).toHaveBeenNthCalledWith(2, {
                features: { board: false, priorities: true, timeEstimates: false },
            });
            expect(updateSettings).toHaveBeenNthCalledWith(3, {
                features: { board: false, priorities: false, timeEstimates: true },
            });
        });
    });

    it('saves the task editor presentation setting', async () => {
        const updateSettings = vi.fn().mockResolvedValue(undefined);
        const showSaved = vi.fn();

        const { getByRole, queryByText } = render(
            <SettingsGtdPage
                t={getEnglishSettingsLabels()}
                language="en"
                settings={{ gtd: { taskEditor: { presentation: 'inline' } } }}
                updateSettings={updateSettings}
                showSaved={showSaved}
                autoArchiveDays={7}
                areas={[]}
            />
        );

        expect(queryByText('Temporary onboarding test')).not.toBeInTheDocument();
        fireEvent.click(getByRole('button', { name: /task editor layout/i }));
        fireEvent.click(getByRole('button', { name: /pop-up/i }));

        await waitFor(() => {
            expect(updateSettings).toHaveBeenCalledWith({
                gtd: {
                    taskEditor: {
                        presentation: 'modal',
                    },
                },
            });
        });
    });

    it('saves the default project flow mode', async () => {
        const updateSettings = vi.fn().mockResolvedValue(undefined);
        const showSaved = vi.fn();

        const { getByRole } = render(
            <SettingsGtdPage
                t={getEnglishSettingsLabels()}
                language="en"
                settings={{ gtd: { defaultProjectFlowMode: 'parallel' } }}
                updateSettings={updateSettings}
                showSaved={showSaved}
                autoArchiveDays={7}
                areas={[]}
            />
        );

        fireEvent.click(getByRole('button', { name: /sequential/i }));

        await waitFor(() => {
            expect(updateSettings).toHaveBeenCalledWith({
                gtd: {
                    defaultProjectFlowMode: 'sequential',
                },
            });
        });
    });

    it('uses localized safe feedback when a GTD setting cannot be saved', async () => {
        const updateSettings = vi.fn().mockRejectedValue(new Error('database detail'));
        const showToast = vi.fn();
        useUiStore.setState({ showToast } as never);
        const labels = {
            ...getEnglishSettingsLabels(),
            settingsSaveFailed: 'Impossible d’enregistrer ce réglage.',
        };

        const { getByRole } = render(
            <SettingsGtdPage
                t={labels}
                language="fr"
                settings={{ gtd: { defaultProjectFlowMode: 'parallel' } }}
                updateSettings={updateSettings}
                showSaved={vi.fn()}
                autoArchiveDays={7}
                areas={[]}
            />
        );

        fireEvent.click(getByRole('button', { name: /sequential/i }));

        await waitFor(() => {
            expect(showToast).toHaveBeenCalledWith('Impossible d’enregistrer ce réglage.', 'error');
        });
        expect(showToast).not.toHaveBeenCalledWith(expect.stringContaining('database detail'), expect.anything());
    });

    it('saves the default area for new tasks', async () => {
        const updateSettings = vi.fn().mockResolvedValue(undefined);
        const showSaved = vi.fn();

        const { getByRole } = render(
            <SettingsGtdPage
                t={getEnglishSettingsLabels()}
                language="en"
                settings={{ gtd: { defaultAreaId: null } }}
                updateSettings={updateSettings}
                showSaved={showSaved}
                autoArchiveDays={7}
                areas={[{
                    id: 'area-work',
                    name: 'Work',
                    color: '#64748b',
                    order: 0,
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                }]}
            />
        );

        fireEvent.click(getByRole('button', { name: /default capture method/i }));
        fireEvent.change(getByRole('combobox', { name: /default area for new tasks/i }), {
            target: { value: 'area-work' },
        });

        await waitFor(() => {
            expect(updateSettings).toHaveBeenCalledWith({
                gtd: {
                    defaultAreaMode: 'fixed',
                    defaultAreaId: 'area-work',
                },
            });
        });
    });

    it('adds a time estimate preset', async () => {
        const updateSettings = vi.fn().mockResolvedValue(undefined);
        const showSaved = vi.fn();

        const { getByRole } = render(
            <SettingsGtdPage
                t={getEnglishSettingsLabels()}
                language="en"
                settings={{ gtd: { timeEstimatePresets: ['5min', '30min'] } }}
                updateSettings={updateSettings}
                showSaved={showSaved}
                autoArchiveDays={7}
                areas={[]}
            />
        );

        fireEvent.click(getByRole('button', { name: /time estimate presets/i }));
        // '15min' ('15m') is not in the current presets; clicking it adds it, re-ordered.
        fireEvent.click(getByRole('button', { name: '15m' }));

        await waitFor(() => {
            expect(updateSettings).toHaveBeenCalledWith({
                gtd: {
                    timeEstimatePresets: ['5min', '15min', '30min'],
                },
            });
        });
    });

    it('removes a time estimate preset', async () => {
        const updateSettings = vi.fn().mockResolvedValue(undefined);
        const showSaved = vi.fn();

        const { getByRole } = render(
            <SettingsGtdPage
                t={getEnglishSettingsLabels()}
                language="en"
                settings={{ gtd: { timeEstimatePresets: ['5min', '30min'] } }}
                updateSettings={updateSettings}
                showSaved={showSaved}
                autoArchiveDays={7}
                areas={[]}
            />
        );

        fireEvent.click(getByRole('button', { name: /time estimate presets/i }));
        // '30min' ('30m') is currently selected; clicking it removes it.
        fireEvent.click(getByRole('button', { name: '30m' }));

        await waitFor(() => {
            expect(updateSettings).toHaveBeenCalledWith({
                gtd: {
                    timeEstimatePresets: ['5min'],
                },
            });
        });
    });

    it('saves the active area mode for new tasks', async () => {
        const updateSettings = vi.fn().mockResolvedValue(undefined);
        const showSaved = vi.fn();

        const { getByRole } = render(
            <SettingsGtdPage
                t={getEnglishSettingsLabels()}
                language="en"
                settings={{ gtd: { defaultAreaId: null } }}
                updateSettings={updateSettings}
                showSaved={showSaved}
                autoArchiveDays={7}
                areas={[]}
            />
        );

        fireEvent.click(getByRole('button', { name: /default capture method/i }));
        fireEvent.change(getByRole('combobox', { name: /default area for new tasks/i }), {
            target: { value: '__active-area__' },
        });

        await waitFor(() => {
            expect(updateSettings).toHaveBeenCalledWith({
                gtd: {
                    defaultAreaMode: 'active',
                    defaultAreaId: null,
                },
            });
        });
    });

    it('saves the natural-language dates toggle (#742)', async () => {
        const updateSettings = vi.fn().mockResolvedValue(undefined);
        const showSaved = vi.fn();

        const { getByRole } = render(
            <SettingsGtdPage
                t={getEnglishSettingsLabels()}
                language="en"
                settings={{ gtd: {} }}
                updateSettings={updateSettings}
                showSaved={showSaved}
                autoArchiveDays={7}
                areas={[]}
            />
        );

        fireEvent.click(getByRole('button', { name: /default capture method/i }));
        fireEvent.click(getByRole('switch', { name: /detect natural-language dates/i }));

        await waitFor(() => {
            expect(updateSettings).toHaveBeenCalledWith({
                gtd: {
                    naturalLanguageDates: false,
                },
            });
        });
    });
});
