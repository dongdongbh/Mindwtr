import { BookOpen, Link2, Paperclip, Pencil, Trash2 } from 'lucide-react';
import { tFallback, type Attachment } from '@mindwtr/core';
import { useBareFileReferenceCheck, useExternalFileReferenceCheck } from '../../../lib/attachment-reference';
import { getAttachmentDisplayTitle } from '../../../lib/attachment-utils';
import { isImageAttachment } from '../task-item-attachment-utils';
import { AttachmentImage } from '../AttachmentImage';
import { QUICK_ADD_FIELD_TOKENS, QuickAddTokenBadge, TaskEditorFieldLabel } from '../task-editor-label';

// Secondary add actions share one bordered blue shape with the checklist's
// "Add item" control so every way to grow a task reads the same.
const taskEditorAddButtonClassName = 'inline-flex h-7 items-center gap-1.5 rounded-md border border-primary/30 px-2.5 text-xs font-medium text-primary transition-colors hover:bg-primary/10';

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
                <TaskEditorFieldLabel icon={Paperclip}>
                    {t('attachments.title')}
                    <QuickAddTokenBadge t={t} token={QUICK_ADD_FIELD_TOKENS.link} />
                </TaskEditorFieldLabel>
                <div className="flex items-center gap-2">
                    <button
                        type="button"
                        onClick={addFileAttachment}
                        className={taskEditorAddButtonClassName}
                    >
                        <Paperclip className="w-3.5 h-3.5" aria-hidden="true" />
                        {t('attachments.addFile')}
                    </button>
                    <button
                        type="button"
                        onClick={addLinkAttachment}
                        className={taskEditorAddButtonClassName}
                    >
                        <Link2 className="w-3.5 h-3.5" aria-hidden="true" />
                        {t('attachments.addLink')}
                    </button>
                    {showObsidianNoteAttachment && (
                        <button
                            type="button"
                            onClick={addObsidianNoteAttachment}
                            className={taskEditorAddButtonClassName}
                        >
                            <BookOpen className="w-3.5 h-3.5" aria-hidden="true" />
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
                                            <div className="flex shrink-0 items-center gap-1">
                                                {canEditAsLink(attachment) && (
                                                    <button
                                                        type="button"
                                                        onClick={() => editLinkAttachment(attachment)}
                                                        aria-label={t('common.edit')}
                                                        title={t('common.edit')}
                                                        className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                                                    >
                                                        <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                                                    </button>
                                                )}
                                                <button
                                                    type="button"
                                                    onClick={() => removeAttachment(attachment.id)}
                                                    aria-label={t('attachments.remove')}
                                                    title={t('attachments.remove')}
                                                    className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                                                >
                                                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
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
                                <div className="flex shrink-0 items-center gap-1">
                                    {canEditAsLink(attachment) && (
                                        <button
                                            type="button"
                                            onClick={() => editLinkAttachment(attachment)}
                                            aria-label={t('common.edit')}
                                            title={t('common.edit')}
                                            className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                                        >
                                            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                                        </button>
                                    )}
                                    <button
                                        type="button"
                                        onClick={() => removeAttachment(attachment.id)}
                                        aria-label={t('attachments.remove')}
                                        title={t('attachments.remove')}
                                        className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                                    >
                                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
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
