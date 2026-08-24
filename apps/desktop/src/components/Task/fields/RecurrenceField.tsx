import { useState } from 'react';
import { buildRRuleString, parseRRuleString, RECURRENCE_INTERVAL_MAX, safeParseDate, tFallback, type RecurrenceByDay, type RecurrenceRule, type RecurrenceStrategy } from '@mindwtr/core';

import { cn } from '../../../lib/utils';
import { DateField } from '../../ui/DateField';
import { WeekdaySelector } from '../TaskForm/WeekdaySelector';
import type { MonthlyRecurrenceInfo } from '../TaskItemFieldRenderer';
import { taskEditorLabelClassName } from '../task-editor-label';
import { formatRecurrenceSummary } from './recurrence-summary';

type RecurrenceFieldProps = {
    t: (key: string) => string;
    language: string;
    editRecurrence: RecurrenceRule | '';
    editRecurrenceStrategy: RecurrenceStrategy;
    editRecurrenceRRule: string;
    editShowFutureRecurrence: boolean;
    monthlyRecurrence: MonthlyRecurrenceInfo;
    parsedRecurrenceRRule: ReturnType<typeof parseRRuleString>;
    completedOccurrences?: number;
    recurrenceEndMode: 'never' | 'until' | 'count';
    recurrenceDefaultEndDate: string;
    dateFormatSetting?: string | null;
    nativeDateInputLocale: string;
    projectedRecurrenceDateLabel?: string;
    onRecurrenceChange: (value: RecurrenceRule | '') => void;
    onRecurrenceStrategyChange: (value: RecurrenceStrategy) => void;
    onRecurrenceRRuleChange: (value: string) => void;
    onShowFutureRecurrenceChange: (value: boolean) => void;
    openCustomRecurrence: () => void;
    buildRecurrenceRRule: (
        rule: RecurrenceRule,
        overrides?: {
            byDay?: RecurrenceByDay[];
            interval?: number;
            byMonthDay?: number[];
            count?: number;
            until?: string;
        },
    ) => string;
};

const normalizeRecurrenceIntervalInput = (value: number): number => (
    Number.isFinite(value) && value > 0
        ? Math.min(Math.round(value), RECURRENCE_INTERVAL_MAX)
        : 1
);

export function RecurrenceField({
    t,
    language,
    editRecurrence,
    editRecurrenceStrategy,
    editRecurrenceRRule,
    editShowFutureRecurrence,
    monthlyRecurrence,
    parsedRecurrenceRRule,
    completedOccurrences,
    recurrenceEndMode,
    recurrenceDefaultEndDate,
    dateFormatSetting,
    nativeDateInputLocale,
    projectedRecurrenceDateLabel,
    onRecurrenceChange,
    onRecurrenceStrategyChange,
    onRecurrenceRRuleChange,
    onShowFutureRecurrenceChange,
    openCustomRecurrence,
    buildRecurrenceRRule,
}: RecurrenceFieldProps) {
    // Session-only disclosure: once a rule exists the editor rests as a
    // one-sentence summary, and picking a rule from the resting dropdown lands
    // you in the expanded editor.
    const [expanded, setExpanded] = useState(false);
    const showEditor = !editRecurrence || expanded;
    const summary = editRecurrence
        ? formatRecurrenceSummary({
            rule: editRecurrence,
            strategy: editRecurrenceStrategy,
            interval: parsedRecurrenceRRule.interval,
            byDay: parsedRecurrenceRRule.byDay,
            byMonthDay: parsedRecurrenceRRule.byMonthDay,
            count: parsedRecurrenceRRule.count,
            completedOccurrences,
            until: parsedRecurrenceRRule.until,
        }, t, language)
        : '';

    return (
        <div className="flex flex-col gap-1 w-full">
            <label className={taskEditorLabelClassName}>{t('taskEdit.recurrenceLabel')}</label>
            {editRecurrence && (
                <button
                    type="button"
                    aria-expanded={expanded}
                    onClick={() => setExpanded((current) => !current)}
                    className={cn(
                        'w-full rounded border px-2 py-1.5 text-left text-xs transition-colors',
                        expanded
                            ? 'border-primary/60 bg-primary/10 text-foreground'
                            : 'border-border bg-muted/30 text-foreground hover:bg-muted/50'
                    )}
                >
                    {summary}
                </button>
            )}
            {showEditor && (<>
            <select
                value={editRecurrence}
                aria-label={t('task.aria.recurrence')}
                onChange={(e) => {
                    const value = e.target.value as RecurrenceRule | '';
                    onRecurrenceChange(value);
                    if (value) setExpanded(true);
                    if (value === 'daily') {
                        if (!editRecurrenceRRule || parsedRecurrenceRRule.rule !== 'daily') {
                            onRecurrenceRRuleChange(buildRRuleString('daily', undefined, 1, {
                                count: parsedRecurrenceRRule.count,
                                until: parsedRecurrenceRRule.until,
                            }));
                        }
                    }
                    if (value === 'weekly') {
                        if (!editRecurrenceRRule || parsedRecurrenceRRule.rule !== 'weekly') {
                            onRecurrenceRRuleChange(buildRRuleString('weekly', undefined, undefined, {
                                count: parsedRecurrenceRRule.count,
                                until: parsedRecurrenceRRule.until,
                            }));
                        }
                    }
                    if (value === 'monthly') {
                        if (!editRecurrenceRRule || parsedRecurrenceRRule.rule !== 'monthly') {
                            onRecurrenceRRuleChange(buildRRuleString('monthly', undefined, undefined, {
                                count: parsedRecurrenceRRule.count,
                                until: parsedRecurrenceRRule.until,
                            }));
                        }
                    }
                    if (value === 'yearly') {
                        if (!editRecurrenceRRule || parsedRecurrenceRRule.rule !== 'yearly') {
                            onRecurrenceRRuleChange(buildRRuleString('yearly', undefined, undefined, {
                                count: parsedRecurrenceRRule.count,
                                until: parsedRecurrenceRRule.until,
                            }));
                        }
                    }

                    if (!value) {
                        onRecurrenceRRuleChange('');
                    }
                }}
                className="text-xs bg-muted/50 border border-border rounded px-2 py-1 w-full text-foreground"
            >
                <option value="">{t('recurrence.none')}</option>
                <option value="daily">{t('recurrence.daily')}</option>
                <option value="weekly">{t('recurrence.weekly')}</option>
                <option value="monthly">{t('recurrence.monthly')}</option>
                <option value="yearly">{t('recurrence.yearly')}</option>
            </select>
            {editRecurrence === 'daily' && (
                <div className="flex items-center gap-2 pt-1">
                    <span className="text-[10px] text-muted-foreground">{t('recurrence.repeatEvery')}</span>
                    <input
                        type="number"
                        min={1}
                        max={RECURRENCE_INTERVAL_MAX}
                        value={Math.max(parsedRecurrenceRRule.interval ?? 1, 1)}
                        onChange={(event) => {
                            const safeInterval = normalizeRecurrenceIntervalInput(Number(event.target.valueAsNumber));
                            onRecurrenceRRuleChange(buildRecurrenceRRule('daily', {
                                byDay: undefined,
                                byMonthDay: undefined,
                                interval: safeInterval,
                            }));
                        }}
                        className="w-20 text-xs bg-muted/50 border border-border rounded px-2 py-1 text-foreground"
                    />
                    <span className="text-[10px] text-muted-foreground">{t('recurrence.dayUnit')}</span>
                </div>
            )}
            {editRecurrence && (
                <label className="flex items-center gap-2 pt-1 text-[10px] text-muted-foreground">
                    <input
                        type="checkbox"
                        checked={editRecurrenceStrategy === 'fluid'}
                        onChange={(e) => onRecurrenceStrategyChange(e.target.checked ? 'fluid' : 'strict')}
                        className="accent-primary"
                    />
                    {t('recurrence.afterCompletion')}
                </label>
            )}
            {editRecurrence && (
                <label className="flex items-center gap-2 pt-1 text-[10px] text-muted-foreground">
                    <input
                        type="checkbox"
                        checked={editShowFutureRecurrence}
                        onChange={(event) => onShowFutureRecurrenceChange(event.target.checked)}
                        className="accent-primary"
                    />
                    {tFallback(t, 'recurrence.showFutureInCalendar', 'Show next occurrence in Calendar')}
                </label>
            )}
            {editRecurrence && editShowFutureRecurrence && (
                <p className="pl-6 text-[10px] leading-snug text-muted-foreground">
                    {tFallback(t, 'recurrence.showFutureInCalendarHint', 'Planning-only preview; the next task is still created when this one is completed.')}
                    {projectedRecurrenceDateLabel
                        ? ` ${tFallback(t, 'recurrence.nextCalendarPreview', 'Next calendar preview')}: ${projectedRecurrenceDateLabel}.`
                        : ''}
                </p>
            )}
            {editRecurrence === 'weekly' && (
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pt-1">
                    <span className="text-[10px] text-muted-foreground">{t('recurrence.repeatEvery')}</span>
                    <input
                        type="number"
                        min={1}
                        max={RECURRENCE_INTERVAL_MAX}
                        value={Math.max(parsedRecurrenceRRule.interval ?? 1, 1)}
                        onChange={(event) => {
                            const safeInterval = normalizeRecurrenceIntervalInput(Number(event.target.valueAsNumber));
                            onRecurrenceRRuleChange(buildRecurrenceRRule('weekly', {
                                byDay: parsedRecurrenceRRule.byDay,
                                byMonthDay: undefined,
                                interval: safeInterval,
                            }));
                        }}
                        className="w-20 text-xs bg-muted/50 border border-border rounded px-2 py-1 text-foreground"
                    />
                    <span className="text-[10px] text-muted-foreground">{t('recurrence.weekUnit')}</span>
                    <span className="text-[10px] text-muted-foreground">{t('recurrence.onLabel')}</span>
                    <WeekdaySelector
                        value={editRecurrenceRRule || buildRRuleString('weekly', undefined, undefined, {
                            count: parsedRecurrenceRRule.count,
                            until: parsedRecurrenceRRule.until,
                        })}
                        onChange={(rrule) => {
                            const parsed = parseRRuleString(rrule);
                            onRecurrenceRRuleChange(buildRRuleString('weekly', parsed.byDay, parsedRecurrenceRRule.interval, {
                                count: parsedRecurrenceRRule.count,
                                until: parsedRecurrenceRRule.until,
                            }));
                        }}
                    />
                </div>
            )}
            {editRecurrence && (
                <div className="flex items-center gap-2 pt-1 flex-wrap">
                    <span className="text-[10px] text-muted-foreground">{t('recurrence.endsLabel')}</span>
                    <select
                        value={recurrenceEndMode}
                        onChange={(event) => {
                            const value = event.target.value as 'never' | 'until' | 'count';
                            if (value === 'never') {
                                onRecurrenceRRuleChange(buildRecurrenceRRule(editRecurrence, {
                                    count: undefined,
                                    until: undefined,
                                }));
                                return;
                            }
                            if (value === 'until') {
                                onRecurrenceRRuleChange(buildRecurrenceRRule(editRecurrence, {
                                    count: undefined,
                                    until: recurrenceDefaultEndDate,
                                }));
                                return;
                            }
                            onRecurrenceRRuleChange(buildRecurrenceRRule(editRecurrence, {
                                count: parsedRecurrenceRRule.count ?? 1,
                                until: undefined,
                            }));
                        }}
                        className="text-xs bg-muted/50 border border-border rounded px-2 py-1 text-foreground"
                    >
                        <option value="never">{t('recurrence.endsNever')}</option>
                        <option value="until">{t('recurrence.endsOnDate')}</option>
                        <option value="count">{t('recurrence.endsAfterCount')}</option>
                    </select>
                    {recurrenceEndMode === 'until' && (
                        <DateField
                            t={t}
                            dateAriaLabel={t('recurrence.endsOnDate')}
                            dateValue={parsedRecurrenceRRule.until || recurrenceDefaultEndDate}
                            selectedDate={safeParseDate(parsedRecurrenceRRule.until || recurrenceDefaultEndDate)}
                            dateFormatSetting={dateFormatSetting}
                            nativeDateInputLocale={nativeDateInputLocale}
                            dateInputClassName="text-xs bg-muted/50 border border-border rounded px-2 py-1 text-foreground"
                            // Inline in the "Ends" row, and there is no empty state:
                            // clearing it falls back to the default end date, so no
                            // onClear and no clear button.
                            className="w-40 max-w-none"
                            onDateChange={(value) => {
                                onRecurrenceRRuleChange(buildRecurrenceRRule(editRecurrence, {
                                    count: undefined,
                                    until: value || recurrenceDefaultEndDate,
                                }));
                            }}
                        />
                    )}
                    {recurrenceEndMode === 'count' && (
                        <>
                            <input
                                type="number"
                                min={1}
                                max={999}
                                value={Math.max(parsedRecurrenceRRule.count ?? 1, 1)}
                                onChange={(event) => {
                                    const countValue = Number(event.target.valueAsNumber);
                                    const safeCount = Number.isFinite(countValue) && countValue > 0
                                        ? Math.min(Math.round(countValue), 999)
                                        : 1;
                                    onRecurrenceRRuleChange(buildRecurrenceRRule(editRecurrence, {
                                        count: safeCount,
                                        until: undefined,
                                    }));
                                }}
                                className="w-20 text-xs bg-muted/50 border border-border rounded px-2 py-1 text-foreground"
                            />
                            <span className="text-[10px] text-muted-foreground">{t('recurrence.occurrenceUnit')}</span>
                        </>
                    )}
                </div>
            )}
            {editRecurrence === 'monthly' && (
                <div className="pt-1 space-y-2">
                    <div className="flex items-center gap-2">
                        <span className="text-[10px] text-muted-foreground">{t('recurrence.repeatEvery')}</span>
                        <input
                            type="number"
                            min={1}
                            max={RECURRENCE_INTERVAL_MAX}
                            value={Math.max(parsedRecurrenceRRule.interval ?? 1, 1)}
                            onChange={(event) => {
                                const safeInterval = normalizeRecurrenceIntervalInput(Number(event.target.valueAsNumber));
                                onRecurrenceRRuleChange(buildRecurrenceRRule('monthly', {
                                    interval: safeInterval,
                                }));
                            }}
                            className="w-20 text-xs bg-muted/50 border border-border rounded px-2 py-1 text-foreground"
                        />
                        <span className="text-[10px] text-muted-foreground">{t('recurrence.monthUnit')}</span>
                    </div>
                    <span className="text-[10px] text-muted-foreground">{t('recurrence.repeatOn')}</span>
                    <div className="flex flex-wrap gap-2">
                        <button
                            type="button"
                            onClick={() => onRecurrenceRRuleChange(buildRecurrenceRRule('monthly', {
                                byDay: undefined,
                                byMonthDay: undefined,
                            }))}
                            className={cn(
                                'text-[10px] px-2 py-1 rounded border transition-colors',
                                monthlyRecurrence.pattern === 'date'
                                    ? 'bg-primary text-primary-foreground border-primary'
                                    : 'bg-transparent text-muted-foreground border-border hover:bg-accent'
                            )}
                        >
                            {t('recurrence.monthlyOnDay')}
                        </button>
                        <button
                            type="button"
                            onClick={openCustomRecurrence}
                            className={cn(
                                'text-[10px] px-2 py-1 rounded border transition-colors',
                                monthlyRecurrence.pattern === 'custom'
                                    ? 'bg-primary text-primary-foreground border-primary'
                                    : 'bg-transparent text-muted-foreground border-border hover:bg-accent'
                            )}
                        >
                            {t('recurrence.custom')}
                        </button>
                    </div>
                </div>
            )}
            {editRecurrence === 'yearly' && (
                <div className="flex items-center gap-2 pt-1">
                    <span className="text-[10px] text-muted-foreground">{t('recurrence.repeatEvery')}</span>
                    <input
                        type="number"
                        min={1}
                        max={RECURRENCE_INTERVAL_MAX}
                        value={Math.max(parsedRecurrenceRRule.interval ?? 1, 1)}
                        onChange={(event) => {
                            const safeInterval = normalizeRecurrenceIntervalInput(Number(event.target.valueAsNumber));
                            onRecurrenceRRuleChange(buildRecurrenceRRule('yearly', {
                                byDay: undefined,
                                byMonthDay: undefined,
                                interval: safeInterval,
                            }));
                        }}
                        className="w-20 text-xs bg-muted/50 border border-border rounded px-2 py-1 text-foreground"
                    />
                    <span className="text-[10px] text-muted-foreground">{t('recurrence.yearUnit')}</span>
                </div>
            )}
            </>)}
        </div>
    );
}
