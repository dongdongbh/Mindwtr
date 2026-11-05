import { logInfo } from './logger';
import { buildGeneralSettingsUpdate, isGeneralSettingStored, MOBILE_QUICK_ACCESS_VIEW_OPTIONS, MOBILE_APP_LOCK_RELOCK_DELAY_OPTIONS, resolveMobileAppLockRelockDelayMinutes, type GeneralSettingsEdit,
    type GeneralSettingsModel } from './general-settings-model';
import { generalPreferenceWitness, legacyGeneralPreferenceNumber,
    type GeneralPreferenceType, type GeneralPreferenceWitness } from './general-preference-witness';
import { SETTINGS_THEME_VALUES } from './settings-options';
import { SUPPORTED_LANGUAGES } from './i18n/i18n-constants';
import { taskEditValuesEqual } from './json-value-equality';
import { readAreaDurableData, createAreaSaveGuard } from './native-host-contract-area-durable';
import type { NativeHostResult } from './native-host-contract';
import { detach, exact, record } from './native-host-contract-project-shared';
import { isNativeJsonWithinBytes } from './native-host-contract-task-view';
import { useTaskStore } from './store';
import { timestampAtLeastAfter } from './store-settings';
import { ensureDeviceId } from './store-helpers';
import type { AppSettings } from './types';

export type { GeneralPreferenceType, GeneralPreferenceWitness } from './general-preference-witness';
export type GeneralPreferenceEdit = Extract<GeneralSettingsEdit, { type: GeneralPreferenceType }>;
export type NativeGeneralPreferenceRequest = { requestId: string; edit: GeneralPreferenceEdit;
    expected: GeneralPreferenceWitness };
export type NativeGeneralPreferenceResult = { type: GeneralPreferenceType;
    value: boolean | string | number; changed: boolean };
export type NativePreparedGeneralPreference = { version: 1; request: NativeGeneralPreferenceRequest;
    preparedAt: string; deviceIdBefore: string | null; deviceIdToInitialize: string | null;
    after: { value: boolean | string | number; stamp: string }; result: NativeGeneralPreferenceResult };
export type NativeGeneralPreferenceOptions = { model: GeneralSettingsModel;
    expected: Record<Exclude<GeneralPreferenceType, 'appLockRelockDelay'>, GeneralPreferenceWitness> };
export type NativeGeneralPreferencePreparation = { kind: 'noop'; result: NativeGeneralPreferenceResult }
    | { kind: 'prepared'; prepared: NativePreparedGeneralPreference };

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const TYPES: Exclude<GeneralPreferenceType, 'appLockRelockDelay'>[] = ['showTaskAge', 'quickAccessView', 'weekStart', 'dateFormat', 'timeFormat', 'calendarSystem', 'theme', 'language'];
const VALUES: Record<Exclude<GeneralPreferenceType, 'showTaskAge' | 'appLockRelockDelay'>, readonly string[]> = {
    quickAccessView: MOBILE_QUICK_ACCESS_VIEW_OPTIONS,
    weekStart: ['system', 'sunday', 'monday', 'saturday'],
    dateFormat: ['system', 'dmy', 'mdy', 'ymd'],
    timeFormat: ['system', '12h', '24h'],
    calendarSystem: ['gregorian', 'jalali'],
    theme: SETTINGS_THEME_VALUES,
    language: SUPPORTED_LANGUAGES,
};
const same = taskEditValuesEqual;
const bounded = (value: unknown, max = 500): value is string => typeof value === 'string' && value.length <= max;
const iso = (value: unknown): value is string => bounded(value, 40)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const fail = (code: 'INVALID_INPUT' | 'STALE_REVISION' | 'SAVE_FAILED', message: string): NativeHostResult<never> =>
    ({ ok: false, error: { code, message } });

const validValue = (type: GeneralPreferenceType, value: unknown): value is boolean | string | number =>
    type === 'appLockRelockDelay' ? MOBILE_APP_LOCK_RELOCK_DELAY_OPTIONS.includes(value as never) : type === 'showTaskAge' ? typeof value === 'boolean'
        : bounded(value) && VALUES[type].includes(value);

const validEdit = (value: unknown): value is GeneralPreferenceEdit => record(value)
    && exact(value, ['type', 'value']) && (value.type === 'appLockRelockDelay' || TYPES.includes(value.type as typeof TYPES[number]))
    && validValue(value.type as GeneralPreferenceType, value.value);

const validWitness = (value: unknown, type: GeneralPreferenceType): value is GeneralPreferenceWitness =>
    record(value) && exact(value, ['present', 'value', 'stampPresent', 'stamp'])
    && typeof value.present === 'boolean' && typeof value.stampPresent === 'boolean'
    && (value.present ? type === 'appLockRelockDelay' ? legacyGeneralPreferenceNumber(value.value) : type === 'showTaskAge' ? typeof value.value === 'boolean'
        : bounded(value.value) || type !== 'quickAccessView' && type !== 'calendarSystem' && type !== 'theme'
            && type !== 'language'
            && legacyGeneralPreferenceNumber(value.value)
        : value.value === null)
    && (value.stampPresent ? iso(value.stamp) : value.stamp === null);

const readRequest = (input: unknown): NativeGeneralPreferenceRequest | null => {
    if (!isNativeJsonWithinBytes(input, 8192)) return null;
    const request = detach<Record<string, unknown>>(input);
    if (!request || !exact(request, ['requestId', 'edit', 'expected'])
        || typeof request.requestId !== 'string' || !UUID.test(request.requestId)
        || !validEdit(request.edit)
        || !validWitness(request.expected, request.edit.type)) return null;
    return request as NativeGeneralPreferenceRequest;
};

const plannedStamp = (preparedAt: string, witness: GeneralPreferenceWitness) =>
    timestampAtLeastAfter(preparedAt, witness.stamp ?? undefined);


const readPrepared = (input: unknown): NativePreparedGeneralPreference | null => {
    if (!isNativeJsonWithinBytes(input, 8192)) return null;
    const envelope = detach<Record<string, unknown>>(input);
    if (!envelope || !exact(envelope, ['request', 'prepared']) || !record(envelope.prepared)) return null;
    const request = readRequest(envelope.request);
    const prepared = envelope.prepared;
    if (!request || !exact(prepared, ['version', 'request', 'preparedAt', 'deviceIdBefore',
        'deviceIdToInitialize', 'after', 'result']) || prepared.version !== 1
        || !same(prepared.request, request) || !iso(prepared.preparedAt)
        || !(prepared.deviceIdBefore === null || bounded(prepared.deviceIdBefore) && Boolean(prepared.deviceIdBefore))
        || (prepared.deviceIdBefore === null ? !UUID.test(String(prepared.deviceIdToInitialize))
            : prepared.deviceIdToInitialize !== null)
        || !record(prepared.after) || !exact(prepared.after, ['value', 'stamp'])
        || !same(prepared.after.value, request.edit.value)
        || prepared.after.stamp !== plannedStamp(prepared.preparedAt, request.expected)
        || !record(prepared.result) || !exact(prepared.result, ['type', 'value', 'changed'])
        || !same(prepared.result, { type: request.edit.type, value: request.edit.value, changed: true })
        || request.expected.present && same(request.expected.value, request.edit.value)) return null;
    return prepared as NativePreparedGeneralPreference;
};

export function createGeneralPreferenceMethods(deps: { readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>;
    model: (settings: AppSettings, deviceTheme?: string | null) => GeneralSettingsModel }) {
    const saves = createAreaSaveGuard(deps.save);
    const resultFor = (edit: GeneralPreferenceEdit, changed: boolean): NativeGeneralPreferenceResult =>
        ({ type: edit.type, value: edit.value, changed });
    return {
        async getAppLockDelayOptions(input: unknown): Promise<NativeHostResult<{
            row: GeneralSettingsModel['privacy']['appLockRelockDelay']; expected: GeneralPreferenceWitness; value: number;
        }>> {
            const ready = deps.readiness(); if (!ready.ok) return ready;
            if (!record(input) || !exact(input, [])) return fail('INVALID_INPUT', 'App lock delay takes an empty object');
            const read = await readAreaDurableData(); if (!read.ok) return read;
            const settings = read.value.authority.snapshot.settings;
            const expected = generalPreferenceWitness(settings, 'appLockRelockDelay');
            if (!expected) return fail('INVALID_INPUT', 'Saved App lock delay is malformed');
            return { ok: true, value: { row: deps.model(settings).privacy.appLockRelockDelay, expected,
                value: resolveMobileAppLockRelockDelayMinutes(settings.security?.mobileAppLockRelockDelayMinutes) } };
        },
        async getGeneralPreferenceOptions(input: { deviceTheme?: string | null }): Promise<NativeHostResult<NativeGeneralPreferenceOptions>> {
            const ready = deps.readiness(); if (!ready.ok) return ready;
            if (!record(input) || !exact(input, []) && !exact(input, ['deviceTheme'])
                || input.deviceTheme !== undefined && input.deviceTheme !== null && !bounded(input.deviceTheme))
                return fail('INVALID_INPUT', 'General options need an optional bounded device theme');
            const read = await readAreaDurableData(); if (!read.ok) return read;
            const settings = read.value.authority.snapshot.settings;
            const expected = {} as Record<Exclude<GeneralPreferenceType, 'appLockRelockDelay'>, GeneralPreferenceWitness>;
            for (const type of TYPES) {
                const witness = generalPreferenceWitness(settings, type);
                if (!witness) return fail('INVALID_INPUT', `Saved ${type} preference has an unsupported value`);
                expected[type] = witness;
            }
            const value = { model: deps.model(settings, input.deviceTheme), expected };
            return isNativeJsonWithinBytes(value, 2_000_000) ? { ok: true, value }
                : fail('INVALID_INPUT', 'General options exceed the bounded response');
        },
        probeGeneralPreferenceOutcome(input: NativeGeneralPreferenceRequest): NativeHostResult<NativeGeneralPreferenceResult> {
            const ready = deps.readiness(); if (!ready.ok) return ready;
            return readRequest(input) ? fail('STALE_REVISION', 'General preference outcome is unknown; refresh General')
                : fail('INVALID_INPUT', 'A bounded General preference request is required');
        },
        async prepareGeneralPreference(input: NativeGeneralPreferenceRequest): Promise<NativeHostResult<NativeGeneralPreferencePreparation>> {
            const ready = deps.readiness(); if (!ready.ok) return ready;
            const request = readRequest(input);
            if (!request) return fail('INVALID_INPUT', 'A bounded General preference request is required');
            const preparedAt = new Date().toISOString();
            const read = await readAreaDurableData(); if (!read.ok) return read;
            const settings = read.value.authority.snapshot.settings;
            const current = generalPreferenceWitness(settings, request.edit.type);
            if (!current || !same(current, request.expected)
                || (settings.deviceId ?? null) !== (read.value.authority.state.settings.deviceId ?? null))
                return fail('STALE_REVISION', 'General preference changed; refresh General');
            if (request.edit.type === 'calendarSystem') {
                const picker = deps.model(settings).regional.calendarSystem;
                if (!picker || !picker.options.some((option) => same(option.edit, request.edit)))
                    return fail('INVALID_INPUT', 'Calendar system choice is unavailable');
            }

            if (isGeneralSettingStored(settings, request.edit))
                return { ok: true, value: { kind: 'noop', result: resultFor(request.edit, false) } };
            const update = buildGeneralSettingsUpdate(settings, request.edit);
            if (!update) return fail('INVALID_INPUT', 'General preference cannot be saved');
            const device = ensureDeviceId(settings);
            const prepared: NativePreparedGeneralPreference = { version: 1, request, preparedAt,
                deviceIdBefore: settings.deviceId ?? null,
                deviceIdToInitialize: device.updated ? device.deviceId : null,
                after: { value: request.edit.value, stamp: plannedStamp(preparedAt, request.expected) },
                result: resultFor(request.edit, true) };
            const frozen = detach<NativePreparedGeneralPreference>(prepared);
            return frozen && readPrepared({ request, prepared: frozen })
                ? { ok: true, value: { kind: 'prepared', prepared: frozen } }
                : fail('INVALID_INPUT', 'General preference exceeds the bounded journal');
        },
        validatePreparedGeneralPreference(input: { request: NativeGeneralPreferenceRequest;
            prepared: NativePreparedGeneralPreference }): NativeHostResult<NativeGeneralPreferenceResult> {
            const prepared = readPrepared(input);
            return prepared ? { ok: true, value: prepared.result }
                : fail('INVALID_INPUT', 'Prepared General preference does not match the request');
        },
        async commitPreparedGeneralPreference(input: { request: NativeGeneralPreferenceRequest;
            prepared: NativePreparedGeneralPreference }): Promise<NativeHostResult<NativeGeneralPreferenceResult>> {
            const ready = deps.readiness(); if (!ready.ok) return ready;
            const prepared = readPrepared(input);
            if (!prepared) return fail('INVALID_INPUT', 'Prepared General preference does not match the request');
            const read = await readAreaDurableData(true); if (!read.ok) return read;
            if (!saves.mayApply(prepared, read.value.adapter))
                return fail('SAVE_FAILED', 'General preference has an unresolved persistence failure');
            const applied = await useTaskStore.getState().commitPreparedGeneralPreference(prepared, read.value.authority);
            if (!applied.success) return fail('STALE_REVISION', applied.error ?? 'General preference changed; refresh General');
            const saved = await saves.finish(prepared, read.value.adapter,
                applied.outcome === 'replayed', read.value.authority.saveBoundary);
            if (saved.ok && prepared.request.edit.type === 'appLockRelockDelay') {
                try { logInfo('Native App lock delay saved', { scope: 'native-host', category: 'storage',
                    context: { releaseCheck: 'v1.3.9/ios-app-lock-delay', outcome: 'saved' } }); }
                catch { }
            }
            return saved.ok ? { ok: true, value: prepared.result } : saved;
        },
    };
}
