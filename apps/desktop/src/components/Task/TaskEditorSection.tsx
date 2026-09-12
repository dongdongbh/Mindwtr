import { useEffect, useId, useRef, type ReactNode } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

interface TaskEditorSectionProps {
    title: string;
    count: number;
    open: boolean;
    onToggle: () => void;
    children: ReactNode;
}

export function TaskEditorSection({ title, count, open, onToggle, children }: TaskEditorSectionProps) {
    const contentId = useId();
    const sectionRef = useRef<HTMLDivElement>(null);
    const headerRef = useRef<HTMLButtonElement>(null);
    const revealOnOpen = useRef(false);

    useEffect(() => {
        if (!open || !revealOnOpen.current) return;
        const frame = requestAnimationFrame(() => {
            revealOnOpen.current = false;
            const section = sectionRef.current;
            if (!section) return;

            // Inline lists and modal editors can have nested scrollports. Native
            // nearest scrolling handles all of them without moving visible content.
            let availableHeight = window.innerHeight;
            for (let parent = section.parentElement; parent; parent = parent.parentElement) {
                if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(parent).overflowY)) {
                    availableHeight = Math.min(availableHeight, parent.clientHeight);
                }
            }
            if (section.getBoundingClientRect().height <= availableHeight) {
                section.scrollIntoView({ block: 'nearest', behavior: 'instant' });
            } else {
                // The full section cannot fit: show its beginning, including the
                // toggle, rather than scrolling straight to its last fields.
                headerRef.current?.scrollIntoView({ block: 'start', behavior: 'instant' });
            }
        });
        return () => cancelAnimationFrame(frame);
    }, [open]);

    return (
        <div ref={sectionRef} className="border-t border-border">
            <button
                ref={headerRef}
                type="button"
                onClick={() => {
                    revealOnOpen.current = !open;
                    onToggle();
                }}
                className="w-full flex items-center justify-between py-3 text-xs uppercase tracking-wide text-muted-foreground font-semibold hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40"
                aria-expanded={open}
                aria-controls={contentId}
            >
                <span className="flex items-center gap-2">
                    {title}
                    {count > 0 && (
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-primary/10 text-primary">{count}</span>
                    )}
                </span>
                {open
                    ? <ChevronDown className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    : <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
            </button>
            <div id={contentId} hidden={!open} className="pb-3 space-y-3">{open && children}</div>
        </div>
    );
}
