import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { TaskEditAudioModal } from './TaskEditOverlayModals';

describe('TaskEditAudioModal', () => {
  it('renders the retry transcription action', () => {
    const onRetryTranscription = vi.fn();

    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <TaskEditAudioModal
          visible
          t={(key) =>
            ({
              'quickAdd.audioNoteTitle': 'Audio Note',
              'common.play': 'Play',
              'common.close': 'Close',
              'attachments.retryTranscription': 'Re-transcribe',
              'audio.loading': 'Loading audio...',
            }[key] ?? key)
          }
          tc={{
            cardBg: '#111',
            border: '#222',
            text: '#fff',
            secondaryText: '#aaa',
            inputBg: '#000',
            tint: '#3b82f6',
            danger: '#ef4444',
          }}
          audioTitle="Audio Note"
          audioStatus={{ isLoaded: true, playing: false, currentTime: 1, duration: 5 }}
          audioLoading={false}
          audioTranscribing={false}
          audioTranscriptionError={null}
          onTogglePlayback={vi.fn()}
          onRetryTranscription={onRetryTranscription}
          onClose={vi.fn()}
        />,
      );
    });

    const retryLabel = tree.root.findByProps({ children: 'Re-transcribe' });
    const retryButton = retryLabel.parent;
    if (!retryButton || typeof retryButton.props.onPress !== 'function') {
      throw new Error('Retry button not found');
    }
    renderer.act(() => {
      retryButton.props.onPress();
    });

    expect(onRetryTranscription).toHaveBeenCalledTimes(1);
  });

  it('shows the transcribing state and inline error', () => {
    let tree!: renderer.ReactTestRenderer;
    renderer.act(() => {
      tree = renderer.create(
        <TaskEditAudioModal
          visible
          t={(key) =>
            ({
              'quickAdd.audioNoteTitle': 'Audio Note',
              'common.play': 'Play',
              'common.close': 'Close',
              'attachments.transcribing': 'Transcribing...',
              'audio.loading': 'Loading audio...',
            }[key] ?? key)
          }
          tc={{
            cardBg: '#111',
            border: '#222',
            text: '#fff',
            secondaryText: '#aaa',
            inputBg: '#000',
            tint: '#3b82f6',
            danger: '#ef4444',
          }}
          audioTitle="Audio Note"
          audioStatus={{ isLoaded: true, playing: false, currentTime: 1, duration: 5 }}
          audioLoading={false}
          audioTranscribing
          audioTranscriptionError="Transcription failed. Please try again."
          onTogglePlayback={vi.fn()}
          onRetryTranscription={vi.fn()}
          onClose={vi.fn()}
        />,
      );
    });

    expect(tree.root.findByProps({ children: 'Transcribing...' }).parent?.props.disabled).toBe(true);
    expect(tree.root.findByProps({ children: 'Transcription failed. Please try again.' })).toBeTruthy();
  });
});
