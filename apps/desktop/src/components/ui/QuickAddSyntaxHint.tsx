import type { ReactNode } from 'react';
import { formatQuickAddHelp, resolveFeatureFlags, useTaskStore } from '@mindwtr/core';


const HINT_SEGMENT = /((?:<[^>]+>)|(?:%"[^"]*")|(?:[/@#+%!][^\s,()<.]+))/g;

export function QuickAddSyntaxHint({ text }: { text: string }) {


    const priorities = useTaskStore((state) => resolveFeatureFlags(state.settings).priorities);
    const timeEstimates = useTaskStore((state) => resolveFeatureFlags(state.settings).timeEstimates);
    const parts = formatQuickAddHelp(text, { priorities, timeEstimates }).split(HINT_SEGMENT);
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
