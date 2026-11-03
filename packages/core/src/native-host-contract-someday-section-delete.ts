import type { NativeHostResult } from './native-host-contract';
import { taskEditValuesEqual } from './json-value-equality';
import { exact, record, detach } from './native-host-contract-project-shared';
import {
    SOMEDAY_SECTION_REQUEST_BYTES,
    SOMEDAY_SECTION_UUID,
    hasUnpairedSurrogate,
    rawSomedaySections,
    rawSomedayStamp,
} from './native-host-contract-someday-section-shared';
import { isNativeJsonWithinBytes } from './native-host-contract-task-view';
import { createNativeRequestReceipts, runStoreWrite, settleWrite } from './native-request-receipts';
import { buildSomedaySectionManagerRows, buildSomedaySectionsSettingsUpdate, removeSomedaySection } from './someday-sections-model';
import { useTaskStore } from './store';
import type { ViewSectionDefinition } from './types';
import { sortViewSectionDefinitions } from './view-sections';

export type NativeSomedaySectionDeleteRequest = {
    requestId: string;
    id: string;
    expected: { sections: unknown[]; updatedAt: string | null };
};
export type NativeSomedaySectionDeleteResult = { id: string; changed: true };

const fail = (code: 'INVALID_INPUT' | 'STALE_REVISION' | 'SAVE_FAILED', message: string): NativeHostResult<never> =>
    ({ ok: false, error: { code, message } });
const validId = (value: unknown): value is string =>
    typeof value === 'string' && Boolean(value.trim()) && value.length <= 500
    && !value.includes('\0') && !hasUnpairedSurrogate(value);
const rawMatches = (sections: readonly unknown[], id: string): Record<string, unknown>[] =>
    sections.filter((row): row is Record<string, unknown> => record(row) && row.id === id);
const visibleTarget = (sections: readonly unknown[], id: string): ViewSectionDefinition | null => {
    if (rawMatches(sections, id).length !== 1) return null;
    return sortViewSectionDefinitions(sections as ViewSectionDefinition[]).find((row) => row.id === id) ?? null;
};
const plannedSections = (request: NativeSomedaySectionDeleteRequest): ViewSectionDefinition[] =>
    removeSomedaySection(request.expected.sections as ViewSectionDefinition[], request.id);
const answer = (request: NativeSomedaySectionDeleteRequest): NativeSomedaySectionDeleteResult =>
    ({ id: request.id, changed: true });

const readRequest = (input: unknown): NativeSomedaySectionDeleteRequest | null => {
    if (!record(input) || !exact(input, ['requestId', 'id', 'expected'])
        || !record(input.expected) || !exact(input.expected, ['sections', 'updatedAt'])
        || !isNativeJsonWithinBytes(input, SOMEDAY_SECTION_REQUEST_BYTES)) return null;
    const request = detach<NativeSomedaySectionDeleteRequest>(input);
    if (!request || !record(request) || !exact(request, ['requestId', 'id', 'expected'])
        || typeof request.requestId !== 'string' || !SOMEDAY_SECTION_UUID.test(request.requestId)
        || !validId(request.id) || !record(request.expected)
        || !exact(request.expected, ['sections', 'updatedAt'])
        || !Array.isArray(request.expected.sections)
        || (request.expected.updatedAt !== null && typeof request.expected.updatedAt !== 'string')
        || !visibleTarget(request.expected.sections, request.id)) return null;
    return request;
};


export function validateSomedaySectionDeleteWrite(input: unknown): NativeHostResult<NativeSomedaySectionDeleteResult> {
    const request = readRequest(input);
    return request ? { ok: true, value: answer(request) }
        : fail('INVALID_INPUT', 'A bounded checked Someday section delete is required');
}

export function createSomedaySectionDeleteMethods(deps: {
    readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>;
    revision: () => string;
    t: (key: string) => string;
}) {
    const durableSave = async (): Promise<NativeHostResult<null>> => {
        try {
            if (useTaskStore.getState().persistenceFailure) await useTaskStore.getState().retryPersistence();
        } catch (error) {
            return fail('SAVE_FAILED', error instanceof Error ? error.message : String(error));
        }
        return deps.save();
    };
    const receipts = createNativeRequestReceipts({ save: durableSave });

    const target = (request: NativeSomedaySectionDeleteRequest): NativeHostResult<NativeSomedaySectionDeleteResult> => {
        const sections = rawSomedaySections();
        if (!sections.ok) return sections;
        return taskEditValuesEqual(sections.value, plannedSections(request))
            ? { ok: true, value: answer(request) }
            : fail('STALE_REVISION', 'Someday section delete outcome is not present');
    };

    return {
        getSomedaySectionDeleteOptions(input: { id: string }): NativeHostResult<{
            revision: string;
            id: string;
            title: string;
            expected: NativeSomedaySectionDeleteRequest['expected'];
            text: ReturnType<typeof buildSomedaySectionManagerRows>[number]['deleteConfirm'];
        }> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!record(input) || !exact(input, ['id']) || !validId(input.id))
                return fail('INVALID_INPUT', 'A Someday section ID is required');
            const sections = rawSomedaySections();
            if (!sections.ok) return sections;
            const stamp = rawSomedayStamp();
            if (!stamp.ok) return stamp;
            const original = sections.value && visibleTarget(sections.value, input.id);
            if (!original) return fail('INVALID_INPUT', 'A unique visible Someday section is required');
            const copy = detach<unknown[]>(sections.value);
            if (!copy) return fail('INVALID_INPUT', 'Stored Someday sections exceed the bounded native response');
            const text = buildSomedaySectionManagerRows(sections.value as ViewSectionDefinition[], deps.t)
                .find((row) => row.id === input.id)?.deleteConfirm;
            if (!text) return fail('INVALID_INPUT', 'A unique visible Someday section is required');
            const value = { revision: deps.revision(), id: original.id, title: original.title,
                expected: { sections: copy, updatedAt: stamp.value }, text };
            return isNativeJsonWithinBytes(value, SOMEDAY_SECTION_REQUEST_BYTES) ? { ok: true, value }
                : fail('INVALID_INPUT', 'Someday section options exceed the bounded native response');
        },

        validateSomedaySectionDeleteWrite,

        probeSomedaySectionDeleteOutcome(input: NativeSomedaySectionDeleteRequest): NativeHostResult<NativeSomedaySectionDeleteResult> {
            const request = readRequest(input);
            if (!request) return fail('INVALID_INPUT', 'A bounded checked Someday section delete is required');
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const identity = receipts.checkIdentity(request.requestId, JSON.stringify(request));
            return identity.ok ? target(request) : identity;
        },

        async deleteSomedaySectionChecked(input: NativeSomedaySectionDeleteRequest): Promise<NativeHostResult<NativeSomedaySectionDeleteResult>> {
            const request = readRequest(input);
            if (!request) return fail('INVALID_INPUT', 'A bounded checked Someday section delete is required');
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const payload = JSON.stringify(request);
            const identity = receipts.checkIdentity(request.requestId, payload);
            if (!identity.ok) return identity;
            const outcome = await receipts.run(request.requestId, payload, async () => {
                const applied = target(request);
                if (applied.ok) return applied;
                if (applied.error.code !== 'STALE_REVISION') return applied;
                const sections = rawSomedaySections();
                if (!sections.ok) return sections;
                const stamp = rawSomedayStamp();
                if (!stamp.ok) return stamp;
                if (!taskEditValuesEqual(sections.value, request.expected.sections)
                    || stamp.value !== request.expected.updatedAt)
                    return fail('STALE_REVISION', 'Someday sections changed while deleting');
                const settings = useTaskStore.getState().settings;
                if (!settings.deviceId) return fail('INVALID_INPUT', 'Loaded device identity is required');
                const written = await runStoreWrite(() => useTaskStore.getState().updateSettings(
                    buildSomedaySectionsSettingsUpdate(settings, plannedSections(request))));
                return settleWrite(written, answer(request));
            });

            return outcome.ok ? target(request) : outcome;
        },
    };
}
