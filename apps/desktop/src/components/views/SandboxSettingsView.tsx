import { FlaskConical, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { useTaskStore } from '@mindwtr/core';
import { useLanguage } from '../../contexts/language-context';
import { exitDesktopSandbox, resetDesktopSandbox } from '../../lib/sandbox-session';
import { LIST_END_GAP } from './list/list-toolbar';

export function SandboxSettingsView() {
    const { t } = useLanguage();
    const settings = useTaskStore((state) => state.settings);
    const [error, setError] = useState<string | null>(null);

    const run = (action: () => void) => {
        setError(null);
        try {
            action();
        } catch {
            setError(t('sandbox.switchFailed'));
        }
    };

    return (
        <div className="h-full overflow-y-auto">
            <div className={`mx-auto max-w-3xl space-y-6 px-4 pt-3 ${LIST_END_GAP}`} data-sandbox-settings>
                <header>
                    <h2 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
                        <FlaskConical className="h-5 w-5 text-primary" aria-hidden="true" />
                        {t('sandbox.title')}
                    </h2>
                    <p className="mt-2 text-sm leading-6 text-muted-foreground">{t('sandbox.description')}</p>
                </header>

                <section className="rounded-lg border border-border bg-card p-5">
                    <p className="text-sm text-foreground">{t('sandbox.notice')}</p>
                    <div className="mt-4 flex flex-wrap gap-2">
                        <button
                            type="button"
                            onClick={() => run(() => resetDesktopSandbox(settings))}
                            className="inline-flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-sm font-medium hover:bg-muted"
                            data-sandbox-settings-reset
                        >
                            <RotateCcw className="h-4 w-4" aria-hidden="true" />
                            {t('sandbox.reset')}
                        </button>
                        <button
                            type="button"
                            onClick={() => run(() => exitDesktopSandbox())}
                            className="rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
                            data-sandbox-settings-exit
                        >
                            {t('sandbox.exit')}
                        </button>
                    </div>
                    {error ? <p className="mt-3 text-xs text-destructive" role="alert">{error}</p> : null}
                </section>
            </div>
        </div>
    );
}
