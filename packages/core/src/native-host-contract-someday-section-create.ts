import type { NativeHostResult } from './native-host-contract';
import { taskEditValuesEqual } from './json-value-equality';
import { exact, record, detach } from './native-host-contract-project-shared';
import { isNativeJsonWithinBytes } from './native-host-contract-task-view';
import { createNativeRequestReceipts, runStoreWrite, settleWrite } from './native-request-receipts';
import {
    SOMEDAY_SECTION_REQUEST_BYTES as REQUEST_BYTES,
    SOMEDAY_SECTION_UUID as UUID,
    rawSomedaySections as rawSections,
    rawSomedayStamp as rawStamp,
    validSomedaySectionTitle,
} from './native-host-contract-someday-section-shared';
import { buildSomedaySectionsSettingsUpdate, getSomedaySectionManagerText, planSomedaySectionCreate } from './someday-sections-model';
import { useTaskStore } from './store';
import type { ViewSectionDefinition } from './types';
import { sortViewSectionDefinitions } from './view-sections';

export type NativeSomedaySectionCreateRequest = {
    requestId: string;
    title: string;
    expected: { sections: unknown[] | null; updatedAt: string | null };
};
export type NativeSomedaySectionCreateResult = { id: string; existing: boolean };

const fail = (code: 'INVALID_INPUT' | 'STALE_REVISION' | 'SAVE_FAILED', message: string): NativeHostResult<never> =>
    ({ ok: false, error: { code, message } });
const same = taskEditValuesEqual;
const readRequest = (input: unknown): NativeSomedaySectionCreateRequest | null => {
    if (!record(input) || !exact(input, ['requestId', 'title', 'expected'])
        || !record(input.expected) || !exact(input.expected, ['sections', 'updatedAt'])
        || !isNativeJsonWithinBytes(input, REQUEST_BYTES)) return null;
    const request = detach<NativeSomedaySectionCreateRequest>(input);
    if (!request || !record(request) || !exact(request, ['requestId', 'title', 'expected'])
        || typeof request.requestId !== 'string' || !UUID.test(request.requestId)
        || !validSomedaySectionTitle(request.title) || !record(request.expected)
        || !exact(request.expected, ['sections', 'updatedAt'])
        || (request.expected.sections !== null && !Array.isArray(request.expected.sections))
        || (request.expected.updatedAt !== null && typeof request.expected.updatedAt !== 'string')) return null;
    const sections = request.expected.sections;
    if (sections?.some((row) => record(row) && row.id === request.requestId)) return null;
    const planned = planSomedaySectionCreate(sections as ViewSectionDefinition[] | undefined,
        request.title, () => request.requestId);
    if (planned.kind === 'existing' && sections?.filter((row) => record(row) && row.id === planned.id).length !== 1) return null;
    return request;
};

const planFor = (request: NativeSomedaySectionCreateRequest) =>
    planSomedaySectionCreate(request.expected.sections as ViewSectionDefinition[] | undefined,
        request.title, () => request.requestId);


export function validateSomedaySectionCreateWrite(input: unknown): NativeHostResult<NativeSomedaySectionCreateResult> {
    const request = readRequest(input);
    if (!request) return fail('INVALID_INPUT', 'A bounded checked Someday section request is required');
    const plan = planFor(request);
    if (plan.kind === 'blank') return fail('INVALID_INPUT', 'A section title is required');
    return { ok: true, value: { id: plan.id, existing: plan.kind === 'existing' } };
}

export function createSomedaySectionCreateMethods(deps: {
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

    const target = (request: NativeSomedaySectionCreateRequest): NativeHostResult<NativeSomedaySectionCreateResult> => {
        const sections = rawSections();
        if (!sections.ok) return sections;
        const plan = planFor(request);
        if (plan.kind === 'blank') return fail('INVALID_INPUT', 'A section title is required');
        const original = plan.kind === 'existing'
            ? sortViewSectionDefinitions(request.expected.sections as ViewSectionDefinition[] | undefined)
                .find((row) => row.id === plan.id)
            : plan.sections[plan.sections.length - 1];
        const matches = sections.value?.filter((row) => record(row) && row.id === plan.id) ?? [];
        const current = matches.length === 1 ? matches[0] : null;
        return current && original && same(current, original)
            ? { ok: true, value: { id: plan.id, existing: plan.kind === 'existing' } }
            : fail('STALE_REVISION', 'Someday section creation outcome is not present');
    };

    return {
        getSomedaySectionCreateOptions(input: Record<string, never>): NativeHostResult<{
            revision: string;
            expected: NativeSomedaySectionCreateRequest['expected'];
            text: ReturnType<typeof getSomedaySectionManagerText>;
            choices: { id: string; title: string }[];
        }> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!record(input) || !exact(input, [])) return fail('INVALID_INPUT', 'Empty Someday section options input is required');
            const sections = rawSections();
            if (!sections.ok) return sections;
            const stamp = rawStamp();
            if (!stamp.ok) return stamp;
            const expected = { sections: sections.value === null ? null : detach<unknown[]>(sections.value), updatedAt: stamp.value };
            if (sections.value !== null && !expected.sections) return fail('INVALID_INPUT', 'Stored Someday sections exceed the bounded native response');
            const value = { revision: deps.revision(), expected,
                text: getSomedaySectionManagerText(deps.t),
                choices: sortViewSectionDefinitions(sections.value as ViewSectionDefinition[] | undefined)
                    .map(({ id, title }) => ({ id, title })) };
            return isNativeJsonWithinBytes(value, REQUEST_BYTES) ? { ok: true, value }
                : fail('INVALID_INPUT', 'Someday section options exceed the bounded native response');
        },

        validateSomedaySectionCreateWrite,

        probeSomedaySectionCreateOutcome(input: NativeSomedaySectionCreateRequest): NativeHostResult<NativeSomedaySectionCreateResult> {
            const request = readRequest(input);
            if (!request) return fail('INVALID_INPUT', 'A bounded checked Someday section request is required');
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            return target(request);
        },

        async createSomedaySectionChecked(input: NativeSomedaySectionCreateRequest): Promise<NativeHostResult<NativeSomedaySectionCreateResult>> {
            const request = readRequest(input);
            if (!request) return fail('INVALID_INPUT', 'A bounded checked Someday section request is required');
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const checked = validateSomedaySectionCreateWrite(request);
            if (!checked.ok) return checked;
            const outcome = await receipts.run(request.requestId, JSON.stringify(request), async () => {
                const applied = target(request);
                if (applied.ok) return applied;
                if (applied.error.code !== 'STALE_REVISION') return applied;
                const sections = rawSections();
                if (!sections.ok) return sections;
                const stamp = rawStamp();
                if (!stamp.ok) return stamp;
                if (!same(sections.value, request.expected.sections) || stamp.value !== request.expected.updatedAt)
                    return fail('STALE_REVISION', 'Someday sections changed while editing');
                const settings = useTaskStore.getState().settings;
                if (!settings.deviceId) return fail('INVALID_INPUT', 'Loaded device identity is required');
                const plan = planFor(request);
                if (plan.kind === 'existing') return fail('STALE_REVISION', 'Existing Someday section changed while editing');
                if (plan.kind !== 'create') return fail('INVALID_INPUT', 'A section title is required');
                const written = await runStoreWrite(() => useTaskStore.getState().updateSettings(
                    buildSomedaySectionsSettingsUpdate(settings, plan.sections)));
                return settleWrite(written, checked.value);
            });


            return outcome.ok ? target(request) : outcome;
        },
    };
}
