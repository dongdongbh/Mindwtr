import type { Language } from '@/contexts/language-context';

export type SettingsScreen =
    | 'main'
    | 'general'
    | 'notifications'
    | 'ai'
    | 'calendar'
    | 'advanced'
    | 'gtd'
    | 'gtd-archive'
    | 'gtd-time-estimates'
    | 'gtd-task-editor'
    | 'manage'
    | 'sync'
    | 'about';

export const SETTINGS_SCREEN_SET: Record<SettingsScreen, true> = {
    main: true,
    general: true,
    notifications: true,
    ai: true,
    calendar: true,
    advanced: true,
    gtd: true,
    'gtd-archive': true,
    'gtd-time-estimates': true,
    'gtd-task-editor': true,
    manage: true,
    sync: true,
    about: true,
};

export const LANGUAGES: { id: Language; native: string }[] = [
    { id: 'en', native: 'English' },
    { id: 'zh', native: '中文（简体）' },
    { id: 'zh-Hant', native: '中文（繁體）' },
    { id: 'es', native: 'Español' },
    { id: 'hi', native: 'हिन्दी' },
    { id: 'ar', native: 'العربية' },
    { id: 'de', native: 'Deutsch' },
    { id: 'ru', native: 'Русский' },
    { id: 'ja', native: '日本語' },
    { id: 'fr', native: 'Français' },
    { id: 'pt', native: 'Português' },
    { id: 'pl', native: 'Polski' },
    { id: 'ko', native: '한국어' },
    { id: 'it', native: 'Italiano' },
    { id: 'tr', native: 'Türkçe' },
];

export const WHISPER_MODEL_BASE_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';
export const WHISPER_MODELS: { id: string; fileName: string; label: string }[] = [
    { id: 'whisper-tiny', fileName: 'ggml-tiny.bin', label: 'whisper-tiny' },
    { id: 'whisper-tiny.en', fileName: 'ggml-tiny.en.bin', label: 'whisper-tiny.en' },
    { id: 'whisper-base', fileName: 'ggml-base.bin', label: 'whisper-base' },
    { id: 'whisper-base.en', fileName: 'ggml-base.en.bin', label: 'whisper-base.en' },
];
export const DEFAULT_WHISPER_MODEL = WHISPER_MODELS[0]?.id ?? 'whisper-tiny';

export const UPDATE_BADGE_AVAILABLE_KEY = 'mindwtr-update-available';
export const UPDATE_BADGE_LAST_CHECK_KEY = 'mindwtr-update-last-check';
export const UPDATE_BADGE_LATEST_KEY = 'mindwtr-update-latest';
export const UPDATE_BADGE_INTERVAL_MS = 1000 * 60 * 60 * 24;
export const AI_PROVIDER_CONSENT_KEY = 'mindwtr-ai-provider-consent-v1';

export const FOSS_LOCAL_LLM_MODEL_OPTIONS = ['llama3.2', 'qwen2.5', 'mistral', 'phi-4-mini'];
export const FOSS_LOCAL_LLM_COPILOT_OPTIONS = ['llama3.2', 'qwen2.5', 'mistral', 'phi-4-mini'];

export type MobileExtraConfig = {
    isFossBuild?: boolean | string;
    dropboxAppKey?: string;
};

export type CloudProvider = 'selfhosted' | 'dropbox' | 'cloudkit';

export const isValidHttpUrl = (value: string): boolean => {
    if (!value.trim()) return false;
    try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
        return false;
    }
};
