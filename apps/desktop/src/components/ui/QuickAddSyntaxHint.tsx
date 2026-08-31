import type { ReactNode } from 'react';
import { formatQuickAddHelp, resolveFeatureFlags, useTaskStore } from '@mindwtr/core';

// Splits the translated quick-add help line so entry tokens (/start:, @context,
// #tag, +Project, %Person, !Area) read as typable input while <placeholder>
// parts recede. Parses whatever the locale string contains, so untranslated
// syntax tokens style consistently in every language and unmatched text
// renders plain (#869).
const HINT_SEGMENT = /((?:<[^>]+>)|(?:%"[^"]*")|(?:[/@#+%!][^\s,()<.]+))/g;

export function QuickAddSyntaxHint({ text }: { text: string }) {
    // Gated here rather than at each caller: Focus, Quick Add and the calendar
    // composer all render this hint, and a new one must not be able to
    // advertise a disabled feature's token.
    const priorities = useTaskStore((state) => resolveFeatureFlags(state.settings).priorities);
    const parts = formatQuickAddHelp(text, { priorities }).split(HINT_SEGMENT);
    return (
        <>
            {parts.map((part, index): ReactNode => {
                if (!part) return null;
                if (part.startsWith('<') && part.endsWith('>')) {
                    return <span key={index} className="opacity-70">{part}</span>;
                }
                if (/^[/@#+%!]/.test(part)) {
                    return <span key={index} className="font-medium text-foreground/80">{part}</span>;
                }
                return part;
            })}
        </>
    );
}
