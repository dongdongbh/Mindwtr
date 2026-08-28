import type { AppSettings } from './types';

export type ResolvedFeatureFlags = {
    board: boolean;
    priorities: boolean;
    timeEstimates: boolean;
    pomodoro: boolean;
};

/**
 * The single source of truth for optional GTD feature toggles. Missing board,
 * priorities, and time-estimate values read as enabled so existing profiles
 * retain their historical behavior. The fresh-profile load migration writes
 * explicit false values for those features. Pomodoro has always been opt-in,
 * so only an explicit true enables it.
 */
export function resolveFeatureFlags(settings: AppSettings | undefined): ResolvedFeatureFlags {
    return {
        board: settings?.features?.board !== false,
        priorities: settings?.features?.priorities !== false,
        timeEstimates: settings?.features?.timeEstimates !== false,
        pomodoro: settings?.features?.pomodoro === true,
    };
}
