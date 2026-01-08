import { buildRRuleString, parseRRuleString, type RecurrenceWeekday } from '@mindwtr/core';
import { cn } from '../../../lib/utils';

const WEEKDAYS: Array<{ id: RecurrenceWeekday; label: string }> = [
    { id: 'MO', label: 'Mon' },
    { id: 'TU', label: 'Tue' },
    { id: 'WE', label: 'Wed' },
    { id: 'TH', label: 'Thu' },
    { id: 'FR', label: 'Fri' },
    { id: 'SA', label: 'Sat' },
    { id: 'SU', label: 'Sun' },
];

type WeekdaySelectorProps = {
    value?: string;
    onChange: (rrule: string) => void;
    className?: string;
};

export function WeekdaySelector({ value, onChange, className }: WeekdaySelectorProps) {
    const parsed = value ? parseRRuleString(value) : {};
    const selected = new Set<RecurrenceWeekday>(
        (parsed.byDay || []).filter((day) => WEEKDAYS.some((weekday) => weekday.id === day)) as RecurrenceWeekday[]
    );

    const handleToggle = (day: RecurrenceWeekday) => {
        const next = new Set(selected);
        if (next.has(day)) {
            next.delete(day);
        } else {
            next.add(day);
        }
        const ordered = WEEKDAYS.map((d) => d.id).filter((d) => next.has(d));
        onChange(buildRRuleString('weekly', ordered));
    };

    return (
        <div className={cn("flex flex-wrap gap-1", className)}>
            {WEEKDAYS.map((day) => {
                const isActive = selected.has(day.id);
                return (
                    <button
                        key={day.id}
                        type="button"
                        onClick={() => handleToggle(day.id)}
                        className={cn(
                            "text-[10px] px-2 py-1 rounded border transition-colors",
                            isActive
                                ? "bg-primary text-primary-foreground border-primary"
                                : "bg-transparent text-muted-foreground border-border hover:bg-accent"
                        )}
                        aria-pressed={isActive}
                    >
                        {day.label}
                    </button>
                );
            })}
        </div>
    );
}
