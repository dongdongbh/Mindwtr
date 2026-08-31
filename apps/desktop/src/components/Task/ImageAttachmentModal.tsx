import type { Attachment } from '@mindwtr/core';
import { Dialog, DialogBody } from '../ui/Dialog';
import { AttachmentImage } from './AttachmentImage';

type ImageAttachmentModalProps = {
    attachment: Attachment | null;
    imageSource: string | null;
    onClose: () => void;
    onOpenExternally: () => void;
    t: (key: string) => string;
};

export function ImageAttachmentModal({
    attachment,
    imageSource: _imageSource,
    onClose,
    onOpenExternally,
    t,
}: ImageAttachmentModalProps) {
    if (!attachment) return null;
    return (
        <Dialog onClose={onClose} label={attachment.title || t('attachments.title')} panelClassName="max-w-3xl">
            <DialogBody className="p-4 space-y-3">
                <div className="flex items-center justify-between">
                    <div className="text-sm font-medium">{attachment.title || t('attachments.title')}</div>
                    <div className="flex items-center gap-3">
                        <button
                            type="button"
                            onClick={onOpenExternally}
                            className="text-xs text-muted-foreground hover:text-foreground"
                        >
                            {t('attachments.open')}
                        </button>
                        <button
                            type="button"
                            onClick={onClose}
                            className="text-xs text-muted-foreground hover:text-foreground"
                        >
                            {t('common.close')}
                        </button>
                    </div>
                </div>
                <div className="max-h-[70vh] overflow-auto rounded-lg border border-border bg-muted/30">
                    <AttachmentImage
                        attachment={attachment}
                        alt={attachment.title || t('attachments.title')}
                        className="block max-w-full h-auto mx-auto"
                        unavailableText={t('attachments.webUnavailable')}
                    />
                </div>
            </DialogBody>
        </Dialog>
    );
}
