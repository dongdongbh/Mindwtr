import { useState } from 'react';
import {
    APP_LOCK_RELOCK_DELAY_OPTIONS,
    setAppLockEnabled,
    setAppLockRelockDelay,
    useAppLockStore,
    type AppLockAvailability,
} from '../../../lib/app-lock';
import { reportError } from '../../../lib/report-error';
import { isMacRuntime } from '../../../lib/runtime';
import { Switch } from '../../ui/Switch';
import type { SettingsLabels } from './labels';
import { SettingRow, SettingsCard, SettingsSectionHeader } from './SettingRow';

const selectCls =
    'rounded-md border border-border bg-muted/50 px-2.5 py-1.5 text-[13px] text-foreground focus:outline-none focus:ring-2 focus:ring-primary/40';

type AppLockSettingsSectionProps = {
    t: SettingsLabels;
    availability: AppLockAvailability;
};

/**
 * The privacy lock row (#1472). Hidden where there is no OS check (Linux, web,
 * sample workspace); disabled with a reason when Windows Hello / the Mac
 * password is not set up. The delay picker shows only while the lock is on.
 */
export function AppLockSettingsSection({ t, availability }: AppLockSettingsSectionProps) {
    const enabled = useAppLockStore((state) => state.enabled);
    const relockDelayMinutes = useAppLockStore((state) => state.relockDelayMinutes);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState('');

    if (!availability.supported) return null;

    const delayLabels: Record<number, string> = {
        0: t.desktopAppLockRelockImmediately,
        1: t.desktopAppLockRelockAfter1,
        5: t.desktopAppLockRelockAfter5,
        15: t.desktopAppLockRelockAfter15,
    };

    const toggle = async () => {
        if (busy) return;
        setBusy(true);
        setMessage('');
        try {
            const outcome = await setAppLockEnabled(
                !enabled,
                // macOS shows the reason after "Mindwtr is trying to …".
                isMacRuntime() ? t.desktopAppLockMacEnableReason : t.desktopAppLockEnablePrompt,
            );
            if (outcome === 'cancelled') setMessage(t.desktopAppLockCancelled);
            else if (outcome === 'failed') setMessage(t.desktopAppLockFailed);
            else if (outcome === 'unavailable') setMessage(t.desktopAppLockUnavailable);
        } finally {
            setBusy(false);
        }
    };

    const description = availability.available || enabled
        ? t.desktopAppLockDesc
        : `${t.desktopAppLockDesc} ${t.desktopAppLockUnavailable}`;

    return (
        <>
            <SettingsSectionHeader>{t.privacy}</SettingsSectionHeader>
            <SettingsCard>
                <SettingRow padded settingsKey="desktopAppLock" title={t.desktopAppLock} description={description}>
                    <Switch
                        disabled={busy || (!availability.available && !enabled)}
                        checked={enabled}
                        aria-label={t.desktopAppLock}
                        onCheckedChange={() => void toggle()}
                    />
                </SettingRow>
                {enabled && (
                    <SettingRow padded settingsKey={null} title={t.desktopAppLockRelock}>
                        <select
                            aria-label={t.desktopAppLockRelock}
                            value={relockDelayMinutes}
                            onChange={(event) => {
                                const minutes = Number(event.target.value) as typeof relockDelayMinutes;
                                void setAppLockRelockDelay(minutes).catch((error) => reportError('Failed to save app lock delay', error));
                            }}
                            className={selectCls}
                        >
                            {APP_LOCK_RELOCK_DELAY_OPTIONS.map((minutes) => (
                                <option key={minutes} value={minutes}>{delayLabels[minutes]}</option>
                            ))}
                        </select>
                    </SettingRow>
                )}
                {message && <div role="status" className="px-4 pb-3 text-xs text-destructive">{message}</div>}
            </SettingsCard>
        </>
    );
}
