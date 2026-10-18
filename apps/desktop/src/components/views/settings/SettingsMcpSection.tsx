import { useEffect, useRef, useState } from 'react';
import { useLanguage } from '../../../contexts/language-context';
import {
    getMcpConnectionDetails,
    getMcpServerStatus,
    isMcpServerAvailable,
    MCP_SERVER_PORT,
    setMcpServerConfig,
    type McpServerConfig,
    type McpServerStatus,
} from '../../../lib/mcp-server';
import { logInfo, logWarn } from '../../../lib/app-log';
import { Switch } from '../../ui/Switch';
import { SettingRow, SettingsDisclosureCard } from './SettingRow';

const actionClass = 'px-3 py-2 bg-muted rounded-md text-sm font-medium hover:bg-muted/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 disabled:cursor-not-allowed';
const POLL_INTERVAL_MS = 3000;

export function SettingsMcpSection({ isTauri }: { isTauri: boolean }) {
    const { t } = useLanguage();
    const available = isTauri && isMcpServerAvailable();
    const [open, setOpen] = useState(false);
    const [advancedOpen, setAdvancedOpen] = useState(false);
    const [portDraft, setPortDraft] = useState<string | null>(null);
    const [portInvalid, setPortInvalid] = useState(false);
    const [status, setStatus] = useState<McpServerStatus | null>(null);
    const [busy, setBusy] = useState(false);
    const [failed, setFailed] = useState(false);
    const [feedback, setFeedback] = useState<string | null>(null);
    const mounted = useRef(false);
    const inFlight = useRef(false);
    const revision = useRef(0);

    useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; revision.current += 1; };
    }, []);

    useEffect(() => {
        if (!available) return;
        let cancelled = false;
        const requestRevision = revision.current;
        getMcpServerStatus().then((next) => {
            if (!cancelled && requestRevision === revision.current) setStatus(next);
        }).catch(() => {
            if (!cancelled && requestRevision === revision.current) setFailed(true);
        });
        return () => { cancelled = true; };
    }, [available]);

    // Schedule after each response so slow calls never overlap; disabled integration does no polling.
    useEffect(() => {
        if (!available || !status?.enabled || busy) return;
        let cancelled = false;
        let timer: ReturnType<typeof setTimeout>;
        const requestRevision = revision.current;
        const poll = async () => {
            try {
                const next = await getMcpServerStatus();
                if (cancelled || requestRevision !== revision.current) return;
                setStatus(next);
                setFailed(false);
            } catch {
                if (cancelled || requestRevision !== revision.current) return;
                setFailed(true);
                setStatus((current) => current ? { ...current, running: false, url: null, token: null } : null);
            }
            if (!cancelled) timer = setTimeout(poll, POLL_INTERVAL_MS);
        };
        timer = setTimeout(poll, POLL_INTERVAL_MS);
        return () => { cancelled = true; clearTimeout(timer); };
    }, [available, status?.enabled, status?.error, busy]);

    const runAction = async (config?: McpServerConfig, copy?: 'json' | 'codex') => {
        if (!available || inFlight.current) return;
        inFlight.current = true;
        revision.current += 1;
        setBusy(true);
        setFailed(false);
        setFeedback(null);
        let clipboardResult: Promise<boolean> | undefined;
        const useClipboardItem = copy && typeof ClipboardItem !== 'undefined' && typeof navigator.clipboard?.write === 'function';
        const reportOutcome = (outcome: 'copied' | 'rotated' | 'invalid-status' | 'clipboard-failed' | 'native-failed') => {
            if (!copy && !config?.regenerateToken) return;
            void (outcome === 'copied' || outcome === 'rotated' ? logInfo : logWarn)('MCP connection action completed', {
                scope: 'mcp', extra: {
                    releaseCheck: copy === 'codex' ? 'v1.3.7/mcp-codex-copy' : 'v1.3.5/mcp-connection-actions', operation: copy ? 'copy' : 'rotate', outcome,
                    backend: copy ? (useClipboardItem ? 'clipboard-item' : 'write-text') : 'native',
                },
            }).catch(() => {});
        };
        try {
            const request = config ? setMcpServerConfig({
                allowArchive: status?.allowArchive ?? false,
                allowDelete: status?.allowDelete ?? false,
                port: status?.port ?? MCP_SERVER_PORT,
                ...config,
            }) : getMcpServerStatus();
            if (useClipboardItem) {
                const data = request.then((next) => {
                    const details = mounted.current && getMcpConnectionDetails(next, copy);
                    if (!details) throw new Error('MCP connection details unavailable.');
                    return new Blob([details], { type: 'text/plain' });
                });
                // Observe data even if construction/write throws or the clipboard rejects before native status arrives.
                void data.catch(() => {});
                try {
                    // WebKit requires starting the write in the click gesture; native data resolves afterward.
                    clipboardResult = navigator.clipboard.write([new ClipboardItem({ 'text/plain': data })]).then(() => true, () => false);
                } catch {
                    clipboardResult = Promise.resolve(false);
                }
            }
            const next = await request;
            if (!mounted.current) return;
            setStatus(next);
            if (config?.port !== undefined && !next.error) {
                setPortDraft(null);
                setPortInvalid(false);
            }
            if (copy) {
                const details = getMcpConnectionDetails(next, copy);
                if (!details) {
                    setFeedback('settings.mcpCopyFailed');
                    reportOutcome('invalid-status');
                    return;
                }
                if (!clipboardResult) {
                    try {
                        clipboardResult = navigator.clipboard.writeText(details).then(() => true, () => false);
                    } catch {
                        clipboardResult = Promise.resolve(false);
                    }
                }
                const copied = await clipboardResult;
                if (mounted.current) {
                    setFeedback(copied ? 'settings.mcpCopied' : 'settings.mcpCopyFailed');
                    reportOutcome(copied ? 'copied' : 'clipboard-failed');
                }
            } else if (config?.regenerateToken) {
                if (!next.error && getMcpConnectionDetails(next)) {
                    setFeedback('settings.mcpTokenRotated');
                    reportOutcome('rotated');
                } else {
                    if (!next.error) setFailed(true);
                    reportOutcome('invalid-status');
                }
            }
        } catch {
            if (mounted.current) {
                setFailed(true);
                setStatus((current) => current ? { ...current, running: false, url: null, token: null } : null);
                reportOutcome('native-failed');
            }
        } finally {
            // A rejected native read must not release the action lock while its clipboard write is still settling.
            if (clipboardResult) await clipboardResult;
            inFlight.current = false;
            if (mounted.current) setBusy(false);
        }
    };

    const error = failed ? 'config_failed' : status?.error;
    return (
        <SettingsDisclosureCard
            sectionKey="mcpTitle"
            title={t('settings.mcpTitle')} description={t('settings.mcpDesc')}
            open={open} onToggle={() => setOpen((value) => !value)}
        >
            <div className="p-4 space-y-4" aria-busy={busy}>
                {!available ? <p className="text-sm text-muted-foreground">{t('settings.mcpUnavailable')}</p> : <>
                    <SettingRow settingsKey={null} title={t('settings.mcpEnable')} description={t('settings.mcpReadPermission')}>
                        <Switch aria-label={t('settings.mcpEnable')} checked={status?.enabled ?? false}
                            disabled={busy || !status} onCheckedChange={(enabled) => void runAction({ enabled, allowWrite: status?.allowWrite ?? false })} />
                    </SettingRow>
                    <p className="text-xs text-muted-foreground">{t('settings.mcpPrivacy')}</p>
                    <p className="text-sm" role="status">
                        {busy || (!status && !error) ? t('common.loading') : t(status?.running ? 'settings.mcpRunning' : 'settings.mcpStopped')}
                    </p>
                    {error && <p className="text-sm text-destructive" role="alert">{t(`settings.mcpError.${error}`)}</p>}
                    {(error || (status?.enabled && !status.running)) && <button type="button" className={actionClass} disabled={busy}
                        onClick={() => void runAction(status ? { enabled: status.enabled, allowWrite: status.allowWrite } : undefined)}>{t('common.retry')}</button>}
                    {status?.enabled && <>
                        <SettingRow settingsKey={null} title={t('settings.mcpAllowWrite')} description={t('settings.mcpAllowWriteDesc')}>
                            <Switch aria-label={t('settings.mcpAllowWrite')} checked={status.allowWrite} disabled={busy}
                                onCheckedChange={(allowWrite) => void runAction({ enabled: true, allowWrite })} />
                        </SettingRow>
                        {status.running && status.url && <p className="text-xs font-mono break-all">{status.url}</p>}
                        <p className="text-xs text-muted-foreground">{t('settings.mcpCopyHint')}</p>
                        <div className="flex flex-wrap gap-2">
                            <button type="button" className={actionClass} disabled={busy || !status.running || !status.token}
                                onClick={() => void runAction(undefined, 'json')}>{t('settings.mcpCopy')}</button>
                            <button type="button" className={actionClass} disabled={busy || !status.running || !status.token}
                                onClick={() => void runAction(undefined, 'codex')}>{t('settings.mcpCopyCodex')}</button>
                            <button type="button" className={actionClass} disabled={busy}
                                onClick={() => void runAction({ enabled: true, allowWrite: status.allowWrite, regenerateToken: true })}>{t('settings.mcpRotate')}</button>
                        </div>
                        <p className="text-xs text-muted-foreground">{t('settings.mcpRotateHint')}</p>
                    </>}
                    {status && <SettingsDisclosureCard sectionKey="mcpAdvanced" settingsKey={null}
                        title={t('settings.advanced')} open={advancedOpen} onToggle={() => setAdvancedOpen((value) => !value)}>
                        <div className="p-4 space-y-4">
                            <SettingRow settingsKey={null} title={t('settings.mcpAllowArchive')} description={t('settings.mcpAllowArchiveDesc')}>
                                <Switch aria-label={t('settings.mcpAllowArchive')} checked={status.allowArchive} disabled={busy}
                                    onCheckedChange={(allowArchive) => void runAction({ enabled: status.enabled, allowWrite: status.allowWrite, allowArchive })} />
                            </SettingRow>
                            <SettingRow settingsKey={null} title={t('settings.mcpAllowDelete')} description={t('settings.mcpAllowDeleteDesc')}>
                                <Switch aria-label={t('settings.mcpAllowDelete')} checked={status.allowDelete} disabled={busy}
                                    onCheckedChange={(allowDelete) => void runAction({ enabled: status.enabled, allowWrite: status.allowWrite, allowDelete })} />
                            </SettingRow>
                            <form noValidate onSubmit={(event) => {
                                event.preventDefault();
                                const value = portDraft ?? String(status.port);
                                const port = Number(value);
                                if (!/^\d+$/.test(value) || !Number.isInteger(port) || port < 1024 || port > 65535) {
                                    setPortInvalid(true);
                                    return;
                                }
                                void runAction({ enabled: status.enabled, allowWrite: status.allowWrite, port });
                            }} className="space-y-2">
                                <label htmlFor="mcp-port" className="text-sm font-medium">{t('settings.mcpPort')}</label>
                                <p id="mcp-port-hint" className="text-xs text-muted-foreground">{t('settings.mcpPortDesc')}</p>
                                <div className="flex flex-wrap items-center gap-2">
                                    <input id="mcp-port" type="number" min={1024} max={65535} step={1}
                                        aria-describedby="mcp-port-hint" aria-invalid={portInvalid} disabled={busy}
                                        value={portDraft ?? status.port} onChange={(event) => { setPortDraft(event.target.value); setPortInvalid(false); }}
                                        className="w-28 bg-background border border-border rounded-md px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
                                    <button type="submit" className={actionClass} disabled={busy || portDraft === null || portDraft === String(status.port)}>{t('common.save')}</button>
                                </div>
                                {portInvalid && <p className="text-sm text-destructive" role="alert">{t('settings.mcpError.invalid_port')}</p>}
                            </form>
                        </div>
                    </SettingsDisclosureCard>}
                    {feedback && <p className="text-xs" role="status">{t(feedback)}</p>}
                </>}
            </div>
        </SettingsDisclosureCard>
    );
}
