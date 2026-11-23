import { describe, expect, it, vi } from 'vitest';
import { createAIProvider } from '../ai-service';
import type { AIProviderId } from '../types';

const models = { openai: 'gpt-4o-mini', gemini: 'gemini-2.5-flash', anthropic: 'claude-haiku-4-5-20251001' };
const area = { id: 'area-car', name: 'Car maintenance' };
const title = 'Swap winter tires';

function mockEndpoint(provider: AIProviderId, reply: unknown, endpoint?: string) {
    const text = JSON.stringify(reply);
    const envelope = provider === 'openai'
        ? { choices: [{ message: { content: text } }] }
        : provider === 'gemini'
            ? { candidates: [{ content: { parts: [{ text }] } }] }
            : { content: [{ type: 'text', text }] };
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(envelope));
    return { ai: createAIProvider({ provider, apiKey: 'test-key', model: models[provider], endpoint, fetcher }), fetcher };
}

function expectAreaSchema(provider: AIProviderId, request: string, operation: 'clarify' | 'copilot') {
    const body = JSON.parse(request);
    if (provider === 'openai') {
        const schema = body.response_format.json_schema.schema;
        const areaSchema = operation === 'clarify' ? schema.properties.suggestedAction.anyOf[0] : schema;
        expect(areaSchema.required).toContain('areaId');
        expect(areaSchema.properties.areaId).toEqual({ anyOf: [{ type: 'string' }, { type: 'null' }] });
    } else if (provider === 'gemini') {
        const schema = body.generationConfig.responseSchema;
        const areaSchema = operation === 'clarify' ? schema.properties.suggestedAction : schema;
        expect(areaSchema.properties.areaId).toEqual({ type: 'string', nullable: true });
    }
}

describe.each<AIProviderId>(['openai', 'gemini', 'anthropic'])('%s Area suggestions', (provider) => {
    it('includes candidates and returns the matching ID for Task Copilot', async () => {
        const { ai, fetcher } = mockEndpoint(provider, { areaId: area.id, context: '@phone', tags: ['car'], timeEstimate: '15m' });
        const suggestion = await ai.predictMetadata({ title, areas: [area] });

        const body = String(fetcher.mock.calls[0]?.[1]?.body);
        expect(body).toContain('areaCandidates');
        expect(body).toContain(area.id);
        expect(body).toContain(area.name);
        expect(body).toContain('Copy its id exactly');
        expectAreaSchema(provider, body, 'copilot');
        expect(suggestion).toEqual({ areaId: area.id, context: '@phone', tags: ['#car'], timeEstimate: '15min' });
    });

    it('includes candidates and returns the matching ID for Clarify', async () => {
        const { ai, fetcher } = mockEndpoint(provider, { question: 'Where?', options: [], suggestedAction: { title, areaId: area.id } });
        const suggestion = await ai.clarifyTask({ title, areas: [area] });

        const body = String(fetcher.mock.calls[0]?.[1]?.body);
        expect(body).toContain('areaCandidates');
        expect(body).toContain(area.id);
        expectAreaSchema(provider, body, 'clarify');
        expect(suggestion.suggestedAction).toEqual({ title, areaId: area.id });
    });

    it.each([null, 'made-up-id', area.name, { id: area.id }])('discards an invalid or uncertain Area %j and keeps other metadata', async (areaId) => {
        const { ai, fetcher } = mockEndpoint(provider, { areaId, tags: ['car'], timeEstimate: '15m' });

        const suggestion = await ai.predictMetadata({ title, areas: [area] });

        expect(suggestion).not.toHaveProperty('areaId');
        expect(suggestion).toMatchObject({ tags: ['#car'], timeEstimate: '15min' });
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('keeps Quick Capture metadata suggestions free of Areas without candidates', async () => {
        const { ai, fetcher } = mockEndpoint(provider, { areaId: area.id, tags: ['car'] });

        const suggestion = await ai.predictMetadata({ title });

        const body = String(fetcher.mock.calls[0]?.[1]?.body);
        expect(body).not.toContain('areaCandidates');
        expect(body).not.toContain('areaId');
        expect(suggestion).not.toHaveProperty('areaId');
        expect(suggestion.tags).toEqual(['#car']);
    });

    it('discards an Area from a Clarify response suggesting a project', async () => {
        const { ai } = mockEndpoint(provider, { question: 'Where?', options: [], suggestedAction: { title, areaId: area.id, isProject: true } });

        const suggestion = await ai.clarifyTask({ title, areas: [area] });

        expect(suggestion.suggestedAction).toEqual({ title, isProject: true });
    });

    it('keeps a Clarify action when the Area ID is malformed', async () => {
        const { ai, fetcher } = mockEndpoint(provider, { question: 'Where?', options: [], suggestedAction: { title, areaId: [area.id] } });

        const suggestion = await ai.clarifyTask({ title, areas: [area] });

        expect(suggestion.suggestedAction).toEqual({ title });
        expect(fetcher).toHaveBeenCalledTimes(1);
    });
});

it('accepts an Area ID from an OpenAI-compatible endpoint in JSON mode', async () => {
    const { ai, fetcher } = mockEndpoint('openai', { areaId: area.id }, 'https://provider.example/v1/chat/completions');
    const suggestion = await ai.predictMetadata({ title, areas: [area] });

    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).response_format).toEqual({ type: 'json_object' });
    expect(suggestion.areaId).toBe(area.id);
});
