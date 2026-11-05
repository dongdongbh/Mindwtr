import type { AppSettings, SpeechToTextSettings } from './types';
import { DEFAULT_GEMINI_STT_MODEL, DEFAULT_OPENAI_STT_MODEL, MOBILE_DEFAULT_WHISPER_MODEL, MOBILE_WHISPER_MODELS, GEMINI_STT_MODEL_OPTIONS, OPENAI_STT_MODEL_OPTIONS, getSpeechProviderPatch, normalizeSpeechLanguageInput } from './ai-settings-model';
import { exact, isNativeJsonWithinBytes, record } from './native-json';

export type NativeVoiceSettingsWitness = {
    aiPresent: boolean; speechPresent: boolean;
    providerPresent: boolean; provider: SpeechToTextSettings['provider'] | null;
    enabledPresent: boolean; enabled: boolean | null;
    modelPresent: boolean; model: string | null;
    languagePresent: boolean; language: string | null;
    modePresent: boolean; mode: 'smart_parse' | 'transcribe_only' | null;
    fieldStrategyPresent: boolean; fieldStrategy: 'smart' | 'title_only' | 'description_only' | null;
    stampPresent: boolean; stamp: string | null;
};
export type NativeVoiceSettingsChange = { type: 'useGemini' } | { type: 'useOpenAI' } | { type: 'useWhisper' } | { type: 'enabled'; value: boolean }
    | { type: 'model' | 'language'; value: string } | { type: 'mode'; value: 'smart_parse' | 'transcribe_only' }
    | { type: 'fieldStrategy'; value: 'smart' | 'title_only' | 'description_only' };
export type NativeVoiceSettingsRequest = { version: 1; requestId: string; expected: NativeVoiceSettingsWitness; change: NativeVoiceSettingsChange };
export type NativeVoiceSettingsOptions = { version: 1; provider: NonNullable<SpeechToTextSettings['provider']>; supported: boolean;
    enabled: boolean; model: string; modelOptions: string[]; language: string;
    mode: 'smart_parse' | 'transcribe_only'; fieldStrategy: 'smart' | 'title_only' | 'description_only'; expected: NativeVoiceSettingsWitness };
export const NATIVE_VOICE_UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
export const nativeVoiceISO = (value: unknown): value is string => typeof value === 'string' && value.length <= 40
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const owns = (value: object, field: string) => Object.prototype.hasOwnProperty.call(value, field);
const provider = (value: unknown): value is NonNullable<SpeechToTextSettings['provider']> => value === 'openai' || value === 'gemini' || value === 'whisper' || value === 'parakeet';
const model = (value: unknown): value is string => typeof value === 'string' && value.length <= 2000;
const language = (value: unknown): value is string => typeof value === 'string' && value.length <= 200;
const mode = (value: unknown): value is 'smart_parse' | 'transcribe_only' => value === 'smart_parse' || value === 'transcribe_only';
const strategy = (value: unknown): value is 'smart' | 'title_only' | 'description_only' => value === 'smart' || value === 'title_only' || value === 'description_only';

export function nativeVoiceSettingsWitness(settings: AppSettings): NativeVoiceSettingsWitness | null {
    if (!record(settings)) return null;
    const aiPresent = owns(settings, 'ai'), ai = aiPresent ? settings.ai : undefined;
    if (aiPresent && (!record(ai) || owns(ai, 'apiKey'))) return null;
    const speechPresent = !!ai && owns(ai, 'speechToText'), raw = speechPresent ? (ai as Record<string, unknown>).speechToText : undefined;
    if (speechPresent && !record(raw)) return null;
    const speech = record(raw) ? raw : undefined;
    const fields: Record<string, unknown> = { aiPresent, speechPresent };
    for (const name of ['provider', 'enabled', 'model', 'language', 'mode', 'fieldStrategy']) {
        fields[name + 'Present'] = !!speech && owns(speech, name); fields[name] = fields[name + 'Present'] ? speech![name] : null;
    }
    const groupPresent = owns(settings, 'syncPreferencesUpdatedAt'), group = groupPresent ? settings.syncPreferencesUpdatedAt : undefined;
    if (groupPresent && !record(group)) return null;
    fields.stampPresent = !!group && owns(group, 'ai'); fields.stamp = fields.stampPresent ? (group as Record<string, unknown>).ai : null;
    return readNativeVoiceSettingsWitness(fields);
}
export function readNativeVoiceSettingsWitness(value: unknown): NativeVoiceSettingsWitness | null {
    if (!record(value) || !exact(value, ['aiPresent', 'speechPresent', 'providerPresent', 'provider', 'enabledPresent', 'enabled',
        'modelPresent', 'model', 'languagePresent', 'language', 'modePresent', 'mode', 'fieldStrategyPresent', 'fieldStrategy', 'stampPresent', 'stamp'])
        || typeof value.aiPresent !== 'boolean' || typeof value.speechPresent !== 'boolean' || typeof value.stampPresent !== 'boolean'
        || !value.aiPresent && value.speechPresent || (value.stampPresent ? !nativeVoiceISO(value.stamp) : value.stamp !== null)) return null;
    const checks: Record<string, (value: unknown) => boolean> = { provider, enabled: value => typeof value === 'boolean', model, language, mode, fieldStrategy: strategy };
    for (const [name, check] of Object.entries(checks)) if (typeof value[name + 'Present'] !== 'boolean'
        || !value.speechPresent && value[name + 'Present'] || (value[name + 'Present'] ? !check(value[name]) : value[name] !== null)) return null;
    return { ...value } as NativeVoiceSettingsWitness;
}
export function readNativeVoiceSettingsRequest(value: unknown): NativeVoiceSettingsRequest | null {
    if (!record(value) || !isNativeJsonWithinBytes(value, 32 * 1024) || !exact(value, ['version', 'requestId', 'expected', 'change'])
        || value.version !== 1 || typeof value.requestId !== 'string' || !NATIVE_VOICE_UUID.test(value.requestId)) return null;
    const expected = readNativeVoiceSettingsWitness(value.expected), change = value.change;
    if (!expected || !record(change)) return null;
    if ((change.type === 'useGemini' || change.type === 'useOpenAI' || change.type === 'useWhisper') && exact(change, ['type']))
        return { version: 1, requestId: value.requestId, expected, change: { type: change.type } };
    if (!exact(change, ['type', 'value']) || !(change.type === 'enabled' && typeof change.value === 'boolean'
        || change.type === 'model' && model(change.value) || change.type === 'language' && language(change.value)
        || change.type === 'mode' && mode(change.value) || change.type === 'fieldStrategy' && strategy(change.value))) return null;
    return { version: 1, requestId: value.requestId, expected, change: { ...change } as NativeVoiceSettingsChange };
}
export function planNativeVoiceSettings(expected: NativeVoiceSettingsWitness, change: NativeVoiceSettingsChange): Partial<SpeechToTextSettings> | null {
    const selected = expected.provider ?? 'gemini';
    if (change.type === 'useGemini' || change.type === 'useOpenAI' || change.type === 'useWhisper') {
        const wanted = change.type === 'useGemini' ? 'gemini' : change.type === 'useOpenAI' ? 'openai' : 'whisper';
        return selected === wanted ? null : getSpeechProviderPatch(wanted, () => undefined);
    }
    if (selected !== 'gemini' && selected !== 'openai' && selected !== 'whisper' && !(change.type === 'enabled' && !change.value)) throw new Error('Speech provider is not supported');
    if (selected === 'whisper' && change.type === 'model' && !MOBILE_WHISPER_MODELS.some(entry => entry.id === change.value))
        throw new Error('Whisper model is not supported');
    const value = change.type === 'language' ? normalizeSpeechLanguageInput(change.value) : change.value;
    return expected[(change.type + 'Present') as keyof NativeVoiceSettingsWitness] && expected[change.type] === value
        ? null : { [change.type]: value };
}
export function buildNativeVoiceSettingsOptions(settings: AppSettings): NativeVoiceSettingsOptions | null {
    const expected = nativeVoiceSettingsWitness(settings); if (!expected) return null;
    const provider = expected.provider ?? 'gemini', model = expected.model ?? (provider === 'gemini' ? DEFAULT_GEMINI_STT_MODEL
        : provider === 'openai' ? DEFAULT_OPENAI_STT_MODEL : MOBILE_DEFAULT_WHISPER_MODEL);
    // Same shared catalog used by the RN settings resolver; no other AI settings are read here.
    const supported = provider === 'gemini' || provider === 'openai' || provider === 'whisper';
    const defaults = provider === 'openai' ? OPENAI_STT_MODEL_OPTIONS
        : provider === 'whisper' ? MOBILE_WHISPER_MODELS.map(entry => entry.id) : GEMINI_STT_MODEL_OPTIONS;
    return { version: 1, provider, supported, enabled: expected.enabled === true,
        model, modelOptions: supported ? Array.from(new Set([...defaults, model])) : [model], language: expected.language ?? 'auto',
        mode: expected.mode ?? 'smart_parse', fieldStrategy: expected.fieldStrategy ?? 'smart', expected };
}

export type NativeVoiceRuntimeOptions = Omit<NativeVoiceSettingsOptions, 'modelOptions'> & { saveAudioAttachments: boolean };
/** Only the recording policy and selected nonsecret speech fields. Credential readiness remains native. */
export function buildNativeVoiceRuntimeOptions(settings: AppSettings): NativeVoiceRuntimeOptions | null {
    const options = buildNativeVoiceSettingsOptions(settings); if (!options) return null;
    const { modelOptions: _catalog, ...runtime } = options;
    return { ...runtime, model: runtime.model || (runtime.provider === 'gemini' ? DEFAULT_GEMINI_STT_MODEL
        : runtime.provider === 'openai' ? DEFAULT_OPENAI_STT_MODEL : MOBILE_DEFAULT_WHISPER_MODEL),
        saveAudioAttachments: settings.gtd?.saveAudioAttachments !== false };
}
