import { useEffect, useId, useMemo, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { normalizeTimeSpentMinutes, tFallback } from '@mindwtr/core';
import { useLanguage } from '../contexts/language-context';
import { useNativeDateInputLocale } from '../hooks/use-native-date-input-locale';
import { isImeComposing } from '../lib/ime';
import {
    joinDateTimeLocal,
    parseDateTimeLocalDate,
    splitDateTimeLocal,
} from '../lib/datetime-local-value';
import { DateField } from './ui/DateField';
import { TimeInput } from './ui/TimeInput';
import { AutocompleteTextInput } from './ui/AutocompleteTextInput';
import { Button } from './ui/Button';
import { Dialog, DialogBody, DialogHeader } from './ui/Dialog';

interface PromptModalNumericField {
    label: string;
    defaultValue?: string;
    placeholder?: string;
}

interface PromptModalProps {
    isOpen: boolean;
    title: string;
    description?: string;
    errorMessage?: string;
    busy?: boolean;
    placeholder?: string;
    defaultValue?: string;
    suggestions?: readonly string[];
    createLabel?: string;
    onCreate?: (value: string) => void | Promise<void>;


    inputType?: 'text' | 'datetime-local';
    multiline?: boolean;
    allowEmptyConfirm?: boolean;

    validate?: (value: string) => string | null;
    browseLabel?: string;
    onBrowse?: () => Promise<string | null>;
    secondaryLabel?: string;
    onSecondary?: (value: string) => void;

    numericField?: PromptModalNumericField;
    confirmLabel: string;
    cancelLabel: string;
    onConfirm: (value: string, numericValue?: number) => void;
    onCancel: () => void;
}

export function PromptModal({
    isOpen,
    title,
    description,
    errorMessage,
    busy = false,
    placeholder,
    defaultValue,
    suggestions,
    createLabel,
    onCreate,
    inputType = 'text',
    multiline = false,
    allowEmptyConfirm = false,
    validate,
    browseLabel,
    onBrowse,
    secondaryLabel,
    onSecondary,
    numericField,
    confirmLabel,
    cancelLabel,
    onConfirm,
    onCancel,
}: PromptModalProps) {
    const { t } = useLanguage();
    const { nativeDateInputLocale, dateFormatSetting } = useNativeDateInputLocale();
    const [value, setValue] = useState(defaultValue ?? '');
    const [hasInteracted, setHasInteracted] = useState(false);
    const [numericDraft, setNumericDraft] = useState(numericField?.defaultValue ?? '');
    const titleId = useId();
    const descriptionId = useId();
    const validationId = useId();
    const numericFieldId = useId();

    useEffect(() => {
        if (isOpen) {
            setValue(defaultValue ?? '');
            setHasInteracted(false);
            setNumericDraft(numericField?.defaultValue ?? '');
        }
    }, [isOpen, defaultValue, numericField?.defaultValue]);
    const dateParts = useMemo(() => splitDateTimeLocal(value), [value]);
    const hasValue = allowEmptyConfirm || value.trim().length > 0;
    const refusal = hasValue ? validate?.(value) ?? null : null;
    const canConfirm = hasValue && !refusal;
    const showValidation = !allowEmptyConfirm && hasInteracted && !hasValue;


    const confirmWithValue = () => {
        if (numericField) {
            onConfirm(value, normalizeTimeSpentMinutes(Number(numericDraft)));
        } else {
            onConfirm(value);
        }
    };


    const handleFieldKeyDown = (event: KeyboardEvent<HTMLElement>) => {
        if (event.defaultPrevented || isImeComposing(event)) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
            return;
        }
        if (event.key !== 'Enter') return;
        if (multiline && event.currentTarget instanceof HTMLTextAreaElement) return;
        event.preventDefault();
        if (canConfirm) {
            confirmWithValue();
        } else {
            setHasInteracted(true);
        }
    };

    if (!isOpen) return null;


    const keepInputFocus = (event: MouseEvent<HTMLButtonElement>) => event.preventDefault();

    return (
        <Dialog
            onClose={onCancel}
            labelledBy={titleId}
            describedBy={description ? descriptionId : undefined}
            placement="top"
            overlayClassName="pt-[20vh]"


            panelClassName="max-h-[70vh]"
        >
            <DialogHeader className="px-4 py-3 border-b">
                <h3 id={titleId} className="font-semibold">{title}</h3>
                {description && (
                    <p id={descriptionId} className="text-xs text-muted-foreground mt-1">
                        {description}
                    </p>
                )}
            </DialogHeader>
            <DialogBody className="p-4 space-y-3">
                {inputType === 'datetime-local' ? (


                    <div onKeyDown={handleFieldKeyDown}>
                    <DateField
                        autoFocus
                        t={t}


                        label={tFallback(t, 'calendar.date', 'Date')}
                        dateAriaLabel={tFallback(t, 'calendar.date', 'Date')}
                        dateValue={dateParts.date}
                        selectedDate={parseDateTimeLocalDate(value)}
                        dateFormatSetting={dateFormatSetting}
                        nativeDateInputLocale={nativeDateInputLocale}
                        dateInputClassName="min-w-0 flex-1 rounded-lg border border-border bg-card px-3 py-2 text-sm shadow-sm transition-colors focus:border-transparent focus:ring-2 focus:ring-primary"
                        hasValue={false}
                        onClear={() => undefined}
                        onDateChange={(nextDate) => {
                            setHasInteracted(true);
                            setValue(joinDateTimeLocal({ date: nextDate, time: dateParts.time }));
                        }}
                        timeInput={(
                            <TimeInput
                                lang={nativeDateInputLocale}
                                aria-label={tFallback(t, 'calendar.time', 'Time')}
                                value={dateParts.time}
                                onKeyDown={handleFieldKeyDown}
                                onChange={(time) => {
                                    setHasInteracted(true);
                                    setValue(joinDateTimeLocal({
                                        date: dateParts.date,
                                        time,
                                    }));
                                }}
                                className="w-28 shrink-0 rounded-lg border border-border bg-card px-2 py-2 text-sm shadow-sm transition-colors focus:border-transparent focus:ring-2 focus:ring-primary"
                            />
                        )}
                    />
                    </div>
                ) : multiline ? (
                    <textarea
                        autoFocus
                        value={value}
                        onChange={(event) => {
                            setValue(event.target.value);
                            setHasInteracted(true);
                        }}
                        onBlur={() => setHasInteracted(true)}
                        onKeyDown={handleFieldKeyDown}
                        placeholder={placeholder}
                        aria-label={title}
                        aria-invalid={showValidation || Boolean(refusal)}
                        aria-describedby={showValidation || refusal ? validationId : description ? descriptionId : undefined}
                        rows={4}
                        className="w-full resize-y rounded-lg border border-border bg-card px-3 py-2 shadow-sm transition-colors focus:border-transparent focus:ring-2 focus:ring-primary"
                    />
                ) : (
                    <AutocompleteTextInput
                        autoFocus
                        type={inputType}
                        value={value}
                        suggestions={suggestions ?? []}
                        createLabel={createLabel}
                        onCreate={onCreate}
                        onChange={(next) => {
                            setValue(next);
                            if (!hasInteracted) {
                                setHasInteracted(true);
                            }
                        }}
                        onBlur={() => setHasInteracted(true)}
                        onKeyDown={handleFieldKeyDown}
                        placeholder={placeholder}
                        aria-invalid={showValidation || Boolean(refusal)}
                        aria-describedby={showValidation || refusal ? validationId : undefined}
                        className="w-full rounded-lg border border-border bg-card px-3 py-2 shadow-sm transition-colors focus:border-transparent focus:ring-2 focus:ring-primary"
                    />
                )}
                {showValidation && (
                    <p id={validationId} className="text-xs text-destructive">
                        {t('common.validationRequired')}
                    </p>
                )}
                {refusal && (
                    <p id={validationId} role="alert" className="text-xs text-destructive">{refusal}</p>
                )}
                {errorMessage && (
                    <p role="alert" className="text-xs text-destructive">{errorMessage}</p>
                )}
                {numericField && (
                    <div className="flex flex-col gap-1">
                        <label htmlFor={numericFieldId} className="text-xs font-medium text-muted-foreground">
                            {numericField.label}
                        </label>
                        <input
                            id={numericFieldId}


                            type="number"
                            min={0}
                            step={1}
                            inputMode="numeric"
                            value={numericDraft}


                            onChange={(e) => setNumericDraft(e.target.value)}
                            onKeyDown={handleFieldKeyDown}
                            placeholder={numericField.placeholder}
                            aria-label={numericField.label}
                            className="w-full rounded-lg border border-border bg-card px-3 py-2 shadow-sm transition-colors focus:border-transparent focus:ring-2 focus:ring-primary"
                        />
                    </div>
                )}
                <div className="flex justify-end gap-2">
                    {browseLabel && onBrowse && (
                        <Button
                            variant="secondary"
                            className="mr-auto"
                            onMouseDown={keepInputFocus}
                            onClick={() => {
                                void onBrowse().then((picked) => {
                                    if (typeof picked === 'string' && picked) {
                                        setValue(picked);
                                        setHasInteracted(true);
                                    }
                                });
                            }}
                        >
                            {browseLabel}
                        </Button>
                    )}
                    {secondaryLabel && onSecondary && (
                        <Button
                            variant="secondary"
                            onMouseDown={keepInputFocus}
                            onClick={() => {
                                if (canConfirm) {
                                    onSecondary(value);
                                } else {
                                    setHasInteracted(true);
                                }
                            }}
                            disabled={!canConfirm}
                        >
                            {secondaryLabel}
                        </Button>
                    )}
                    <Button variant="secondary" onMouseDown={keepInputFocus} onClick={onCancel} disabled={busy}>
                        {cancelLabel}
                    </Button>
                    <Button
                        onMouseDown={keepInputFocus}
                        onClick={() => {
                            if (canConfirm) {
                                confirmWithValue();
                            } else {
                                setHasInteracted(true);
                            }
                        }}
                        disabled={!canConfirm || busy}
                    >
                        {confirmLabel}
                    </Button>
                </div>
            </DialogBody>
        </Dialog>
    );
}
