import { X } from 'lucide-react';
import { tFallback } from '@mindwtr/core';

import { cn } from '../lib/utils';

export type InboxProcessingScheduleFieldControl = {
    date: string;
    timeDraft: string;
    onDateChange: (value: string) => void;
    onTimeDraftChange: (value: string) => void;
    onTimeCommit: () => void;
    onClear: () => void;
};

export type InboxProcessingScheduleFieldsControls = {
    start: InboxProcessingScheduleFieldControl;
    due: InboxProcessingScheduleFieldControl;
    review: InboxProcessingScheduleFieldControl;
};

export type InboxProcessingScheduleFieldKey = keyof InboxProcessingScheduleFieldsControls;

type InboxProcessingScheduleFieldsProps = {
    t: (key: string) => string;
    fields: InboxProcessingScheduleFieldsControls;
    visibleFieldKeys?: InboxProcessingScheduleFieldKey[];
    variant?: 'quick' | 'guided';
};

const FIELD_CONFIG = [
    {
        key: 'start',
        labelKey: 'taskEdit.startDateLabel',
        timeAriaKey: 'task.aria.startTime',
    },
    {
        key: 'due',
        labelKey: 'taskEdit.dueDateLabel',
        timeAriaKey: 'task.aria.dueTime',
    },
    {
        key: 'review',
        labelKey: 'taskEdit.reviewDateLabel',
        timeAriaKey: 'task.aria.reviewTime',
    },
] as const;

export function InboxProcessingScheduleFields({
    t,
    fields,
    visibleFieldKeys,
    variant = 'quick',
}: InboxProcessingScheduleFieldsProps) {
    const compact = variant === 'quick';
    const clearText = tFallback(t, 'common.clear', 'Clear');
    const renderedFieldConfig = visibleFieldKeys?.length
        ? FIELD_CONFIG.filter(({ key }) => visibleFieldKeys.includes(key))
        : FIELD_CONFIG;

    return (
        <div className="space-y-3">
            {renderedFieldConfig.map(({ key, labelKey, timeAriaKey }) => {
                const field = fields[key];
                const label = t(labelKey);
                const showClear = Boolean(field.date || field.timeDraft);

                return (
                    <div key={key} className="space-y-1">
                        <label className={cn(
                            'font-medium text-muted-foreground',
                            compact ? 'text-[11px]' : 'text-xs'
                        )}>
                            {label}
                        </label>
                        <div className="flex items-center gap-2">
                            <input
                                type="date"
                                aria-label={label}
                                value={field.date}
                                onChange={(event) => field.onDateChange(event.target.value)}
                                className={cn(
                                    'flex-1 rounded border border-border bg-muted/50 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40',
                                    compact ? 'px-3 py-2 text-sm' : 'px-2 py-1 text-xs'
                                )}
                            />
                            <input
                                type="text"
                                aria-label={t(timeAriaKey)}
                                value={field.timeDraft}
                                inputMode="numeric"
                                placeholder="HH:MM"
                                onChange={(event) => field.onTimeDraftChange(event.target.value)}
                                onBlur={field.onTimeCommit}
                                className={cn(
                                    'w-24 shrink-0 rounded border border-border bg-muted/50 text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40',
                                    compact ? 'px-3 py-2 text-sm' : 'px-2 py-1 text-xs'
                                )}
                            />
                            {showClear ? (
                                <button
                                    type="button"
                                    onClick={field.onClear}
                                    className={cn(
                                        'shrink-0 rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground',
                                        compact ? 'p-2' : 'p-1.5'
                                    )}
                                    aria-label={`${clearText} ${label}`}
                                >
                                    <X className="h-4 w-4" />
                                </button>
                            ) : (
                                <span aria-hidden="true" className="h-8 w-8 shrink-0" />
                            )}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
