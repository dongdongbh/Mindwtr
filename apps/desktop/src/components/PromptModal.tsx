import { useEffect, useId, useState } from 'react';
import { useLanguage } from '../contexts/language-context';
import { Button } from './ui/Button';

interface PromptModalProps {
    isOpen: boolean;
    title: string;
    description?: string;
    placeholder?: string;
    defaultValue?: string;
    inputType?: 'text' | 'date' | 'datetime-local';
    secondaryLabel?: string;
    onSecondary?: () => void;
    confirmLabel: string;
    cancelLabel: string;
    onConfirm: (value: string) => void;
    onCancel: () => void;
}

export function PromptModal({
    isOpen,
    title,
    description,
    placeholder,
    defaultValue,
    inputType = 'text',
    secondaryLabel,
    onSecondary,
    confirmLabel,
    cancelLabel,
    onConfirm,
    onCancel,
}: PromptModalProps) {
    const { t } = useLanguage();
    const [value, setValue] = useState(defaultValue ?? '');
    const [hasInteracted, setHasInteracted] = useState(false);
    const titleId = useId();
    const descriptionId = useId();
    const validationId = useId();

    useEffect(() => {
        if (isOpen) {
            setValue(defaultValue ?? '');
            setHasInteracted(false);
        }
    }, [isOpen, defaultValue]);
    const canConfirm = value.trim().length > 0;
    const showValidation = hasInteracted && !canConfirm;

    if (!isOpen) return null;

    return (
        <div
            className="fixed inset-0 bg-black/50 flex items-start justify-center pt-[20vh] z-50"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            aria-describedby={description ? descriptionId : undefined}
            onClick={onCancel}
        >
            <div
                className="w-full max-w-md bg-popover text-popover-foreground rounded-xl border shadow-2xl overflow-hidden flex flex-col"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="px-4 py-3 border-b">
                    <h3 id={titleId} className="font-semibold">{title}</h3>
                    {description && (
                        <p id={descriptionId} className="text-xs text-muted-foreground mt-1">
                            {description}
                        </p>
                    )}
                </div>
                <div className="p-4 space-y-3">
                    <input
                        autoFocus
                        type={inputType}
                        value={value}
                        onChange={(e) => {
                            setValue(e.target.value);
                            if (!hasInteracted) {
                                setHasInteracted(true);
                            }
                        }}
                        onBlur={() => setHasInteracted(true)}
                        onKeyDown={(e) => {
                            if (e.key === 'Escape') {
                                e.preventDefault();
                                onCancel();
                            }
                            if (e.key === 'Enter') {
                                e.preventDefault();
                                if (canConfirm) {
                                    onConfirm(value);
                                } else {
                                    setHasInteracted(true);
                                }
                            }
                        }}
                        placeholder={placeholder}
                        aria-invalid={showValidation}
                        aria-describedby={showValidation ? validationId : undefined}
                        className="w-full bg-card border border-border rounded-lg py-2 px-3 shadow-sm focus:ring-2 focus:ring-primary focus:border-transparent transition-all"
                    />
                    {showValidation && (
                        <p id={validationId} className="text-xs text-red-500">
                            {t('common.validationRequired')}
                        </p>
                    )}
                    <div className="flex justify-end gap-2">
                        {secondaryLabel && onSecondary && (
                            <Button variant="secondary" onClick={onSecondary}>
                                {secondaryLabel}
                            </Button>
                        )}
                        <Button variant="secondary" onClick={onCancel}>
                            {cancelLabel}
                        </Button>
                        <Button
                            onClick={() => {
                                if (canConfirm) {
                                    onConfirm(value);
                                } else {
                                    setHasInteracted(true);
                                }
                            }}
                            disabled={!canConfirm}
                        >
                            {confirmLabel}
                        </Button>
                    </div>
                </div>
            </div>
        </div>
    );
}
