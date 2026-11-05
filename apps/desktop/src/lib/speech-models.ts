


export {
    DEFAULT_WHISPER_MODEL,
    WHISPER_MODEL_BASE_URL,
    WHISPER_MODELS,
    type WhisperModelDescriptor as WhisperModelOption,
} from '@mindwtr/core/whisper-models';

export type ParakeetModelOption = {
    id: string;
    label: string;
    modelDirName: string;
    sha256: string;
    sizeBytes: number;
};

export const PARAKEET_MODELS: ParakeetModelOption[] = [
    {
        id: 'parakeet-tdt-0.6b-v3-int8',
        label: 'Parakeet-TDT-0.6B v3 int8 (experimental)',
        modelDirName: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8',
        sha256: '5793d0fd397c5778d2cf2126994d58e9d56b1be7c04d13c7a15bb1b4eafb16bf',
        sizeBytes: 670478772,
    },
];

export const DEFAULT_PARAKEET_MODEL = PARAKEET_MODELS[0]?.id ?? 'parakeet-tdt-0.6b-v3-int8';
export const PARAKEET_MODEL_INSTALL_DIR = 'parakeet-model';
export const PARAKEET_REQUIRED_FILES = [
    'encoder.int8.onnx',
    'decoder.int8.onnx',
    'joiner.int8.onnx',
    'tokens.txt',
] as const;

export const OPENAI_SPEECH_MODELS = [
    'gpt-transcribe',
    'gpt-4o-mini-transcribe',
    'gpt-4o-transcribe',
    'whisper-1',
];

export const GEMINI_SPEECH_MODELS = [
    'gemini-3.6-flash',
    'gemini-3.5-flash',
    'gemini-3.5-flash-lite',
];
