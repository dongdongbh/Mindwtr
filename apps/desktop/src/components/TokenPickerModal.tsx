import { useEffect, useId, useMemo, useState } from 'react';
import { useLanguage } from '../contexts/language-context';
import { cn } from '../lib/utils';
import { isImeComposing } from '../lib/ime';
import { Dialog, DialogBody, DialogHeader } from './ui/Dialog';

interface TokenPickerModalProps {
    isOpen: boolean;
    title: string;
    description?: string;
    tokens: string[];
    placeholder?: string;
    allowCustomValue?: boolean;

    multiSelect?: boolean;
    confirmLabel: string;
    cancelLabel: string;
    onConfirm: (values: string[]) => void;
    onCancel: () => void;
}

export function TokenPickerModal({
    isOpen,
    title,
    description,
    tokens,
    placeholder,
    allowCustomValue = false,
    multiSelect = false,
    confirmLabel,
    cancelLabel,
    onConfirm,
    onCancel,
}: TokenPickerModalProps) {
    const { t } = useLanguage();
    const [query, setQuery] = useState('');
    const [selectedTokens, setSelectedTokens] = useState<string[]>([]);
    const titleId = useId();
    const descriptionId = useId();

    useEffect(() => {
        if (!isOpen) return;
        setQuery('');
        setSelectedTokens([]);
    }, [isOpen]);

    const filteredTokens = useMemo(() => {
        const normalizedQuery = query.trim().toLowerCase();
        if (!normalizedQuery) return tokens;
        return tokens.filter((token) => token.toLowerCase().includes(normalizedQuery));
    }, [query, tokens]);

    const toggleToken = (token: string) => {
        if (multiSelect) {
            setSelectedTokens((current) => (current.includes(token)
                ? current.filter((item) => item !== token)
                : [...current, token]));
            return;
        }
        setSelectedTokens([token]);
        setQuery(token);
    };

    const confirmValues = multiSelect
        ? selectedTokens
        : [allowCustomValue ? (selectedTokens[0] ?? query.trim()) : (selectedTokens[0] ?? '')]
            .filter((value) => value.trim().length > 0);
    const canConfirm = confirmValues.length > 0;

    if (!isOpen) return null;

    return (
        <Dialog
            onClose={onCancel}
            labelledBy={titleId}
            describedBy={description ? descriptionId : undefined}
            placement="top"
            overlayClassName="pt-[16vh]"
            panelClassName="max-w-lg max-h-[70vh]"
        >
            <DialogHeader className="border-b px-4 py-3">
                <h3 id={titleId} className="font-semibold">{title}</h3>
                {description && (
                    <p id={descriptionId} className="mt-1 text-xs text-muted-foreground">
                        {description}
                    </p>
                )}
            </DialogHeader>
            <DialogBody className="flex flex-1 flex-col gap-3 p-4">
                <input
                    autoFocus
                    type="text"
                    value={query}
                    onChange={(event) => {
                        const value = event.target.value;
                        setQuery(value);

                        if (multiSelect) return;
                        if (!allowCustomValue) {
                            const exactMatch = tokens.find((token) => token.toLowerCase() === value.trim().toLowerCase());
                            setSelectedTokens(exactMatch ? [exactMatch] : []);
                        } else if (selectedTokens[0] && selectedTokens[0] !== value) {
                            setSelectedTokens([]);
                        }
                    }}
                    onKeyDown={(event) => {
                        if (isImeComposing(event)) return;
                        if (event.key === 'Escape') {
                            event.preventDefault();
                            onCancel();
                        }
                        if (event.key === 'Enter' && canConfirm) {
                            event.preventDefault();
                            onConfirm(confirmValues);
                        }
                    }}
                    placeholder={placeholder}
                    className="w-full rounded-lg border border-border bg-card px-3 py-2 shadow-sm transition-colors focus:border-transparent focus:ring-2 focus:ring-primary"
                />
                <div className="flex max-h-64 flex-wrap gap-2 overflow-y-auto rounded-lg border border-border/80 bg-card/60 p-3">
                    {filteredTokens.length > 0 ? filteredTokens.map((token) => {
                        const isActive = selectedTokens.includes(token);
                        return (
                            <button
                                key={token}
                                type="button"
                                aria-pressed={multiSelect ? isActive : undefined}
                                onClick={() => toggleToken(token)}
                                className={cn(
                                    'rounded-full border px-3 py-1.5 text-xs transition-colors',
                                    isActive
                                        ? 'border-primary bg-primary/10 text-primary'
                                        : 'border-border text-muted-foreground hover:border-primary/50 hover:text-foreground'
                                )}
                            >
                                {token}
                            </button>
                        );
                    }) : (
                        <div className="w-full py-6 text-center text-sm text-muted-foreground">
                            {t('common.noMatches')}
                        </div>
                    )}
                </div>
                <div className="flex justify-end gap-2">
                    <button
                        type="button"
                        onClick={onCancel}
                        className="rounded-md bg-muted px-3 py-1.5 text-sm hover:bg-muted/80"
                    >
                        {cancelLabel}
                    </button>
                    <button
                        type="button"
                        onClick={() => {
                            if (canConfirm) {
                                onConfirm(confirmValues);
                            }
                        }}
                        disabled={!canConfirm}
                        className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        {confirmLabel}
                    </button>
                </div>
            </DialogBody>
        </Dialog>
    );
}
