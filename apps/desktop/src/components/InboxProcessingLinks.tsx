import { useState } from 'react';
import { Link as LinkIcon, Plus } from 'lucide-react';
import { formatI18nTemplate, getAttachmentDisplayTitle, isSandboxMode, parseAttachmentLinkBatch, type Attachment } from '@mindwtr/core';
import { openAttachmentTarget } from '../lib/open-attachment-target';
import { PromptModal } from './PromptModal';

export type InboxProcessingLinksProps = {
    t: (key: string) => string;
    attachments: readonly Attachment[];
    onAddLinks: (value: string) => boolean;
};

export function InboxProcessingLinks({ t, attachments, onAddLinks }: InboxProcessingLinksProps) {
    const [showPrompt, setShowPrompt] = useState(false);
    const [openError, setOpenError] = useState('');
    const links = attachments.filter((attachment) => attachment.kind === 'link' && !attachment.deletedAt);
    const openLink = async (attachment: Attachment) => {
        setOpenError('');
        if (isSandboxMode()) {
            setOpenError(t('sandbox.unavailable'));
            return;
        }
        try {
            await openAttachmentTarget(attachment.uri, attachment.id);
        } catch {
            setOpenError(t('attachments.fileNotSupported'));
        }
    };

    return (
        <div className="space-y-1" onKeyDown={(event) => { if (showPrompt) event.stopPropagation(); }}>
            {links.map((attachment) => {
                const title = getAttachmentDisplayTitle(attachment);
                return (
                    <button
                        key={attachment.id}
                        type="button"
                        title={attachment.uri}
                        aria-label={`${t('attachments.open')}: ${title}`}
                        onClick={() => { void openLink(attachment); }}
                        className="flex max-w-full items-center gap-2 rounded px-1 py-1 text-sm text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                    >
                        <LinkIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        <span className="break-all text-left">{title}</span>
                    </button>
                );
            })}
            <button
                type="button"
                onClick={() => setShowPrompt(true)}
                className="inline-flex items-center gap-1 rounded px-1 py-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                {t('attachments.addLink')}
            </button>
            {openError && <p role="alert" className="text-xs text-destructive">{openError}</p>}
            {showPrompt && (
                <PromptModal
                    isOpen
                    title={t('attachments.addLink')}
                    description={t('attachments.linkBatchHint')}
                    placeholder={t('attachments.linkPlaceholder')}
                    multiline
                    validate={(value) => {
                        const { invalidLine } = parseAttachmentLinkBatch(value, true);
                        return invalidLine === null ? null : formatI18nTemplate(t('attachments.invalidLinkLine'), { line: invalidLine });
                    }}
                    confirmLabel={t('common.save')}
                    cancelLabel={t('common.cancel')}
                    onCancel={() => setShowPrompt(false)}
                    onConfirm={(value) => { if (onAddLinks(value)) setShowPrompt(false); }}
                />
            )}
        </div>
    );
}
