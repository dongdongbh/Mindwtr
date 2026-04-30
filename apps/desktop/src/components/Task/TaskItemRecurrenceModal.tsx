import { useId } from 'react';
import { translateWithFallback, type RecurrenceWeekday } from '@mindwtr/core';

import { cn } from '../../lib/utils';

type TaskItemRecurrenceModalProps = {
    t: (key: string) => string;
    weekdayOrder: RecurrenceWeekday[];
    weekdayLabels: Record<RecurrenceWeekday, string>;
    customInterval: number;
    customMode: 'date' | 'nth';
    customOrdinal: '1' | '2' | '3' | '4' | '-1';
    customWeekday: RecurrenceWeekday;
    customMonthDay: number;
    onIntervalChange: (value: number) => void;
    onModeChange: (value: 'date' | 'nth') => void;
    onOrdinalChange: (value: '1' | '2' | '3' | '4' | '-1') => void;
    onWeekdayChange: (value: RecurrenceWeekday) => void;
    onMonthDayChange: (value: number) => void;
    onClose: () => void;
    onApply: () => void;
};

export function TaskItemRecurrenceModal({
    t,
    weekdayOrder,
    weekdayLabels,
    customInterval,
    customMode,
    customOrdinal,
    customWeekday,
    customMonthDay,
    onIntervalChange,
    onModeChange,
    onOrdinalChange,
    onWeekdayChange,
    onMonthDayChange,
    onClose,
    onApply,
}: TaskItemRecurrenceModalProps) {
    const titleId = useId();
    const intervalInputId = useId();
    const ordinalSelectId = useId();
    const weekdaySelectId = useId();
    const monthDayInputId = useId();
    const resolveText = (key: string, fallback: string) => {
        return translateWithFallback(t, key, fallback);
    };
    const ordinalKey = customOrdinal === '-1'
        ? 'last'
        : customOrdinal === '1'
            ? 'first'
            : customOrdinal === '2'
                ? 'second'
                : customOrdinal === '3'
                    ? 'third'
                    : 'fourth';
    const ordinalLabel = t(`recurrence.ordinal.${ordinalKey}`);
    const weekdayLabel = weekdayLabels[customWeekday] ?? customWeekday;
    const onDayLabel = t('recurrence.onDayOfMonth').replace('{day}', String(customMonthDay));
    const onNthLabel = t('recurrence.onNthWeekday')
        .replace('{ordinal}', ordinalLabel)
        .replace('{weekday}', weekdayLabel);
    const ordinalSelectLabel = resolveText('recurrence.ordinalSelectLabel', 'Recurrence ordinal');
    const weekdaySelectLabel = resolveText('recurrence.weekdaySelectLabel', 'Recurrence weekday');

    return (
        <div
            className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
            onClick={onClose}
            onKeyDown={(event) => {
                if (event.key === 'Escape') {
                    event.preventDefault();
                    onClose();
                }
            }}
        >
            <div
                className="bg-card border border-border rounded-lg shadow-xl max-w-md w-full mx-4"
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                onClick={(event) => event.stopPropagation()}
            >
                <div className="p-4 border-b border-border">
                    <h3 id={titleId} className="text-lg font-semibold">{t('recurrence.customTitle')}</h3>
                </div>
                <div className="p-4 space-y-4">
                    <div className="flex items-center gap-2 flex-wrap">
                        <label htmlFor={intervalInputId} className="text-sm">{t('recurrence.repeatEvery')}</label>
                        <input
                            id={intervalInputId}
                            type="number"
                            min={1}
                            max={12}
                            value={customInterval}
                            onChange={(event) => onIntervalChange(event.target.valueAsNumber || 1)}
                            className="w-20 text-sm bg-muted/50 border border-border rounded px-2 py-1 text-foreground"
                        />
                        <span className="text-sm">{t('recurrence.monthUnit')}</span>
                    </div>
                    <div className="space-y-2">
                        <div className="text-xs text-muted-foreground">{t('recurrence.onLabel')}</div>
                        <div className="flex flex-wrap gap-2">
                            <button
                                type="button"
                                onClick={() => onModeChange('date')}
                                className={cn(
                                    'text-[10px] px-2 py-1 rounded border transition-colors',
                                    customMode === 'date'
                                        ? 'bg-primary text-primary-foreground border-primary'
                                        : 'bg-transparent text-muted-foreground border-border hover:bg-accent'
                                )}
                            >
                                {onDayLabel}
                            </button>
                            <button
                                type="button"
                                onClick={() => onModeChange('nth')}
                                className={cn(
                                    'text-[10px] px-2 py-1 rounded border transition-colors',
                                    customMode === 'nth'
                                        ? 'bg-primary text-primary-foreground border-primary'
                                        : 'bg-transparent text-muted-foreground border-border hover:bg-accent'
                                )}
                            >
                                {onNthLabel}
                            </button>
                        </div>
                        {customMode === 'nth' && (
                            <div className="flex flex-wrap gap-2 items-center">
                                <label htmlFor={ordinalSelectId} className="sr-only">{ordinalSelectLabel}</label>
                                <select
                                    id={ordinalSelectId}
                                    value={customOrdinal}
                                    onChange={(event) => onOrdinalChange(event.target.value as '1' | '2' | '3' | '4' | '-1')}
                                    className="text-xs bg-muted/50 border border-border rounded px-2 py-1 text-foreground"
                                >
                                    <option value="1">{t('recurrence.ordinal.first')}</option>
                                    <option value="2">{t('recurrence.ordinal.second')}</option>
                                    <option value="3">{t('recurrence.ordinal.third')}</option>
                                    <option value="4">{t('recurrence.ordinal.fourth')}</option>
                                    <option value="-1">{t('recurrence.ordinal.last')}</option>
                                </select>
                                <label htmlFor={weekdaySelectId} className="sr-only">{weekdaySelectLabel}</label>
                                <select
                                    id={weekdaySelectId}
                                    value={customWeekday}
                                    onChange={(event) => onWeekdayChange(event.target.value as RecurrenceWeekday)}
                                    className="text-xs bg-muted/50 border border-border rounded px-2 py-1 text-foreground"
                                >
                                    {weekdayOrder.map((day) => (
                                        <option key={day} value={day}>
                                            {weekdayLabels[day] ?? day}
                                        </option>
                                    ))}
                                </select>
                            </div>
                        )}
                        {customMode === 'date' && (
                            <div className="flex items-center gap-2">
                                <label htmlFor={monthDayInputId} className="text-xs text-muted-foreground">
                                    {t('recurrence.onDayOfMonth').replace('{day}', '')}
                                </label>
                                <input
                                    id={monthDayInputId}
                                    type="number"
                                    min={1}
                                    max={31}
                                    value={customMonthDay}
                                    onChange={(event) => onMonthDayChange(event.target.valueAsNumber || 1)}
                                    className="w-20 text-sm bg-muted/50 border border-border rounded px-2 py-1 text-foreground"
                                />
                            </div>
                        )}
                    </div>
                </div>
                <div className="p-4 border-t border-border flex justify-end gap-2">
                    <button
                        type="button"
                        className="text-sm px-3 py-1 rounded border border-border text-muted-foreground hover:bg-muted"
                        onClick={onClose}
                    >
                        {t('common.cancel')}
                    </button>
                    <button
                        type="button"
                        className="text-sm px-3 py-1 rounded bg-primary text-primary-foreground hover:bg-primary/90"
                        onClick={onApply}
                    >
                        {t('common.save')}
                    </button>
                </div>
            </div>
        </div>
    );
}
