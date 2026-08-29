import { SUPPORTED_LANGUAGES } from './i18n/i18n-constants';
import type { AIProviderId, AIReasoningEffort } from './ai/types';
import type {
    AiSettings,
    AppearanceSettings,
    AppData,
    GtdSettings,
    SettingsSyncGroup,
    SettingsSyncPreferences,
} from './types';

type ThemeValue = NonNullable<AppData['settings']['theme']>;
type LanguageValue = NonNullable<AppData['settings']['language']>;
type WeekStartValue = NonNullable<AppData['settings']['weekStart']>;
type TimeFormatValue = NonNullable<AppData['settings']['timeFormat']>;
type KeybindingStyleValue = NonNullable<AppData['settings']['keybindingStyle']>;
type DensityValue = NonNullable<AppearanceSettings['density']>;
type TextSizeValue = NonNullable<AppearanceSettings['textSize']>;
type MobileQuickAccessViewValue = NonNullable<AppearanceSettings['mobileQuickAccessView']>;
type FocusGroupByValue = NonNullable<GtdSettings['focusGroupBy']>;
type DefaultProjectFlowModeValue = NonNullable<GtdSettings['defaultProjectFlowMode']>;
type DefaultTaskAreaModeValue = NonNullable<GtdSettings['defaultAreaMode']>;
type SpeechToTextSettings = NonNullable<AiSettings['speechToText']>;
type SpeechToTextProviderValue = NonNullable<SpeechToTextSettings['provider']>;
type SpeechToTextModeValue = NonNullable<SpeechToTextSettings['mode']>;
type SpeechToTextFieldStrategyValue = NonNullable<SpeechToTextSettings['fieldStrategy']>;

const THEME_VALUE_FLAGS: Record<ThemeValue, true> = {
    light: true,
    dark: true,
    system: true,
    eink: true,
    nord: true,
    sepia: true,
    'material3-light': true,
    'material3-dark': true,
    oled: true,
    'catppuccin-macchiato': true,
    dracula: true,
};

const WEEK_START_VALUE_FLAGS: Record<WeekStartValue, true> = {
    system: true,
    monday: true,
    saturday: true,
    sunday: true,
};

const TIME_FORMAT_VALUE_FLAGS: Record<TimeFormatValue, true> = {
    system: true,
    '12h': true,
    '24h': true,
};

const KEYBINDING_STYLE_VALUE_FLAGS: Record<KeybindingStyleValue, true> = {
    vim: true,
    emacs: true,
    standard: true,
};

const DENSITY_VALUE_FLAGS: Record<DensityValue, true> = {
    comfortable: true,
    compact: true,
    condensed: true,
};

const TEXT_SIZE_VALUE_FLAGS: Record<TextSizeValue, true> = {
    small: true,
    default: true,
    large: true,
    'extra-large': true,
};

const MOBILE_QUICK_ACCESS_VIEW_VALUE_FLAGS: Record<MobileQuickAccessViewValue, true> = {
    review: true,
    projects: true,
    calendar: true,
    contexts: true,
};

const FOCUS_GROUP_BY_VALUE_FLAGS: Record<FocusGroupByValue, true> = {
    none: true,
    context: true,
    project: true,
    area: true,
    energy: true,
    priority: true,
    person: true,
    tag: true,
};

const DEFAULT_PROJECT_FLOW_MODE_VALUE_FLAGS: Record<DefaultProjectFlowModeValue, true> = {
    parallel: true,
    sequential: true,
};

const DEFAULT_TASK_AREA_MODE_VALUE_FLAGS: Record<DefaultTaskAreaModeValue, true> = {
    none: true,
    fixed: true,
    active: true,
};

const AI_PROVIDER_VALUE_FLAGS: Record<AIProviderId, true> = {
    gemini: true,
    openai: true,
    anthropic: true,
};

const AI_REASONING_EFFORT_VALUE_FLAGS: Record<AIReasoningEffort, true> = {
    minimal: true,
    low: true,
    medium: true,
    high: true,
};

const STT_PROVIDER_VALUE_FLAGS: Record<SpeechToTextProviderValue, true> = {
    openai: true,
    gemini: true,
    whisper: true,
    parakeet: true,
};

const STT_MODE_VALUE_FLAGS: Record<SpeechToTextModeValue, true> = {
    smart_parse: true,
    transcribe_only: true,
};

const STT_FIELD_STRATEGY_VALUE_FLAGS: Record<SpeechToTextFieldStrategyValue, true> = {
    smart: true,
    title_only: true,
    description_only: true,
};

export const SETTINGS_THEME_VALUES = Object.keys(THEME_VALUE_FLAGS) as ThemeValue[];
export const SETTINGS_THEME_VALUE_SET = new Set<ThemeValue>(SETTINGS_THEME_VALUES);

export const SETTINGS_LANGUAGE_VALUES: LanguageValue[] = [...SUPPORTED_LANGUAGES, 'system'];
export const SETTINGS_LANGUAGE_VALUE_SET = new Set<LanguageValue>(SETTINGS_LANGUAGE_VALUES);

export const SETTINGS_WEEK_START_VALUES = Object.keys(WEEK_START_VALUE_FLAGS) as WeekStartValue[];
export const SETTINGS_WEEK_START_VALUE_SET = new Set<WeekStartValue>(SETTINGS_WEEK_START_VALUES);

export const SETTINGS_TIME_FORMAT_VALUES = Object.keys(TIME_FORMAT_VALUE_FLAGS) as TimeFormatValue[];
export const SETTINGS_TIME_FORMAT_VALUE_SET = new Set<TimeFormatValue>(SETTINGS_TIME_FORMAT_VALUES);

export const SETTINGS_KEYBINDING_STYLE_VALUES = Object.keys(KEYBINDING_STYLE_VALUE_FLAGS) as KeybindingStyleValue[];
export const SETTINGS_KEYBINDING_STYLE_VALUE_SET = new Set<KeybindingStyleValue>(SETTINGS_KEYBINDING_STYLE_VALUES);

export const SETTINGS_DENSITY_VALUES = Object.keys(DENSITY_VALUE_FLAGS) as DensityValue[];
export const SETTINGS_DENSITY_VALUE_SET = new Set<DensityValue>(SETTINGS_DENSITY_VALUES);

export const SETTINGS_TEXT_SIZE_VALUES = Object.keys(TEXT_SIZE_VALUE_FLAGS) as TextSizeValue[];
export const SETTINGS_TEXT_SIZE_VALUE_SET = new Set<TextSizeValue>(SETTINGS_TEXT_SIZE_VALUES);

export const SETTINGS_MOBILE_QUICK_ACCESS_VIEW_VALUES = Object.keys(MOBILE_QUICK_ACCESS_VIEW_VALUE_FLAGS) as MobileQuickAccessViewValue[];
export const SETTINGS_MOBILE_QUICK_ACCESS_VIEW_VALUE_SET = new Set<MobileQuickAccessViewValue>(SETTINGS_MOBILE_QUICK_ACCESS_VIEW_VALUES);

export const SETTINGS_FOCUS_GROUP_BY_VALUES = Object.keys(FOCUS_GROUP_BY_VALUE_FLAGS) as FocusGroupByValue[];
export const SETTINGS_FOCUS_GROUP_BY_VALUE_SET = new Set<FocusGroupByValue>(SETTINGS_FOCUS_GROUP_BY_VALUES);

export const SETTINGS_DEFAULT_PROJECT_FLOW_MODE_VALUES = Object.keys(DEFAULT_PROJECT_FLOW_MODE_VALUE_FLAGS) as DefaultProjectFlowModeValue[];
export const SETTINGS_DEFAULT_PROJECT_FLOW_MODE_VALUE_SET = new Set<DefaultProjectFlowModeValue>(SETTINGS_DEFAULT_PROJECT_FLOW_MODE_VALUES);

export const SETTINGS_DEFAULT_TASK_AREA_MODE_VALUES = Object.keys(DEFAULT_TASK_AREA_MODE_VALUE_FLAGS) as DefaultTaskAreaModeValue[];
export const SETTINGS_DEFAULT_TASK_AREA_MODE_VALUE_SET = new Set<DefaultTaskAreaModeValue>(SETTINGS_DEFAULT_TASK_AREA_MODE_VALUES);

export const AI_PROVIDER_VALUES = Object.keys(AI_PROVIDER_VALUE_FLAGS) as AIProviderId[];
export const AI_PROVIDER_VALUE_SET = new Set<AIProviderId>(AI_PROVIDER_VALUES);

export const AI_REASONING_EFFORT_VALUES = Object.keys(AI_REASONING_EFFORT_VALUE_FLAGS) as AIReasoningEffort[];
export const AI_REASONING_EFFORT_VALUE_SET = new Set<AIReasoningEffort>(AI_REASONING_EFFORT_VALUES);

export const STT_PROVIDER_VALUES = Object.keys(STT_PROVIDER_VALUE_FLAGS) as SpeechToTextProviderValue[];
export const STT_PROVIDER_VALUE_SET = new Set<SpeechToTextProviderValue>(STT_PROVIDER_VALUES);

export const STT_MODE_VALUES = Object.keys(STT_MODE_VALUE_FLAGS) as SpeechToTextModeValue[];
export const STT_MODE_VALUE_SET = new Set<SpeechToTextModeValue>(STT_MODE_VALUES);

export const STT_FIELD_STRATEGY_VALUES = Object.keys(STT_FIELD_STRATEGY_VALUE_FLAGS) as SpeechToTextFieldStrategyValue[];
export const STT_FIELD_STRATEGY_VALUE_SET = new Set<SpeechToTextFieldStrategyValue>(STT_FIELD_STRATEGY_VALUES);

// GTD settings sync by default. An explicit false remains authoritative so a
// device can keep these preferences local without a migration writing default
// values into the document and winning over an existing choice.
export const isSettingsSyncGroupEnabled = (
    preferences: SettingsSyncPreferences | undefined,
    group: SettingsSyncGroup,
): boolean => preferences?.[group] ?? (group === 'gtd');

// Single source of truth for which `settings.gtd` fields sync. Nested Inbox
// processing fields are handled separately below because defaultMode is a
// device-local presentation choice. Upload, merge, and timestamp stamping all
// derive from these lists to prevent allowlist drift.
export const GTD_SYNCED_FIELD_KEYS = [
    'timeEstimatePresets',
    'taskEditor',
    'autoArchiveDays',
    'defaultCaptureMethod',
    'defaultScheduleTime',
    'defaultAreaMode',
    'defaultAreaId',
    'focusTaskLimit',
    'focusGroupBy',
    'defaultProjectFlowMode',
    'naturalLanguageDates',
    'viewSections',
    'saveAudioAttachments',
    'weeklyReview',
    'dailyReview',
    'pomodoro',
] as const satisfies readonly (keyof GtdSettings)[];

export type GtdSyncedFieldKey = (typeof GTD_SYNCED_FIELD_KEYS)[number];

type InboxProcessingSettings = NonNullable<GtdSettings['inboxProcessing']>;
export const GTD_SYNCED_INBOX_PROCESSING_FIELD_KEYS = [
    'twoMinuteEnabled',
    'twoMinuteFirst',
    'projectFirst',
    'contextStepEnabled',
    'scheduleEnabled',
    'referenceEnabled',
] as const satisfies readonly (keyof InboxProcessingSettings)[];

export type GtdSyncedInboxProcessingFieldKey = (typeof GTD_SYNCED_INBOX_PROCESSING_FIELD_KEYS)[number];
export type GtdSyncedInboxProcessingSettings = Pick<InboxProcessingSettings, GtdSyncedInboxProcessingFieldKey>;
export type GtdSyncedSettings = Pick<GtdSettings, GtdSyncedFieldKey> & {
    inboxProcessing?: GtdSyncedInboxProcessingSettings;
};

export const GTD_SYNCED_APP_SETTINGS_FIELD_KEYS = [
    'quickAddAutoClean',
    'markdownEditorAssist',
] as const satisfies readonly (keyof AppData['settings'])[];

export type GtdSyncedAppSettingsFieldKey = (typeof GTD_SYNCED_APP_SETTINGS_FIELD_KEYS)[number];

type FeatureSettings = NonNullable<AppData['settings']['features']>;
export const GTD_SYNCED_FEATURE_FIELD_KEYS = [
    'priorities',
    'timeEstimates',
    'pomodoro',
] as const satisfies readonly (keyof FeatureSettings)[];

export type GtdSyncedFeatureFieldKey = (typeof GTD_SYNCED_FEATURE_FIELD_KEYS)[number];
export type GtdSyncedFeatureSettings = Pick<FeatureSettings, GtdSyncedFeatureFieldKey>;

export type GtdSyncSnapshot = Pick<AppData['settings'], GtdSyncedAppSettingsFieldKey> & {
    gtd?: GtdSyncedSettings;
    features?: GtdSyncedFeatureSettings;
};

export const getGtdSyncSnapshot = (settings: AppData['settings']): GtdSyncSnapshot => {
    const snapshot: GtdSyncSnapshot = {};
    const gtd: GtdSyncedSettings = {};
    for (const key of GTD_SYNCED_FIELD_KEYS) {
        const value = settings.gtd?.[key];
        if (value !== undefined) {
            (gtd as Record<GtdSyncedFieldKey, unknown>)[key] = value;
        }
    }

    const inboxProcessing: GtdSyncedInboxProcessingSettings = {};
    for (const key of GTD_SYNCED_INBOX_PROCESSING_FIELD_KEYS) {
        const value = settings.gtd?.inboxProcessing?.[key];
        if (value !== undefined) {
            (inboxProcessing as Record<GtdSyncedInboxProcessingFieldKey, unknown>)[key] = value;
        }
    }
    if (Object.keys(inboxProcessing).length > 0) {
        gtd.inboxProcessing = inboxProcessing;
    }
    if (Object.keys(gtd).length > 0) {
        snapshot.gtd = gtd;
    }

    for (const key of GTD_SYNCED_APP_SETTINGS_FIELD_KEYS) {
        const value = settings[key];
        if (value !== undefined) {
            (snapshot as Record<GtdSyncedAppSettingsFieldKey, unknown>)[key] = value;
        }
    }

    const features: GtdSyncedFeatureSettings = {};
    for (const key of GTD_SYNCED_FEATURE_FIELD_KEYS) {
        const value = settings.features?.[key];
        if (value !== undefined) {
            (features as Record<GtdSyncedFeatureFieldKey, unknown>)[key] = value;
        }
    }
    if (Object.keys(features).length > 0) {
        snapshot.features = features;
    }

    return snapshot;
};
