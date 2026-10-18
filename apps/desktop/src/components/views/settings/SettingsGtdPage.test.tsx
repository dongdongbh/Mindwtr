import { fireEvent, render, waitFor, within } from '@testing-library/react';
import { useTaskStore } from '@mindwtr/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getEnglishSettingsLabels } from './labels';
import { SettingsGtdPage } from './SettingsGtdPage';
import { useUiStore } from '../../../store/ui-store';
import { holdSyncSave } from '../../../test/hold-sync-save';

const initialTaskState = useTaskStore.getState();

describe('SettingsGtdPage', () => {
    afterEach(() => {
        useTaskStore.setState(initialTaskState, true);
    });

    it('keeps a GTD key another device synced while the page showed older settings', async () => {
        const updateSettings = useTaskStore.getState().updateSettings;
        useTaskStore.setState({ settings: { gtd: { defaultProjectFlowMode: 'parallel' } } });
        const { getByRole } = render(
            <SettingsGtdPage
                t={getEnglishSettingsLabels()}
                language="en"
                settings={useTaskStore.getState().settings}
                updateSettings={updateSettings}
                showSaved={vi.fn()}
                autoArchiveDays={7}
                areas={[]}
            />
        );
        // A sync save holds the gate while the user clicks, then publishes another device's auto-archive change.
        const finish = holdSyncSave(() => useTaskStore.setState({
            settings: { gtd: { defaultProjectFlowMode: 'parallel', autoArchiveDays: 3 } },
        }));

        fireEvent.click(getByRole('button', { name: /sequential/i }));
        await finish();

        await waitFor(() => {
            expect(useTaskStore.getState().settings.gtd).toEqual({ defaultProjectFlowMode: 'sequential', autoArchiveDays: 3 });
        });
    });

    it('hides a task editor field the page showed, even when another device hid it meanwhile', async () => {
        const updateSettings = useTaskStore.getState().updateSettings;
        const t = getEnglishSettingsLabels();
        useTaskStore.setState({ settings: { gtd: { taskEditor: { hidden: [] } } } });
        const { getByRole, getByText } = render(
            <SettingsGtdPage t={t} language="en" settings={useTaskStore.getState().settings} updateSettings={updateSettings}
                showSaved={vi.fn()} autoArchiveDays={7} areas={[]} />
        );
        fireEvent.click(getByRole('button', { name: new RegExp(t.taskEditorLayout) }));
        // The other device hid Status after this page rendered it as visible.
        useTaskStore.setState({ settings: { gtd: { taskEditor: { hidden: ['status'] } } } });
        const row = getByText(t.taskEditorFieldStatus).closest('div.flex') as HTMLElement;
        fireEvent.click(within(row).getByRole('button', { name: t.visible }));

        await waitFor(() => {
            expect(useTaskStore.getState().settings.gtd?.taskEditor?.hidden).toContain('status');
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

    it('does not surface or rewrite the retired time-estimate preset editor', () => {
        const updateSettings = vi.fn().mockResolvedValue(undefined);
        const showSaved = vi.fn();

        const { queryByRole } = render(
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

        expect(queryByRole('button', { name: /time estimate presets/i })).not.toBeInTheDocument();
        expect(updateSettings).not.toHaveBeenCalled();
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
