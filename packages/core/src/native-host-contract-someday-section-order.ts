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
import { buildSomedaySectionsSettingsUpdate, moveSomedaySection } from './someday-sections-model';
import { useTaskStore } from './store';
import type { ViewSectionDefinition } from './types';
import { sortViewSectionDefinitions } from './view-sections';

export type NativeSomedaySectionOrderRequest = {
    requestId: string;
    id: string;
    offset: -1 | 1;
    expected: { sections: unknown[]; updatedAt: string | null };
};
export type NativeSomedaySectionOrderResult = { id: string; changed: true };

const fail = (code: 'INVALID_INPUT' | 'STALE_REVISION' | 'SAVE_FAILED', message: string): NativeHostResult<never> =>
    ({ ok: false, error: { code, message } });
const validId = (value: unknown): value is string =>
    typeof value === 'string' && Boolean(value.trim()) && value.length <= 500
    && !value.includes('\0') && !hasUnpairedSurrogate(value);


const visibleIds = (sections: readonly unknown[]): string[] | null => {
    const ids = sortViewSectionDefinitions(sections as ViewSectionDefinition[]).map((row) => row.id);
    const counts = new Map<string, number>();
    for (const row of sections) {
        if (record(row) && typeof row.id === 'string') counts.set(row.id, (counts.get(row.id) ?? 0) + 1);
    }
    return ids.every((id) => validId(id) && counts.get(id) === 1) ? ids : null;
};
const moveAllowed = (sections: readonly unknown[], id: string, offset: -1 | 1): boolean => {
    const ids = visibleIds(sections);
    const index = ids?.indexOf(id) ?? -1;
    return index >= 0 && index + offset >= 0 && index + offset < ids!.length;
};
const plannedSections = (request: NativeSomedaySectionOrderRequest): ViewSectionDefinition[] =>
    moveSomedaySection(request.expected.sections as ViewSectionDefinition[], request.id, request.offset)!;
const answer = (request: NativeSomedaySectionOrderRequest): NativeSomedaySectionOrderResult =>
    ({ id: request.id, changed: true });

const readRequest = (input: unknown): NativeSomedaySectionOrderRequest | null => {
    if (!record(input) || !exact(input, ['requestId', 'id', 'offset', 'expected'])
        || !record(input.expected) || !exact(input.expected, ['sections', 'updatedAt'])
        || !isNativeJsonWithinBytes(input, SOMEDAY_SECTION_REQUEST_BYTES)) return null;
    const request = detach<NativeSomedaySectionOrderRequest>(input);
    if (!request || !record(request) || !exact(request, ['requestId', 'id', 'offset', 'expected'])
        || typeof request.requestId !== 'string' || !SOMEDAY_SECTION_UUID.test(request.requestId)
        || !validId(request.id) || (request.offset !== -1 && request.offset !== 1)
        || !record(request.expected) || !exact(request.expected, ['sections', 'updatedAt'])
        || !Array.isArray(request.expected.sections)
        || (request.expected.updatedAt !== null && typeof request.expected.updatedAt !== 'string')
        || !moveAllowed(request.expected.sections, request.id, request.offset)) return null;
    return request;
};


export function validateSomedaySectionOrderWrite(input: unknown): NativeHostResult<NativeSomedaySectionOrderResult> {
    const request = readRequest(input);
    return request ? { ok: true, value: answer(request) }
        : fail('INVALID_INPUT', 'A bounded checked Someday section order is required');
}

export function createSomedaySectionOrderMethods(deps: {
    readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>;
    revision: () => string;
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

    const target = (request: NativeSomedaySectionOrderRequest): NativeHostResult<NativeSomedaySectionOrderResult> => {
        const sections = rawSomedaySections();
        if (!sections.ok) return sections;
        return taskEditValuesEqual(sections.value, plannedSections(request))
            ? { ok: true, value: answer(request) }
            : fail('STALE_REVISION', 'Someday section order outcome is not present');
    };

    return {
        getSomedaySectionOrderOptions(input: { id: string; offset: -1 | 1 }): NativeHostResult<{
            revision: string;
            id: string;
            offset: -1 | 1;
            expected: NativeSomedaySectionOrderRequest['expected'];
        }> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!record(input) || !exact(input, ['id', 'offset']) || !validId(input.id)
                || (input.offset !== -1 && input.offset !== 1))
                return fail('INVALID_INPUT', 'A Someday section ID and direction are required');
            const sections = rawSomedaySections();
            if (!sections.ok) return sections;
            const stamp = rawSomedayStamp();
            if (!stamp.ok) return stamp;
            if (!sections.value || !moveAllowed(sections.value, input.id, input.offset))
                return fail('INVALID_INPUT', 'A unique movable Someday section is required');
            const copy = detach<unknown[]>(sections.value);
            if (!copy) return fail('INVALID_INPUT', 'Stored Someday sections exceed the bounded native response');
            const value = { revision: deps.revision(), id: input.id, offset: input.offset,
                expected: { sections: copy, updatedAt: stamp.value } };
            return isNativeJsonWithinBytes(value, SOMEDAY_SECTION_REQUEST_BYTES) ? { ok: true, value }
                : fail('INVALID_INPUT', 'Someday section options exceed the bounded native response');
        },

        validateSomedaySectionOrderWrite,

        probeSomedaySectionOrderOutcome(input: NativeSomedaySectionOrderRequest): NativeHostResult<NativeSomedaySectionOrderResult> {
            const request = readRequest(input);
            if (!request) return fail('INVALID_INPUT', 'A bounded checked Someday section order is required');
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const identity = receipts.checkIdentity(request.requestId, JSON.stringify(request));
            return identity.ok ? target(request) : identity;
        },

        async orderSomedaySectionChecked(input: NativeSomedaySectionOrderRequest): Promise<NativeHostResult<NativeSomedaySectionOrderResult>> {
            const request = readRequest(input);
            if (!request) return fail('INVALID_INPUT', 'A bounded checked Someday section order is required');
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
                    return fail('STALE_REVISION', 'Someday sections changed while ordering');
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
