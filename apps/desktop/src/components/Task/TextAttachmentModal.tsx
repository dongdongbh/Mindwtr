import type { Attachment } from '@mindwtr/core';

type TextAttachmentModalProps = {
    attachment: Attachment | null;
    textContent: string;
    textLoading: boolean;
    textError: string | null;
    onClose: () => void;
    onOpenExternally: () => void;
    t: (key: string) => string;
};

export function TextAttachmentModal({
    attachment,
    textContent,
    textLoading,
    textError,
    onClose,
    onOpenExternally,
    t,
}: TextAttachmentModalProps) {
    if (!attachment) return null;
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
            <div className="w-full max-w-3xl rounded-lg border border-border bg-card p-4 shadow-xl">
                <div className="flex items-center justify-between">
                    <div className="text-sm font-medium">{attachment.title || t('attachments.open')}</div>
                    <button
                        type="button"
                        onClick={onClose}
                        className="text-xs text-muted-foreground hover:text-foreground"
                    >
                        {t('common.close')}
                    </button>
                </div>
                <div className="mt-3">
                    {textLoading ? (
                        <div className="text-xs text-muted-foreground" aria-live="polite">{t('common.loading')}</div>
                    ) : textError ? (
                        <div className="flex items-center justify-between text-xs text-red-500" role="alert" aria-live="assertive">
                            <span>{textError}</span>
                            <button
                                type="button"
                                onClick={onOpenExternally}
                                className="text-xs text-muted-foreground hover:text-foreground"
                            >
                                {t('attachments.open')}
                            </button>
                        </div>
                    ) : (
                        <pre className="max-h-[60vh] overflow-auto rounded border border-border bg-muted/30 p-3 text-xs text-foreground whitespace-pre-wrap">
                            {textContent}
                        </pre>
                    )}
                </div>
            </div>
        </div>
    );
}
