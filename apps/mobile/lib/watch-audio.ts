import type { AppData } from '@mindwtr/core';

import { loadAIKey } from './ai-config';
import {
  processAudioCapture,
  resolveSpeechToTextRuntimeSettings,
  type SpeechToTextConfig,
} from './speech-to-text';


export async function transcribePendingAudio(
  audioPath: string,
  settings: AppData['settings'],
): Promise<string | null> {
  const runtime = resolveSpeechToTextRuntimeSettings(settings.ai?.speechToText);
  if (!runtime.enabled) return null;
  const apiKey = runtime.provider === 'whisper'
    ? ''
    : await loadAIKey(runtime.provider).catch(() => '');
  if (runtime.provider !== 'whisper' && !apiKey && !runtime.baseUrl) return null;

  const timeZone = typeof Intl === 'object' && typeof Intl.DateTimeFormat === 'function'
    ? Intl.DateTimeFormat().resolvedOptions().timeZone
    : undefined;
  const result = await processAudioCapture(audioPath, {
    provider: runtime.provider,
    apiKey,
    baseUrl: runtime.baseUrl,
    model: runtime.model,
    modelPath: runtime.modelPath,
    isFossBuild: runtime.isFossBuild,
    language: runtime.language,
    mode: runtime.mode,
    fieldStrategy: runtime.fieldStrategy,
    parseModel: runtime.provider === 'openai' && settings.ai?.provider === 'openai'
      ? settings.ai.model
      : undefined,
    now: new Date(),
    timeZone,
  } satisfies SpeechToTextConfig);
  const transcript = result.transcript?.trim();


  if (runtime.provider === 'whisper' && transcript === '[BLANK_AUDIO]') return null;
  return transcript || null;
}


export const transcribePendingWatchAudio = transcribePendingAudio;
