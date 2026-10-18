import {
    buildSomedaySectionsSettingsUpdate,
    flushPendingSave,
    planSomedaySectionCreate,
    sortViewSectionDefinitions,
    updateSettingsFromLatest,
    useTaskStore,
} from '@mindwtr/core';

import { useUiStore } from '../store/ui-store';

const makeSomedaySectionId = () => globalThis.crypto?.randomUUID?.()
    ?? `someday-${Date.now()}-${Math.random().toString(36).slice(2)}`;

// A failed first-section save leaves the definition optimistic in the store.
// Keep its id until recovery completes so retry finishes that same creation.
let pendingFirstSectionId: string | null = null;

function enableGroupingAfterFirstSectionSave(wasFirstCreation: boolean): void {
    const latestSections = sortViewSectionDefinitions(useTaskStore.getState().settings?.gtd?.viewSections?.someday);
    const firstCreationRecovered = pendingFirstSectionId !== null
        && latestSections.some((section) => section.id === pendingFirstSectionId);
    if (!wasFirstCreation && !firstCreationRecovered) {
        pendingFirstSectionId = null;
        return;
    }
    const uiState = useUiStore.getState();
    if (uiState.listOptions.somedayGroupBy === 'none') {
        uiState.setListOptions({ somedayGroupBy: 'viewSection' });
    }
    pendingFirstSectionId = null;
}

async function ensureCatalogueSaved(): Promise<void> {
    const state = useTaskStore.getState();
    // A terminal flush can exhaust its queue while keeping an optimistic
    // definition in settings. A plain second flush would return empty; the
    // store's recovery path re-enqueues its current snapshot before flushing.
    if (state.persistenceFailure) await state.retryPersistence();
    else await flushPendingSave();
}

/**
 * The one desktop write path for creating a Someday catalogue section.
 * Reads both stores at commit time so every picker sees the latest catalogue,
 * and so a grouping choice made while persistence is pending still wins.
 */
export async function createSomedaySection(title: string): Promise<string | null> {
    // Core's plan keeps every stored entry as it is, in stored order, and appends the new one. It is made on
    // the settings as stored when the write is admitted, so a section another device synced since stays.
    let plan = null as ReturnType<typeof planSomedaySectionCreate> | null;
    let wasFirstCreation = false;
    await updateSettingsFromLatest((settings) => {
        const stored = settings?.gtd?.viewSections?.someday;
        plan = planSomedaySectionCreate(stored, title, makeSomedaySectionId);
        wasFirstCreation = sortViewSectionDefinitions(stored).length === 0;
        return plan.kind === 'create' ? buildSomedaySectionsSettingsUpdate(settings, plan.sections) : null;
    });
    if (!plan || plan.kind === 'blank') return null;
    if (plan.kind === 'existing') {
        await ensureCatalogueSaved();
        enableGroupingAfterFirstSectionSave(false);
        return plan.id;
    }

    const { id } = plan;
    if (wasFirstCreation) pendingFirstSectionId = id;
    await ensureCatalogueSaved();
    enableGroupingAfterFirstSectionSave(wasFirstCreation);
    return id;
}
