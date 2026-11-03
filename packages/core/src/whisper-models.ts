


export type WhisperModelDescriptor = {
    id: string;
    fileName: string;
    label: string;
    minBytes: number;
    sha256: string;
    sizeBytes: number;
};

export const WHISPER_MODEL_BASE_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';


export const WHISPER_MODEL_BASE_URLS: readonly string[] = [
    WHISPER_MODEL_BASE_URL,
    'https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main',
];

export const WHISPER_MODELS: WhisperModelDescriptor[] = [
    { id: 'whisper-tiny', fileName: 'ggml-tiny.bin', label: 'whisper-tiny', minBytes: 77691713, sizeBytes: 77691713, sha256: 'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21' },
    { id: 'whisper-tiny.en', fileName: 'ggml-tiny.en.bin', label: 'whisper-tiny.en', minBytes: 77704715, sizeBytes: 77704715, sha256: '921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f' },
    { id: 'whisper-base', fileName: 'ggml-base.bin', label: 'whisper-base', minBytes: 147951465, sizeBytes: 147951465, sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe' },
    { id: 'whisper-base.en', fileName: 'ggml-base.en.bin', label: 'whisper-base.en', minBytes: 147964211, sizeBytes: 147964211, sha256: 'a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002' },
    { id: 'whisper-large-v3-turbo', fileName: 'ggml-large-v3-turbo.bin', label: 'whisper-large-v3-turbo', minBytes: 1624555275, sizeBytes: 1624555275, sha256: '1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69' },
];

export const DEFAULT_WHISPER_MODEL = WHISPER_MODELS[0]?.id ?? 'whisper-tiny';

export const getWhisperModelDescriptor = (modelId: string | undefined): WhisperModelDescriptor | undefined => (
    modelId ? WHISPER_MODELS.find((model) => model.id === modelId) : undefined
);
