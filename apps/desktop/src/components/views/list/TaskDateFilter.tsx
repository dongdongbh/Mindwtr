import type { DateRange } from '@mindwtr/core';
import { cn } from '../../../lib/utils';
import { FILTER_OPTION_BASE, FilterCategory } from './FilterDisclosure';

const PRESETS = ['today', 'next_7_days', 'next_14_days', 'next_30_days', 'upcoming'] as const;

export function TaskDateFilter({ id, value, onChange, expanded, onToggle, t }: {
    id: string;
    value?: DateRange;
    onChange: (value: DateRange | undefined) => void;
    expanded: boolean;
    onToggle: () => void;
    t: (key: string) => string;
}) {
    const selectedPreset = value && 'preset' in value ? value.preset : undefined;
    return (
        <FilterCategory id={id} label={t('filters.taskDates')}
            summary={selectedPreset ? t(`filters.datePreset.${selectedPreset}`) : t('filters.anyTime')}
            expanded={expanded} onToggle={onToggle}>
            <div className="flex flex-wrap gap-2">
                {[undefined, ...PRESETS].map((preset) => {
                    const selected = preset ? selectedPreset === preset : !value;
                    return (
                        <button key={preset ?? 'any'} type="button" aria-pressed={selected}
                            onClick={() => onChange(preset ? { preset } : undefined)}
                            className={cn(FILTER_OPTION_BASE, selected ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-muted/80')}>
                            {t(preset ? `filters.datePreset.${preset}` : 'filters.anyTime')}
                        </button>
                    );
                })}
            </div>
        </FilterCategory>
    );
}
