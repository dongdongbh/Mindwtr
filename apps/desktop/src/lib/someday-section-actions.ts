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


    if (state.persistenceFailure) await state.retryPersistence();
    else await flushPendingSave();
}


export async function createSomedaySection(title: string): Promise<string | null> {


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
