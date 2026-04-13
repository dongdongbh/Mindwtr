import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AudioAttachmentModal } from './AudioAttachmentModal';

describe('AudioAttachmentModal', () => {
    it('renders a retry transcription action', () => {
        const onRetryTranscription = vi.fn();

        render(
            <AudioAttachmentModal
                attachment={{
                    id: 'attachment-1',
                    kind: 'file',
                    title: 'Audio Note',
                    uri: '/tmp/audio.wav',
                    createdAt: '2026-04-07T00:00:00.000Z',
                    updatedAt: '2026-04-07T00:00:00.000Z',
                }}
                audioSource="blob:audio"
                audioRef={{ current: null }}
                audioError={null}
                audioTranscribing={false}
                audioTranscriptionError={null}
                onClose={vi.fn()}
                onAudioError={vi.fn()}
                onOpenExternally={vi.fn()}
                onRetryTranscription={onRetryTranscription}
                t={(key) => ({
                    'attachments.retryTranscription': 'Re-transcribe',
                    'common.close': 'Close',
                    'quickAdd.audioNoteTitle': 'Audio Note',
                }[key] ?? key)}
            />,
        );

        fireEvent.click(screen.getByRole('button', { name: /re-transcribe/i }));

        expect(onRetryTranscription).toHaveBeenCalledTimes(1);
    });

    it('shows the busy retry label while retranscribing', () => {
        render(
            <AudioAttachmentModal
                attachment={{
                    id: 'attachment-1',
                    kind: 'file',
                    title: 'Audio Note',
                    uri: '/tmp/audio.wav',
                    createdAt: '2026-04-07T00:00:00.000Z',
                    updatedAt: '2026-04-07T00:00:00.000Z',
                }}
                audioSource="blob:audio"
                audioRef={{ current: null }}
                audioError={null}
                audioTranscribing
                audioTranscriptionError="Transcription failed. Please try again."
                onClose={vi.fn()}
                onAudioError={vi.fn()}
                onOpenExternally={vi.fn()}
                onRetryTranscription={vi.fn()}
                t={(key) => ({
                    'attachments.transcribing': 'Transcribing...',
                    'common.close': 'Close',
                    'quickAdd.audioNoteTitle': 'Audio Note',
                }[key] ?? key)}
            />,
        );

        expect(screen.getByRole('button', { name: /transcribing/i })).toBeDisabled();
        expect(screen.getByText(/transcription failed/i)).toBeInTheDocument();
    });
});
