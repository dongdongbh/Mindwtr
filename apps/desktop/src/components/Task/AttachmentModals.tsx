import type { RefObject } from 'react';
import type { Attachment } from '@mindwtr/core';
import { AudioAttachmentModal } from './AudioAttachmentModal';
import { ImageAttachmentModal } from './ImageAttachmentModal';
import { TextAttachmentModal } from './TextAttachmentModal';

type AttachmentModalsProps = {
    audioAttachment: Attachment | null;
    audioSource: string | null;
    audioRef: RefObject<HTMLAudioElement | null>;
    audioError: string | null;
    audioTranscribing: boolean;
    audioTranscriptionError: string | null;
    onCloseAudio: () => void;
    onAudioError: () => void;
    onOpenAudioExternally: () => void;
    onRetryAudioTranscription: () => void;
    imageAttachment: Attachment | null;
    imageSource: string | null;
    onCloseImage: () => void;
    onOpenImageExternally: () => void;
    textAttachment: Attachment | null;
    textContent: string | null;
    textLoading: boolean;
    textError: string | null;
    onCloseText: () => void;
    onOpenTextExternally: () => void;
    t: (key: string) => string;
};

export function AttachmentModals({
    audioAttachment,
    audioSource,
    audioRef,
    audioError,
    audioTranscribing,
    audioTranscriptionError,
    onCloseAudio,
    onAudioError,
    onOpenAudioExternally,
    onRetryAudioTranscription,
    imageAttachment,
    imageSource,
    onCloseImage,
    onOpenImageExternally,
    textAttachment,
    textContent,
    textLoading,
    textError,
    onCloseText,
    onOpenTextExternally,
    t,
}: AttachmentModalsProps) {
    return (
        <>
            {audioAttachment ? (
                <AudioAttachmentModal
                    attachment={audioAttachment}
                    audioSource={audioSource}
                    audioRef={audioRef}
                    audioError={audioError}
                    audioTranscribing={audioTranscribing}
                    audioTranscriptionError={audioTranscriptionError}
                    onClose={onCloseAudio}
                    onAudioError={onAudioError}
                    onOpenExternally={onOpenAudioExternally}
                    onRetryTranscription={onRetryAudioTranscription}
                    t={t}
                />
            ) : null}
            {imageAttachment ? (
                <ImageAttachmentModal
                    attachment={imageAttachment}
                    imageSource={imageSource}
                    onClose={onCloseImage}
                    onOpenExternally={onOpenImageExternally}
                    t={t}
                />
            ) : null}
            {textAttachment ? (
                <TextAttachmentModal
                    attachment={textAttachment}
                    textContent={textContent ?? ''}
                    textLoading={textLoading}
                    textError={textError}
                    onClose={onCloseText}
                    onOpenExternally={onOpenTextExternally}
                    t={t}
                />
            ) : null}
        </>
    );
}
