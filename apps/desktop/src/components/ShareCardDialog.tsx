import { useMemo, useState } from 'react';
import {
    renderShareCardSvg,
    SHARE_CARD_REFLECTION_LIMIT,
    type ShareCardStyle,
} from '@mindwtr/core/share-card';
import { Copy, Download, Image as ImageIcon, X } from 'lucide-react';

import { Button } from './ui/Button';
import { Dialog, DialogBody, DialogFooter, DialogHeader } from './ui/Dialog';
import {
    canCopyShareCardPng,
    copyShareCardPng,
    renderSvgToPng,
    saveShareCardPng,
} from '../lib/share-card-export';

type ShareCardDialogProps = {
    onClose: () => void;
    reviewDate: string;
    t: (key: string) => string;
};

type PendingOperation = 'copy' | 'save' | null;

const toSvgDataUrl = (svg: string) =>
    `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

const SHARE_CARD_STYLES: Array<{
    id: ShareCardStyle;
    labelKey: string;
}> = [
    { id: 'reflection', labelKey: 'shareCard.styleReflection' },
    { id: 'minimal', labelKey: 'shareCard.styleMinimal' },
    { id: 'ripple', labelKey: 'shareCard.styleRipple' },
];

export function ShareCardDialog({
    onClose,
    reviewDate,
    t,
}: ShareCardDialogProps) {
    const [reflection, setReflection] = useState('');
    const [style, setStyle] = useState<ShareCardStyle>('reflection');
    const [pending, setPending] = useState<PendingOperation>(null);
    const [message, setMessage] = useState<string | null>(null);

    const svgResult = useMemo(() => {
        try {
            return {
                svg: renderShareCardSvg(
                    {
                        kind: 'review',
                        reviewDate,
                        reflection,
                        style,
                    },
                    t,
                ),
                failed: false,
            };
        } catch {
            return { svg: '', failed: true };
        }
    }, [reflection, reviewDate, style, t]);

    const reflectionLength = Array.from(reflection).length;

    const busy = pending !== null;
    const errorMessage = svgResult.failed ? t('shareCard.error') : message;

    const exportImage = async (operation: Exclude<PendingOperation, null>) => {
        if (!svgResult.svg || busy) return;
        setPending(operation);
        setMessage(null);
        try {
            const png = await renderSvgToPng(svgResult.svg);
            if (operation === 'copy') {
                await copyShareCardPng(png, 'review');
                setMessage(t('shareCard.copied'));
            } else {
                const saved = await saveShareCardPng(
                    png,
                    'review',
                    t('shareCard.save'),
                );
                if (saved) setMessage(t('shareCard.saved'));
            }
        } catch {
            setMessage(t('shareCard.error'));
        } finally {
            setPending(null);
        }
    };

    return (
        <Dialog
            onClose={() => {
                if (!busy) onClose();
            }}
            labelledBy="share-card-dialog-title"
            describedBy="share-card-privacy"
            closeOnBackdrop={!busy}
            closeOnEscape={!busy}
            panelClassName="mx-4 max-w-4xl bg-card"
        >
            <DialogHeader className="flex items-center justify-between border-b border-border px-5 py-4">
                <h2
                    id="share-card-dialog-title"
                    className="flex items-center gap-2 text-base font-semibold"
                >
                    <ImageIcon
                        className="h-4 w-4 text-primary"
                        aria-hidden="true"
                    />
                    {t('shareCard.title')}
                </h2>
                <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={onClose}
                    disabled={busy}
                    aria-label={t('shareCard.close')}
                >
                    <X className="h-4 w-4" aria-hidden="true" />
                </Button>
            </DialogHeader>

            <DialogBody className="grid gap-6 p-5 md:grid-cols-[minmax(0,1fr)_15rem] md:items-start">
                <figure
                    className="mx-auto w-full"
                    style={{ maxWidth: 'min(30rem, calc(85vh - 11rem))' }}
                >
                    <div
                        className="aspect-square overflow-hidden rounded-xl shadow-[0_16px_40px_rgba(15,39,71,0.16)]"
                        style={{
                            backgroundColor:
                                style === 'ripple' ? '#102e52' : '#f7fbfc',
                        }}
                    >
                        {svgResult.svg ? (
                            <img
                                src={toSvgDataUrl(svgResult.svg)}
                                alt={t('shareCard.preview')}
                                className="h-full w-full object-contain"
                            />
                        ) : (
                            <div className="flex h-full items-center justify-center p-8 text-center text-sm text-foreground">
                                {t('shareCard.error')}
                            </div>
                        )}
                    </div>
                </figure>

                <div className="space-y-5">
                    <p
                        id="share-card-privacy"
                        className="text-sm leading-6 text-muted-foreground"
                    >
                        {t('shareCard.privacy')}
                    </p>

                    <div className="space-y-2">
                        <span className="block text-sm font-medium text-foreground">
                            {t('shareCard.styleLabel')}
                        </span>
                        <div
                            className="grid grid-cols-3 gap-1 rounded-lg bg-muted/60 p-1"
                            role="group"
                            aria-label={t('shareCard.styleLabel')}
                        >
                            {SHARE_CARD_STYLES.map((option) => {
                                const selected = style === option.id;
                                return (
                                    <button
                                        key={option.id}
                                        type="button"
                                        aria-pressed={selected}
                                        disabled={busy}
                                        onClick={() => {
                                            setMessage(null);
                                            setStyle(option.id);
                                        }}
                                        className={`min-h-11 rounded-md px-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60 ${
                                            selected
                                                ? 'bg-card text-foreground shadow-sm'
                                                : 'text-muted-foreground hover:bg-card/60 hover:text-foreground'
                                        }`}
                                    >
                                        {t(option.labelKey)}
                                    </button>
                                );
                            })}
                        </div>
                    </div>

                    <div className="space-y-2">
                        <label
                            htmlFor="share-card-reflection"
                            className="block text-sm font-medium text-foreground"
                        >
                            {t('shareCard.reflectionLabel')}
                        </label>
                        <textarea
                            id="share-card-reflection"
                            value={reflection}
                            disabled={busy}
                            onChange={(event) => {
                                setMessage(null);
                                setReflection(
                                    Array.from(event.target.value)
                                        .slice(0, SHARE_CARD_REFLECTION_LIMIT)
                                        .join(''),
                                );
                            }}
                            placeholder={t('shareCard.reflectionPlaceholder')}
                            rows={5}
                            className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2.5 text-sm font-normal leading-5 text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
                        />
                        {!reflection.trim() && (
                            <p className="text-xs leading-4 text-muted-foreground">
                                {t('shareCard.defaultHint')}
                            </p>
                        )}
                        <span className="block text-right text-xs font-normal tabular-nums text-muted-foreground">
                            {reflectionLength}/{SHARE_CARD_REFLECTION_LIMIT}
                        </span>
                    </div>

                    <p
                        className="min-h-5 text-sm"
                        role={
                            errorMessage === t('shareCard.error')
                                ? 'alert'
                                : 'status'
                        }
                        aria-live="polite"
                    >
                        {errorMessage && (
                            <span
                                className={
                                    errorMessage === t('shareCard.error')
                                        ? 'text-destructive'
                                        : 'text-muted-foreground'
                                }
                            >
                                {errorMessage}
                            </span>
                        )}
                    </p>
                </div>
            </DialogBody>

            <DialogFooter className="flex flex-wrap items-center justify-end gap-2 border-t border-border bg-muted/20 px-5 py-4">
                <Button variant="ghost" onClick={onClose} disabled={busy}>
                    {t('shareCard.close')}
                </Button>
                {canCopyShareCardPng() && (
                    <Button
                        variant="outline"
                        onClick={() => void exportImage('copy')}
                        loading={pending === 'copy'}
                        disabled={busy || svgResult.failed}
                        leadingIcon={
                            <Copy className="h-4 w-4" aria-hidden="true" />
                        }
                    >
                        {pending === 'copy'
                            ? t('shareCard.generating')
                            : t('shareCard.copy')}
                    </Button>
                )}
                <Button
                    onClick={() => void exportImage('save')}
                    loading={pending === 'save'}
                    disabled={busy || svgResult.failed}
                    leadingIcon={
                        <Download className="h-4 w-4" aria-hidden="true" />
                    }
                >
                    {pending === 'save'
                        ? t('shareCard.generating')
                        : t('shareCard.save')}
                </Button>
            </DialogFooter>
        </Dialog>
    );
}
