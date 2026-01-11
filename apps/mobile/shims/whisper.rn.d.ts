declare module 'whisper.rn' {
  type WhisperContext = {
    transcribe: (audioUri: string, options?: Record<string, unknown>) => {
      promise: Promise<unknown>;
    };
  };

  export function initWhisper(options: { filePath: string }): Promise<WhisperContext>;
}
