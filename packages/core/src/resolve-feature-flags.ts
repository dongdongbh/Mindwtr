import type { AppSettings } from './types';

export type ResolvedFeatureFlags = {
    priorities: boolean;
    timeEstimates: boolean;
    pomodoro: boolean;
};

/**
 * The single source of truth for the three optional GTD feature toggles'
 * default polarity: priorities and time estimates default ON (missing/
 * undefined reads as enabled), pomodoro defaults OFF (missing/undefined
 * reads as disabled) — mismatched on purpose, since Pomodoro is opt-in and
 * the other two are opt-out. ~24 call sites across desktop and mobile used
 * to re-derive this inline; collapsing it here means a new site can't
 * silently pick the wrong default by copying the wrong sibling.
 */
export function resolveFeatureFlags(settings: AppSettings | undefined): ResolvedFeatureFlags {
    return {
        priorities: settings?.features?.priorities !== false,
        timeEstimates: settings?.features?.timeEstimates !== false,
        pomodoro: settings?.features?.pomodoro === true,
    };
}
