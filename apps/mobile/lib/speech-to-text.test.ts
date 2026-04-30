import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
}));

import { startWhisperRealtimeCapture } from './speech-to-text';

describe('speech-to-text', () => {
  it('does not load Whisper realtime modules on Android', async () => {
    await expect(
      startWhisperRealtimeCapture('/tmp/mindwtr-audio.wav', {
        provider: 'whisper',
        model: 'whisper-tiny',
        modelPath: '/tmp/ggml-tiny.en.bin',
      })
    ).rejects.toThrow('Whisper realtime capture is disabled on Android.');
  });
});
