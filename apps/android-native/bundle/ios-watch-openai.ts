import type { AppSettings } from '../../../packages/core/src/types';
import { buildNativeVoiceSettingsOptions } from '../../../packages/core/src/native-voice-settings';
import { DEFAULT_OPENAI_STT_MODEL } from '../../../packages/core/src/ai-settings-model';
import {
    buildRemoteOpenAISpeechTranscriptionRequest, decodeRemoteOpenAISpeechTranscriptionResponse,
    buildRemoteOpenAISpeechParseRequest, decodeRemoteOpenAISpeechParseResponse, resolveOpenAIParseModel, normalizeSpeechLanguage,
} from '../../../packages/core/src/speech-to-task';

const invalid = () => new Error('INVALID_INPUT: Native OpenAI speech input is invalid');
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, names: string[]) => Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
const text = (value: unknown, maximum: number): value is string => typeof value === 'string' && value.length <= maximum
    && new TextEncoder().encode(value).byteLength <= maximum;
const field = (value: unknown, maximum: number): value is string => text(value, maximum) && !/[\u0000-\u001f\u007f]/u.test(value);
const api = (value: unknown): value is 'responses' | 'chat' => value === 'responses' || value === 'chat';

export function readWatchOpenAIRuntime(settings: AppSettings) {
    const options = buildNativeVoiceSettingsOptions(settings);
    if (!options) throw invalid();
    if (options.provider !== 'openai') return null;
    const baseUrl = settings.ai?.speechToText?.baseUrl;
    if (baseUrl !== undefined && !field(baseUrl, 4096)) throw invalid();
    const model = options.model.trim() || DEFAULT_OPENAI_STT_MODEL;
    const language = normalizeSpeechLanguage(options.language);
    if (!field(model, 2000) || !field(options.language, 200)) throw invalid();
    const request = buildRemoteOpenAISpeechTranscriptionRequest({ model, language, baseUrl });
    const selectedParseModel = settings.ai?.provider === 'openai' ? settings.ai.model : undefined;
    if (selectedParseModel !== undefined && !field(selectedParseModel, 2000)) throw invalid();
    return { version: 1, provider: 'openai', enabled: options.enabled, model, language,
        mode: options.mode, fieldStrategy: options.fieldStrategy, endpoint: request.url,
        credentialRequired: !baseUrl?.trim(), parseModel: resolveOpenAIParseModel(selectedParseModel, baseUrl),
        retryModel: baseUrl?.trim() ? resolveOpenAIParseModel(selectedParseModel, baseUrl) : resolveOpenAIParseModel('gpt-4o-mini') };
}

export function buildWatchOpenAITranscription(value: unknown) {
    if (!record(value) || !exact(value, ['model', 'language', 'endpoint'])
        || !field(value.model, 2000) || !value.model.trim() || !field(value.language, 200)
        || !field(value.endpoint, 4096) || !value.endpoint) throw invalid();
    return buildRemoteOpenAISpeechTranscriptionRequest({ model: value.model, language: value.language, baseUrl: value.endpoint });
}

export function decodeWatchOpenAITranscription(value: unknown) {
    return { transcript: decodeRemoteOpenAISpeechTranscriptionResponse(value) };
}

export function buildWatchOpenAIParse(value: unknown) {
    if (!record(value) || !exact(value, ['config', 'transcript', 'model', 'api']) || !api(value.api)
        || !field(value.model, 2000) || !value.model.trim() || !text(value.transcript, 64 * 1024)
        || !value.transcript || !record(value.config)) throw invalid();
    const config = value.config;
    if (!exact(config, ['language', 'fieldStrategy', 'now', 'timeZone', 'baseUrl']) || !field(config.language, 200)
        || !field(config.baseUrl, 4096) || !config.baseUrl
        || !['smart', 'title_only', 'description_only'].includes(String(config.fieldStrategy))
        || !text(config.now, 40) || !Number.isFinite(Date.parse(config.now))
        || new Date(config.now).toISOString() !== config.now
        || config.timeZone !== null && !field(config.timeZone, 200)) throw invalid();
    return buildRemoteOpenAISpeechParseRequest({ language: config.language, baseUrl: config.baseUrl,
        fieldStrategy: config.fieldStrategy as 'smart' | 'title_only' | 'description_only', now: new Date(config.now),
        ...(config.timeZone === null ? {} : { timeZone: config.timeZone as string }) }, value.transcript, value.model, value.api);
}

export function decodeWatchOpenAIParse(value: unknown) {
    if (!record(value) || !exact(value, ['api', 'response']) || !api(value.api)) throw invalid();
    return decodeRemoteOpenAISpeechParseResponse(value.response, value.api);
}
