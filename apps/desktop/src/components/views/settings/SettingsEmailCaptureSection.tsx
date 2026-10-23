import { useCallback, useEffect, useState } from 'react';
import { getDocsGuideUrl, safeFormatDate } from '@mindwtr/core';
import { useDocumentationLanguage } from '../../../contexts/language-context';
import { ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';

import { Switch } from '../../ui/Switch';
import { SettingField } from './SettingRow';
import { SettingsGmailCaptureSection } from './SettingsGmailCaptureSection';
import {
    DEFAULT_EMAIL_CAPTURE_FOLDER,
    DEFAULT_EMAIL_CAPTURE_PORT,
    getEmailCaptureConfig,
    getEmailCaptureStatus,
    pollEmailCaptureNow,
    setEmailCaptureConfig,
    subscribeEmailCaptureStatus,
    toEmailCaptureError,
    type EmailCaptureStatus,
} from '../../../lib/email-capture';
import { useUiStore } from '../../../store/ui-store';

type Labels = {
    emailCaptureGuideTitle: string;
    emailCapture: string;
    emailCaptureDesc: string;
    emailCaptureHost: string;
    emailCapturePort: string;
    emailCaptureUsername: string;
    emailCapturePassword: string;
    emailCapturePasswordHint: string;
    emailCapturePasswordStored: string;
    emailCaptureFolder: string;
    emailCaptureFolderHint: string;
    emailCaptureSave: string;
    emailCaptureRemove: string;
    emailCaptureCheckNow: string;
    emailCaptureChecking: string;
    emailCaptureLastChecked: string;
    emailCaptureNeverChecked: string;
    emailCaptureImportedCount: string;
    emailCaptureSaveFailed: string;
};

type SettingsEmailCaptureSectionProps = {
    t: Labels;
    isTauri: boolean;
    showSaved: () => void;
};

export function SettingsEmailCaptureSection({ t, isTauri, showSaved }: SettingsEmailCaptureSectionProps) {
    const language = useDocumentationLanguage();
    const showToast = useUiStore((state) => state.showToast);
    const [open, setOpen] = useState(false);
    const [enabled, setEnabled] = useState(false);
    const [host, setHost] = useState('');
    const [portText, setPortText] = useState(String(DEFAULT_EMAIL_CAPTURE_PORT));
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [hasPassword, setHasPassword] = useState(false);
    const [folder, setFolder] = useState(DEFAULT_EMAIL_CAPTURE_FOLDER);
    const [isSaving, setIsSaving] = useState(false);
    const [isChecking, setIsChecking] = useState(false);
    const [status, setStatus] = useState<EmailCaptureStatus>(() => getEmailCaptureStatus());

    useEffect(() => {
        if (!isTauri) return;
        let cancelled = false;
        (async () => {
            try {
                const config = await getEmailCaptureConfig();
                if (cancelled) return;
                setEnabled(config.enabled);
                setHost(config.host);
                setPortText(String(config.port || DEFAULT_EMAIL_CAPTURE_PORT));
                setUsername(config.username);
                setFolder(config.folder || DEFAULT_EMAIL_CAPTURE_FOLDER);
                setHasPassword(config.hasPassword);
            } catch {
                // Leave the defaults; the section stays editable.
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [isTauri]);

    useEffect(() => subscribeEmailCaptureStatus(setStatus), []);

    const handleSave = useCallback(async () => {
        setIsSaving(true);
        try {
            const port = Number.parseInt(portText, 10);
            const config = await setEmailCaptureConfig({
                enabled,
                host,
                port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : DEFAULT_EMAIL_CAPTURE_PORT,
                username,
                folder,
            }, password);
            setEnabled(config.enabled);
            setHost(config.host);
            setPortText(String(config.port || DEFAULT_EMAIL_CAPTURE_PORT));
            setUsername(config.username);
            setFolder(config.folder || DEFAULT_EMAIL_CAPTURE_FOLDER);
            setHasPassword(config.hasPassword);
            setPassword('');
            showSaved();
        } catch (error) {
            const info = toEmailCaptureError(error);
            // An enable that fails its connection check is persisted disabled.
            setEnabled(false);
            showToast(info.message || t.emailCaptureSaveFailed, 'error', 6000);
        } finally {
            setIsSaving(false);
        }
    }, [enabled, folder, host, password, portText, showSaved, showToast, t.emailCaptureSaveFailed, username]);

    const handleRemove = useCallback(async () => {
        setIsSaving(true);
        try {
            await setEmailCaptureConfig({
                enabled: false,
                host: '',
                port: DEFAULT_EMAIL_CAPTURE_PORT,
                username: '',
                folder: DEFAULT_EMAIL_CAPTURE_FOLDER,
            });
            setEnabled(false);
            setHost('');
            setPortText(String(DEFAULT_EMAIL_CAPTURE_PORT));
            setUsername('');
            setPassword('');
            setHasPassword(false);
            setFolder(DEFAULT_EMAIL_CAPTURE_FOLDER);
            showSaved();
        } catch (error) {
            showToast(toEmailCaptureError(error).message || t.emailCaptureSaveFailed, 'error');
        } finally {
            setIsSaving(false);
        }
    }, [showSaved, showToast, t.emailCaptureSaveFailed]);

    const handleCheckNow = useCallback(async () => {
        setIsChecking(true);
        try {
            await pollEmailCaptureNow();
        } finally {
            setIsChecking(false);
        }
    }, []);

    const statusLine = status.lastPollAt
        ? safeFormatDate(status.lastPollAt, 'PPpp', status.lastPollAt)
        : t.emailCaptureNeverChecked;

    return (
        <>
        <SettingsGmailCaptureSection isTauri={isTauri} showSaved={showSaved} />
        <div className="bg-card border border-border rounded-lg">
            <div className="p-4 flex items-start justify-between gap-4">
                <div className="min-w-0 flex-1 space-y-2">
                    <button data-settings-key="emailCapture" data-settings-section="emailCapture"
                        type="button"
                        onClick={() => setOpen((prev) => !prev)}
                        aria-expanded={open}
                        className="w-full text-left flex items-center justify-between gap-4"
                    >
                        <div className="min-w-0">
                            <div className="text-sm font-medium">{t.emailCapture}</div>
                            <p className="text-xs text-muted-foreground mt-1">{t.emailCaptureDesc}</p>
                        </div>
                        {open ? <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" /> : <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />}
                    </button>
                    <a
                        href={getDocsGuideUrl('power-users/email-capture', language)}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
                    >
                        {t.emailCaptureGuideTitle}
                        <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />
                    </a>
                </div>
                <Switch
                    aria-label={t.emailCapture}
                    checked={enabled}
                    onCheckedChange={setEnabled}
                />
            </div>
            {open && (
                <div className="border-t border-border p-4 space-y-4">
                    <div className="grid grid-cols-1 sm:grid-cols-[1fr_8rem] gap-3">
                        <SettingField settingsKey="emailCaptureHost" title={t.emailCaptureHost}>
                            <input
                                type="text"
                                value={host}
                                aria-label={t.emailCaptureHost}
                                onChange={(event) => setHost(event.target.value)}
                                placeholder="imap.gmail.com"
                                className="bg-muted p-2 rounded text-sm font-mono border border-border focus:outline-none focus:ring-2 focus:ring-primary"
                            />
                        </SettingField>
                        <SettingField settingsKey="emailCapturePort" title={t.emailCapturePort}>
                            <input
                                type="number"
                                value={portText}
                                aria-label={t.emailCapturePort}
                                onChange={(event) => setPortText(event.target.value)}
                                min={1}
                                max={65535}
                                className="bg-muted p-2 rounded text-sm font-mono border border-border focus:outline-none focus:ring-2 focus:ring-primary"
                            />
                        </SettingField>
                    </div>

                    <SettingField settingsKey="emailCaptureUsername" title={t.emailCaptureUsername}>
                        <input
                            type="text"
                            value={username}
                            aria-label={t.emailCaptureUsername}
                            onChange={(event) => setUsername(event.target.value)}
                            placeholder="you@example.com"
                            autoComplete="off"
                            className="bg-muted p-2 rounded text-sm font-mono border border-border focus:outline-none focus:ring-2 focus:ring-primary"
                        />
                    </SettingField>

                    <SettingField settingsKey="emailCapturePassword" title={t.emailCapturePassword}>
                        <input
                            type="password"
                            value={password}
                            aria-label={t.emailCapturePassword}
                            onChange={(event) => setPassword(event.target.value)}
                            placeholder={hasPassword ? '••••••••' : ''}
                            autoComplete="new-password"
                            className="bg-muted p-2 rounded text-sm font-mono border border-border focus:outline-none focus:ring-2 focus:ring-primary"
                        />
                        <p className="text-xs text-muted-foreground">
                            {hasPassword ? t.emailCapturePasswordStored : t.emailCapturePasswordHint}
                        </p>
                    </SettingField>

                    <SettingField settingsKey="emailCaptureFolder" title={t.emailCaptureFolder}>
                        <input
                            type="text"
                            value={folder}
                            aria-label={t.emailCaptureFolder}
                            onChange={(event) => setFolder(event.target.value)}
                            placeholder={DEFAULT_EMAIL_CAPTURE_FOLDER}
                            className="bg-muted p-2 rounded text-sm font-mono border border-border focus:outline-none focus:ring-2 focus:ring-primary"
                        />
                        <p className="text-xs text-muted-foreground">{t.emailCaptureFolderHint}</p>
                    </SettingField>

                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="space-y-1">
                            <p className="text-xs text-muted-foreground">
                                {t.emailCaptureLastChecked}:{' '}
                                <span className="font-medium text-foreground">{statusLine}</span>
                                {status.lastImportCount > 0 && !status.lastError && (
                                    <>
                                        {' · '}
                                        {t.emailCaptureImportedCount.replace('{{count}}', String(status.lastImportCount))}
                                    </>
                                )}
                            </p>
                            {status.lastError && (
                                <p className="text-xs text-warning">{status.lastError.message}</p>
                            )}
                        </div>
                        <div className="flex flex-wrap gap-2">
                            <button
                                type="button"
                                onClick={handleRemove}
                                disabled={isSaving || !host.trim()}
                                className="px-4 py-2 bg-muted text-muted-foreground rounded-md text-sm font-medium hover:bg-muted/80 whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {t.emailCaptureRemove}
                            </button>
                            <button
                                type="button"
                                onClick={handleCheckNow}
                                disabled={isChecking || !enabled || !isTauri}
                                className="px-4 py-2 bg-secondary text-secondary-foreground rounded-md text-sm font-medium hover:bg-secondary/90 whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {isChecking ? t.emailCaptureChecking : t.emailCaptureCheckNow}
                            </button>
                            <button
                                type="button"
                                onClick={handleSave}
                                disabled={isSaving || !isTauri}
                                className="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90 whitespace-nowrap disabled:bg-muted disabled:text-muted-foreground disabled:cursor-not-allowed"
                            >
                                {t.emailCaptureSave}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
        </>
    );
}
