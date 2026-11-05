import type { QuickAddPreviewEntry } from '@mindwtr/core';

import { cn } from '../lib/utils';


const MAX_VISIBLE_ENTRIES = 8;

type QuickAddPreviewProps = {
    entries: QuickAddPreviewEntry[];
    className?: string;
};


export function QuickAddPreview({ entries, className }: QuickAddPreviewProps) {
    const visible = entries.slice(0, MAX_VISIBLE_ENTRIES);
    const overflow = entries.length - visible.length;


    return (
        <div
            role="status"
            aria-live="polite"
            data-testid="quick-add-preview"
            className={cn('flex flex-wrap items-center gap-1 text-[11px] leading-4', className)}
        >
            {visible.map((entry) => (
                <span
                    key={entry.id}


                    aria-hidden={entry.kind === 'title' ? true : undefined}
                    className={cn(
                        'inline-flex max-w-full items-baseline gap-1 rounded-full border px-2 py-0.5',
                        entry.tone === 'warning'
                            ? 'border-destructive/40 bg-destructive/10 text-destructive'
                            : 'border-border bg-muted/40 text-muted-foreground',
                    )}
                >
                    {entry.label ? <span className="shrink-0">{entry.label}</span> : null}
                    <span className={cn('truncate font-medium', entry.tone === 'warning' ? '' : 'text-foreground/80')}>
                        {entry.value}
                    </span>
                </span>
            ))}
            {overflow > 0 ? (
                <span className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-muted-foreground">
                    +{overflow}
                </span>
            ) : null}
        </div>
    );
}
