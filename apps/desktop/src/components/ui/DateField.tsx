import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { CalendarDays, CalendarX, ChevronLeft, ChevronRight, type LucideIcon } from 'lucide-react';
import {
    addCalendarMonths,
    formatCalendarInputDate,
    getCalendarDayOfMonth,
    getCalendarMonthIndex,
    getQuickDate,
    getShortWeekdayLabels,
    isJalaliCalendarLocale,
    isQuickDatePresetSelected,
    QUICK_DATE_PRESETS_EXTENDED,
    normalizeDateFormatSetting,
    parseCalendarInputDate,
    safeFormatDate,
    safeParseDate,
    startOfCalendarMonth,
    tFallback,
    type QuickDatePreset,
} from '@mindwtr/core';

import { cn } from '../../lib/utils';
import { usePointerPress } from '../../hooks/usePointerPress';
import { QuickAddTokenBadge, TaskEditorFieldLabel } from '../Task/task-editor-label';
import { normalizeDateInputValue } from '../Task/task-item-helpers';
import { QUICK_DATE_LABELS } from '../QuickDateChips';

const DATE_INPUT_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DATE_POPOVER_WIDTH = 418;
const DATE_POPOVER_APPROX_HEIGHT = 340;
const DATE_POPOVER_MARGIN = 8;

type DateInputOrder = 'dmy' | 'mdy' | 'ymd';

function parseDateInputDate(value: string): Date | null {
    if (!DATE_INPUT_PATTERN.test(value)) return safeParseDate(value);
    const [year, month, day] = value.split('-').map(Number);
    if (!year || !month || !day) return null;
    const parsed = new Date(year, month - 1, day);
    if (
        parsed.getFullYear() !== year
        || parsed.getMonth() !== month - 1
        || parsed.getDate() !== day
    ) {
        return null;
    }
    return parsed;
}

/**
 * A year-less entry ("1/1") means the next occurrence of that day and month:
 * this year while it is still ahead, next year once it has passed (#1050).
 */
function resolveYearlessDate(month: string, day: string): string | null {
    if (month.length > 2 || day.length > 2) return null;
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    for (const year of [now.getFullYear(), now.getFullYear() + 1]) {
        const candidate = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
        const parsed = parseDateInputDate(candidate);
        if (parsed && parsed >= today) return candidate;
    }
    return null;
}

function getCalendarLocale(locale: string): string | undefined {
    const normalized = locale.trim();
    if (!normalized) return undefined;
    return normalized.split('-u-')[0] || normalized;
}

function getWeekStartIndex(locale: string): number {
    const normalized = locale.toLowerCase();
    if (normalized.includes('fw-mon')) return 1;
    if (normalized.includes('fw-sat')) return 6;
    return 0;
}

function getCalendarGridDays(monthDate: Date, weekStartIndex: number, calendarSystem: string): Date[] {
    const firstOfMonth = startOfCalendarMonth(monthDate, calendarSystem);
    const offset = (firstOfMonth.getDay() - weekStartIndex + 7) % 7;
    const start = new Date(firstOfMonth.getFullYear(), firstOfMonth.getMonth(), 1 - offset);
    return Array.from({ length: 42 }, (_, index) =>
        new Date(start.getFullYear(), start.getMonth(), start.getDate() + index)
    );
}

function getWeekdayLabels(locale: string, weekStartIndex: number): string[] {
    const labels = getShortWeekdayLabels(getCalendarLocale(locale));
    return Array.from({ length: 7 }, (_, index) => labels[(weekStartIndex + index) % 7]);
}

function getDateInputOrder(dateFormatSetting: string | null | undefined, locale: string): DateInputOrder {
    const dateFormat = normalizeDateFormatSetting(dateFormatSetting);
    if (dateFormat === 'dmy') return 'dmy';
    if (dateFormat === 'mdy') return 'mdy';
    if (dateFormat === 'ymd') return 'ymd';

    const formatter = new Intl.DateTimeFormat(getCalendarLocale(locale), {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    });
    const order = formatter
        .formatToParts(new Date(2026, 10, 22))
        .filter((part) => part.type === 'year' || part.type === 'month' || part.type === 'day')
        .map((part) => part.type[0])
        .join('');
    if (order === 'dmy' || order === 'mdy' || order === 'ymd') return order;
    return 'mdy';
}

function getDateInputPlaceholder(order: DateInputOrder): string {
    if (order === 'dmy') return 'DD/MM/YYYY';
    if (order === 'mdy') return 'MM/DD/YYYY';
    return 'YYYY-MM-DD';
}

function formatDateInputDisplay(value: string, order: DateInputOrder, calendarSystem: string): string {
    if (!value) return '';
    if (calendarSystem === 'jalali') {
        return formatCalendarInputDate(value, calendarSystem);
    }
    const parsed = parseDateInputDate(value);
    if (!parsed) return value;

    const year = String(parsed.getFullYear()).padStart(4, '0');
    const month = String(parsed.getMonth() + 1).padStart(2, '0');
    const day = String(parsed.getDate()).padStart(2, '0');
    if (order === 'dmy') return `${day}/${month}/${year}`;
    if (order === 'mdy') return `${month}/${day}/${year}`;
    return `${year}-${month}-${day}`;
}

/**
 * `lenient` additionally accepts year-less ("1/1") and 2-digit-year ("1/1/27")
 * entry. Those forms only resolve when the user leaves the field: completing
 * them on every keystroke committed a date mid-typing, which rewrote the text
 * under the user and made "1/1/27" impossible to type (#1050).
 */
function parseDateInputDisplay(
    value: string,
    order: DateInputOrder,
    calendarSystem: string,
    lenient = false,
): string | null {
    const trimmed = value.trim();
    if (!trimmed) return '';

    if (calendarSystem === 'jalali') {
        if (DATE_INPUT_PATTERN.test(trimmed)) {
            return parseCalendarInputDate(trimmed, calendarSystem);
        }
        const parts = trimmed.match(/\d{1,4}/g);
        if (!parts || parts.length !== 3 || parts[0].length !== 4) return null;
        const [year, month, day] = parts;
        return parseCalendarInputDate(
            `${year.padStart(4, '0')}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`,
            calendarSystem
        );
    }

    if (DATE_INPUT_PATTERN.test(trimmed)) {
        const normalized = normalizeDateInputValue(trimmed);
        return parseDateInputDate(normalized) ? normalized : null;
    }

    const parts = trimmed.match(/\d{1,4}/g);
    if (!parts) return null;
    if (parts.length === 2 && lenient) {
        // ymd has no year to lead with here, so its two-part form reads month/day.
        return order === 'dmy'
            ? resolveYearlessDate(parts[1], parts[0])
            : resolveYearlessDate(parts[0], parts[1]);
    }
    if (parts.length !== 3) return null;

    let year: string;
    let month: string;
    let day: string;
    if (parts[0].length === 4) {
        [year, month, day] = parts;
    } else if (order === 'dmy') {
        [day, month, year] = parts;
    } else if (order === 'mdy') {
        [month, day, year] = parts;
    } else {
        [year, month, day] = parts;
    }

    // A 2-digit year is read as the 2000s: "1/1/27" is 2027 (#1050).
    if (year.length === 2 && lenient) year = String(2000 + Number(year));
    if (year.length !== 4) return null;
    const normalized = normalizeDateInputValue(
        `${year.padStart(4, '0')}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
    );
    return parseDateInputDate(normalized) ? normalized : null;
}

type DateFieldProps = {
    t: (key: string) => string;
    /** Rendered above the input. Omit when the host already labels the field. */
    label?: string;
    /** Leading icon for the rendered label, per the shared editor vocabulary. */
    labelIcon?: LucideIcon;
    labelToken?: string;
    dateAriaLabel: string;
    dateValue: string;
    selectedDate: Date | null;
    dateFormatSetting?: string | null;
    nativeDateInputLocale: string;
    dateInputClassName: string;
    timeInput?: ReactNode;
    onDateChange: (value: string) => void;
    /** Omit where the value cannot be emptied: no clear button, and typing the
     *  field empty reverts on blur instead of committing a clear. */
    onClear?: () => void;
    onDateOnly?: () => void;
    hasValue?: boolean;
    /** Focus the date input on mount, for hosts that open with this field ready. */
    autoFocus?: boolean;
    /** Merged onto the root; hosts widen past the editor's 22rem cap with it. */
    className?: string;
};

/**
 * The one desktop date input: locale-ordered display, Jalali calendar support,
 * and a positioned calendar popover with quick-date suggestions. Every
 * user-facing date on desktop goes through this so a Jalali user never meets a
 * Gregorian control halfway through a flow.
 */
export function DateField({
    t,
    label,
    labelIcon,
    labelToken,
    dateAriaLabel,
    dateValue,
    selectedDate,
    dateFormatSetting,
    nativeDateInputLocale,
    dateInputClassName,
    timeInput,
    onDateChange,
    onClear,
    onDateOnly,
    hasValue,
    autoFocus,
    className,
}: DateFieldProps) {
    const rootRef = useRef<HTMLDivElement | null>(null);
    const inputRef = useRef<HTMLInputElement | null>(null);
    const calendarRef = useRef<HTMLDivElement | null>(null);
    const { runAfterPointerRelease } = usePointerPress();
    const [isCalendarOpen, setIsCalendarOpen] = useState(false);
    const [calendarPosition, setCalendarPosition] = useState({ top: 0, left: 0 });
    const calendarSystem = isJalaliCalendarLocale(nativeDateInputLocale) ? 'jalali' : 'gregorian';
    const [calendarMonth, setCalendarMonth] = useState(() =>
        startOfCalendarMonth(selectedDate ?? parseDateInputDate(dateValue) ?? new Date(), calendarSystem)
    );
    const accessibleName = label ?? dateAriaLabel;
    const clearText = tFallback(t, 'common.clear', 'Clear');
    const dateOnlyText = t('taskEdit.dateOnly');
    const calendarText = t('nav.calendar');
    const previousMonthText = t('calendar.prevMonth');
    const nextMonthText = t('calendar.nextMonth');
    const calendarAriaLabel = `${accessibleName} ${calendarText}`;
    const previousMonthAriaLabel = `${calendarText}: ${previousMonthText}`;
    const nextMonthAriaLabel = `${calendarText}: ${nextMonthText}`;
    const dateInputOrder = calendarSystem === 'jalali'
        ? 'ymd'
        : getDateInputOrder(dateFormatSetting, nativeDateInputLocale);
    const [draftDateValue, setDraftDateValue] = useState(() => (
        formatDateInputDisplay(dateValue, dateInputOrder, calendarSystem)
    ));
    const [announceDraftInvalid, setAnnounceDraftInvalid] = useState(false);
    const weekStartIndex = getWeekStartIndex(nativeDateInputLocale);
    const calendarLocale = getCalendarLocale(nativeDateInputLocale);
    const monthLabel = new Intl.DateTimeFormat(calendarLocale, { month: 'long', year: 'numeric' }).format(calendarMonth);
    const fullDateFormatter = new Intl.DateTimeFormat(calendarLocale, {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
    });
    const weekdayLabels = getWeekdayLabels(nativeDateInputLocale, weekStartIndex);
    const days = getCalendarGridDays(calendarMonth, weekStartIndex, calendarSystem);
    const now = new Date();
    const todayValue = safeFormatDate(now, 'yyyy-MM-dd');

    const updateCalendarPosition = useCallback(() => {
        const anchor = inputRef.current?.parentElement ?? inputRef.current;
        if (!anchor) return;
        const rect = anchor.getBoundingClientRect();
        const maxLeft = Math.max(DATE_POPOVER_MARGIN, window.innerWidth - DATE_POPOVER_WIDTH - DATE_POPOVER_MARGIN);
        const left = Math.min(Math.max(rect.left, DATE_POPOVER_MARGIN), maxLeft);
        const wouldOverflowBottom = rect.bottom + DATE_POPOVER_APPROX_HEIGHT + DATE_POPOVER_MARGIN > window.innerHeight;
        const top = wouldOverflowBottom
            ? Math.max(DATE_POPOVER_MARGIN, rect.top - DATE_POPOVER_APPROX_HEIGHT - 4)
            : rect.bottom + 4;
        setCalendarPosition({ top, left });
    }, []);
    const openCalendar = useCallback(() => {
        updateCalendarPosition();
        setIsCalendarOpen(true);
    }, [updateCalendarPosition]);

    const resetFieldState = useCallback(() => {
        setIsCalendarOpen(false);
        setAnnounceDraftInvalid(false);
        setDraftDateValue(formatDateInputDisplay(dateValue, dateInputOrder, calendarSystem));
    }, [calendarSystem, dateInputOrder, dateValue]);

    /** Leaving the field completes lenient-only forms ("1/1", "1/1/27"); an
     *  unparseable draft still reverts to the saved value. */
    const commitOrResetFieldState = useCallback(() => {
        const parsed = parseDateInputDisplay(draftDateValue, dateInputOrder, calendarSystem, true);
        if (parsed && parsed !== dateValue) {
            setIsCalendarOpen(false);
            setAnnounceDraftInvalid(false);
            onDateChange(parsed);
            return;
        }
        resetFieldState();
    }, [calendarSystem, dateInputOrder, dateValue, draftDateValue, onDateChange, resetFieldState]);

    useEffect(() => {
        setDraftDateValue(formatDateInputDisplay(dateValue, dateInputOrder, calendarSystem));
    }, [calendarSystem, dateInputOrder, dateValue]);

    useEffect(() => {
        if (!isCalendarOpen) return;
        const nextDate = selectedDate ?? parseDateInputDate(dateValue) ?? new Date();
        setCalendarMonth(startOfCalendarMonth(nextDate, calendarSystem));
    }, [calendarSystem, dateValue, isCalendarOpen, selectedDate]);

    useEffect(() => {
        if (!isCalendarOpen) return;
        updateCalendarPosition();

        const handlePointerDown = (event: MouseEvent | PointerEvent | TouchEvent) => {
            const target = event.target;
            if (target instanceof Node && rootRef.current?.contains(target)) return;
            commitOrResetFieldState();
        };
        const handleKeyDown = (event: globalThis.KeyboardEvent) => {
            if (event.key === 'Escape') {
                setIsCalendarOpen(false);
            }
        };
        const handleViewportChange = () => updateCalendarPosition();

        document.addEventListener('pointerdown', handlePointerDown, true);
        document.addEventListener('mousedown', handlePointerDown, true);
        document.addEventListener('touchstart', handlePointerDown, true);
        document.addEventListener('keydown', handleKeyDown);
        window.addEventListener('resize', handleViewportChange);
        window.addEventListener('scroll', handleViewportChange, true);
        return () => {
            document.removeEventListener('pointerdown', handlePointerDown, true);
            document.removeEventListener('mousedown', handlePointerDown, true);
            document.removeEventListener('touchstart', handlePointerDown, true);
            document.removeEventListener('keydown', handleKeyDown);
            window.removeEventListener('resize', handleViewportChange);
            window.removeEventListener('scroll', handleViewportChange, true);
        };
    }, [isCalendarOpen, commitOrResetFieldState, updateCalendarPosition]);

    const handleDateInputChange = (value: string) => {
        setDraftDateValue(value);
        setAnnounceDraftInvalid(false);
        const parsed = parseDateInputDisplay(value, dateInputOrder, calendarSystem);
        if (parsed === null) return;
        if (!parsed) {
            onClear?.();
            return;
        }
        onDateChange(parsed);
    };
    // Unparseable text never commits (blur reverts to the saved value), but
    // without a signal it looked accepted while typed (#1050).
    const isDraftInvalid = draftDateValue.trim() !== ''
        && parseDateInputDisplay(draftDateValue, dateInputOrder, calendarSystem, true) === null;
    // The border turns while typing, but `aria-invalid` only after the field is
    // left: a half-typed date is invalid on nearly every keystroke, and flipping
    // the attribute each time makes a screen reader call the field invalid before
    // the user has finished entering a date that will parse fine.
    const announceInvalid = isDraftInvalid && announceDraftInvalid;
    const applyCalendarDate = (date: Date) => {
        const nextDateValue = safeFormatDate(date, 'yyyy-MM-dd');
        setDraftDateValue(formatDateInputDisplay(nextDateValue, dateInputOrder, calendarSystem));
        onDateChange(nextDateValue);
        setIsCalendarOpen(false);
    };
    const applyQuickDatePreset = (preset: QuickDatePreset) => {
        const date = getQuickDate(preset, new Date());
        if (!date) {
            setDraftDateValue('');
            onClear?.();
            setIsCalendarOpen(false);
            return;
        }
        applyCalendarDate(date);
    };

    return (
        <div
            className={cn('relative flex w-full max-w-[min(22rem,100%)] flex-col gap-1', className)}
            ref={rootRef}
            onBlurCapture={() => {
                runAfterPointerRelease(() => {
                    const activeElement = document.activeElement;
                    if (activeElement instanceof Node && rootRef.current?.contains(activeElement)) return;
                    commitOrResetFieldState();
                });
            }}
        >
            {label ? (
                <TaskEditorFieldLabel icon={labelIcon}>
                    {label}
                    {labelToken && <QuickAddTokenBadge t={t} token={labelToken} />}
                </TaskEditorFieldLabel>
            ) : null}
            <div className="flex w-full items-center gap-2">
                <div className="relative min-w-0 flex-1">
                    <input
                        ref={inputRef}
                        autoFocus={autoFocus}
                        type="text"
                        inputMode="numeric"
                        placeholder={getDateInputPlaceholder(dateInputOrder)}
                        lang={nativeDateInputLocale}
                        aria-label={dateAriaLabel}
                        aria-haspopup="dialog"
                        aria-expanded={isCalendarOpen}
                        value={draftDateValue}
                        aria-invalid={announceInvalid || undefined}
                        onChange={(event) => handleDateInputChange(event.target.value)}
                        onBlur={() => setAnnounceDraftInvalid(true)}
                        // The calendar icon is a small target, so the whole field opens the
                        // popover (#896). openCalendar only positions and shows it — it never
                        // moves focus — so the caret stays where it was clicked and the date
                        // can still be typed straight over it.
                        onClick={openCalendar}
                        onKeyDown={(event) => {
                            if (event.key === 'Escape') {
                                setIsCalendarOpen(false);
                                event.stopPropagation();
                            } else if (event.key === 'ArrowDown') {
                                openCalendar();
                                event.preventDefault();
                            }
                        }}
                        className={cn(
                            `${dateInputClassName} w-full pr-8`,
                            isDraftInvalid && 'border-warning ring-1 ring-inset ring-warning/50',
                        )}
                    />
                    <button
                        type="button"
                        aria-label={calendarAriaLabel}
                        aria-haspopup="dialog"
                        aria-expanded={isCalendarOpen}
                        onClick={openCalendar}
                        className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                        <CalendarDays className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                </div>
                {timeInput}
                {onDateOnly ? (
                    <button
                        type="button"
                        onClick={onDateOnly}
                        className="shrink-0 whitespace-nowrap rounded px-1.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        aria-label={`${dateOnlyText}: ${accessibleName}`}
                    >
                        {dateOnlyText}
                    </button>
                ) : null}
                {!onClear ? null : hasValue ? (
                    <button
                        type="button"
                        onClick={() => {
                            setDraftDateValue('');
                            onClear();
                            setIsCalendarOpen(false);
                        }}
                        className="shrink-0 rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        aria-label={`${clearText} ${accessibleName}`}
                        title={`${clearText} ${accessibleName}`}
                    >
                        <CalendarX className="h-4 w-4" aria-hidden="true" />
                    </button>
                ) : (
                    <span aria-hidden="true" className="h-7 w-7 shrink-0" />
                )}
            </div>
            {isCalendarOpen && (
                <div
                    ref={calendarRef}
                    role="dialog"
                    aria-label={calendarAriaLabel}
                    className="fixed z-50 flex rounded-lg border border-border bg-popover text-popover-foreground shadow-lg"
                    style={{ top: calendarPosition.top, left: calendarPosition.left }}
                >
                    <div className="w-72 p-3">
                        <div className="mb-2 flex items-center justify-between gap-2">
                            <button
                                type="button"
                                aria-label={previousMonthAriaLabel}
                                onClick={() => setCalendarMonth((current) => addCalendarMonths(current, -1, calendarSystem))}
                                className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                            >
                                <ChevronLeft className="h-4 w-4" />
                            </button>
                            <div className="min-w-0 flex-1 text-center text-sm font-medium text-foreground">
                                {monthLabel}
                            </div>
                            <button
                                type="button"
                                aria-label={nextMonthAriaLabel}
                                onClick={() => setCalendarMonth((current) => addCalendarMonths(current, 1, calendarSystem))}
                                className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                            >
                                <ChevronRight className="h-4 w-4" />
                            </button>
                        </div>
                        <div className="grid grid-cols-7 gap-1 text-center text-[11px] font-medium text-muted-foreground">
                            {weekdayLabels.map((weekday, index) => (
                                <div key={`${weekday}-${index}`} className="py-1">
                                    {weekday}
                                </div>
                            ))}
                        </div>
                        <div className="mt-1 grid grid-cols-7 gap-1">
                            {days.map((day) => {
                                const value = safeFormatDate(day, 'yyyy-MM-dd');
                                const isSelected = value === dateValue;
                                const isToday = value === todayValue;
                                const isOutsideMonth = getCalendarMonthIndex(day, calendarSystem) !== getCalendarMonthIndex(calendarMonth, calendarSystem);
                                return (
                                    <button
                                        key={value}
                                        type="button"
                                        aria-label={fullDateFormatter.format(day)}
                                        aria-pressed={isSelected}
                                        onMouseDown={(event) => event.preventDefault()}
                                        onClick={() => applyCalendarDate(day)}
                                        className={[
                                            'h-8 rounded text-xs transition-colors',
                                            isSelected
                                                ? 'bg-primary text-primary-foreground'
                                                : isToday
                                                    ? 'border border-primary/60 text-primary hover:bg-primary/10'
                                                    : 'text-foreground hover:bg-muted',
                                            isOutsideMonth && !isSelected ? 'text-muted-foreground/50' : '',
                                        ].filter(Boolean).join(' ')}
                                    >
                                        {getCalendarDayOfMonth(day, calendarSystem)}
                                    </button>
                                );
                            })}
                        </div>
                    </div>
                    <div className="flex w-32 shrink-0 flex-col gap-0.5 border-l border-border p-2">
                        {QUICK_DATE_PRESETS_EXTENDED.map((preset) => {
                            const labelConfig = QUICK_DATE_LABELS[preset];
                            const suggestionLabel = tFallback(t, labelConfig.key, labelConfig.fallback);
                            const active = isQuickDatePresetSelected(preset, selectedDate, now);
                            return (
                                <button
                                    key={preset}
                                    type="button"
                                    aria-pressed={active}
                                    onMouseDown={(event) => event.preventDefault()}
                                    onClick={() => applyQuickDatePreset(preset)}
                                    className={[
                                        'rounded px-2 py-1.5 text-left text-xs transition-colors',
                                        active
                                            ? 'bg-primary text-primary-foreground'
                                            : 'text-foreground hover:bg-muted',
                                    ].filter(Boolean).join(' ')}
                                >
                                    {suggestionLabel}
                                </button>
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
}
