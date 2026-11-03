import { formatI18nTemplate, parseAttachmentLinkBatch } from '@mindwtr/core';
import { browseForLinkTarget } from '../../lib/attachment-import';
import { isTauriRuntime } from '../../lib/runtime';
import { PromptModal } from '../PromptModal';
import { AudioAttachmentModal } from './AudioAttachmentModal';
import { ImageAttachmentModal } from './ImageAttachmentModal';
import { TextAttachmentModal } from './TextAttachmentModal';
import type { useTaskItemAttachments } from './useTaskItemAttachments';

type TaskAttachmentOverlaysProps = {


    attachments: ReturnType<typeof useTaskItemAttachments>;
    t: (key: string) => string;
};

export function TaskAttachmentOverlays({ attachments, t }: TaskAttachmentOverlaysProps) {
    const {
        showLinkPrompt,
        linkPromptVariant,
        linkPromptDefaultValue,
        editingLinkAttachmentId,
        closeLinkPrompt,
        handleAddLinkAttachment,
        audioAttachment,
        audioSource,
        audioRef,
        audioError,
        audioTranscribing,
        audioTranscriptionError,
        closeAudio,
        handleAudioError,
        openAudioExternally,
        retryAudioTranscription,
        imageAttachment,
        imageSource,
        closeImage,
        openImageExternally,
        textAttachment,
        textContent,
        textLoading,
        textError,
        closeText,
        openTextExternally,
    } = attachments;
    const isObsidianLink = linkPromptVariant === 'obsidian';


    const canBrowseLinkTarget = linkPromptVariant === 'link' && isTauriRuntime();
    const batchEntry = !editingLinkAttachmentId && linkPromptVariant === 'link';

    return (
        <>
            {showLinkPrompt && (
                <PromptModal
                    isOpen
                    title={editingLinkAttachmentId
                        ? t('common.edit')
                        : isObsidianLink
                            ? t('attachments.attachObsidianNote')
                            : t('attachments.addLink')}
                    description={batchEntry
                        ? t('attachments.linkBatchHint')
                        : isObsidianLink
                        ? t('attachments.obsidianLinkInputHint')
                        : t('attachments.linkInputHint')}
                    placeholder={isObsidianLink
                        ? t('attachments.obsidianLinkPlaceholder')
                        : t('attachments.linkPlaceholder')}
                    defaultValue={linkPromptDefaultValue}
                    multiline={batchEntry}
                    validate={batchEntry ? (value) => {
                        const { invalidLine } = parseAttachmentLinkBatch(value, true);
                        return invalidLine === null ? null : formatI18nTemplate(t('attachments.invalidLinkLine'), { line: invalidLine });
                    } : undefined}
                    browseLabel={canBrowseLinkTarget ? t('attachments.linkToFile') : undefined}
                    onBrowse={canBrowseLinkTarget
                        ? () => browseForLinkTarget(t('attachments.linkToFile'))
                        : undefined}
                    confirmLabel={t('common.save')}
                    cancelLabel={t('common.cancel')}
                    onCancel={closeLinkPrompt}
                    onConfirm={(value) => {
                        if (!handleAddLinkAttachment(value)) return;
                        closeLinkPrompt();
                    }}
                />
            )}
            {audioAttachment ? (
                <AudioAttachmentModal
                    attachment={audioAttachment}
                    audioSource={audioSource}
                    audioRef={audioRef}
                    audioError={audioError}
                    audioTranscribing={audioTranscribing}
                    audioTranscriptionError={audioTranscriptionError}
                    onClose={closeAudio}
                    onAudioError={handleAudioError}
                    onOpenExternally={openAudioExternally}
                    onRetryTranscription={retryAudioTranscription}
                    t={t}
                />
            ) : null}
            {imageAttachment ? (
                <ImageAttachmentModal
                    attachment={imageAttachment}
                    imageSource={imageSource}
                    onClose={closeImage}
                    onOpenExternally={openImageExternally}
                    t={t}
                />
            ) : null}
            {textAttachment ? (
                <TextAttachmentModal
                    attachment={textAttachment}
                    textContent={textContent}
                    textLoading={textLoading}
                    textError={textError}
                    onClose={closeText}
                    onOpenExternally={openTextExternally}
                    t={t}
                />
            ) : null}
        </>
    );
}
