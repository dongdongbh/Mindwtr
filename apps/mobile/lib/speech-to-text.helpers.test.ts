import { describe, expect, it } from 'vitest';
import { buildMultipartAudioPart } from './speech-to-text.helpers';

describe('speech-to-text helpers', () => {
  it('builds a blob-backed multipart part when bytes are available', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const { part, fileName } = buildMultipartAudioPart({
      uri: 'file:///tmp/clip.m4a',
      name: 'clip.m4a',
      type: 'audio/mp4',
      bytes,
    });

    expect(part).toBeInstanceOf(Blob);
    expect(fileName).toBe('clip.m4a');
    await expect((part as Blob).arrayBuffer()).resolves.toBeInstanceOf(ArrayBuffer);
  });

  it('falls back to the React Native uri part when bytes are unavailable', () => {
    const { part, fileName } = buildMultipartAudioPart({
      uri: 'file:///tmp/clip.m4a',
      name: 'clip.m4a',
      type: 'audio/mp4',
      bytes: null,
    });

    expect(part).toEqual({
      uri: 'file:///tmp/clip.m4a',
      name: 'clip.m4a',
      type: 'audio/mp4',
    });
    expect(fileName).toBeUndefined();
  });
});
