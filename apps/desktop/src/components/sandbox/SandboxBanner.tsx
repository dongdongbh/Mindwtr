import { RotateCcw, ShieldCheck } from 'lucide-react';
import { isSandboxMode, useTaskStore } from '@mindwtr/core';
import { useState } from 'react';
import { useLanguage } from '../../contexts/language-context';
import { exitDesktopSandbox, resetDesktopSandbox } from '../../lib/sandbox-session';

export function SandboxBanner() {
    const { t } = useLanguage();
    const settings = useTaskStore((state) => state.settings);
    const [error, setError] = useState<string | null>(null);
    if (!isSandboxMode()) return null;

    const run = (action: () => void) => {
        setError(null);
        try {
            action();
        } catch {
            setError(t('sandbox.switchFailed'));
        }
    };

    return (
        <div
            className="fixed inset-x-0 top-0 z-40 flex h-10 items-center justify-between gap-3 border-b border-primary/30 bg-primary px-3 text-sm text-primary-foreground shadow-sm"
            role="status"
            aria-live="polite"
            data-sandbox-banner
        >
            <span className="inline-flex min-w-0 items-center gap-2 font-semibold">
                <ShieldCheck className="h-4 w-4 shrink-0" aria-hidden="true" />
                <span className="truncate">{error ?? t('sandbox.title')}</span>
            </span>
            <span className="flex shrink-0 items-center gap-2">
                <button
                    type="button"
                    onClick={() => run(() => resetDesktopSandbox(settings))}
                    className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition-colors hover:bg-primary-foreground/10 focus-visible:ring-2 focus-visible:ring-primary-foreground"
                    data-sandbox-reset
                >
                    <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                    {t('sandbox.reset')}
                </button>
                <button
                    type="button"
                    onClick={() => run(() => exitDesktopSandbox())}
                    className="rounded-md border border-primary-foreground/50 px-2.5 py-1 text-xs font-semibold transition-colors hover:bg-primary-foreground/10 focus-visible:ring-2 focus-visible:ring-primary-foreground"
                    data-sandbox-exit
                >
                    {t('sandbox.exit')}
                </button>
            </span>
        </div>
    );
}
