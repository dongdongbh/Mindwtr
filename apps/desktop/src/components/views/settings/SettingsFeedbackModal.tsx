import { useEffect, useId, useRef, useState } from 'react';
import { Bug, ExternalLink, Lightbulb, MessageSquare, Send, X } from 'lucide-react';

import { FEEDBACK_CATEGORIES, type FeedbackCategory } from '@mindwtr/core';
import { cn } from '../../../lib/utils';
import { Dialog, DialogBody, DialogHeader } from '../../ui/Dialog';
import { Button } from '../../ui/Button';
import { Switch } from '../../ui/Switch';

type Labels = {
    feedback: string;
    feedbackDesc: string;
    feedbackCategory: string;
    feedbackCategoryBug: string;
    feedbackCategoryFeature: string;
    feedbackCategoryOther: string;
    feedbackMessage: string;
    feedbackMessagePlaceholder: string;
    feedbackMessagePlaceholderBug: string;
    feedbackMessagePlaceholderFeature: string;
    feedbackMessagePlaceholderOther: string;
    feedbackWhere: string;
    feedbackWherePlaceholder: string;
    feedbackWhereMessagePrefix: string;
    feedbackWhereInbox: string;
    feedbackWhereFocus: string;
    feedbackWhereProjects: string;
    feedbackWhereReview: string;
    feedbackWhereSettings: string;
    feedbackWhereSync: string;
    feedbackWhereImportExport: string;
    feedbackWhereNotifications: string;
    feedbackWhereOther: string;
    feedbackEmail: string;
    feedbackEmailPlaceholder: string;
    feedbackIncludeDiagnostics: string;
    feedbackIncludeDiagnosticsDesc: string;
    feedbackPrivacy: string;
    feedbackSubmit: string;
    feedbackSending: string;
    feedbackSent: string;
    feedbackFailed: string;
    feedbackUnavailable: string;
    feedbackUnavailableDesc: string;
    feedbackOpenGitHubIssue: string;
    feedbackGitHubDesc: string;
    feedbackOpenGitHubDiscussion: string;
    feedbackRequired: string;
    feedbackInvalidEmail: string;
    close: string;
};

export type FeedbackSubmitInput = {
    category: FeedbackCategory;
    message: string;
    email?: string;
    includeDiagnostics: boolean;
};

type SettingsFeedbackModalProps = {
    isOpen: boolean;
    isConfigured: boolean;
    t: Labels;
    onClose: () => void;
    onOpenGitHub?: (category: FeedbackCategory) => void;
    onSubmit: (input: FeedbackSubmitInput) => Promise<void>;
};

const categoryIcons: Record<FeedbackCategory, typeof Bug> = {
    bug: Bug,
    feature: Lightbulb,
    other: MessageSquare,
};

const feedbackLocations = [
    'inbox',
    'focus',
    'projects',
    'review',
    'settings',
    'sync',
    'importExport',
    'notifications',
    'other',
] as const;

type FeedbackLocation = typeof feedbackLocations[number];

export function SettingsFeedbackModal({
    isConfigured,
    isOpen,
    onClose,
    onOpenGitHub,
    onSubmit,
    t,
}: SettingsFeedbackModalProps) {
    const [category, setCategory] = useState<FeedbackCategory>('bug');
    const [message, setMessage] = useState('');
    const [email, setEmail] = useState('');
    const [bugLocation, setBugLocation] = useState<FeedbackLocation | ''>('');
    const [includeDiagnostics, setIncludeDiagnostics] = useState(false);
    const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
    const [error, setError] = useState<string | null>(null);
    const modalRef = useRef<HTMLDivElement>(null);
    const messageRef = useRef<HTMLTextAreaElement>(null);
    const titleId = useId();
    const descriptionId = useId();
    const diagnosticsDescriptionId = useId();

    const categoryLabels: Record<FeedbackCategory, string> = {
        bug: t.feedbackCategoryBug,
        feature: t.feedbackCategoryFeature,
        other: t.feedbackCategoryOther,
    };
    const messagePlaceholders: Record<FeedbackCategory, string> = {
        bug: t.feedbackMessagePlaceholderBug || t.feedbackMessagePlaceholder,
        feature: t.feedbackMessagePlaceholderFeature || t.feedbackMessagePlaceholder,
        other: t.feedbackMessagePlaceholderOther || t.feedbackMessagePlaceholder,
    };
    const locationLabels: Record<FeedbackLocation, string> = {
        inbox: t.feedbackWhereInbox,
        focus: t.feedbackWhereFocus,
        projects: t.feedbackWhereProjects,
        review: t.feedbackWhereReview,
        settings: t.feedbackWhereSettings,
        sync: t.feedbackWhereSync,
        importExport: t.feedbackWhereImportExport,
        notifications: t.feedbackWhereNotifications,
        other: t.feedbackWhereOther,
    };

    useEffect(() => {
        if (!isOpen) return;
        setStatus('idle');
        setError(null);
        const timer = window.setTimeout(() => messageRef.current?.focus(), 50);
        return () => window.clearTimeout(timer);
    }, [isOpen]);

    useEffect(() => {
        if (category === 'bug') return;
        setIncludeDiagnostics(false);
        setBugLocation('');
    }, [category]);

    if (!isOpen || typeof document === 'undefined') return null;

    const trimmedMessage = message.trim();
    const trimmedEmail = email.trim();
    const emailValid = !trimmedEmail || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail);
    const canSubmit = isConfigured && trimmedMessage.length > 0 && emailValid && status !== 'sending';
    const visibleError = error
        ?? (trimmedEmail && !emailValid ? t.feedbackInvalidEmail : null);

    const handleSubmit = async () => {
        if (!trimmedMessage) {
            setError(t.feedbackRequired);
            return;
        }
        if (!emailValid) {
            setError(t.feedbackInvalidEmail);
            return;
        }
        setStatus('sending');
        setError(null);
        const submittedMessage = category === 'bug' && bugLocation
            ? `${t.feedbackWhereMessagePrefix}: ${locationLabels[bugLocation]}\n\n${trimmedMessage}`
            : trimmedMessage;
        try {
            await onSubmit({
                category,
                email: trimmedEmail || undefined,
                includeDiagnostics: category === 'bug' && includeDiagnostics,
                message: submittedMessage,
            });
            setStatus('sent');
            setMessage('');
            setEmail('');
            setBugLocation('');
            setIncludeDiagnostics(false);
        } catch {
            setStatus('error');
            setError(t.feedbackFailed);
        }
    };

    return (
        <Dialog
            onClose={onClose}
            labelledBy={titleId}
            describedBy={descriptionId}
            placement="top"
            overlayClassName="px-4 pt-[12vh]"
            // Capped to fit under the 12vh offset: the form is taller than a
            // short window, and without this the Send button sat off-screen
            // with nothing to scroll (#957).
            panelClassName="max-h-[84vh] max-w-lg border-border"
            panelRef={modalRef}
        >
            <DialogHeader className="flex items-start justify-between gap-4 border-b border-border px-4 py-3">
                <div>
                    <h3 id={titleId} className="text-base font-semibold">{t.feedback}</h3>
                    <p id={descriptionId} className="mt-1 text-xs leading-5 text-muted-foreground">
                        {t.feedbackDesc}
                    </p>
                </div>
                <button
                    type="button"
                    className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    aria-label={t.close}
                    onClick={onClose}
                >
                    <X className="h-4 w-4" />
                </button>
            </DialogHeader>

            {status === 'sent' ? (
                <DialogBody className="space-y-4 p-4">
                    <div className="rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">
                        {t.feedbackSent}
                    </div>
                    <div className="flex justify-end">
                        <Button onClick={onClose}>{t.close}</Button>
                    </div>
                </DialogBody>
            ) : (
                <DialogBody className="space-y-4 p-4">
                    {onOpenGitHub && (
                        <div className="border-b border-border pb-3">
                            <button
                                type="button"
                                className="inline-flex min-h-11 items-center gap-2 text-sm font-medium text-primary underline underline-offset-4 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                onClick={() => onOpenGitHub(category)}
                            >
                                {category === 'other' ? t.feedbackOpenGitHubDiscussion : t.feedbackOpenGitHubIssue}
                                <ExternalLink className="h-4 w-4 shrink-0" aria-hidden="true" />
                            </button>
                            <p className="text-xs leading-5 text-muted-foreground">{t.feedbackGitHubDesc}</p>
                        </div>
                    )}
                    <div className="space-y-2">
                        <label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                            {t.feedbackCategory}
                        </label>
                        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                            {FEEDBACK_CATEGORIES.map((item) => {
                                const Icon = categoryIcons[item];
                                const selected = item === category;
                                return (
                                    <button
                                        key={item}
                                        type="button"
                                        className={cn(
                                            'flex min-h-10 items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition-colors',
                                            selected
                                                ? 'border-primary bg-primary/10 text-primary'
                                                : 'border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground',
                                        )}
                                        onClick={() => setCategory(item)}
                                    >
                                        <Icon className="h-4 w-4" />
                                        <span>{categoryLabels[item]}</span>
                                    </button>
                                );
                            })}
                        </div>
                    </div>

                    {category === 'bug' && (
                        <label className="block space-y-2">
                            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                                {t.feedbackWhere}
                            </span>
                            <select
                                value={bugLocation}
                                onChange={(event) => {
                                    setBugLocation(event.target.value as FeedbackLocation | '');
                                    setError(null);
                                }}
                                aria-label={t.feedbackWhere}
                                className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:ring-2 focus:ring-primary/40"
                            >
                                <option value="">{t.feedbackWherePlaceholder}</option>
                                {feedbackLocations.map((location) => (
                                    <option key={location} value={location}>
                                        {locationLabels[location]}
                                    </option>
                                ))}
                            </select>
                        </label>
                    )}

                    <label className="block space-y-2">
                        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                            {t.feedbackMessage}
                        </span>
                        <textarea
                            ref={messageRef}
                            value={message}
                            onChange={(event) => {
                                setMessage(event.target.value);
                                setError(null);
                            }}
                            placeholder={messagePlaceholders[category]}
                            maxLength={4000}
                            className="min-h-32 w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm leading-5 text-foreground outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-primary/40"
                        />
                    </label>

                    <label className="block space-y-2">
                        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                            {t.feedbackEmail}
                        </span>
                        <input
                            type="email"
                            value={email}
                            onChange={(event) => {
                                setEmail(event.target.value);
                                setError(null);
                            }}
                            placeholder={t.feedbackEmailPlaceholder}
                            className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:ring-2 focus:ring-primary/40"
                        />
                    </label>

                    {category === 'bug' && (
                        <div className="flex items-start justify-between gap-4 rounded-lg border border-border bg-card px-3 py-3">
                            <div>
                                <span className="block text-sm font-medium">{t.feedbackIncludeDiagnostics}</span>
                                <span
                                    id={diagnosticsDescriptionId}
                                    className="block text-xs leading-5 text-muted-foreground"
                                >
                                    {t.feedbackIncludeDiagnosticsDesc}
                                </span>
                            </div>
                            <Switch
                                aria-label={t.feedbackIncludeDiagnostics}
                                aria-describedby={diagnosticsDescriptionId}
                                checked={includeDiagnostics}
                                onCheckedChange={setIncludeDiagnostics}
                            />
                        </div>
                    )}

                    <p className="rounded-lg bg-muted/50 px-3 py-2 text-xs leading-5 text-muted-foreground">
                        {t.feedbackPrivacy}
                    </p>

                    {!isConfigured && (
                        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                            <div className="font-medium">{t.feedbackUnavailable}</div>
                            <div className="mt-1 text-xs leading-5">{t.feedbackUnavailableDesc}</div>
                        </div>
                    )}

                    {visibleError && (
                        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                            {visibleError}
                        </div>
                    )}

                    <div className="flex justify-end gap-2">
                        <Button variant="secondary" onClick={onClose}>
                            {t.close}
                        </Button>
                        <Button onClick={handleSubmit} disabled={!canSubmit}>
                            <Send className="h-4 w-4" />
                            {status === 'sending' ? t.feedbackSending : t.feedbackSubmit}
                        </Button>
                    </div>
                </DialogBody>
            )}
        </Dialog>
    );
}
