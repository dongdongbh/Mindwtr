import { sortViewSectionDefinitions, useTaskStore } from '@mindwtr/core';

import { useUiStore } from '../store/ui-store';

const makeSomedaySectionId = () => globalThis.crypto?.randomUUID?.()
    ?? `someday-${Date.now()}-${Math.random().toString(36).slice(2)}`;

/**
 * The one desktop write path for creating a Someday catalogue section.
 * Reads both stores at commit time so every picker sees the latest catalogue,
 * and so a grouping choice made while persistence is pending still wins.
 */
export async function createSomedaySection(title: string): Promise<string | null> {
    const trimmed = title.trim();
    if (!trimmed) return null;

    const taskState = useTaskStore.getState();
    const settings = taskState.settings;
    const currentSections = sortViewSectionDefinitions(settings?.gtd?.viewSections?.someday);
    const existing = currentSections.find(
        (section) => section.title.toLowerCase() === trimmed.toLowerCase(),
    );
    if (existing) return existing.id;

    const id = makeSomedaySectionId();
    const maxOrder = currentSections.reduce(
        (maximum, section) => Number.isFinite(section.order) ? Math.max(maximum, section.order) : maximum,
        -1,
    );
    await taskState.updateSettings({
        gtd: {
            ...(settings?.gtd ?? {}),
            viewSections: {
                ...(settings?.gtd?.viewSections ?? {}),
                someday: [...currentSections, { id, title: trimmed, order: maxOrder + 1 }],
            },
        },
    });

    const uiState = useUiStore.getState();
    if (currentSections.length === 0 && uiState.listOptions.somedayGroupBy === 'none') {
        uiState.setListOptions({ somedayGroupBy: 'viewSection' });
    }
    return id;
}
