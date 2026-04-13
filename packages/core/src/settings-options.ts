import { SUPPORTED_LANGUAGES } from './i18n/i18n-constants';
import type { AIProviderId, AIReasoningEffort } from './ai/types';
import type { AppData } from './types';

type ThemeValue = NonNullable<AppData['settings']['theme']>;
type LanguageValue = NonNullable<AppData['settings']['language']>;
type WeekStartValue = NonNullable<AppData['settings']['weekStart']>;
type TimeFormatValue = NonNullable<AppData['settings']['timeFormat']>;
type KeybindingStyleValue = NonNullable<AppData['settings']['keybindingStyle']>;
type DensityValue = NonNullable<NonNullable<AppData['settings']['appearance']>['density']>;
type TextSizeValue = NonNullable<NonNullable<AppData['settings']['appearance']>['textSize']>;
type SpeechToTextSettings = NonNullable<NonNullable<AppData['settings']['ai']>['speechToText']>;
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
};

const WEEK_START_VALUE_FLAGS: Record<WeekStartValue, true> = {
    monday: true,
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
};

const DENSITY_VALUE_FLAGS: Record<DensityValue, true> = {
    comfortable: true,
    compact: true,
};

const TEXT_SIZE_VALUE_FLAGS: Record<TextSizeValue, true> = {
    default: true,
    large: true,
    'extra-large': true,
};

const AI_PROVIDER_VALUE_FLAGS: Record<AIProviderId, true> = {
    gemini: true,
    openai: true,
    anthropic: true,
};

const AI_REASONING_EFFORT_VALUE_FLAGS: Record<AIReasoningEffort, true> = {
    low: true,
    medium: true,
    high: true,
};

const STT_PROVIDER_VALUE_FLAGS: Record<SpeechToTextProviderValue, true> = {
    openai: true,
    gemini: true,
    whisper: true,
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
