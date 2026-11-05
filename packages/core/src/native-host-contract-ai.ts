


import { createAIProvider } from './ai/ai-service';
import { fetchProviderModelsCached, mergeModelOptions } from './ai/model-list';
import type { AIProviderConfig, AIProviderId, AIRequestOptions, AIReasoningEffort, AudioCaptureMode, AudioFieldStrategy, CopilotResponse } from './ai/types';
import {
    AI_REQUEST_TIMEOUT_OPTIONS,
    buildAIConfig,
    buildCopilotConfig,
    createAIKeyStore,
    formatOpenAIExtraBodyParams,
    isAIKeyRequired,
    parseOpenAIExtraBodyParamsInput,
    type AIKeyStore,
} from './ai-config';
import {
    AI_MODEL_FETCH_DEBOUNCE_MS,
    canDiscoverAIModels,
    canFetchAIChatModels,
    createAISettingsTranslator,
    getAIConsentPrompt,
    getAIProviderDefaultsPatch,
    getAIProviderLabel,
    getAnthropicThinkingPatch,
    getAnthropicThinkingBudgetPresets,
    getFossSpeechCorrection,
    getSelectedMobileWhisperModel,
    getSpeechModelListKind,
    getSpeechProviderPatch,
    needsFossAIProviderReset,
    normalizeSpeechLanguageInput,
    readAIProviderConsent,
    recordAIProviderConsent,
    resolveAISettingsScreenState,
    type AIConsentPrompt,
    type SpeechProviderChoice,
} from './ai-settings-model';
import {
    appendTaskBreakdownSteps,
    applyTaskCopilotParts,
    buildInboxClarifyInput,
    buildTaskBreakdownInput,
    buildTaskClarifyInput,
    formatTaskCopilotApplied,
    getAIClarifyDialog,
    getAIErrorAlert,
    getTaskAIProjectContext,
    getTaskBreakdownDialog,
    getTaskBreakdownSteps,
    getTaskClarifySuggestionEdit,
    getTaskCopilotParts,
    getTaskCopilotText,
    getWeeklyReviewAnalysisError,
    keepTaskCopilotSuggestion,
    readWeeklyReviewAnalysis,
    redactAIError,
    TASK_COPILOT_DELAY_MS,
    type TaskCopilotPart,
} from './ai-task-actions';
import { applyCaptureModalCopilotParts } from './capture-modal-model';
import type { Language } from './i18n/i18n-types';
import { NATIVE_HOST_CONTRACT_VERSION, type NativeHostResult, type NativeInboxProcessingView, type NativeTaskDraftEdit } from './native-host-contract';
import { fail, isObjectRecord, isText } from './native-host-contract-menu-views';
import { createNativeRequestReceipts, runStoreWrite, settleWrite, taskRevisionOf } from './native-request-receipts';
import { getProcessInboxTokenPools, type ProcessInboxDraftEdit } from './process-inbox-model';
import { resolveFeatureFlags } from './resolve-feature-flags';
import { getWeeklyReviewBuckets } from './review-utils';
import { getReviewSuggestionActionLabel, getWeeklyReviewLabels, getWeeklyReviewSettings, isActionableReviewSuggestion } from './review-views-model';
import { isSandboxMode } from './sandbox';
import { useTaskStore } from './store';
import { createSyncSecretVault } from './sync-secret-storage';
import { getChecklistEditStatus } from './task-checklist-model';
import { taskDraftToUpdatePatch, type TaskDraft } from './task-draft';
import { parseTaskEditorTokenList } from './task-editor-model';
import type { AppSettings, ChecklistItem, Task, TimeEstimate } from './types';
import { deterministicHash128Hex, generateUUID } from './uuid';
import { exact, isNativeJsonWithinBytes } from './native-json';
import { abortableAIFetch } from './ai/utils';

type Translate = (key: string) => string;
type AISettings = NonNullable<AppSettings['ai']>;
type SpeechSettings = NonNullable<AISettings['speechToText']>;


export type NativeAIHost = {
    platform: {

        isFossBuild: boolean;
    };

    storage: {
        getItem(key: string): Promise<string | null>;
        setItem(key: string, value: string): Promise<void>;
        removeItem(key: string): Promise<void>;
    };

    secrets: {
        get(key: string): Promise<string | null>;
        set(key: string, value: string): Promise<void>;
        delete(key: string): Promise<void>;
    };


    fetch?: typeof fetch;
    /** Read-only action loader supplied by hosts that must not migrate existing credentials. Settings keep their normal store. */
    loadRequestKey?: (provider: AIProviderId) => Promise<string | null>;
    /** A selected native configuration owner stores the explicit replacement without broad key-store access. */
    saveConfigurationKey?: (provider: AIProviderId, value: string) => Promise<void>;
    /** The app log (no key is ever passed). */
    log?: {
        warn(message: string): void;
        info(message: string, context: { scope: string; extra: Record<string, string | number> }): void;
    };

    whisper?: {
        preferredModelUri(modelId: string): string;

        locate(modelId: string, storedPath: string | undefined): Promise<{ exists: boolean; uri: string; size: number }>;
    };
};

/** Commands carrying credentials, private URLs or arbitrary request JSON stay process-only. */
export const NATIVE_AI_UNJOURNALED_COMMANDS = ['setAIKey', 'setAIEndpoint', 'setAIExtraBodyParams'] as const;

export type AIDeps = {
    readiness: () => NativeHostResult<null>;
    save: () => Promise<NativeHostResult<null>>;
    t: () => Translate;
    language: () => Language;
    requestIdPattern: RegExp;
    host: () => NativeAIHost | null;

    readDraft: (value: unknown) => TaskDraft | null;

    isReadOnly: (task: Task) => boolean;

    inboxStep: (input: { sessionId: string; taskId: string; step: string }) => NativeHostResult<NativeInboxProcessingView>;
};

export type NativeAIToast = { title: string; message: string; tone: 'warning'; durationMs: number };
export type NativeAIChoice<T> = { value: T; label: string; selected: boolean };
type NativeAIRow = { label: string; description: string | null };
type NativeAIKeyField = NativeAIRow & { note: string | null; placeholder: string; mask: string };

export type NativeAIProviderPanel =
    | {
        kind: 'openai';
        reasoning: NativeAIRow & { options: NativeAIChoice<AIReasoningEffort>[] };
        baseUrl: NativeAIRow & { placeholder: string; value: string };

        extraBody: NativeAIRow & { placeholder: string; value: string; hint: string; error: string | null; save: string };
        apiKey: NativeAIKeyField;
    }
    | { kind: 'gemini'; thinking: NativeAIRow & { options: NativeAIChoice<number>[] }; apiKey: NativeAIKeyField }
    | {
        kind: 'anthropic';
        thinking: NativeAIRow & { value: boolean };

        budget: (NativeAIRow & { options: NativeAIChoice<number>[] }) | null;
        apiKey: NativeAIKeyField;
    };


export type NativeAISettings = {
    version: typeof NATIVE_HOST_CONTRACT_VERSION;
    title: string;
    assistant: {
        title: string;
        description: string;
        enabled: NativeAIRow & { value: boolean };
        provider: NativeAIRow & { options: NativeAIChoice<AIProviderId>[] };
        model: NativeAIRow & { value: string; placeholder: string; suggestions: string };
        copilotModel: NativeAIRow & { value: string; placeholder: string; suggestions: string };
        panel: NativeAIProviderPanel;
        advanced: {
            label: string;
            timeout: NativeAIRow & { value: string; options: NativeAIChoice<number>[] };
        };
    };
    speech: {
        title: string;
        description: string;
        enabled: NativeAIRow & { value: boolean };
        provider: NativeAIRow & { options: NativeAIChoice<SpeechProviderChoice>[] };

        model: NativeAIRow & { kind: 'input' | 'dropdown'; value: string; suggestions: string };

        whisper: (NativeAIRow & { status: string; action: { label: string; kind: 'download' | 'delete'; enabled: boolean } }) | null;
        apiKey: NativeAIKeyField | null;
        baseUrl: (NativeAIRow & { placeholder: string; value: string }) | null;
        language: NativeAIRow & { placeholder: string; value: string };
        mode: NativeAIRow & { options: NativeAIChoice<AudioCaptureMode>[] };
        fieldStrategy: NativeAIRow & { options: NativeAIChoice<AudioFieldStrategy>[] };
    };

    pickers: {
        model: { title: string; options: NativeAIChoice<string>[] };
        copilotModel: { title: string; options: NativeAIChoice<string>[] };
        speechModel: { title: string; options: NativeAIChoice<string>[] };
    };

    modelLists: { delayMs: number; assistant: { request: string | null }; speech: { request: string | null } };
};


export type NativeAISettingChange =
    | { type: 'enabled'; value: boolean }
    | { type: 'provider'; value: AIProviderId }
    | { type: 'model' | 'copilotModel'; value: string }
    | { type: 'reasoningEffort'; value: AIReasoningEffort }
    | { type: 'thinkingBudget'; value: number }
    | { type: 'anthropicThinking'; value: boolean }
    | { type: 'requestTimeoutSeconds'; value: number }

    | { type: 'extraBodyParams'; text: string }
    | { type: 'speechEnabled'; value: boolean }
    | { type: 'speechProvider'; value: SpeechProviderChoice }
    | { type: 'speechModel'; value: string }

    | { type: 'speechLanguage'; text: string }
    | { type: 'speechMode'; value: AudioCaptureMode }
    | { type: 'speechFieldStrategy'; value: AudioFieldStrategy };

export type NativeAISettingResult = {
    changed: boolean;

    consent: AIConsentPrompt | null;

    extraBodyDraft: string | null;
    toasts: NativeAIToast[];
};


export type NativeAIDialogChoice<Apply> = { label: string; variant: 'primary' | 'secondary' | null; apply: Apply | null };


export type NativeAIActionAnswer<Apply> =
    | { kind: 'none' }
    | { kind: 'alert'; title: string; message: string }
    | { kind: 'toast'; toast: NativeAIToast & { action: { label: string; screen: 'ai' } } }
    | { kind: 'dialog'; title: string; message: string | null; choices: NativeAIDialogChoice<Apply>[] };


export type NativeAICopilotSuggestion = CopilotResponse & { language: Language };

export type NativeAICopilotApplied = { context?: string; timeEstimate?: TimeEstimate; tags: string[] };


export type NativeTaskEditorAI = {

    enabled: boolean;
    clarify: string;
    breakdown: string;

    working: string;
    copilot: {

        request: { text: string; delayMs: number } | null;
        suggested: {
            label: string;

            parts: { kind: TaskCopilotPart['kind']; label: string; edit: NativeTaskDraftEdit; applied: NativeAICopilotApplied }[];

            applyAll: { label: string; edit: NativeTaskDraftEdit; applied: NativeAICopilotApplied } | null;
            hint: string;
        } | null;
        applied: string | null;
    };
};


export type NativeAIBreakdownApply = { checklist: ChecklistItem[]; edit: NativeTaskDraftEdit | null };

export type NativeWeeklyReviewAnalysis = {

    error: string | null;


    suggestions: { id: string; action: string; reason: string; title: string; meta: string; actionable: boolean; taskRevision: string | null }[] | null;

    selectedIds: string[] | null;
};

const PROVIDERS: readonly AIProviderId[] = ['openai', 'gemini', 'anthropic'];
const SPEECH_PROVIDERS: readonly SpeechProviderChoice[] = ['openai', 'gemini', 'whisper'];
const EFFORTS: readonly AIReasoningEffort[] = ['low', 'medium', 'high'];
const MODES: readonly AudioCaptureMode[] = ['smart_parse', 'transcribe_only'];
const STRATEGIES: readonly AudioFieldStrategy[] = ['smart', 'title_only', 'description_only'];
const GEMINI_BUDGETS = [0, 128, 256, 512];
const anthropicBudgets = getAnthropicThinkingBudgetPresets;
const EXTRA_BODY_PLACEHOLDER = '{\n  "thinking": { "type": "disabled" }\n}';
const SPEECH_BASE_URL_PLACEHOLDER = 'http://localhost:8000/v1';
const TEXT_LIMIT = 4000;

/** Shared private-editor preflight. No input or parser error text crosses its boundary. */
export function readNativeAIExtraBodyInput(text: unknown): { value: Record<string, unknown> | undefined; formatted: string } | null {
    if (typeof text !== 'string' || text.length > TEXT_LIMIT) return null;
    try {
        const parsed = parseOpenAIExtraBodyParamsInput(text);
        if (!parsed.ok) return null;
        const formatted = formatOpenAIExtraBodyParams(parsed.value);
        return formatted.length <= TEXT_LIMIT && isNativeJsonWithinBytes({ value: formatted }, 16 * 1024)
            ? { value: parsed.value, formatted } : null;
    } catch { return null; }
}

const KEY_LIMIT = 4000;

const mask = (key: string) => '•'.repeat(key.length);
const same = (left: unknown, right: unknown) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
const isOneOf = <T,>(values: readonly T[]) => (value: unknown): value is T => values.includes(value as T);


type ModelList = { request: string; models: string[] | null; signal?: AbortSignal };
type Visit = {

    keys: { assistant: { provider: AIProviderId; value: string } | null; speech: { provider: SpeechProviderChoice; value: string } | null };
    models: { assistant: ModelList | null; speech: ModelList | null };
    whisper: { modelId: string; exists: boolean; size: number } | null;

    extraBody: { error: string; stored: string } | null;

    consent: Record<string, boolean> | null;
};

const readChange = (value: unknown): NativeAISettingChange | null => {
    if (!isObjectRecord(value) || typeof value.type !== 'string') return null;
    const one = (keys: string[]) => Object.keys(value).every((key) => keys.includes(key));
    const text = (entry: unknown, max = TEXT_LIMIT) => isText(entry, max);
    switch (value.type) {
        case 'enabled':
        case 'anthropicThinking':
        case 'speechEnabled':
            return one(['type', 'value']) && typeof value.value === 'boolean' ? value as NativeAISettingChange : null;
        case 'provider':
            return one(['type', 'value']) && isOneOf(PROVIDERS)(value.value) ? value as NativeAISettingChange : null;
        case 'model':
        case 'copilotModel':
        case 'speechModel':
            return one(['type', 'value']) && text(value.value, 2000) ? value as NativeAISettingChange : null;
        case 'reasoningEffort':
            return one(['type', 'value']) && isOneOf(EFFORTS)(value.value) ? value as NativeAISettingChange : null;
        case 'thinkingBudget':
            return one(['type', 'value']) && [...GEMINI_BUDGETS, ...anthropicBudgets()].includes(value.value as number) ? value as NativeAISettingChange : null;
        case 'requestTimeoutSeconds':
            return one(['type', 'value']) && AI_REQUEST_TIMEOUT_OPTIONS.some((option) => option === value.value) ? value as NativeAISettingChange : null;
        case 'extraBodyParams':
        case 'speechLanguage':
            return one(['type', 'text']) && text(value.text) ? value as NativeAISettingChange : null;
        case 'speechProvider':
            return one(['type', 'value']) && isOneOf(SPEECH_PROVIDERS)(value.value) ? value as NativeAISettingChange : null;
        case 'speechMode':
            return one(['type', 'value']) && isOneOf(MODES)(value.value) ? value as NativeAISettingChange : null;
        case 'speechFieldStrategy':
            return one(['type', 'value']) && isOneOf(STRATEGIES)(value.value) ? value as NativeAISettingChange : null;
        default:
            return null;
    }
};

export function createAIMethods(deps: AIDeps) {
    const receipts = createNativeRequestReceipts({ save: deps.save });

    const salt = generateUUID();
    const fingerprint = (value: unknown): string => deterministicHash128Hex(JSON.stringify([salt, value]));
    const extraBodyRequest = (input: unknown): { requestId: string; text: string; value: Record<string, unknown> | undefined; payload: string } | null => {
        if (!isObjectRecord(input) || !exact(input, ['requestId', 'text']) || typeof input.requestId !== 'string'
            || !deps.requestIdPattern.test(input.requestId) || typeof input.text !== 'string') return null;
        const parsed = readNativeAIExtraBodyInput(input.text);
        return parsed ? { requestId: input.requestId, text: input.text, value: parsed.value,
            payload: JSON.stringify(['setAIExtraBodyParams', fingerprint(['extra-body', input.text])]) } : null;
    };
    const extraBodySaved = (request: NonNullable<ReturnType<typeof extraBodyRequest>>): NativeHostResult<{ changed: boolean }> | null => {
        const saved = receipts.saved<{ changed: boolean }>(request.requestId, request.payload);
        if (!saved || !saved.ok) return saved;
        return isObjectRecord(saved.value) && exact(saved.value, ['changed']) && typeof saved.value.changed === 'boolean'
            ? saved : fail('INVALID_INPUT', 'AI extra body parameters result is malformed');
    };
    let visit: Visit | null = null;

    let keyStoreFor: { host: NativeAIHost; store: AIKeyStore } | null = null;

    const requireHost = (): NativeHostResult<NativeAIHost> => {
        const ready = deps.readiness();
        if (!ready.ok) return ready;
        const host = deps.host();
        return host ? { ok: true, value: host } : fail('ACTION_FAILED', 'AI is not available on this device yet');
    };
    const keys = (host: NativeAIHost): AIKeyStore => {
        if (keyStoreFor?.host !== host) {
            const secrets = {
                getItem: (key: string) => host.secrets.get(key),
                setItem: (key: string, value: string) => host.secrets.set(key, value),
                deleteItem: (key: string) => host.secrets.delete(key),
            };
            keyStoreFor = {
                host,
                store: createAIKeyStore({ storage: host.storage, secrets, vault: createSyncSecretVault({ isAvailable: async () => true }) }),
            };
        }
        return keyStoreFor.store;
    };
    const warn = (host: NativeAIHost) => (message: string) => { host.log?.warn(message); };
    const settings = (): AppSettings => useTaskStore.getState().settings;
    const translators = () => {
        const t = deps.t();
        return { t, tr: createAISettingsTranslator(t) };
    };


    const aiUpdate = (patch: Partial<AISettings>) => ({ ai: { ...(settings().ai ?? {}), ...patch } });
    const speechPatch = (patch: Partial<SpeechSettings>): Partial<AISettings> => ({ speechToText: { ...(settings().ai?.speechToText ?? {}), ...patch } });
    const holds = (patch: Partial<AISettings>): boolean => {
        const stored = settings().ai ?? {};
        return Object.entries(patch).every(([key, value]) => (key === 'speechToText'
            ? Object.entries(value as SpeechSettings).every(([field, entry]) => same(stored.speechToText?.[field as keyof SpeechSettings], entry))
            : same(stored[key as keyof AISettings], value)));
    };

    const writeAI = async (...patches: Partial<AISettings>[]): Promise<NativeHostResult<boolean>> => {
        let changed = false;
        for (const patch of patches) {
            if (holds(patch)) continue;
            const written = await runStoreWrite(() => useTaskStore.getState().updateSettings(aiUpdate(patch)));
            if (!written.ok) return written;
            changed = true;
        }
        return { ok: true, value: changed };
    };


    const whisperPathFix = async (host: NativeAIHost, isFossBuild: boolean): Promise<Partial<AISettings> | null> => {
        const state = resolveAISettingsScreenState(settings(), isFossBuild);
        if (!host.whisper || state.speechProvider !== 'whisper') {
            if (visit) visit.whisper = null;
            return null;
        }
        const storedPath = settings().ai?.speechToText?.offlineModelPath;
        const resolved = await host.whisper.locate(state.speechModel, storedPath);
        if (visit) visit.whisper = { modelId: state.speechModel, exists: resolved.exists, size: resolved.size };
        if (!storedPath) return null;
        const nextPath = resolved.exists ? resolved.uri : host.whisper.preferredModelUri(state.speechModel);
        return nextPath && nextPath !== storedPath ? speechPatch({ offlineModelPath: nextPath }) : null;
    };


    const loadKeys = async (host: NativeAIHost, isFossBuild: boolean) => {
        if (!visit) return;
        const state = resolveAISettingsScreenState(settings(), isFossBuild);
        const load = async (provider: AIProviderId) => {
            try {
                return await keys(host).load(provider);
            } catch {
                host.log?.warn('Failed to load AI key');
                return '';
            }
        };
        if (visit.keys.assistant?.provider !== state.aiProvider) {
            visit.keys.assistant = { provider: state.aiProvider, value: await load(state.aiProvider) };
        }
        if (visit.keys.speech?.provider !== state.speechProvider) {
            visit.keys.speech = {
                provider: state.speechProvider,
                value: state.speechProvider === 'whisper' ? '' : await load(state.speechProvider),
            };
        }
    };

    const modelRequests = (isFossBuild: boolean) => {
        const state = resolveAISettingsScreenState(settings(), isFossBuild);
        const assistantKey = visit?.keys.assistant?.provider === state.aiProvider ? visit.keys.assistant.value : '';
        const speechKey = visit?.keys.speech?.provider === state.speechProvider ? visit.keys.speech.value : '';
        const consent = visit?.consent ?? null;
        const agreed = (provider: string) => consent !== null
            && canDiscoverAIModels({ provider, consent, aiEnabled: state.aiEnabled, aiProvider: state.aiProvider });
        const assistant = agreed(state.aiProvider)
            && canFetchAIChatModels({ isFossBuild, provider: state.aiProvider, apiKey: assistantKey.trim(), baseUrl: state.aiBaseUrl.trim() })
            ? { provider: state.aiProvider, apiKey: assistantKey.trim(), baseUrl: state.aiBaseUrl.trim(), kind: 'chat' as const }
            : null;
        const speechKind = getSpeechModelListKind({ provider: state.speechProvider, apiKey: speechKey.trim(), baseUrl: state.speechBaseUrl.trim() });
        const speech = speechKind && state.speechProvider !== 'whisper' && agreed(state.speechProvider)
            ? { provider: state.speechProvider as AIProviderId, apiKey: speechKey.trim(), baseUrl: state.speechBaseUrl.trim(), kind: speechKind }
            : null;
        return {
            assistant: assistant ? { ...assistant, request: fingerprint(['assistant', assistant]) } : null,
            speech: speech ? { ...speech, request: fingerprint(['speech', speech]) } : null,
        };
    };

    const buildView = (host: NativeAIHost): NativeAISettings => {
        const { isFossBuild } = host.platform;
        const { t, tr } = translators();
        const stored = settings();
        const state = resolveAISettingsScreenState(stored, isFossBuild);
        const requests = modelRequests(isFossBuild);
        const fetched = (list: 'assistant' | 'speech') => {
            const loaded = visit?.models[list];
            return loaded && loaded.request === requests[list]?.request ? loaded.models : null;
        };
        const aiModelOptions = mergeModelOptions(fetched('assistant'), state.staticAiModelOptions, state.aiModel);
        const aiCopilotOptions = mergeModelOptions(fetched('assistant'), state.staticAiCopilotOptions, state.aiCopilotModel);
        const speechModelOptions = mergeModelOptions(fetched('speech'), state.staticSpeechModelOptions, state.speechModel);
        const providerLabel = (provider: AIProviderId) => getAIProviderLabel(provider, isFossBuild, { t, tr });
        const assistantKey = visit?.keys.assistant?.provider === state.aiProvider ? visit.keys.assistant.value : '';
        const speechKey = visit?.keys.speech?.provider === state.speechProvider ? visit.keys.speech.value : '';
        const keyField = (key: string, note: string | null): NativeAIKeyField => ({
            label: t('settings.aiApiKey'), description: t('settings.aiApiKeyHint'), note, placeholder: t('settings.aiApiKeyPlaceholder'), mask: mask(key),
        });
        const choices = <T,>(options: { value: T; label: string }[], selected: T): NativeAIChoice<T>[] => (
            options.map((option) => ({ ...option, selected: option.value === selected }))
        );
        const formattedExtraBody = formatOpenAIExtraBodyParams(state.aiOpenAIExtraBodyParams);
        const extraBodyError = visit?.extraBody && visit.extraBody.stored === formattedExtraBody ? visit.extraBody.error : null;
        const panel: NativeAIProviderPanel = state.aiProvider === 'openai'
            ? {
                kind: 'openai',
                reasoning: {
                    label: t('settings.aiReasoning'),
                    description: t(isFossBuild ? 'settings.aiReasoningHintFoss' : 'settings.aiReasoningHint'),
                    options: choices(EFFORTS.map((effort) => ({
                        value: effort,
                        label: t(effort === 'low' ? 'settings.aiEffortLow' : effort === 'medium' ? 'settings.aiEffortMedium' : 'settings.aiEffortHigh'),
                    })), state.aiReasoningEffort),
                },
                baseUrl: { label: t('settings.aiBaseUrl'), description: t('settings.aiBaseUrlHint'), placeholder: t('settings.aiBaseUrlPlaceholder'), value: state.aiBaseUrl },
                extraBody: {
                    label: t('settings.aiExtraBodyParams'),
                    description: t('settings.aiExtraBodyParamsDesc'),
                    placeholder: EXTRA_BODY_PLACEHOLDER,
                    value: formattedExtraBody,
                    hint: t('settings.aiExtraBodyParamsHint'),
                    error: extraBodyError,
                    save: t('settings.aiExtraBodyParamsSave'),
                },
                apiKey: keyField(assistantKey, isFossBuild ? tr('settings.aiMobile.useTheApiKeyForYourLocalOrSelfHosted') : null),
            }
            : state.aiProvider === 'gemini'
                ? {
                    kind: 'gemini',
                    thinking: {
                        label: t('settings.aiThinkingBudget'),
                        description: t('settings.aiThinkingHint'),
                        options: choices([
                            { value: 0, label: t('settings.aiThinkingOff') },
                            { value: 128, label: t('settings.aiThinkingLow') },
                            { value: 256, label: t('settings.aiThinkingMedium') },
                            { value: 512, label: t('settings.aiThinkingHigh') },
                        ], state.aiThinkingBudget),
                    },
                    apiKey: keyField(assistantKey, null),
                }
                : {
                    kind: 'anthropic',
                    thinking: { label: t('settings.aiThinkingEnable'), description: t('settings.aiThinkingEnableDesc'), value: state.anthropicThinkingEnabled },
                    budget: state.anthropicThinkingEnabled
                        ? {
                            label: t('settings.aiThinkingBudget'),
                            description: t('settings.aiThinkingHint'),
                            options: choices(anthropicBudgets().map((value, index) => ({
                                value,
                                label: t(['settings.aiThinkingLow', 'settings.aiThinkingMedium', 'settings.aiThinkingHigh'][index]),
                            })), state.aiThinkingBudget),
                        }
                        : null,
                    apiKey: keyField(assistantKey, null),
                };
        const whisperModel = getSelectedMobileWhisperModel(state.speechModel);
        const whisperFile = visit?.whisper && visit.whisper.modelId === state.speechModel ? visit.whisper : null;
        const whisperReady = Boolean(whisperModel && whisperFile?.exists && whisperFile.size === whisperModel.sizeBytes);
        const speechProviderLabel = (provider: SpeechProviderChoice) => (provider === 'openai'
            ? t('settings.aiProviderOpenAI')
            : provider === 'gemini' ? t('settings.aiProviderGemini') : t('settings.speechProviderOffline'));
        return {
            version: NATIVE_HOST_CONTRACT_VERSION,
            title: t('settings.ai'),
            assistant: {
                title: t('settings.ai'),
                description: t('settings.aiDesc'),
                enabled: {
                    label: t('settings.aiEnable'),
                    description: tr('settings.aiMobile.taskTextSentToProvider', { provider: providerLabel(state.aiProvider) }),
                    value: state.aiEnabled,
                },
                provider: {
                    label: t('settings.aiProvider'),
                    description: providerLabel(state.aiProvider),
                    options: choices((isFossBuild ? PROVIDERS.slice(0, 1) : PROVIDERS).map((provider) => ({
                        value: provider,
                        label: provider === 'openai' ? providerLabel('openai') : t(provider === 'gemini' ? 'settings.aiProviderGemini' : 'settings.aiProviderAnthropic'),
                    })), state.aiProvider),
                },
                model: { label: t('settings.aiModel'), description: null, value: state.aiModel, placeholder: aiModelOptions[0] ?? '', suggestions: tr('settings.aiMobile.suggestions') },
                copilotModel: {
                    label: t('settings.aiCopilotModel'),
                    description: t('settings.aiCopilotHint'),
                    value: state.aiCopilotModel,
                    placeholder: aiCopilotOptions[0] ?? '',
                    suggestions: tr('settings.aiMobile.suggestions'),
                },
                panel,
                advanced: {
                    label: t('settings.aiAdvanced'),
                    timeout: {
                        label: t('settings.aiRequestTimeout'),
                        description: t('settings.aiRequestTimeoutDesc'),
                        value: tr('settings.aiRequestTimeoutSeconds', { seconds: state.aiRequestTimeoutSeconds }),
                        options: choices(AI_REQUEST_TIMEOUT_OPTIONS.map((seconds) => ({
                            value: seconds as number, label: tr('settings.aiRequestTimeoutSeconds', { seconds }),
                        })), state.aiRequestTimeoutSeconds),
                    },
                },
            },
            speech: {
                title: t('settings.speechTitle'),
                description: t('settings.speechDesc'),
                enabled: { label: t('settings.speechEnable'), description: null, value: state.speechEnabled },
                provider: {
                    label: t('settings.speechProvider'),
                    description: speechProviderLabel(state.speechProvider),
                    options: choices((isFossBuild ? SPEECH_PROVIDERS.slice(2) : SPEECH_PROVIDERS).map((provider) => ({
                        value: provider,
                        label: provider === 'whisper' && isFossBuild ? tr('settings.aiMobile.localWhisper') : speechProviderLabel(provider),
                    })), state.speechProvider),
                },
                model: {
                    label: t('settings.speechModel'),
                    description: null,
                    kind: state.speechProvider === 'openai' ? 'input' : 'dropdown',
                    value: state.speechModel,
                    suggestions: tr('settings.aiMobile.suggestions'),
                },
                whisper: state.speechProvider === 'whisper'
                    ? {
                        label: t('settings.speechOfflineModel'),
                        description: t('settings.speechOfflineModelDesc'),
                        status: `${whisperReady ? t('settings.speechOfflineReady') : t('settings.speechOfflineNotDownloaded')}${
                            whisperReady && whisperFile && whisperFile.size > 0 ? ` - ${(whisperFile.size / (1024 * 1024)).toFixed(1)} MB` : ''}`,
                        action: whisperReady
                            ? { label: t('settings.speechOfflineDelete'), kind: 'delete', enabled: false }
                            : { label: t('settings.speechOfflineDownload'), kind: 'download', enabled: false },
                    }
                    : null,
                apiKey: state.speechProvider === 'whisper'
                    ? null
                    : { label: t('settings.aiApiKey'), description: t('settings.aiApiKeyHint'), note: null, placeholder: t('settings.aiApiKeyPlaceholder'), mask: mask(speechKey) },
                baseUrl: state.speechProvider === 'openai'
                    ? { label: t('settings.speechBaseUrl'), description: t('settings.speechBaseUrlHint'), placeholder: SPEECH_BASE_URL_PLACEHOLDER, value: state.speechBaseUrl }
                    : null,
                language: {
                    label: t('settings.speechLanguage'),
                    description: t('settings.speechLanguageHint'),
                    placeholder: t('settings.speechLanguageAuto'),
                    value: state.speechLanguage === 'auto' ? '' : state.speechLanguage,
                },
                mode: {
                    label: t('settings.speechMode'),
                    description: t('settings.speechModeHint'),
                    options: choices([
                        { value: 'smart_parse' as const, label: t('settings.speechModeSmart') },
                        { value: 'transcribe_only' as const, label: t('settings.speechModeTranscript') },
                    ], state.speechMode as AudioCaptureMode),
                },
                fieldStrategy: {
                    label: t('settings.speechFieldStrategy'),
                    description: t('settings.speechFieldStrategyHint'),
                    options: choices([
                        { value: 'smart' as const, label: t('settings.speechFieldSmart') },
                        { value: 'title_only' as const, label: t('settings.speechFieldTitle') },
                        { value: 'description_only' as const, label: t('settings.speechFieldDescription') },
                    ], state.speechFieldStrategy as AudioFieldStrategy),
                },
            },
            pickers: {
                model: { title: t('settings.aiModel'), options: choices(aiModelOptions.map((value) => ({ value, label: value })), state.aiModel) },
                copilotModel: { title: t('settings.aiCopilotModel'), options: choices(aiCopilotOptions.map((value) => ({ value, label: value })), state.aiCopilotModel) },
                speechModel: { title: t('settings.speechModel'), options: choices(speechModelOptions.map((value) => ({ value, label: value })), state.speechModel) },
            },
            modelLists: {
                delayMs: AI_MODEL_FETCH_DEBOUNCE_MS,
                assistant: { request: requests.assistant?.request ?? null },
                speech: { request: requests.speech?.request ?? null },
            },
        };
    };


    const planChange = (
        host: NativeAIHost,
        change: NativeAISettingChange,
    ): { patches: Partial<AISettings>[]; consentFor: AIProviderId | null; extraBodyDraft?: string }
        | { answer: Omit<NativeAISettingResult, 'toasts'> & { toast?: NativeAIToast } }
        | null => {
        const { isFossBuild } = host.platform;
        const state = resolveAISettingsScreenState(settings(), isFossBuild);
        const unchanged = { answer: { changed: false, consent: null, extraBodyDraft: null } };
        switch (change.type) {
            case 'enabled':
                return change.value ? { patches: [{ enabled: true }], consentFor: state.aiProvider } : { patches: [{ enabled: false }], consentFor: null };
            case 'provider':
                if (isFossBuild && change.value !== 'openai') return null;
                if (change.value === state.aiProvider) return unchanged;
                return { patches: [getAIProviderDefaultsPatch(change.value, isFossBuild)], consentFor: state.aiEnabled ? change.value : null };
            case 'model':
            case 'copilotModel':
                return { patches: [{ [change.type]: change.value }], consentFor: null };
            case 'reasoningEffort':
                return state.aiProvider === 'openai' ? { patches: [{ reasoningEffort: change.value }], consentFor: null } : null;
            case 'thinkingBudget':
                return (state.aiProvider === 'gemini' && GEMINI_BUDGETS.includes(change.value))
                    || (state.aiProvider === 'anthropic' && state.anthropicThinkingEnabled && anthropicBudgets().includes(change.value))
                    ? { patches: [{ thinkingBudget: change.value }], consentFor: null }
                    : null;
            case 'anthropicThinking':
                if (state.aiProvider !== 'anthropic') return null;

                return change.value === state.anthropicThinkingEnabled ? unchanged : { patches: [getAnthropicThinkingPatch(change.value)], consentFor: null };
            case 'requestTimeoutSeconds':
                return { patches: [{ requestTimeoutSeconds: change.value }], consentFor: null };
            case 'extraBodyParams': {
                if (state.aiProvider !== 'openai') return null;
                const parsed = parseOpenAIExtraBodyParamsInput(change.text);
                if (!parsed.ok) {
                    const { t } = translators();
                    const message = t('settings.aiExtraBodyParamsInvalid');
                    if (visit) visit.extraBody = { error: message, stored: formatOpenAIExtraBodyParams(state.aiOpenAIExtraBodyParams) };
                    return {
                        answer: {
                            changed: false, consent: null, extraBodyDraft: null,
                            toast: { title: t('settings.aiExtraBodyParams'), message, tone: 'warning', durationMs: 4200 },
                        },
                    };
                }
                if (visit) visit.extraBody = null;
                return { patches: [{ openAIExtraBodyParams: parsed.value }], consentFor: null, extraBodyDraft: formatOpenAIExtraBodyParams(parsed.value) };
            }
            case 'speechEnabled':
                return { patches: [speechPatch({ enabled: change.value })], consentFor: null };
            case 'speechProvider':
                if (isFossBuild && change.value !== 'whisper') return null;

                if (change.value === state.speechProvider) return unchanged;
                return { patches: [speechPatch(getSpeechProviderPatch(change.value, (modelId) => host.whisper?.preferredModelUri(modelId)))], consentFor: null };
            case 'speechModel':
                return {
                    patches: [speechPatch(state.speechProvider === 'whisper'
                        ? { model: change.value, offlineModelPath: host.whisper?.preferredModelUri(change.value) }
                        : { model: change.value })],
                    consentFor: null,
                };
            case 'speechLanguage':
                return { patches: [speechPatch({ language: normalizeSpeechLanguageInput(change.text) })], consentFor: null };
            case 'speechMode':
                return { patches: [speechPatch({ mode: change.value })], consentFor: null };
            case 'speechFieldStrategy':
                return { patches: [speechPatch({ fieldStrategy: change.value })], consentFor: null };
            default:
                return null;
        }
    };


    const providerFor = async (host: NativeAIHost, copilot: boolean) => {
        const stored = settings();
        const provider = (stored.ai?.provider ?? 'openai') as AIProviderId;
        if (stored.ai?.enabled !== true) return { gate: 'disabled' as const, apiKey: '' };
        const apiKey = host.loadRequestKey ? await host.loadRequestKey(provider) ?? '' : await keys(host).load(provider);
        if (isAIKeyRequired(stored) && !apiKey) return { gate: 'missingKey' as const, apiKey };
        const build = (): AIProviderConfig => {
            if (isSandboxMode()) throw new Error('Unavailable in sandbox');
            const config = (copilot ? buildCopilotConfig : buildAIConfig)(stored, apiKey);
            return {
                ...config,
                language: deps.language(),
                ...(host.fetch ? { fetcher: host.fetch } : {}),
                onRequestStop: (reason) => {
                    host.log?.info('AI request stopped without retry', {
                        scope: 'ai',
                        extra: { releaseCheck: 'v1.3.0/ai-request-stop-once', outcome: reason, provider: config.provider, timeoutMs: config.timeoutMs ?? 0 },
                    });
                },
            };
        };
        return { gate: 'ready' as const, apiKey, build, sent: stored };
    };

    const editorTask = (input: { id: unknown; draft: unknown }): NativeHostResult<{ task: Task; draft: TaskDraft }> => {
        if (!isObjectRecord(input) || typeof input.id !== 'string' || !input.id.trim()) return fail('INVALID_INPUT', 'Task ID is required');
        const draft = deps.readDraft(input.draft);
        if (!draft) return fail('INVALID_INPUT', 'draft must hold every task draft field with a valid value');
        const task = useTaskStore.getState()._tasksById.get(input.id);
        if (!task || task.deletedAt) return fail('TASK_NOT_FOUND', 'Task not found');
        return { ok: true, value: { task, draft } };
    };
    const mergedTask = (task: Task, draft: TaskDraft) => ({ ...task, ...(taskDraftToUpdatePatch(draft, task, { attachments: task.attachments ?? [] }) ?? {}) });
    const projectContext = (task: Task, draft: TaskDraft) => (settings().ai?.enabled === true
        ? getTaskAIProjectContext({ projectId: draft.projectId, projects: useTaskStore.getState().projects, tasks: useTaskStore.getState().tasks, taskId: task.id })
        : null);
    const gateAlert = (gate: 'disabled' | 'missingKey'): NativeAIActionAnswer<never> => {
        const t = deps.t();
        return gate === 'disabled'
            ? { kind: 'alert', title: t('ai.disabledTitle'), message: t('ai.disabledBody') }
            : { kind: 'alert', title: t('ai.missingKeyTitle'), message: t('ai.missingKeyBody') };
    };


    const sentRedacted = (error: unknown, apiKey: string, sent: AppSettings | null): unknown => (sent ? redactAIError(error, apiKey, sent) : error);
    const errorAlert = (error: unknown, apiKey: string, host: NativeAIHost, what: string, sent: AppSettings | null): NativeAIActionAnswer<never> => {
        const redacted = sentRedacted(error, apiKey, sent);
        host.log?.warn(`${what}: ${redactAIError(redacted, apiKey, settings()).message}`);
        return { kind: 'alert', ...getAIErrorAlert(redacted, deps.t(), apiKey, settings()) };
    };
    const choice = <Apply,>(label: string, variant: 'primary' | 'secondary' | undefined, apply: Apply | null): NativeAIDialogChoice<Apply> => (
        { label, variant: variant ?? null, apply }
    );
    const readApplied = (value: unknown): NativeAICopilotApplied | null => {
        if (value === undefined) return { tags: [] };
        if (!isObjectRecord(value) || !Array.isArray(value.tags) || value.tags.length > 50 || !value.tags.every((tag) => isText(tag, 200))
            || (value.context !== undefined && !isText(value.context, 200)) || (value.timeEstimate !== undefined && !isText(value.timeEstimate, 50))) return null;
        return value as NativeAICopilotApplied;
    };
    const readSuggestion = (value: unknown): NativeAICopilotSuggestion | null | undefined => {
        if (value === null || value === undefined) return null;
        if (!isObjectRecord(value) || typeof value.language !== 'string'
            || (value.context !== undefined && !isText(value.context, 200)) || (value.timeEstimate !== undefined && !isText(value.timeEstimate, 50))
            || (value.tags !== undefined && (!Array.isArray(value.tags) || value.tags.length > 50 || !value.tags.every((tag) => isText(tag, 200))))) return undefined;
        return value as unknown as NativeAICopilotSuggestion;
    };

    return {


        async openAISettings(input: { requestId: string }): Promise<NativeHostResult<NativeAISettings>> {
            const bound = requireHost();
            if (!bound.ok) return bound;
            const host = bound.value;
            if (!isObjectRecord(input) || typeof input.requestId !== 'string' || !deps.requestIdPattern.test(input.requestId)) {
                return fail('INVALID_INPUT', 'A request UUID is required');
            }
            const { isFossBuild } = host.platform;
            visit = { keys: { assistant: null, speech: null }, models: { assistant: null, speech: null }, whisper: null, extraBody: null, consent: null };
            const opened = visit;
            try {
                const corrected = await receipts.run<{ changed: boolean }>(input.requestId, JSON.stringify(['openAISettings']), async () => {

                    const patches: Partial<AISettings>[] = [];
                    if (needsFossAIProviderReset(settings().ai?.provider, isFossBuild)) patches.push(getAIProviderDefaultsPatch('openai', isFossBuild));
                    const written = await writeAI(...patches);
                    if (!written.ok) return settleWrite(written, { changed: true });
                    const speech = getFossSpeechCorrection(settings().ai?.speechToText, isFossBuild);
                    const speechWritten = await writeAI(...(speech ? [speechPatch(speech)] : []));
                    if (!speechWritten.ok) return settleWrite(speechWritten, { changed: true });
                    await loadKeys(host, isFossBuild);
                    const moved = await whisperPathFix(host, isFossBuild);
                    const movedWritten = await writeAI(...(moved ? [moved] : []));
                    const changed = written.value || speechWritten.value || (movedWritten.ok && movedWritten.value);
                    return movedWritten.ok ? { ok: true, value: { changed } } : settleWrite(movedWritten, { changed: true });
                });
                if (!corrected.ok) return corrected;
                if (visit !== opened) return fail('ACTION_FAILED', 'Settings › AI was closed or opened again');

                opened.consent = await readAIProviderConsent(host.storage, warn(host));
                await loadKeys(host, isFossBuild);

                if (!opened.whisper) await whisperPathFix(host, isFossBuild);
                return { ok: true, value: buildView(host) };
            } catch (error) {
                return fail('ACTION_FAILED', redactAIError(error, '', settings()).message);
            }
        },


        getAISettings(): NativeHostResult<NativeAISettings> {
            const bound = requireHost();
            if (!bound.ok) return bound;
            if (!visit) return fail('ACTION_FAILED', 'Open Settings › AI first');
            return { ok: true, value: buildView(bound.value) };
        },


        closeAISettings(): NativeHostResult<null> {
            visit = null;
            return { ok: true, value: null };
        },


        async setAISetting(input: { requestId: string; change: NativeAISettingChange; consent?: boolean }): Promise<NativeHostResult<NativeAISettingResult>> {
            const bound = requireHost();
            if (!bound.ok) return bound;
            const host = bound.value;
            const change = isObjectRecord(input) ? readChange(input.change) : null;
            if (!change || typeof input.requestId !== 'string' || !deps.requestIdPattern.test(input.requestId)
                || (input.consent !== undefined && typeof input.consent !== 'boolean')
                || Object.keys(input).some((key) => key !== 'requestId' && key !== 'change' && key !== 'consent')) {
                return fail('INVALID_INPUT', 'A request UUID and a change the AI screen offers are required');
            }
            const consented = input.consent === true;
            return receipts.run<NativeAISettingResult>(input.requestId, JSON.stringify(['setAISetting', change, consented]), async () => {
                const plan = planChange(host, change);
                if (!plan) return fail('INVALID_INPUT', 'The AI screen does not offer that change now');
                if ('answer' in plan) {
                    const { toast, ...answer } = plan.answer;
                    return { ok: true, value: { ...answer, toasts: toast ? [toast] : [] } };
                }
                if (plan.consentFor) {
                    if (consented) {
                        await recordAIProviderConsent(host.storage, plan.consentFor, warn(host));
                        if (visit?.consent) visit.consent = { ...visit.consent, [plan.consentFor]: true };
                    } else {
                        const agreed = await readAIProviderConsent(host.storage, warn(host));
                        if (!agreed[plan.consentFor]) {
                            return { ok: true, value: { changed: false, consent: getAIConsentPrompt(plan.consentFor, host.platform.isFossBuild, translators()), extraBodyDraft: null, toasts: [] } };
                        }
                    }
                }
                const written = await writeAI(...plan.patches);
                const extraBodyDraft = plan.extraBodyDraft ?? null;
                if (!written.ok) return settleWrite(written, { changed: true, consent: null, extraBodyDraft, toasts: [] });

                await loadKeys(host, host.platform.isFossBuild);
                let changed = written.value;
                if (change.type.startsWith('speech')) {
                    const moved = await whisperPathFix(host, host.platform.isFossBuild);
                    const movedWritten = await writeAI(...(moved ? [moved] : []));
                    if (!movedWritten.ok) return settleWrite(movedWritten, { changed: true, consent: null, extraBodyDraft, toasts: [] });
                    changed = changed || movedWritten.value;
                }
                return { ok: true, value: { changed, consent: null, extraBodyDraft, toasts: [] } };
            });
        },


        async setAIEndpoint(input: { requestId: string; field: 'assistant' | 'speech'; value: string }): Promise<NativeHostResult<{ changed: boolean }>> {
            const bound = requireHost();
            if (!bound.ok) return bound;
            const host = bound.value;
            if (!isObjectRecord(input) || typeof input.requestId !== 'string' || !deps.requestIdPattern.test(input.requestId)
                || (input.field !== 'assistant' && input.field !== 'speech') || !isText(input.value, 2000)) {
                return fail('INVALID_INPUT', 'A request UUID, a base URL field and its text are required');
            }
            const { field, value: url } = input;
            return receipts.run<{ changed: boolean }>(input.requestId, JSON.stringify(['setAIEndpoint', field, fingerprint(['url', url])]), async () => {
                const state = resolveAISettingsScreenState(settings(), host.platform.isFossBuild);
                if (field === 'assistant' ? state.aiProvider !== 'openai' : state.speechProvider !== 'openai') {
                    return fail('INVALID_INPUT', 'The AI screen shows no such base URL now');
                }
                const written = await writeAI(field === 'assistant' ? { baseUrl: url } : speechPatch({ baseUrl: url }));
                return written.ok ? { ok: true, value: { changed: written.value } } : settleWrite(written, { changed: true });
            });
        },

        /** The private editor's exact input has only a salted process receipt and a Boolean reply. */
        async setAIExtraBodyParams(input: { requestId: string; text: string }): Promise<NativeHostResult<{ changed: boolean }>> {
            try {
                const request = extraBodyRequest(input);
                if (!request) return fail('INVALID_INPUT', 'A bounded request UUID and JSON object are required');
                const bound = requireHost();
                if (!bound.ok) return { ok: false, error: { code: bound.error.code, message: 'AI extra body parameters are unavailable' } };
                if ((settings().ai?.provider ?? 'openai') !== 'openai')
                    return fail('INVALID_INPUT', 'The AI screen does not offer extra body parameters now');
                const result = await receipts.run<{ changed: boolean }>(request.requestId, request.payload, async () => {
                    const written = await writeAI({ openAIExtraBodyParams: request.value });
                    return written.ok ? { ok: true, value: { changed: written.value } } : settleWrite(written, { changed: true });
                });
                return result.ok ? result : { ok: false, error: { code: result.error.code, message: 'AI extra body parameters could not be confirmed' } };
            } catch { return fail('ACTION_FAILED', 'AI extra body parameters could not be confirmed'); }
        },

        /** A saved process receipt may outlive later settings; no equality-only or cold acknowledgment. */
        probeAIExtraBodyParamsOutcome(input: { requestId: string; text: string }): NativeHostResult<{ changed: boolean }> | null {
            try {
                const request = extraBodyRequest(input);
                if (!request) return fail('INVALID_INPUT', 'A bounded request UUID and JSON object are required');
                return extraBodySaved(request);
            } catch { return fail('ACTION_FAILED', 'AI extra body parameters are unavailable'); }
        },

        /**
         * A key field's change: stored in the keystore under the provider's name (blank removes
         * it). `provider` is the one the view shows for that field; another answers STALE_REVISION.
         * Never journaled (NATIVE_AI_UNJOURNALED_COMMANDS).
         */
        async setAIKey(input: { requestId: string; field: 'assistant' | 'speech'; provider: string; value: string }): Promise<NativeHostResult<{ mask: string }>> {
            const bound = requireHost();
            if (!bound.ok) return bound;
            const host = bound.value;
            if (!isObjectRecord(input) || typeof input.requestId !== 'string' || !deps.requestIdPattern.test(input.requestId)
                || (input.field !== 'assistant' && input.field !== 'speech') || typeof input.provider !== 'string' || !isText(input.value, KEY_LIMIT)) {
                return fail('INVALID_INPUT', 'A request UUID, a key field, its provider and the key are required');
            }
            const { field, provider, value } = input;
            return receipts.run<{ mask: string }>(input.requestId, JSON.stringify(['setAIKey', field, provider, fingerprint(['key', value])]), async () => {
                const state = resolveAISettingsScreenState(settings(), host.platform.isFossBuild);
                const shown = field === 'assistant' ? state.aiProvider : state.speechProvider;
                if (provider !== shown || shown === 'whisper') return fail('STALE_REVISION', 'The provider changed; read the view again');
                try {
                    if (host.saveConfigurationKey) await host.saveConfigurationKey(shown, value);
                    else await keys(host).save(shown, value);
                } catch (error) {
                    return fail('ACTION_FAILED', redactAIError(error, value, settings()).message);
                }
                if (visit && field === 'assistant') visit.keys.assistant = { provider: state.aiProvider, value };
                if (visit && field === 'speech') visit.keys.speech = { provider: state.speechProvider, value };
                return { ok: true, value: { mask: mask(value) } };
            });
        },


        async loadAIModels(input: { list: 'assistant' | 'speech'; request: string }, options: AIRequestOptions = {}): Promise<NativeHostResult<NativeAISettings>> {
            const bound = requireHost();
            if (!bound.ok) return bound;
            const host = bound.value;
            if (!isObjectRecord(input) || (input.list !== 'assistant' && input.list !== 'speech') || !isText(input.request, 64)) {
                return fail('INVALID_INPUT', 'A model list and its request are required');
            }
            if (!visit) return fail('ACTION_FAILED', 'Open Settings › AI first');
            const opened = visit;
            const wanted = modelRequests(host.platform.isFossBuild)[input.list];
            const current = opened.models[input.list];
            if (wanted && wanted.request === input.request && (current?.request !== input.request || current.signal?.aborted)) {
                const slot: ModelList = { request: input.request, models: null, signal: options.signal };
                opened.models[input.list] = slot;
                try {
                    slot.models = await fetchProviderModelsCached(wanted.provider, {
                        apiKey: wanted.apiKey, baseUrl: wanted.baseUrl, kind: wanted.kind, fetchImpl: abortableAIFetch(host.fetch ?? globalThis.fetch, options.signal),
                    });
                } catch {

                    if (options.signal?.aborted && opened.models[input.list] === slot) opened.models[input.list] = null;
                }
            }
            return visit ? { ok: true, value: buildView(host) } : fail('ACTION_FAILED', 'Settings › AI was closed');
        },


        getTaskEditorAI(input: { id: string; draft: TaskDraft; copilot?: { suggestion: NativeAICopilotSuggestion | null; applied: NativeAICopilotApplied } }): NativeHostResult<NativeTaskEditorAI> {
            const ready = deps.readiness();
            if (!ready.ok) return ready;
            const found = editorTask(input);
            if (!found.ok) return found;
            const suggestion = readSuggestion(input.copilot?.suggestion);
            const applied = readApplied(input.copilot?.applied);
            if (suggestion === undefined || !applied || (input.copilot !== undefined && !isObjectRecord(input.copilot))) {
                return fail('INVALID_INPUT', 'copilot must hold the kept suggestion and the applied parts');
            }
            const { draft } = found.value;
            const t = deps.t();
            const stored = settings();
            const enabled = stored.ai?.enabled === true;
            const estimates = resolveFeatureFlags(stored).timeEstimates;
            const text = enabled ? getTaskCopilotText(draft.title, draft.description) : null;
            const visible = suggestion && suggestion.language === deps.language() ? suggestion : null;
            const parts = enabled ? getTaskCopilotParts(visible, applied, estimates) : [];
            const chip = (chosen: TaskCopilotPart[]) => ({
                edit: { type: 'fields' as const, patch: applyTaskCopilotParts(draft, chosen, estimates).patch },
                applied: applyCaptureModalCopilotParts(applied, chosen, estimates),
            });
            return {
                ok: true,
                value: {
                    enabled,
                    clarify: t('taskEdit.aiClarify'),
                    breakdown: t('taskEdit.aiBreakdown'),
                    working: t('ai.working'),
                    copilot: {
                        request: text ? { text, delayMs: TASK_COPILOT_DELAY_MS } : null,
                        suggested: parts.length > 0
                            ? {
                                label: t('copilot.suggested'),
                                parts: parts.map((part) => ({ kind: part.kind, label: part.value, ...chip([part]) })),
                                applyAll: parts.length > 1 ? { label: t('copilot.applyAll'), ...chip(parts) } : null,
                                hint: t('copilot.applyHint'),
                            }
                            : null,
                        applied: enabled ? formatTaskCopilotApplied(t, applied, estimates) : null,
                    },
                },
            };
        },


        async requestTaskEditorCopilot(input: { id: string; draft: TaskDraft }, options: AIRequestOptions = {}): Promise<NativeHostResult<{ text: string | null; suggestion: NativeAICopilotSuggestion | null }>> {
            const bound = requireHost();
            if (!bound.ok) return bound;
            const found = editorTask(input);
            if (!found.ok) return found;
            const { draft } = found.value;
            const text = getTaskCopilotText(draft.title, draft.description);
            const derived = useTaskStore.getState().getDerivedState();
            const contexts = Array.from(new Set([...derived.allContexts, ...parseTaskEditorTokenList(draft.contexts, '@')])).filter(Boolean);
            const tags = Array.from(new Set([...derived.allTags, ...parseTaskEditorTokenList(draft.tags, '#')])).filter(Boolean);
            try {
                const ai = text ? await providerFor(bound.value, true) : null;
                if (!text || ai?.gate !== 'ready') return { ok: true, value: { text, suggestion: null } };
                const answer = await createAIProvider(ai.build()).predictMetadata({ title: text, contexts, tags }, options);
                const kept = keepTaskCopilotSuggestion(answer, resolveFeatureFlags(settings()).timeEstimates);
                return { ok: true, value: { text, suggestion: kept ? { ...kept, language: deps.language() } : null } };
            } catch {
                return { ok: true, value: { text, suggestion: null } };
            }
        },


        async requestAICopilot(input: { request: { title: string; contexts: string[]; tags: string[] } }, options: AIRequestOptions = {}): Promise<NativeHostResult<{ suggestion: CopilotResponse | null }>> {
            const bound = requireHost();
            if (!bound.ok) return bound;
            const request = isObjectRecord(input) && isObjectRecord(input.request) ? input.request : null;
            const tokens = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 1000 && value.every((entry) => isText(entry, 200));
            if (!request || !isText(request.title, TEXT_LIMIT) || !request.title.trim() || !tokens(request.contexts) || !tokens(request.tags)) {
                return fail('INVALID_INPUT', 'A copilot request (title, contexts, tags) is required');
            }
            try {
                const ai = await providerFor(bound.value, true);
                if (ai.gate !== 'ready') return { ok: true, value: { suggestion: null } };
                const answer = await createAIProvider(ai.build()).predictMetadata({ title: request.title, contexts: request.contexts, tags: request.tags }, options);
                return { ok: true, value: { suggestion: keepTaskCopilotSuggestion(answer, resolveFeatureFlags(settings()).timeEstimates) } };
            } catch {
                return { ok: true, value: { suggestion: null } };
            }
        },


        async requestTaskEditorClarify(input: { id: string; draft: TaskDraft }, options: AIRequestOptions = {}): Promise<NativeHostResult<NativeAIActionAnswer<NativeTaskDraftEdit>>> {
            const bound = requireHost();
            if (!bound.ok) return bound;
            const host = bound.value;
            const found = editorTask(input);
            if (!found.ok) return found;
            const { task, draft } = found.value;
            const title = draft.title.trim();
            if (!title || deps.isReadOnly(task)) return { ok: true, value: { kind: 'none' } };
            let apiKey = '';
            let sent: AppSettings | null = null;
            try {
                const ai = await providerFor(host, false);
                if (ai.gate !== 'ready') return { ok: true, value: gateAlert(ai.gate) };
                apiKey = ai.apiKey;
                sent = ai.sent;
                const response = await createAIProvider(ai.build()).clarifyTask(buildTaskClarifyInput({
                    title, tasks: useTaskStore.getState().tasks, task, merged: mergedTask(task, draft), projectContext: projectContext(task, draft),
                }), options);
                const dialog = getAIClarifyDialog(response, deps.t());
                return {
                    ok: true,
                    value: {
                        kind: 'dialog',
                        title: dialog.title,
                        message: null,
                        choices: dialog.choices.map(({ label, variant, apply }) => {
                            if (apply.type === 'cancel') return choice<NativeTaskDraftEdit>(label, variant, null);
                            const edit = apply.type === 'title'
                                ? { title: apply.title, patch: {} }
                                : getTaskClarifySuggestionEdit(draft.contexts, apply.suggestion);
                            return choice<NativeTaskDraftEdit>(label, variant, {
                                type: 'fields',
                                patch: { ...(edit.title ? { title: edit.title } : {}), ...edit.patch },
                            });
                        }),
                    },
                };
            } catch (error) {
                return { ok: true, value: errorAlert(error, apiKey, host, 'AI clarify failed', sent) };
            }
        },


        async requestTaskEditorBreakdown(input: { id: string; draft: TaskDraft; checklist: ChecklistItem[] }, options: AIRequestOptions = {}): Promise<NativeHostResult<NativeAIActionAnswer<NativeAIBreakdownApply>>> {
            const bound = requireHost();
            if (!bound.ok) return bound;
            const host = bound.value;
            const found = editorTask(input);
            if (!found.ok) return found;
            if (!Array.isArray(input.checklist) || input.checklist.length > 1000 || !input.checklist.every((item) => (
                isObjectRecord(item) && isText(item.id, 200) && isText(item.title, 10_000) && typeof item.isCompleted === 'boolean'))) {
                return fail('INVALID_INPUT', 'checklist must be the editor\'s bounded checklist');
            }
            const { task, draft } = found.value;
            const title = draft.title.trim();
            if (!title || deps.isReadOnly(task)) return { ok: true, value: { kind: 'none' } };
            let apiKey = '';
            let sent: AppSettings | null = null;
            try {
                const ai = await providerFor(host, false);
                if (ai.gate !== 'ready') return { ok: true, value: gateAlert(ai.gate) };
                apiKey = ai.apiKey;
                sent = ai.sent;
                const response = await createAIProvider(ai.build()).breakDownTask(buildTaskBreakdownInput({
                    title, description: draft.description, projectContext: projectContext(task, draft),
                }), options);
                const steps = getTaskBreakdownSteps(response);
                if (steps.length === 0) return { ok: true, value: { kind: 'none' } };
                const dialog = getTaskBreakdownDialog(steps, deps.t());
                const checklist = appendTaskBreakdownSteps(input.checklist, steps, generateUUID);
                const status = getChecklistEditStatus({ taskMode: task.taskMode, status: draft.status, checklist });
                return {
                    ok: true,
                    value: {
                        kind: 'dialog',
                        title: dialog.title,
                        message: dialog.message,
                        choices: [
                            choice<NativeAIBreakdownApply>(dialog.cancel.label, dialog.cancel.variant, null),
                            choice<NativeAIBreakdownApply>(dialog.add.label, dialog.add.variant, {
                                checklist,
                                edit: status === draft.status ? null : { type: 'fields', patch: { status } },
                            }),
                        ],
                    },
                };
            } catch (error) {
                return { ok: true, value: errorAlert(error, apiKey, host, 'AI breakdown failed', sent) };
            }
        },


        async requestInboxClarify(input: { sessionId: string; taskId: string; step: string }, options: AIRequestOptions = {}): Promise<NativeHostResult<NativeAIActionAnswer<ProcessInboxDraftEdit[]>>> {
            const bound = requireHost();
            if (!bound.ok) return bound;
            const host = bound.value;
            if (!isObjectRecord(input) || typeof input.sessionId !== 'string' || typeof input.taskId !== 'string' || typeof input.step !== 'string') {
                return fail('INVALID_INPUT', 'A session, task and step are required');
            }
            const step = deps.inboxStep({ sessionId: input.sessionId, taskId: input.taskId, step: input.step });
            if (!step.ok) return step;
            const { draft } = step.value;
            const task = useTaskStore.getState()._tasksById.get(step.value.taskId);
            if (!task) return fail('TASK_NOT_FOUND', 'Task not found');
            const t = deps.t();
            let apiKey = '';
            let sent: AppSettings | null = null;
            try {
                const ai = await providerFor(host, false);
                if (ai.gate !== 'ready') {
                    const toast = {
                        title: t('ai.errorTitle'),
                        message: t(ai.gate === 'disabled' ? 'ai.disabledBody' : 'ai.missingKeyBody'),
                        tone: 'warning' as const,
                        durationMs: 5200,
                        action: { label: t('common.open'), screen: 'ai' as const },
                    };
                    return { ok: true, value: { kind: 'toast', toast } };
                }
                apiKey = ai.apiKey;
                sent = ai.sent;
                const response = await createAIProvider(ai.build()).clarifyTask(buildInboxClarifyInput({
                    title: draft.title,
                    task,
                    contextPool: getProcessInboxTokenPools(useTaskStore.getState().tasks).contexts,
                    selectedContexts: draft.contexts,
                }), options);
                const dialog = getAIClarifyDialog(response, t);
                return {
                    ok: true,
                    value: {
                        kind: 'dialog',
                        title: dialog.title,
                        message: null,
                        choices: dialog.choices.map(({ label, variant, apply }) => {
                            if (apply.type === 'cancel') return choice<ProcessInboxDraftEdit[]>(label, variant, null);
                            const title = apply.type === 'title' ? apply.title : apply.suggestion.title;
                            const context = apply.type === 'suggestion' ? apply.suggestion.context : undefined;
                            return choice<ProcessInboxDraftEdit[]>(label, variant, [
                                { type: 'set', field: 'title', value: title },
                                ...(context ? [{ type: 'addContext' as const, value: context }] : []),
                            ]);
                        }),
                    },
                };
            } catch (error) {
                return { ok: true, value: errorAlert(error, apiKey, host, 'Inbox processing failed', sent) };
            }
        },

        /**
         * The Weekly Review's "Run analysis" on the stale step's items. The host keeps the list: a
         * null `suggestions` or `selectedIds` keeps what it shows. Apply sends the chosen suggestions
         * to runReviewAction's applySuggestions.
         */
        async requestWeeklyReviewAnalysis(options: AIRequestOptions = {}): Promise<NativeHostResult<NativeWeeklyReviewAnalysis>> {
            const bound = requireHost();
            if (!bound.ok) return bound;
            const host = bound.value;
            const t = deps.t();
            const state = useTaskStore.getState();
            let apiKey = '';
            let sent: AppSettings | null = null;
            try {
                const ai = await providerFor(host, false);
                if (ai.gate !== 'ready') {
                    return { ok: true, value: { error: t(ai.gate === 'disabled' ? 'ai.disabledBody' : 'ai.missingKeyBody'), suggestions: null, selectedIds: null } };
                }
                apiKey = ai.apiKey;
                sent = ai.sent;
                const { weekStart } = getWeeklyReviewSettings(state.settings);
                const { staleItems } = getWeeklyReviewBuckets(state.tasks, state.projects, { weekStart, sections: state.sections });
                if (staleItems.length === 0) return { ok: true, value: { error: null, suggestions: [], selectedIds: [] } };
                host.log?.info('Weekly review sequence candidates prepared', {
                    scope: 'ai',
                    extra: {
                        releaseCheck: 'v1.3.8/review-sequence', candidateCount: staleItems.length,
                        staleTaskCount: staleItems.filter((item) => !item.id.startsWith('project:')).length,
                        staleProjectCount: staleItems.filter((item) => item.id.startsWith('project:')).length,
                    },
                });
                const response = await createAIProvider(ai.build()).analyzeReview({ items: staleItems }, options);
                const analysis = readWeeklyReviewAnalysis(response, staleItems);
                const labels = getWeeklyReviewLabels(t);

                const liveTasks = state._tasksById;
                return {
                    ok: true,
                    value: {
                        error: null,
                        suggestions: analysis.suggestions.map((suggestion) => ({
                            id: suggestion.id,
                            action: suggestion.action,
                            reason: suggestion.reason,
                            title: suggestion.title,
                            meta: `${getReviewSuggestionActionLabel(suggestion.action, labels)} · ${suggestion.reason}`,
                            actionable: isActionableReviewSuggestion(suggestion),
                            taskRevision: ((task) => (task && !task.deletedAt ? taskRevisionOf(task) : null))(liveTasks.get(suggestion.id)),
                        })),
                        selectedIds: analysis.selectedIds,
                    },
                };
            } catch (error) {
                return { ok: true, value: { error: getWeeklyReviewAnalysisError(sentRedacted(error, apiKey, sent), t, apiKey, settings()), suggestions: null, selectedIds: null } };
            }
        },
    };
}
