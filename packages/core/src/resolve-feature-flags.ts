import type { AppSettings } from './types';

export type ResolvedFeatureFlags = {
    priorities: boolean;
    timeEstimates: boolean;
    pomodoro: boolean;
    timeline: boolean;
};

/**
 * The single source of truth for the optional GTD feature toggles' default
 * polarity: priorities and time estimates default ON (missing/undefined
 * reads as enabled), pomodoro and the desktop Timeline view default OFF
 * (missing/undefined reads as disabled) — mismatched on purpose, since those
 * two are opt-in and the other two are opt-out. ~24 call sites across desktop and mobile used
 * to re-derive this inline; collapsing it here means a new site can't
 * silently pick the wrong default by copying the wrong sibling.
 */
export function resolveFeatureFlags(
    settings: { features?: AppSettings['features'] } | null | undefined,
): ResolvedFeatureFlags {
    return {
        priorities: settings?.features?.priorities !== false,
        timeEstimates: settings?.features?.timeEstimates !== false,
        pomodoro: settings?.features?.pomodoro === true,
        timeline: settings?.features?.timeline === true,
    };
}
