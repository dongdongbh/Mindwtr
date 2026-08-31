import { formatI18nTemplate, tFallback } from '@mindwtr/core';

export const taskEditorLabelClassName = 'text-xs text-muted-foreground font-semibold';

// Quick-add tokens each editor field maps to, verified against parseQuickAdd
// (packages/core/src/quick-add.ts). Fields whose token the parser does not
// accept get no hint. Tokens are language-neutral and never translated.
export const QUICK_ADD_FIELD_TOKENS = {
    priority: '/priority:',
    energyLevel: '/energy:',
    assignedTo: '%Name',
    contexts: '@context',
    tags: '#tag',
    startTime: '/start:',
    dueDate: '/due:',
    reviewAt: '/review:',
    note: '/note:',
    link: '/link:',
    area: '!Area',
    project: '+Project',
} as const;

// Localized "Quick add: <token>" hint for a token badge's `title` tooltip (#918).
export function quickAddTokenHint(t: (key: string) => string, token: string): string {
    return formatI18nTemplate(
        tFallback(t, 'taskEdit.quickAddTokenHint', 'Quick add: {{token}}'),
        { token },
    );
}

export function QuickAddTokenBadge({
    t,
    token,
}: {
    t: (key: string) => string;
    token: string;
}) {
    return (
        <code
            title={quickAddTokenHint(t, token)}
            className="inline-flex rounded border border-current/30 bg-background/20 px-1 py-0.5 font-mono text-[10px] font-normal leading-none text-current opacity-80"
        >
            {token}
        </code>
    );
}
