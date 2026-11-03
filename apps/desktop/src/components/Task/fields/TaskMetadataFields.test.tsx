import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TIME_ESTIMATE_OPTIONS } from '@mindwtr/core';

import { TimeEstimateField } from './TaskMetadataFields';


const t = (key: string) => ({
    'taskEdit.timeEstimateLabel': 'Time estimate',
    'task.aria.timeEstimate': 'Time estimate',
    'common.none': 'None',
    'recurrence.custom': 'Custom…',
    'units.minutesShort': '{{minutes}} Min.',
    'units.hoursShort': '{{hours}} Std.',
    'units.hoursPlusShort': '{{hours}} Std.+',
}[key] ?? key);

describe('TimeEstimateField', () => {
    it('offers None, every core time estimate, then Custom', () => {
        const { getByLabelText } = render(<TimeEstimateField t={t} value="" onChange={() => undefined} />);
        const select = getByLabelText('Time estimate') as HTMLSelectElement;
        expect([...select.options].map((option) => option.value)).toEqual([
            '',
            ...TIME_ESTIMATE_OPTIONS,
            '__custom',
        ]);
    });

    it('labels the estimates with the locale unit text', () => {
        const { getByLabelText } = render(<TimeEstimateField t={t} value="" onChange={() => undefined} />);
        const select = getByLabelText('Time estimate') as HTMLSelectElement;
        expect(select.options[1].textContent).toBe('5 Min.');
        expect(select.options[6].textContent).toBe('2 Std.');
        expect(select.options[9].textContent).toBe('4 Std.+');
    });

    it('selects the Custom entry for a custom estimate without listing it as an option', () => {
        const { getByLabelText } = render(<TimeEstimateField t={t} value="custom:75" onChange={() => undefined} />);
        const select = getByLabelText('Time estimate') as HTMLSelectElement;
        expect(select.value).toBe('__custom');
        expect([...select.options].map((option) => option.value)).not.toContain('custom:75');
    });
});
