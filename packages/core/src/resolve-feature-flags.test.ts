import { describe, expect, it } from 'vitest';
import { resolveFeatureFlags } from './resolve-feature-flags';
import type { AppSettings } from './types';

describe('resolveFeatureFlags', () => {
    it('defaults priorities and timeEstimates on, pomodoro off, when settings are undefined', () => {
        expect(resolveFeatureFlags(undefined)).toEqual({
            priorities: true,
            timeEstimates: true,
            pomodoro: false,
        });
    });

    it('defaults priorities and timeEstimates on, pomodoro off, when features is missing', () => {
        expect(resolveFeatureFlags({} as AppSettings)).toEqual({
            priorities: true,
            timeEstimates: true,
            pomodoro: false,
        });
    });

    it('reads priorities as disabled only on an explicit false', () => {
        expect(resolveFeatureFlags({ features: { priorities: false } } as AppSettings).priorities).toBe(false);
        expect(resolveFeatureFlags({ features: { priorities: true } } as AppSettings).priorities).toBe(true);
        expect(resolveFeatureFlags({ features: { priorities: undefined } } as AppSettings).priorities).toBe(true);
    });

    it('reads timeEstimates as disabled only on an explicit false', () => {
        expect(resolveFeatureFlags({ features: { timeEstimates: false } } as AppSettings).timeEstimates).toBe(false);
        expect(resolveFeatureFlags({ features: { timeEstimates: true } } as AppSettings).timeEstimates).toBe(true);
        expect(resolveFeatureFlags({ features: { timeEstimates: undefined } } as AppSettings).timeEstimates).toBe(true);
    });

    it('reads pomodoro as enabled only on an explicit true — the opposite polarity from the other two', () => {
        expect(resolveFeatureFlags({ features: { pomodoro: true } } as AppSettings).pomodoro).toBe(true);
        expect(resolveFeatureFlags({ features: { pomodoro: false } } as AppSettings).pomodoro).toBe(false);
        expect(resolveFeatureFlags({ features: { pomodoro: undefined } } as AppSettings).pomodoro).toBe(false);
    });
});
