import type { AppSettings } from './types';

export type ResolvedFeatureFlags = {
    priorities: boolean;
    timeEstimates: boolean;
    pomodoro: boolean;
    timeline: boolean;
};


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
