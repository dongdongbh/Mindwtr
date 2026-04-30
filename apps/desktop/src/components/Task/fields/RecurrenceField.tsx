import { buildRRuleString, parseRRuleString, type RecurrenceByDay, type RecurrenceRule, type RecurrenceStrategy } from '@mindwtr/core';

import { cn } from '../../../lib/utils';
import { WeekdaySelector } from '../TaskForm/WeekdaySelector';
import type { MonthlyRecurrenceInfo } from '../TaskItemFieldRenderer';

type RecurrenceFieldProps = {
    t: (key: string) => string;
    editRecurrence: RecurrenceRule | '';
    editRecurrenceStrategy: RecurrenceStrategy;
    editRecurrenceRRule: string;
    monthlyRecurrence: MonthlyRecurrenceInfo;
    parsedRecurrenceRRule: ReturnType<typeof parseRRuleString>;
    recurrenceEndMode: 'never' | 'until' | 'count';
    recurrenceDefaultEndDate: string;
    onRecurrenceChange: (value: RecurrenceRule | '') => void;
    onRecurrenceStrategyChange: (value: RecurrenceStrategy) => void;
    onRecurrenceRRuleChange: (value: string) => void;
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

export function RecurrenceField({
    t,
    editRecurrence,
    editRecurrenceStrategy,
    editRecurrenceRRule,
    monthlyRecurrence,
    parsedRecurrenceRRule,
    recurrenceEndMode,
    recurrenceDefaultEndDate,
    onRecurrenceChange,
    onRecurrenceStrategyChange,
    onRecurrenceRRuleChange,
    openCustomRecurrence,
    buildRecurrenceRRule,
}: RecurrenceFieldProps) {
    return (
        <div className="flex flex-col gap-1 w-full">
            <label className="text-xs text-muted-foreground font-medium">{t('taskEdit.recurrenceLabel')}</label>
            <select
                value={editRecurrence}
                aria-label={t('task.aria.recurrence')}
                onChange={(e) => {
                    const value = e.target.value as RecurrenceRule | '';
                    onRecurrenceChange(value);
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
                        max={365}
                        value={Math.max(parsedRecurrenceRRule.interval ?? 1, 1)}
                        onChange={(event) => {
                            const intervalValue = Number(event.target.valueAsNumber);
                            const safeInterval = Number.isFinite(intervalValue) && intervalValue > 0
                                ? Math.min(Math.round(intervalValue), 365)
                                : 1;
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
            {editRecurrence === 'weekly' && (
                <div className="pt-1 space-y-2">
                    <div className="flex items-center gap-2">
                        <span className="text-[10px] text-muted-foreground">{t('recurrence.repeatEvery')}</span>
                        <input
                            type="number"
                            min={1}
                            max={52}
                            value={Math.max(parsedRecurrenceRRule.interval ?? 1, 1)}
                            onChange={(event) => {
                                const intervalValue = Number(event.target.valueAsNumber);
                                const safeInterval = Number.isFinite(intervalValue) && intervalValue > 0
                                    ? Math.min(Math.round(intervalValue), 52)
                                    : 1;
                                onRecurrenceRRuleChange(buildRecurrenceRRule('weekly', {
                                    byDay: parsedRecurrenceRRule.byDay,
                                    byMonthDay: undefined,
                                    interval: safeInterval,
                                }));
                            }}
                            className="w-20 text-xs bg-muted/50 border border-border rounded px-2 py-1 text-foreground"
                        />
                        <span className="text-[10px] text-muted-foreground">{t('recurrence.weekUnit')}</span>
                    </div>
                    <div>
                        <span className="text-[10px] text-muted-foreground">{t('recurrence.repeatOn')}</span>
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
                            className="pt-1"
                        />
                    </div>
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
                        <input
                            type="date"
                            value={parsedRecurrenceRRule.until || recurrenceDefaultEndDate}
                            onChange={(event) => {
                                onRecurrenceRRuleChange(buildRecurrenceRRule(editRecurrence, {
                                    count: undefined,
                                    until: event.target.value || recurrenceDefaultEndDate,
                                }));
                            }}
                            className="text-xs bg-muted/50 border border-border rounded px-2 py-1 text-foreground"
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
                            max={120}
                            value={Math.max(parsedRecurrenceRRule.interval ?? 1, 1)}
                            onChange={(event) => {
                                const intervalValue = Number(event.target.valueAsNumber);
                                const safeInterval = Number.isFinite(intervalValue) && intervalValue > 0
                                    ? Math.min(Math.round(intervalValue), 120)
                                    : 1;
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
        </div>
    );
}
