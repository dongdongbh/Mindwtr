import {
    forwardRef,
    useEffect,
    useMemo,
    useRef,
    useState,
    type FocusEvent,
    type InputHTMLAttributes,
    type KeyboardEvent,
} from 'react';
import { flushSync } from 'react-dom';
import { isImeComposing } from '../../lib/ime';
import {
    normalizeClockTimeInput,
    normalizeTimeFormatSetting,
    useTaskStore,
    type TimeFormatSetting,
} from '@mindwtr/core';

type ResolvedTimeInputFormat = Exclude<TimeFormatSetting, 'system'>;

function getDeviceLocale(): string {
    if (typeof navigator !== 'undefined') {
        const locale = String(navigator.languages?.[0] || navigator.language || '').trim();
        if (locale) return locale;
    }
    try {
        return Intl.DateTimeFormat().resolvedOptions().locale || 'en-US';
    } catch {
        return 'en-US';
    }
}

export function resolveTimeInputFormat(
    setting?: string | null,
    locale = getDeviceLocale(),
): ResolvedTimeInputFormat {
    const normalized = normalizeTimeFormatSetting(setting);
    if (normalized !== 'system') return normalized;
    try {
        const options = new Intl.DateTimeFormat(locale, { hour: 'numeric' }).resolvedOptions() as (
            Intl.ResolvedDateTimeFormatOptions & { hourCycle?: string }
        );
        if (options.hourCycle === 'h11' || options.hourCycle === 'h12') return '12h';
        if (options.hourCycle === 'h23' || options.hourCycle === 'h24') return '24h';
        return options.hour12 ? '12h' : '24h';
    } catch {
        return '24h';
    }
}

export function formatClockTimeForInput(
    value: string,
    format: ResolvedTimeInputFormat,
): string {
    const normalized = normalizeClockTimeInput(value);
    if (!normalized) return '';
    if (format === '24h') return normalized;

    const [hourText, minuteText] = normalized.split(':');
    const hour = Number(hourText);
    const meridiem = hour < 12 ? 'AM' : 'PM';
    const displayHour = hour % 12 || 12;
    return `${displayHour}:${minuteText} ${meridiem}`;
}

export function parseClockTimeDraft(
    value: string,
    format: ResolvedTimeInputFormat,
): string | null {
    const trimmed = value.trim();
    if (!trimmed) return '';
    if (format === '24h') return normalizeClockTimeInput(trimmed);

    const compact = trimmed.replace(/\./g, '').replace(/\s+/g, '');
    const match = compact.match(/^(\d{1,2})(?::?(\d{2}))?([ap])m$/i);
    // A canonical two-digit 24-hour value remains a useful paste/manual-entry
    // format in 12-hour display mode. A draft such as `1:59` stays incomplete
    // so adding `PM` does not briefly commit the wrong half of the day.
    if (!match) {
        if (!/^\d{2}:\d{2}$/.test(trimmed)) return null;
        return normalizeClockTimeInput(trimmed);
    }
    const hour = Number(match[1]);
    const minute = match[2] === undefined ? 0 : Number(match[2]);
    if (hour < 1 || hour > 12 || minute < 0 || minute > 59) return null;

    const isPm = match[3].toLowerCase() === 'p';
    const canonicalHour = (hour % 12) + (isPm ? 12 : 0);
    return `${String(canonicalHour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

type NativeInputProps = Omit<
    InputHTMLAttributes<HTMLInputElement>,
    'type' | 'value' | 'defaultValue' | 'onChange' | 'inputMode'
>;

export type TimeInputProps = NativeInputProps & {
    /** Canonical 24-hour value (`HH:mm`) or an explicit empty value. */
    value: string;
    /** Receives only a complete normalized `HH:mm` value or an explicit clear. */
    onChange: (value: string) => void;
    /** Defaults to the synced desktop preference. Primarily useful for isolated hosts/tests. */
    timeFormat?: string | null;
    /** Defaults to the device locale and controls only the `system` preference. */
    locale?: string;
};

/**
 * Deterministic desktop time entry. Native `type=time` controls may ignore the
 * requested hour cycle, so this keeps a text draft while exposing only
 * canonical `HH:mm` values to date, task, and notification state.
 */
export const TimeInput = forwardRef<HTMLInputElement, TimeInputProps>(function TimeInput({
    value,
    onChange,
    timeFormat,
    locale,
    onBlur,
    onFocus,
    onKeyDown,
    placeholder,
    autoComplete = 'off',
    ...inputProps
}, forwardedRef) {
    const storedTimeFormat = useTaskStore((state) => state.settings?.timeFormat);
    const resolvedFormat = useMemo(
        () => resolveTimeInputFormat(timeFormat ?? storedTimeFormat, locale ?? getDeviceLocale()),
        [locale, storedTimeFormat, timeFormat],
    );
    const [draft, setDraft] = useState(() => formatClockTimeForInput(value, resolvedFormat));
    const isFocusedRef = useRef(false);
    const lastEmittedValueRef = useRef<string | null>(null);
    const currentCanonicalRef = useRef(value);
    const previousFormatRef = useRef(resolvedFormat);
    const keyDownHandlerRef = useRef(onKeyDown);
    keyDownHandlerRef.current = onKeyDown;

    useEffect(() => {
        const formatChanged = previousFormatRef.current !== resolvedFormat;
        previousFormatRef.current = resolvedFormat;
        currentCanonicalRef.current = value;

        if (isFocusedRef.current && !formatChanged && lastEmittedValueRef.current === value) {
            lastEmittedValueRef.current = null;
            return;
        }

        lastEmittedValueRef.current = null;
        setDraft(formatClockTimeForInput(value, resolvedFormat));
    }, [resolvedFormat, value]);

    const emitCanonical = (nextValue: string) => {
        if (nextValue === currentCanonicalRef.current) return;
        currentCanonicalRef.current = nextValue;
        lastEmittedValueRef.current = nextValue;
        onChange(nextValue);
    };

    const handleChange = (nextDraft: string) => {
        setDraft(nextDraft);
        const parsed = parseClockTimeDraft(nextDraft, resolvedFormat);
        // An empty draft may be the first keystroke of a replacement. Commit
        // an intentional clear only when the user leaves or submits the field.
        if (parsed !== null && parsed !== '') emitCanonical(parsed);
    };

    const resetToExternalValue = () => {
        lastEmittedValueRef.current = null;
        currentCanonicalRef.current = value;
        setDraft(formatClockTimeForInput(value, resolvedFormat));
    };

    const handleBlur = (event: FocusEvent<HTMLInputElement>) => {
        isFocusedRef.current = false;
        const parsed = parseClockTimeDraft(draft, resolvedFormat);
        if (parsed === null) {
            resetToExternalValue();
        } else {
            emitCanonical(parsed);
            setDraft(formatClockTimeForInput(parsed, resolvedFormat));
        }
        onBlur?.(event);
    };

    const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (isImeComposing(event)) return;
        if (event.key === 'Enter') {
            const parsed = parseClockTimeDraft(draft, resolvedFormat);
            if (parsed === null) {
                event.preventDefault();
                event.stopPropagation();
                return;
            }
            // Enter may submit through a consumer key handler in this event.
            // Flush a deferred clear before reading its latest callback.
            if (parsed !== currentCanonicalRef.current) {
                flushSync(() => emitCanonical(parsed));
            }
        }
        if (event.key === 'Escape') {
            const externalDisplay = formatClockTimeForInput(value, resolvedFormat);
            if (draft !== externalDisplay) {
                event.preventDefault();
                event.stopPropagation();
                resetToExternalValue();
                return;
            }
        }
        keyDownHandlerRef.current?.(event);
    };

    return (
        <input
            {...inputProps}
            ref={forwardedRef}
            type="text"
            value={draft}
            placeholder={placeholder ?? (resolvedFormat === '12h' ? 'h:mm AM' : 'HH:mm')}
            autoComplete={autoComplete}
            onChange={(event) => handleChange(event.target.value)}
            onFocus={(event) => {
                isFocusedRef.current = true;
                onFocus?.(event);
            }}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
        />
    );
});
