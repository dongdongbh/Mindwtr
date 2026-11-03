import { describe, expect, it } from 'vitest';

import { DEFAULT_WHISPER_MODEL, getWhisperModelDescriptor, WHISPER_MODELS } from './whisper-models';


const EXPECTED_MODELS: Record<string, { fileName: string; sha256: string; sizeBytes: number }> = {
    'whisper-tiny': { fileName: 'ggml-tiny.bin', sizeBytes: 77691713, sha256: 'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21' },
    'whisper-tiny.en': { fileName: 'ggml-tiny.en.bin', sizeBytes: 77704715, sha256: '921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f' },
    'whisper-base': { fileName: 'ggml-base.bin', sizeBytes: 147951465, sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe' },
    'whisper-base.en': { fileName: 'ggml-base.en.bin', sizeBytes: 147964211, sha256: 'a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002' },
    'whisper-large-v3-turbo': { fileName: 'ggml-large-v3-turbo.bin', sizeBytes: 1624555275, sha256: '1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69' },
};

describe('whisper model catalogue', () => {
    it('has no lost entries and every model carries a sha256', () => {
        const ids = WHISPER_MODELS.map((model) => model.id);
        expect(new Set(ids)).toEqual(new Set(Object.keys(EXPECTED_MODELS)));

        for (const model of WHISPER_MODELS) {
            expect(model.sha256).toBeTruthy();
            expect(model.fileName).toBe(EXPECTED_MODELS[model.id]?.fileName);
            expect(model.sizeBytes).toBe(EXPECTED_MODELS[model.id]?.sizeBytes);
            expect(model.sha256).toBe(EXPECTED_MODELS[model.id]?.sha256);

            expect(model.minBytes).toBeGreaterThan(0);
        }
    });

    it('includes whisper-large-v3-turbo, which mobile previously lacked', () => {
        expect(WHISPER_MODELS.some((model) => model.id === 'whisper-large-v3-turbo')).toBe(true);
    });

    it('defaults to whisper-tiny', () => {
        expect(DEFAULT_WHISPER_MODEL).toBe('whisper-tiny');
    });

    it('looks up a model descriptor by id and returns undefined for unknown ids', () => {
        expect(getWhisperModelDescriptor('whisper-base')).toMatchObject({ fileName: 'ggml-base.bin' });
        expect(getWhisperModelDescriptor('not-a-model')).toBeUndefined();
        expect(getWhisperModelDescriptor(undefined)).toBeUndefined();
    });
});
