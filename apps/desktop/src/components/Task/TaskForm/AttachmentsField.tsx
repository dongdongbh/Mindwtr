import { BookOpen, Edit3, Link2, Paperclip } from 'lucide-react';
import { tFallback, type Attachment } from '@mindwtr/core';
import { useBareFileReferenceCheck, useExternalFileReferenceCheck } from '../../../lib/attachment-reference';
import { getAttachmentDisplayTitle } from '../../../lib/attachment-utils';
import { isImageAttachment } from '../task-item-attachment-utils';
import { AttachmentImage } from '../AttachmentImage';
import { QUICK_ADD_FIELD_TOKENS, QuickAddTokenBadge, taskEditorLabelClassName } from '../task-editor-label';

type AttachmentsFieldProps = {
    t: (key: string) => string;
    attachmentError: string | null;
    visibleEditAttachments: Attachment[];
    addFileAttachment: () => void;
    addLinkAttachment: () => void;
    addObsidianNoteAttachment: () => void;
    showObsidianNoteAttachment: boolean;
    editLinkAttachment: (attachment: Attachment) => void;
    openAttachment: (attachment: Attachment) => void;
    removeAttachment: (id: string) => void;
};

export function AttachmentsField({
    t,
    attachmentError,
    visibleEditAttachments,
    addFileAttachment,
    addLinkAttachment,
    addObsidianNoteAttachment,
    showObsidianNoteAttachment,
    editLinkAttachment,
    openAttachment,
    removeAttachment,
}: AttachmentsFieldProps) {
    const isBareFileReference = useBareFileReferenceCheck();
    // Edit shows for real links and for file attachments pointing outside the
    // managed dir — the pre-#1001-fix "Add link" shape; re-saving one converts
    // it to a true pointer.
    const isExternalFileReference = useExternalFileReferenceCheck();
    const canEditAsLink = (attachment: Attachment) =>
        attachment.kind === 'link' || isExternalFileReference(attachment);
    const imageAttachmentIds = new Set(
        visibleEditAttachments
            .filter((attachment) => (
                isImageAttachment(attachment)
                && Boolean(attachment.uri)
                && attachment.localStatus !== 'missing'
            ))
            .map((attachment) => attachment.id)
    );
    const imageAttachments = visibleEditAttachments.filter((attachment) => imageAttachmentIds.has(attachment.id));
    const otherAttachments = visibleEditAttachments.filter((attachment) => !imageAttachmentIds.has(attachment.id));

    return (
        <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
                <label className={`${taskEditorLabelClassName} inline-flex items-center gap-1.5`}>
                    {t('attachments.title')}
                    <QuickAddTokenBadge t={t} token={QUICK_ADD_FIELD_TOKENS.link} />
                </label>
                <div className="flex items-center gap-2">
                    <button
                        type="button"
                        onClick={addFileAttachment}
                        className="text-xs px-2 py-1 rounded bg-muted/50 hover:bg-muted transition-colors flex items-center gap-1"
                    >
                        <Paperclip className="w-3 h-3" />
                        {t('attachments.addFile')}
                    </button>
                    <button
                        type="button"
                        onClick={addLinkAttachment}
                        className="text-xs px-2 py-1 rounded bg-muted/50 hover:bg-muted transition-colors flex items-center gap-1"
                    >
                        <Link2 className="w-3 h-3" />
                        {t('attachments.addLink')}
                    </button>
                    {showObsidianNoteAttachment && (
                        <button
                            type="button"
                            onClick={addObsidianNoteAttachment}
                            className="text-xs px-2 py-1 rounded bg-muted/50 hover:bg-muted transition-colors flex items-center gap-1"
                        >
                            <BookOpen className="w-3 h-3" />
                            {t('attachments.attachObsidianNote')}
                        </button>
                    )}
                </div>
            </div>
            {attachmentError && (
                <div role="alert" className="text-xs text-destructive">{attachmentError}</div>
            )}
            {visibleEditAttachments.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t('common.none')}</p>
            ) : (
                <div className="space-y-2">
                    {imageAttachments.length > 0 ? (
                        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                            {imageAttachments.map((attachment) => {
                                const displayTitle = getAttachmentDisplayTitle(attachment);
                                const fullTitle = attachment.kind === 'link' ? attachment.uri : attachment.title;
                                return (
                                    <div key={attachment.id} className="rounded-lg border border-border bg-card overflow-hidden">
                                        <button
                                            type="button"
                                            onClick={(event) => {
                                                event.preventDefault();
                                                event.stopPropagation();
                                                openAttachment(attachment);
                                            }}
                                            className="block w-full text-left"
                                            title={fullTitle || displayTitle}
                                            aria-label={`${tFallback(t, 'attachments.open', 'Open')}: ${displayTitle}`}
                                        >
                                            <AttachmentImage
                                                attachment={attachment}
                                                alt={displayTitle}
                                                className="block h-28 w-full object-cover bg-muted/30"
                                            />
                                        </button>
                                        <div className="flex items-center justify-between gap-2 px-2 py-1.5 text-xs">
                                            <button
                                                type="button"
                                                onClick={(event) => {
                                                    event.preventDefault();
                                                    event.stopPropagation();
                                                    openAttachment(attachment);
                                                }}
                                                className="min-w-0 truncate text-primary hover:underline"
                                                title={fullTitle || displayTitle}
                                            >
                                                {displayTitle}
                                            </button>
                                            <div className="flex shrink-0 items-center gap-2">
                                                {canEditAsLink(attachment) && (
                                                    <button
                                                        type="button"
                                                        onClick={() => editLinkAttachment(attachment)}
                                                        className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
                                                    >
                                                        <Edit3 className="h-3 w-3" />
                                                        {t('common.edit')}
                                                    </button>
                                                )}
                                                <button
                                                    type="button"
                                                    onClick={() => removeAttachment(attachment.id)}
                                                    className="text-muted-foreground hover:text-foreground"
                                                >
                                                    {t('attachments.remove')}
                                                </button>
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    ) : null}
                    {otherAttachments.map((attachment) => {
                        const displayTitle = getAttachmentDisplayTitle(attachment);
                        const isPointer = attachment.kind === 'link' || isBareFileReference(attachment);
                        const fullTitle = isPointer ? attachment.uri : attachment.title;
                        return (
                            <div key={attachment.id} className="-mx-1.5 flex items-center justify-between gap-2 rounded-md px-1.5 py-1 text-xs transition-colors hover:bg-muted/40">
                                <div className="flex min-w-0 items-center gap-1.5">
                                    {isPointer
                                        ? <Link2 className="w-3 h-3 shrink-0 text-muted-foreground" aria-hidden="true" />
                                        : <Paperclip className="w-3 h-3 shrink-0 text-muted-foreground" aria-hidden="true" />}
                                    <button
                                        type="button"
                                        onClick={(event) => {
                                            event.preventDefault();
                                            event.stopPropagation();
                                            openAttachment(attachment);
                                        }}
                                        className="truncate text-primary hover:underline"
                                        title={fullTitle || displayTitle}
                                    >
                                        {displayTitle}
                                    </button>
                                </div>
                                <div className="flex shrink-0 items-center gap-2">
                                    {canEditAsLink(attachment) && (
                                        <button
                                            type="button"
                                            onClick={() => editLinkAttachment(attachment)}
                                            className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
                                        >
                                            <Edit3 className="h-3 w-3" />
                                            {t('common.edit')}
                                        </button>
                                    )}
                                    <button
                                        type="button"
                                        onClick={() => removeAttachment(attachment.id)}
                                        className="text-muted-foreground hover:text-foreground"
                                    >
                                        {t('attachments.remove')}
                                    </button>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
