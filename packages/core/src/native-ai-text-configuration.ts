import type { NativeHostResult } from './native-host-contract';
import { detach, exact, record } from './native-host-contract-project-shared';
import { isNativeJsonWithinBytes } from './native-host-contract-task-view';
import { taskEditValuesEqual } from './json-value-equality';
import { createNativeRequestReceipts, NativeReceiptSqliteAdapter } from './native-request-receipts';
import { getPersistenceStatus, getStorageAdapter, useTaskStore } from './store';
import { createAISettingsTranslator, getAIConsentPrompt, type AIConsentPrompt } from './ai-settings-model';
import type { TranslateFn } from './i18n';
import type { PreparedAreaAuthority } from './store-types';
import type { AppSettings } from './types';
import type { AIProviderId } from './ai/types';

import { nativeAITextConfigurationWitness, readNativeAITextConfigurationRequest, buildNativeAITextConfigurationOptions,
    planNativeAITextConfigurationChange, readAITextConfigurationChange,
    type AITextConfigurationRequest, type AITextConfigurationOptions,
    type PreparedAITextConfiguration, nativeAITextConfigurationWitnessV2, readNativeAITextConfigurationRequestV2,
    buildNativeAITextConfigurationOptionsV2, planNativeAITextConfigurationChangeV2, readAITextConfigurationChangeV2,
    nativeAITextConfigurationConsentTarget, type AITextConfigurationRequestV2, type AITextConfigurationOptionsV2,
    type PreparedAITextConfigurationV2, buildNativeAIAnthropicThinkingOptions, type AIAnthropicThinkingOptions } from './native-ai-text-configuration-request';
export { nativeAITextConfigurationWitness, readNativeAITextConfigurationRequest,
    buildNativeAITextConfigurationOptions, planNativeAITextConfigurationChange, nativeAITextConfigurationWitnessV2,
    readNativeAITextConfigurationRequestV2, readAITextConfigurationChangeV2, buildNativeAITextConfigurationOptionsV2,
    planNativeAITextConfigurationChangeV2, nativeAITextConfigurationConsentTarget, buildNativeAIAnthropicThinkingOptions } from './native-ai-text-configuration-request';
export type { AITextConfigurationChange, AITextConfigurationWitness, AITextConfigurationRequest,
    AITextConfigurationResult, AITextConfigurationOptions, PreparedAITextConfiguration, AITextConfigurationChangeV2,
    AITextConfigurationWitnessV2, AITextConfigurationRequestV2, AITextConfigurationResultV2, AITextConfigurationOptionsV2,
    PreparedAITextConfigurationV2, AIAnthropicThinkingOptions } from './native-ai-text-configuration-request';

const fail = (code: 'INVALID_INPUT' | 'STALE_REVISION' | 'SAVE_FAILED' | 'ACTION_FAILED', message: string): NativeHostResult<never> =>
    ({ ok: false, error: { code, message } });

type ConfigurationRequest = AITextConfigurationRequest | AITextConfigurationRequestV2;
type ConfigurationResult<R extends ConfigurationRequest> = { change: R['change']; changed: boolean };

/** Private synced scalar writes. Never activates the AI factory or migrates credentials. */
export function createNativeAITextConfigurationMethods(deps: { readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>; t: () => TranslateFn }) {
    // A getData race can advance the adapter's accepted epoch. Only a new explicit host load restores authority.
    let retired = false;
    const read = async (current: () => void, witness: (settings: AppSettings) => unknown): Promise<NativeHostResult<{ adapter: ReturnType<typeof getStorageAdapter>; authority: PreparedAreaAuthority }>> => {
        if (retired) return fail('STALE_REVISION', 'AI text configuration owner is retired; reload before editing');
        const adapter = getStorageAdapter(), state = useTaskStore.getState(), status = getPersistenceStatus();
        const references = [state._allTasks, state._allProjects, state._allSections, state._allAreas, state._allPeople, state.settings];
        let frozen: unknown, fullReadStarted = false;
        const ready = () => {
            current();
            const admission = deps.readiness(); if (!admission.ok) throw new Error(admission.error.code);
            const now = useTaskStore.getState(), persistence = getPersistenceStatus();
            if (getStorageAdapter() !== adapter || persistence.generation !== status.generation
                || now.lastDataChangeAt !== state.lastDataChangeAt
                || ![now._allTasks, now._allProjects, now._allSections, now._allAreas, now._allPeople, now.settings]
                    .every((value, index) => value === references[index])
                || frozen && !taskEditValuesEqual(references, frozen)) throw new Error('STALE_REVISION');
            if (persistence.failed || persistence.queued || persistence.inFlight || persistence.immediate || persistence.retrying
                || now.isLoading || now.editLockCount > 0) throw new Error('ACTION_FAILED');
        };
        try {
            ready();
            if (!(adapter instanceof NativeReceiptSqliteAdapter) || !adapter.concurrentWritesGuarded) return fail('ACTION_FAILED', 'AI text configuration needs guarded receipt storage');
            const baseline = await adapter.readRowBaseline(); ready();
            if (!baseline) throw new Error('STALE_REVISION');
            if (!witness(baseline.settings)) return fail('INVALID_INPUT', 'Saved AI text configuration controls are malformed');
            if (!taskEditValuesEqual(baseline.settings, state.settings)) throw new Error('STALE_REVISION');
            frozen = JSON.parse(JSON.stringify(references));
            fullReadStarted = true;
            const snapshot = await adapter.getData({ rawTasks: true }); ready();
            const after = await adapter.readRowBaseline(); ready();
            if (!after || !taskEditValuesEqual(after, baseline) || !taskEditValuesEqual(snapshot.settings, baseline.settings))
                throw new Error('STALE_REVISION');
            return { ok: true, value: { adapter, authority: { snapshot, state } } };
        } catch (error) {
            if (fullReadStarted) retired = true;
            const message = error instanceof Error ? error.message : '';
            if (message.includes('ACTION_FAILED') || message.includes('NOT_READY') || message.includes('SAVE_FAILED'))
                return fail('ACTION_FAILED', 'AI text configuration waits for current saved data');
            retired = true;
            return fail('STALE_REVISION', 'AI text configuration saved data changed; reload before editing');
        }
    };
    const authorizations = new Map<string, { payload: string; adapter: ReturnType<typeof getStorageAdapter>;
        authority: PreparedAreaAuthority }>();
    const receipts = createNativeRequestReceipts({
        save: async (id) => {
            const authorized = authorizations.get(id);
            if (useTaskStore.getState().persistenceFailure) {
                if (!authorized || getStorageAdapter() !== authorized.adapter
                    || authorized.authority.saveBoundary?.failure !== useTaskStore.getState().persistenceFailure)
                    return fail('SAVE_FAILED', 'AI text configuration save ownership changed');
                const retry = await useTaskStore.getState().retryPreparedAITextConfigurationSnapshot(authorized.authority);
                if (!retry.success) return fail('SAVE_FAILED', 'AI text configuration save ownership changed');
            }
            const boundary = authorized?.authority.saveBoundary, raw = authorized?.authority.rawSavedSnapshot;
            const before = useTaskStore.getState();
            const owns = authorized && boundary && raw && getStorageAdapter() === authorized.adapter
                && before._allTasks === boundary.taskReference && before.settings === raw.settings
                && before.lastDataChangeAt === boundary.lastDataChangeAt
                && getPersistenceStatus().generation === boundary.generation && before.persistenceFailure === boundary.failure;
            const saved = await deps.save();
            const after = useTaskStore.getState();
            if (owns && !saved.ok && saved.error.code === 'SAVE_FAILED' && after.persistenceFailure
                && after.persistenceFailure !== before.persistenceFailure && getStorageAdapter() === authorized.adapter
                && after._allTasks === boundary.taskReference && after.settings === raw.settings
                && after.lastDataChangeAt === boundary.lastDataChangeAt && getPersistenceStatus().generation === boundary.generation)
                authorized.authority.saveBoundary = { ...boundary, failure: after.persistenceFailure };
            return saved;
        },
        receiptOnly: async (id, frozen) => {
            const authorized = authorizations.get(id), boundary = authorized?.authority.saveBoundary;
            const raw = authorized?.authority.rawSavedSnapshot, state = useTaskStore.getState(), status = getPersistenceStatus();
            if (!authorized || authorized.payload !== frozen || !boundary || !raw
                || getStorageAdapter() !== authorized.adapter || !(authorized.adapter instanceof NativeReceiptSqliteAdapter)
                || state._allTasks !== boundary.taskReference || state.settings !== raw.settings
                || state.lastDataChangeAt !== boundary.lastDataChangeAt || status.generation !== boundary.generation
                || status.failed || status.queued || status.inFlight || status.immediate || status.retrying) return false;
            return authorized.adapter.commitReceiptOnly(id, frozen);
        },
    });
    const versionMethods = <R extends ConfigurationRequest, O, P extends { version: 1 | 2; request: R },
        C extends { kind: 'consent'; prompt: AIConsentPrompt }>(config: {
        version: P['version']; command: string; request: (input: unknown) => R | null;
        change: (input: unknown) => R['change'] | null;
        witness: (settings: AppSettings) => R['expected'] | null;
        plan: (expected: R['expected'], change: R['change']) => Partial<NonNullable<AppSettings['ai']>> | null;
        options: (settings: AppSettings) => O | null; prepared: (request: R) => P;
        consentTarget: (request: R) => AIProviderId | null;
        consent: (provider: AIProviderId, prompt: AIConsentPrompt) => C;
    }) => {
        const preparedOf = (input: unknown): P | null => {
            if (!isNativeJsonWithinBytes(input, 64 * 1024) || !record(input) || !exact(input, ['request', 'prepared'])
                || !record(input.prepared) || !exact(input.prepared, ['version', 'request']) || input.prepared.version !== config.version) return null;
            const request = config.request(input.request), original = config.request(input.prepared.request);
            return request && original && taskEditValuesEqual(request, original) ? config.prepared(request) : null;
        };
        const payload = (request: R) => JSON.stringify([config.command, request.change, request.expected, request.consent]);
        const resultFor = (request: R, changed: boolean): ConfigurationResult<R> => ({ change: request.change, changed });
        const validResult = (value: unknown, request: R): value is ConfigurationResult<R> => record(value)
            && exact(value, ['change', 'changed']) && value.changed === true
            && config.change(value.change) !== null && taskEditValuesEqual(value.change, request.change);
        const saved = (request: R): NativeHostResult<ConfigurationResult<R>> | null => {
            const result = receipts.saved<ConfigurationResult<R>>(request.requestId, payload(request));
            if (!result || !result.ok) return result;
            return validResult(result.value, request) ? result : fail('INVALID_INPUT', 'Saved AI text configuration receipt is malformed');
        };
        return {
            async options(input: unknown, current: () => void = () => {}): Promise<NativeHostResult<O>> {
                if (!record(input) || !exact(input, [])) return fail('INVALID_INPUT', 'AI text configuration options take an empty object');
                const saved = await read(current, config.witness); if (!saved.ok) return saved;
                const options = config.options(saved.value.authority.snapshot.settings);
                return options ? { ok: true, value: options }
                    : fail('INVALID_INPUT', 'Saved AI text configuration controls are malformed');
            },
            outcome(input: unknown): NativeHostResult<ConfigurationResult<R>> {
                const ready = deps.readiness(); if (!ready.ok) return ready;
                const request = config.request(input);
                return request ? saved(request) ?? fail('STALE_REVISION', 'AI text configuration outcome is unknown; refresh AI settings')
                    : fail('INVALID_INPUT', 'A bounded AI text configuration request is required');
            },
            async prepare(input: unknown, current: () => void = () => {}, consentRecordedFor: AIProviderId | null = null): Promise<NativeHostResult<C
                | { kind: 'noop'; result: ConfigurationResult<R> }
                | { kind: 'prepared'; prepared: P }>> {
                const request = config.request(input);
                if (!request) return fail('INVALID_INPUT', 'A bounded AI text configuration request is required');
                const key = payload(request), identity = receipts.checkIdentity(request.requestId, key);
                if (!identity.ok) return identity;
                const known = authorizations.get(request.requestId);
                if (known && known.payload !== key) return fail('INVALID_INPUT', 'Request ID already belongs to another action');
                const data = await read(current, config.witness); if (!data.ok) return data;
                const witness = config.witness(data.value.authority.snapshot.settings);
                if (!witness || !taskEditValuesEqual(witness, request.expected))
                    return fail('STALE_REVISION', 'AI text configuration setting changed; refresh AI settings');
                if (!config.plan(witness, request.change))
                    return { ok: true, value: { kind: 'noop', result: resultFor(request, false) } };
                const consentTarget = config.consentTarget(request);
                if (consentTarget && !request.consent && consentRecordedFor !== consentTarget) {
                    const t = deps.t();
                    return { ok: true, value: config.consent(consentTarget, getAIConsentPrompt(consentTarget, false, { t, tr: createAISettingsTranslator(t) })) };
                }
                const prepared = detach<P>(config.prepared(request));
                if (!prepared || !preparedOf({ request, prepared })) return fail('INVALID_INPUT', 'AI text configuration journal exceeds the bound');
                // Another preparation can publish this UUID while the durable read awaits.
                const latestIdentity = receipts.checkIdentity(request.requestId, key);
                if (!latestIdentity.ok) return latestIdentity;
                const latest = authorizations.get(request.requestId);
                if (latest && latest.payload !== key) return fail('INVALID_INPUT', 'Request ID already belongs to another action');
                // The private native facade admits one intent. Retain only applied snapshots
                // that can still own an uncertain save; cancelled unapplied plans need no raw data.
                for (const [id, previous] of authorizations) {
                    if (id !== request.requestId && !previous.authority.saveBoundary) authorizations.delete(id);
                }
                authorizations.set(request.requestId, { payload: key, adapter: data.value.adapter, authority: data.value.authority });
                return { ok: true, value: { kind: 'prepared', prepared } };
            },
            validate(input: unknown): NativeHostResult<ConfigurationResult<R>> {
                const prepared = preparedOf(input);
                return prepared ? { ok: true, value: resultFor(prepared.request, true) }
                    : fail('INVALID_INPUT', 'Prepared AI text configuration request is malformed');
            },
            async commit(input: unknown, current: () => void = () => {}): Promise<NativeHostResult<ConfigurationResult<R>>> {
                const ready = deps.readiness(); if (!ready.ok) return ready;
                const prepared = preparedOf(input);
                if (!prepared) return fail('INVALID_INPUT', 'Prepared AI text configuration request is malformed');
                const request = prepared.request, known = saved(request);
                if (known) { if (known.ok) authorizations.delete(request.requestId); return known; }
                const key = payload(request);
                const result = await receipts.run<ConfigurationResult<R>>(request.requestId, key, async () => {
                    const authorized = authorizations.get(request.requestId);
                    if (!authorized || authorized.payload !== key || getStorageAdapter() !== authorized.adapter)
                        return fail('STALE_REVISION', 'AI text configuration outcome is unknown; refresh AI settings');
                    if (useTaskStore.getState().persistenceFailure)
                        return fail('ACTION_FAILED', 'AI settings have an unresolved persistence failure');
                    const data = await read(current, config.witness);
                    if (useTaskStore.getState().persistenceFailure)
                        return fail('ACTION_FAILED', 'AI settings have an unresolved persistence failure');
                    if (!data.ok) return data;
                    if (data.value.adapter !== authorized.adapter) return fail('STALE_REVISION', 'AI text configuration storage changed');
                    current();
                    const applied = await useTaskStore.getState().commitPreparedAITextConfiguration(request, data.value.authority);
                    if (!applied.success) return fail('STALE_REVISION', 'AI text configuration setting changed; refresh AI settings');
                    authorized.authority = data.value.authority;
                    return { ok: true, value: resultFor(request, true) };
                });
                if (result.ok || result.error.code === 'STALE_REVISION') authorizations.delete(request.requestId);
                return result;
            },
        };
    };
    const v1 = versionMethods<AITextConfigurationRequest, AITextConfigurationOptions, PreparedAITextConfiguration,
        { kind: 'consent'; prompt: AIConsentPrompt }>({
        version: 1, command: 'aiTextConfiguration', request: readNativeAITextConfigurationRequest, change: readAITextConfigurationChange,
        witness: nativeAITextConfigurationWitness, plan: planNativeAITextConfigurationChange,
        options: buildNativeAITextConfigurationOptions, prepared: request => ({ version: 1, request }),
        consentTarget: request => request.change.type === 'enabled' && request.change.value ? 'openai' : null,
        consent: (_provider, prompt) => ({ kind: 'consent', prompt }),
    });
    const v2 = versionMethods<AITextConfigurationRequestV2, AITextConfigurationOptionsV2, PreparedAITextConfigurationV2,
        { kind: 'consent'; provider: AIProviderId; prompt: AIConsentPrompt }>({
        version: 2, command: 'aiTextConfigurationV2', request: readNativeAITextConfigurationRequestV2, change: readAITextConfigurationChangeV2,
        witness: nativeAITextConfigurationWitnessV2, plan: planNativeAITextConfigurationChangeV2,
        options: settings => buildNativeAITextConfigurationOptionsV2(settings, deps.t()), prepared: request => ({ version: 2, request }),
        consentTarget: nativeAITextConfigurationConsentTarget, consent: (provider, prompt) => ({ kind: 'consent', provider, prompt }),
    });
    return { ...v1, prepare: (input: unknown, current: () => void = () => {}, consentRecorded = false) =>
        v1.prepare(input, current, consentRecorded ? 'openai' : null),
        async anthropicThinkingOptions(input: unknown, current: () => void = () => {}): Promise<NativeHostResult<AIAnthropicThinkingOptions>> {
            if (!record(input) || !exact(input, [])) return fail('INVALID_INPUT', 'Anthropic thinking options take an empty object');
            const saved = await read(current, nativeAITextConfigurationWitnessV2); if (!saved.ok) return saved;
            const options = buildNativeAIAnthropicThinkingOptions(saved.value.authority.snapshot.settings, deps.t());
            return options ? { ok: true, value: options } : fail('INVALID_INPUT', 'Anthropic thinking needs a selected Anthropic provider');
        },
        optionsV2: v2.options, prepareV2: v2.prepare, validateV2: v2.validate, commitV2: v2.commit, outcomeV2: v2.outcome };
}
