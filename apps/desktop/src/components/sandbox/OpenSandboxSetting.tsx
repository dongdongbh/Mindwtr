import { FlaskConical } from 'lucide-react';
import { useState } from 'react';
import { useTaskStore } from '@mindwtr/core';
import { getCurrentUiLanguage } from '../../contexts/language-context';
import { openDesktopSandbox } from '../../lib/sandbox-session';
import { coerceDesktopThemeMode, THEME_STORAGE_KEY } from '../../lib/theme';
import { coerceDesktopTextSize, TEXT_SIZE_STORAGE_KEY } from '../../lib/text-size';
import { Dialog } from '../ui/Dialog';
import type { SettingsSyncLabels } from '../views/settings/sync/types';
import type { AppSettings } from '@mindwtr/core';

type OpenSandboxSettingProps = {
    t: Pick<
        SettingsSyncLabels,
        | 'cancel'
        | 'sandboxWorkspace'
        | 'sandboxDescription'
        | 'sandboxSwitching'
        | 'sandboxSwitchFailed'
        | 'sandboxConfirmTitle'
        | 'sandboxConfirmDescription'
        | 'sandboxEnter'
    >;
    onEnterSandbox?: (settings: AppSettings) => Promise<void>;
    disabled?: boolean;
};

export function OpenSandboxSetting({ t, onEnterSandbox = openDesktopSandbox, disabled = false }: OpenSandboxSettingProps) {
    const settings = useTaskStore((state) => state.settings);
    const [confirming, setConfirming] = useState(false);
    const [switching, setSwitching] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const openSandbox = async () => {
        if (switching || disabled) return;
        setSwitching(true);
        setError(null);
        try {
            const deviceTheme = coerceDesktopThemeMode(localStorage.getItem(THEME_STORAGE_KEY));
            const deviceTextSize = coerceDesktopTextSize(localStorage.getItem(TEXT_SIZE_STORAGE_KEY));
            await onEnterSandbox({
                ...settings,
                theme: settings.theme ?? deviceTheme ?? undefined,
                language: settings.language && settings.language !== 'system'
                    ? settings.language
                    : getCurrentUiLanguage(),
                appearance: {
                    ...settings.appearance,
                    textSize: settings.appearance?.textSize ?? deviceTextSize,
                },
            });
        } catch {
            setError(t.sandboxSwitchFailed);
            setSwitching(false);
        }
    };

    return (
        <>
            <div className="rounded-lg border border-primary/25 bg-primary/5 p-4" data-settings-key="sandboxWorkspace">
                <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                        <div className="flex items-center gap-2 text-sm font-medium">
                            <FlaskConical className="h-4 w-4 text-primary" aria-hidden="true" />
                            {t.sandboxWorkspace}
                        </div>
                        <p className="mt-1 text-xs leading-5 text-muted-foreground">{t.sandboxDescription}</p>
                    </div>
                    <button
                        type="button"
                        onClick={() => {
                            if (!disabled) setConfirming(true);
                        }}
                        disabled={switching || disabled}
                        className="shrink-0 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-wait"
                        data-open-sandbox
                    >
                        {switching ? t.sandboxSwitching : t.sandboxWorkspace}
                    </button>
                </div>
                {error ? <p className="mt-2 text-xs text-destructive" role="alert">{error}</p> : null}
            </div>
            {confirming ? (
                <Dialog
                    onClose={() => setConfirming(false)}
                    labelledBy="sandbox-confirm-title"
                    describedBy="sandbox-confirm-description"
                    panelClassName="max-w-lg"
                >
                    <div className="space-y-3 p-5">
                        <h2 id="sandbox-confirm-title" className="text-lg font-semibold">
                            {t.sandboxConfirmTitle}
                        </h2>
                        <p id="sandbox-confirm-description" className="text-sm leading-6 text-muted-foreground">
                            {t.sandboxConfirmDescription}
                        </p>
                        <div className="flex justify-end gap-2 pt-2">
                            <button
                                type="button"
                                onClick={() => setConfirming(false)}
                                className="rounded-md border border-border px-3 py-2 text-sm font-medium hover:bg-muted"
                                data-sandbox-confirm-cancel
                            >
                                {t.cancel}
                            </button>
                            <button
                                type="button"
                                onClick={() => {
                                    setConfirming(false);
                                    void openSandbox();
                                }}
                                disabled={disabled}
                                className="rounded-md bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
                                data-sandbox-confirm-enter
                            >
                                {t.sandboxEnter}
                            </button>
                        </div>
                    </div>
                </Dialog>
            ) : null}
            {switching ? (
                <Dialog
                    onClose={() => undefined}
                    label={t.sandboxSwitching}
                    closeOnBackdrop={false}
                    closeOnEscape={false}
                    overlayClassName="z-[70] p-4"
                    panelClassName="max-w-sm"
                    onKeyDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                    }}
                >
                    <div
                        className="px-5 py-4 text-center text-sm font-medium"
                        role="status"
                        aria-live="polite"
                        data-sandbox-switching
                    >
                        {t.sandboxSwitching}
                    </div>
                </Dialog>
            ) : null}
        </>
    );
}
