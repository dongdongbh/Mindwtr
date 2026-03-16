import { describe, expect, it } from 'vitest';

import { formatTimeEstimateChipLabel, matchesSelectedTimeEstimates } from './time-estimate-filter-utils';

describe('time-estimate-filter-utils', () => {
    it('formats short chip labels', () => {
        expect(formatTimeEstimateChipLabel('5min')).toBe('5m');
        expect(formatTimeEstimateChipLabel('30min')).toBe('30m');
        expect(formatTimeEstimateChipLabel('1hr')).toBe('1h');
        expect(formatTimeEstimateChipLabel('4hr+')).toBe('4h+');
    });

    it('matches all tasks when no estimate filters are selected', () => {
        expect(matchesSelectedTimeEstimates({ timeEstimate: '15min' }, [])).toBe(true);
        expect(matchesSelectedTimeEstimates({}, [])).toBe(true);
    });

    it('requires a matching estimate when filters are selected', () => {
        expect(matchesSelectedTimeEstimates({ timeEstimate: '15min' }, ['5min', '15min'])).toBe(true);
        expect(matchesSelectedTimeEstimates({ timeEstimate: '30min' }, ['5min', '15min'])).toBe(false);
        expect(matchesSelectedTimeEstimates({}, ['5min', '15min'])).toBe(false);
    });
});
