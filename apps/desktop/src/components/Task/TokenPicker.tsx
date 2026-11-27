import { useId, useMemo, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { getTaskTokenPickerOptions } from '@mindwtr/core';

import { isImeComposing } from '../../lib/ime';

export function TokenPicker({ t, label, tokens, selected, onToggle }: {
    t: (key: string) => string;
    label: string;
    tokens: readonly string[];
    selected: Iterable<string>;
    onToggle: (token: string) => void;
}) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const id = useId();
    const triggerRef = useRef<HTMLButtonElement>(null);
    const options = useMemo(() => open ? getTaskTokenPickerOptions(tokens, selected) : [], [open, selected, tokens]);
    const search = query.trim().toLowerCase();
    const visible = options.filter(({ token }) => token.toLowerCase().includes(search));
    const browseLabel = t('settings.browse');
    const searchLabel = t('common.search');
    const close = () => {
        setOpen(false);
        setQuery('');
    };

    return (
        <div onKeyDown={(event) => {
            if (!open || isImeComposing(event) || event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            close();
            triggerRef.current?.focus();
        }}>
            <button
                type="button"
                ref={triggerRef}
                aria-expanded={open}
                aria-controls={id}
                aria-label={`${label} · ${browseLabel}`}
                onClick={() => open ? close() : setOpen(true)}
                className="group inline-flex items-center gap-1 rounded px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary/40"
            >
                {browseLabel}
                <ChevronDown className="h-3.5 w-3.5 group-aria-expanded:rotate-180" aria-hidden="true" />
            </button>
            <div id={id} hidden={!open} className="mt-1 rounded-lg border border-border bg-card p-2">
                {open && (
                    <>
                        <input
                            type="search"
                            autoFocus
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                            onKeyDown={(event) => {
                                if (event.key !== 'Enter' || isImeComposing(event)) return;
                                event.preventDefault();
                                event.stopPropagation();
                            }}
                            aria-label={`${label} · ${searchLabel}`}
                            placeholder={searchLabel}
                            className="w-full rounded border border-border bg-muted/50 px-2 py-1.5 text-sm text-foreground focus-visible:ring-2 focus-visible:ring-primary/40"
                        />
                        <div role="group" aria-label={label} className="mt-1 max-h-56 overflow-y-auto overscroll-contain">
                            {visible.map((option) => (
                                <label key={option.token} className="flex min-h-11 cursor-pointer items-center gap-2 rounded px-2 text-sm hover:bg-muted">
                                    <input
                                        type="checkbox"
                                        checked={option.selected}
                                        onChange={() => onToggle(option.token)}
                                        className="h-4 w-4 shrink-0 accent-primary"
                                    />
                                    <span className="break-all">{option.token}</span>
                                </label>
                            ))}
                            {visible.length === 0 && <p role="status" className="px-2 py-2 text-xs text-muted-foreground">{t('common.noMatches')}</p>}
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
