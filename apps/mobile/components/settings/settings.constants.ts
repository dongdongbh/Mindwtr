import { WHISPER_MODEL_BASE_URL } from '@mindwtr/core/whisper-models';

export type SettingsScreen =
    | 'main'
    | 'general'
    | 'notifications'
    | 'ai'
    | 'calendar'
    | 'advanced'
    | 'gtd'
    | 'gtd-archive'
    | 'gtd-capture'
    | 'gtd-inbox'
    | 'gtd-pomodoro'
    | 'gtd-review'
    | 'gtd-time-estimates'
    | 'gtd-task-editor'
    | 'manage'
    | 'sync'
    | 'data'
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
    'gtd-capture': true,
    'gtd-inbox': true,
    'gtd-pomodoro': true,
    'gtd-review': true,
    'gtd-time-estimates': true,
    'gtd-task-editor': true,
    manage: true,
    sync: true,
    data: true,
    about: true,
};

export function normalizeSettingsScreen(value: string | undefined): SettingsScreen {
    if (!value || !SETTINGS_SCREEN_SET[value as SettingsScreen]) return 'main';


    return value === 'gtd-time-estimates' ? 'gtd' : value as SettingsScreen;
}


export {
    buildSettingsMenuSearchText,
    findSettingsMenuMatch,
    SETTINGS_MENU_KEYWORD_KEYS,
    settingsMenuMatchesQuery,
    type SettingsMenuMatch,
    type SettingsMenuRowId,
} from '@mindwtr/core';


export { SETTINGS_LANGUAGE_OPTIONS as LANGUAGES } from '@mindwtr/core';

export { WHISPER_MODEL_BASE_URL };


export {
    AI_PROVIDER_CONSENT_KEY,
    FOSS_LOCAL_LLM_COPILOT_OPTIONS,
    FOSS_LOCAL_LLM_MODEL_OPTIONS,
    MOBILE_DEFAULT_WHISPER_MODEL as DEFAULT_WHISPER_MODEL,
    MOBILE_WHISPER_MODELS as WHISPER_MODELS,
} from '@mindwtr/core/ai-settings-model';

export {
    UPDATE_BADGE_AVAILABLE_KEY,
    UPDATE_BADGE_LAST_CHECK_KEY,
    UPDATE_BADGE_LATEST_KEY,
    UPDATE_BADGE_INTERVAL_MS,
} from '@mindwtr/core';

export type MobileExtraConfig = {
    analyticsHeartbeatUrl?: string;
    analyticsHeartbeatChannel?: string;
    analyticsReleaseVersion?: string;
    feedbackEndpointUrl?: string;
    isFossBuild?: boolean | string;
    dropboxAppKey?: string;
    promptTestControlsEnabled?: boolean | string;
    appleClarificationPrototypeEnabled?: boolean | string;
};
