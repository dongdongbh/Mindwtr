import { AREA_PRESET_COLORS, DEFAULT_AREA_COLOR } from './color-constants';
import { getManageEditorDraft, planManageEditorSave } from './manage-settings-model';
import type { NativeHostResult } from './native-host-contract';
import { detach, exact, record } from './native-host-contract-project-shared';
import { isNativeJsonWithinBytes } from './native-host-contract-task-view';
import { createNativeRequestReceipts, runStoreWrite, settleWrite } from './native-request-receipts';
import { useTaskStore } from './store';

export type NativeUnassignedAreaColorRequest = {
    requestId: string;
    color: string;
    expected: { color: string | null; updatedAt: string | null };
};
export type NativeUnassignedAreaColorResult = { color: string; changed: boolean };

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const fail = (code: 'INVALID_INPUT' | 'STALE_REVISION' | 'SAVE_FAILED', message: string): NativeHostResult<never> =>
    ({ ok: false, error: { code, message } });
const bounded = (value: unknown): value is string => typeof value === 'string' && value.length <= 500;
const readRequest = (input: unknown): NativeUnassignedAreaColorRequest | null => {
    if (!isNativeJsonWithinBytes(input, 4096)) return null;
    const request = detach<NativeUnassignedAreaColorRequest>(input);
    if (!request || !record(request) || !exact(request, ['requestId', 'color', 'expected'])
        || typeof request.requestId !== 'string' || !UUID.test(request.requestId)
        || !bounded(request.color) || !record(request.expected)
        || !exact(request.expected, ['color', 'updatedAt'])
        || (request.expected.color !== null && !bounded(request.expected.color))
        || (request.expected.updatedAt !== null && !bounded(request.expected.updatedAt))
        || (!(AREA_PRESET_COLORS as readonly string[]).includes(request.color)
            && !(request.color === DEFAULT_AREA_COLOR
                && (request.expected.color === null || request.expected.color === '' || request.expected.color === DEFAULT_AREA_COLOR))
            && request.color !== request.expected.color)) return null;
    return request;
};


export function validateUnassignedAreaColorWrite(input: unknown): NativeHostResult<NativeUnassignedAreaColorResult> {
    const request = readRequest(input);
    return request ? { ok: true, value: { color: request.color, changed: request.expected.color !== request.color } }
        : fail('INVALID_INPUT', 'A bounded checked unassigned Area color is required');
}

const raw = (): NativeHostResult<{ color: string | null; updatedAt: string | null }> => {
    const settings = useTaskStore.getState().settings;
    const appearance = settings.appearance;
    if (appearance !== undefined && !record(appearance))
        return fail('INVALID_INPUT', 'Stored appearance has an unsupported value');
    const color = appearance && own(appearance, 'unassignedAreaColor') ? appearance.unassignedAreaColor : null;
    if (color !== null && !bounded(color))
        return fail('INVALID_INPUT', 'Stored unassigned Area color has an unsupported value');
    if (appearance && own(appearance, 'unassignedAreaColor') && color === null)
        return fail('INVALID_INPUT', 'Stored unassigned Area color has an unsupported value');
    const stamps = settings.syncPreferencesUpdatedAt;
    if (stamps !== undefined && !record(stamps))
        return fail('INVALID_INPUT', 'Stored appearance timestamp has an unsupported value');
    const updatedAt = stamps && own(stamps, 'appearance') ? stamps.appearance : null;
    if (updatedAt !== null && !bounded(updatedAt))
        return fail('INVALID_INPUT', 'Stored appearance timestamp has an unsupported value');
    if (stamps && own(stamps, 'appearance') && updatedAt === null)
        return fail('INVALID_INPUT', 'Stored appearance timestamp has an unsupported value');
    return { ok: true, value: { color, updatedAt } };
};

export function createUnassignedAreaColorMethods(deps: {
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
    const target = (request: NativeUnassignedAreaColorRequest): NativeHostResult<NativeUnassignedAreaColorResult> => {
        const current = raw();
        if (!current.ok) return current;
        return current.value.color === request.color
            ? { ok: true, value: { color: request.color, changed: request.expected.color !== request.color } }
            : fail('STALE_REVISION', 'Unassigned Area color outcome is not present');
    };

    return {
        getUnassignedAreaColorOptions(input: Record<string, never>): NativeHostResult<{
            revision: string; color: string; colors: string[];
            expected: NativeUnassignedAreaColorRequest['expected'];
        }> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            if (!record(input) || !exact(input, [])) return fail('INVALID_INPUT', 'Empty unassigned Area color options input is required');
            const current = raw();
            if (!current.ok) return current;
            return { ok: true, value: { revision: deps.revision(), color: current.value.color || DEFAULT_AREA_COLOR,
                colors: [...AREA_PRESET_COLORS], expected: current.value } };
        },

        validateUnassignedAreaColorWrite,

        probeUnassignedAreaColorOutcome(input: NativeUnassignedAreaColorRequest): NativeHostResult<NativeUnassignedAreaColorResult> {
            const request = readRequest(input);
            if (!request) return fail('INVALID_INPUT', 'A bounded checked unassigned Area color is required');
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const identity = receipts.checkIdentity(request.requestId, JSON.stringify(request));
            return identity.ok ? target(request) : identity;
        },

        async setUnassignedAreaColorChecked(input: NativeUnassignedAreaColorRequest): Promise<NativeHostResult<NativeUnassignedAreaColorResult>> {
            const request = readRequest(input);
            if (!request) return fail('INVALID_INPUT', 'A bounded checked unassigned Area color is required');
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const payload = JSON.stringify(request);
            const identity = receipts.checkIdentity(request.requestId, payload);
            if (!identity.ok) return identity;

            if (request.expected.color === request.color) return target(request);
            const outcome = await receipts.run(request.requestId, payload, async () => {
                const applied = target(request);
                if (applied.ok) return applied;
                if (applied.error.code !== 'STALE_REVISION') return applied;
                const current = raw();
                if (!current.ok) return current;
                if (current.value.color !== request.expected.color
                    || current.value.updatedAt !== request.expected.updatedAt)
                    return fail('STALE_REVISION', 'Unassigned Area color changed while editing');
                const settings = useTaskStore.getState().settings;
                if (!settings.deviceId) return fail('INVALID_INPUT', 'Loaded device identity is required');
                const draft = getManageEditorDraft({ type: 'unassignedArea', color: current.value.color ?? undefined });
                const writes = planManageEditorSave({ type: 'unassignedArea' }, { ...draft, color: request.color }, settings);
                if (!writes || writes.length !== 1 || writes[0].kind !== 'updateSettings')
                    return fail('INVALID_INPUT', 'Unassigned Area color cannot be saved');
                const update = writes[0].updates;
                const written = await runStoreWrite(() => useTaskStore.getState().updateSettings(update));
                return settleWrite(written, { color: request.color, changed: true });
            });

            return outcome.ok ? target(request) : outcome;
        },
    };
}
