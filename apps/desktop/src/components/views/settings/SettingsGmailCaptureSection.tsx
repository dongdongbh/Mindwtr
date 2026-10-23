import { useEffect, useRef, useState } from 'react';
import { safeFormatDate } from '@mindwtr/core';
import { ChevronDown, ChevronRight } from 'lucide-react';

import { useLanguage } from '../../../contexts/language-context';
import {
    cancelGmailCapture,
    configureGmailCapture,
    connectGmailCapture,
    disconnectGmailCapture,
    getGmailCaptureConfig,
    getGmailCaptureLabels,
    getGmailCaptureStatus,
    gmailCaptureErrorTranslation,
    pollGmailCaptureNow,
    subscribeGmailCaptureStatus,
    toGmailCaptureError,
    type GmailCaptureConfig,
    type GmailCaptureLabel,
} from '../../../lib/gmail-capture';

type Props = { isTauri: boolean; showSaved: () => void };
type Operation = 'connect' | 'save' | 'disconnect' | 'check' | 'cancel' | null;

const buttonClass = 'px-4 py-2 rounded-md text-sm font-medium cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50 disabled:cursor-not-allowed';

export function SettingsGmailCaptureSection({ isTauri, showSaved }: Props) {
    const { t } = useLanguage();
    const [open, setOpen] = useState(false);
    const [config, setConfig] = useState<GmailCaptureConfig | null>(null);
    const [labels, setLabels] = useState<GmailCaptureLabel[]>([]);
    const [labelId, setLabelId] = useState('');
    const [operation, setOperation] = useState<Operation>(null);
    const [error, setError] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [status, setStatus] = useState(getGmailCaptureStatus);
    const generation = useRef(0);
    const busy = operation !== null;

    useEffect(() => subscribeGmailCaptureStatus(setStatus), []);
    useEffect(() => {
        const current = ++generation.current;
        if (isTauri) {
            void (async () => {
                try {
                    const next = await getGmailCaptureConfig();
                    if (current !== generation.current) return;
                    setConfig(next);
                    if (next.connected) {
                        const nextLabels = await getGmailCaptureLabels();
                        if (current !== generation.current) return;
                        setLabels(nextLabels);
                        setLabelId(next.labelId ?? nextLabels.find((label) => label.name === 'Mindwtr')?.id ?? '');
                    }
                } catch (failure) {
                    if (current === generation.current) setError(gmailCaptureErrorTranslation(toGmailCaptureError(failure)));
                }
            })();
        }
        return () => { generation.current += 1; };
    }, [isTauri]);

    const runOperation = async (nextOperation: Exclude<Operation, null>, action: (current: number) => Promise<void>) => {
        const current = ++generation.current;
        setOperation(nextOperation);
        setError(null);
        setNotice(null);
        try {
            await action(current);
        } catch (failure) {
            if (current === generation.current) setError(gmailCaptureErrorTranslation(toGmailCaptureError(failure)));
        } finally {
            if (current === generation.current) setOperation(null);
        }
    };

    const connect = () => runOperation('connect', async (current) => {
        // Reconnect retires the old account immediately, even if consent is cancelled.
        setConfig((previous) => previous && ({ ...previous, connected: false, account: null, accountId: null, labelId: null, enabled: false }));
        setLabels([]);
        setLabelId('');
        const next = await connectGmailCapture();
        if (current !== generation.current) return;
        setConfig(next);
        const nextLabels = await getGmailCaptureLabels();
        if (current !== generation.current) return;
        setLabels(nextLabels);
        setLabelId(next.labelId ?? nextLabels.find((label) => label.name === 'Mindwtr')?.id ?? '');
    });

    const cancel = () => runOperation('cancel', async (current) => {
        await cancelGmailCapture();
        if (current === generation.current) setNotice('settings.gmailCaptureCancelled');
    });

    const save = () => runOperation('save', async (current) => {
        // Native configuration disables import before it validates the selected label.
        setConfig((previous) => previous && ({ ...previous, enabled: false }));
        const next = await configureGmailCapture(labelId, true);
        if (current !== generation.current) return;
        setConfig(next);
        setLabelId(next.labelId ?? '');
        showSaved();
    });

    const disconnect = () => runOperation('disconnect', async (current) => {
        setConfig((previous) => previous && ({ ...previous, connected: false, account: null, accountId: null, labelId: null, enabled: false }));
        setLabels([]);
        setLabelId('');
        const result = await disconnectGmailCapture();
        if (current !== generation.current) return;
        setNotice(result.revoked ? 'settings.gmailCaptureDisconnected' : 'settings.gmailCaptureRevokeManually');
        showSaved();
    });

    const check = () => runOperation('check', async () => { await pollGmailCaptureNow(); });
    const statusLine = status.lastPollAt
        ? safeFormatDate(status.lastPollAt, 'PPpp', status.lastPollAt)
        : t('settings.gmailCaptureNeverChecked');
    const displayedError = error ?? (status.lastError ? gmailCaptureErrorTranslation(status.lastError) : null);

    return (
        <div className="bg-card border border-border rounded-lg">
            <button
                type="button"
                data-settings-key="gmailCapture"
                data-settings-section="gmailCapture"
                onClick={() => setOpen((previous) => !previous)}
                aria-expanded={open}
                className="w-full p-4 text-left flex items-center justify-between gap-4 rounded-lg cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
                <div className="min-w-0">
                    <div className="text-sm font-medium">{t('settings.gmailCapture')}</div>
                    <p className="text-xs text-muted-foreground mt-1">{t('settings.gmailCaptureDesc')}</p>
                </div>
                {open ? <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" aria-hidden="true" /> : <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" aria-hidden="true" />}
            </button>
            {open && (
                <div className="border-t border-border p-4 space-y-4">
                    <p className="text-xs text-muted-foreground">{t('settings.gmailCaptureDisclosure')}</p>
                    {(!isTauri || (config && !config.available)) ? (
                        <p className="text-sm text-muted-foreground">{t('settings.gmailCaptureUnavailable')}</p>
                    ) : (
                        <>
                            {config?.connected && (
                                <div className="space-y-3">
                                    <p className="text-sm break-all"><span className="text-muted-foreground">{t('settings.gmailCaptureAccount')}: </span>{config.account}</p>
                                    <label data-settings-key="gmailCaptureLabel" className="block space-y-1">
                                        <span className="text-sm font-medium">{t('settings.gmailCaptureLabel')}</span>
                                        <select
                                            value={labelId}
                                            onChange={(event) => setLabelId(event.target.value)}
                                            disabled={busy}
                                            className="block w-full bg-muted p-2 rounded text-sm border border-border focus:outline-none focus:ring-2 focus:ring-primary disabled:opacity-50"
                                        >
                                            <option value="">{t('settings.gmailCaptureChooseLabel')}</option>
                                            {labels.map((label) => <option key={label.id} value={label.id}>{label.name}</option>)}
                                        </select>
                                    </label>
                                    <p className="text-xs text-muted-foreground">{t('settings.gmailCaptureLabelHint')}</p>
                                    <p className="text-xs text-muted-foreground">{t(config.enabled ? 'settings.gmailCaptureActive' : 'settings.gmailCapturePaused')}</p>
                                </div>
                            )}
                            <div className="flex flex-wrap gap-2">
                                <button type="button" onClick={() => { void connect(); }} disabled={busy || !config?.available} className={`${buttonClass} bg-secondary text-secondary-foreground hover:bg-secondary/90`}>
                                    {t(operation === 'connect' ? 'settings.gmailCaptureConnecting' : config?.connected ? 'settings.gmailCaptureReconnect' : 'settings.gmailCaptureConnect')}
                                </button>
                                {operation === 'connect' && (
                                    <button type="button" onClick={() => { void cancel(); }} className={`${buttonClass} bg-muted hover:bg-muted/80`}>
                                        {t('settings.gmailCaptureCancel')}
                                    </button>
                                )}
                                {config?.connected && (
                                    <>
                                        <button type="button" onClick={() => { void disconnect(); }} disabled={operation === 'disconnect' || operation === 'cancel'} className={`${buttonClass} bg-muted hover:bg-muted/80`}>
                                            {t('settings.gmailCaptureDisconnect')}
                                        </button>
                                        <button type="button" onClick={() => { void check(); }} disabled={busy || !config.enabled || status.terminal} className={`${buttonClass} bg-secondary text-secondary-foreground hover:bg-secondary/90`}>
                                            {t(operation === 'check' ? 'settings.gmailCaptureChecking' : 'settings.gmailCaptureCheckNow')}
                                        </button>
                                        <button type="button" onClick={() => { void save(); }} disabled={busy || !labelId} className={`${buttonClass} bg-primary text-primary-foreground hover:bg-primary/90`}>
                                            {t(operation === 'save' ? 'settings.gmailCaptureSaving' : 'settings.gmailCaptureSave')}
                                        </button>
                                    </>
                                )}
                            </div>
                        </>
                    )}
                    {status.lastPollAt && config?.connected && (
                        <p className="text-xs text-muted-foreground">
                            {t('settings.gmailCaptureLastChecked')}: {statusLine}
                            {status.lastImportCount > 0 && !status.lastError && ` · ${t('settings.gmailCaptureImportedCount').replace('{{count}}', String(status.lastImportCount))}`}
                        </p>
                    )}
                    {displayedError && <p role="alert" className="text-xs text-warning">{t(displayedError)}</p>}
                    {notice && <p role="status" className="text-xs text-muted-foreground">{t(notice)}</p>}
                </div>
            )}
        </div>
    );
}
