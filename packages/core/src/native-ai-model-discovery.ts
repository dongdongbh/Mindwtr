import { canDiscoverAIModels, canFetchAIChatModels, getSpeechModelListKind } from './ai-settings-model';
import { fetchProviderModels, mergeModelOptions, type ModelListProviderId, type ModelListKind } from './ai/model-list';
import { abortableAIFetch, throwIfAIRequestAborted } from './ai/utils';
import { isNativeJsonWithinBytes } from './native-json';

export type NativeAITextModelDiscoveryInput = {
    provider: ModelListProviderId;
    enabled: boolean;
    model: string;
    copilotModel: string;
    modelOptions: string[];
    copilotModelOptions: string[];
    baseUrl?: string;
    consent: boolean;
    isFossBuild: boolean;
};
export type NativeAITextModelDiscoveryDependencies = {
    readCredential: () => Promise<string | null>;
    fetch: typeof fetch;
    current: () => void;
    signal?: AbortSignal;
};
export type NativeAITextModelDiscoveryResult = {
    status: 'loaded' | 'fallback' | 'unavailable';
    modelOptions: string[];
    copilotModelOptions: string[];
};

export type NativeVoiceModelDiscoveryInput = {
    provider: string;
    model: string;
    modelOptions: string[];
    baseUrl?: string;
    consent: boolean;
    aiEnabled: boolean;
    aiProvider: string;
    isFossBuild: boolean;
};
export type NativeVoiceModelDiscoveryResult = Pick<NativeAITextModelDiscoveryResult, 'status' | 'modelOptions'>;

type ModelChoices = NativeVoiceModelDiscoveryResult & { copilotModelOptions?: string[] };
const bounded = (choices: ModelChoices): boolean =>
    [choices.modelOptions, ...(choices.copilotModelOptions ? [choices.copilotModelOptions] : [])]
        .every(list => list.length > 0 && list.length <= 100
            && list.every(id => typeof id === 'string' && id.trim().length > 0 && id.length <= 2000))
    && isNativeJsonWithinBytes(choices, 64 * 1024);

type DiscoveryGate = {
    provider: ModelListProviderId | null;
    baseUrl?: string;
    consent: boolean;
    aiEnabled: boolean;
    aiProvider: string;
    kind: (credential: string, baseUrl: string) => ModelListKind | null;
};

async function discoverModels<Result extends ModelChoices>(gate: DiscoveryGate,
    dependencies: NativeAITextModelDiscoveryDependencies,
    choices: (status: ModelChoices['status'], fetched: string[] | null) => Result): Promise<Result> {
    const current = () => {
        throwIfAIRequestAborted(dependencies.signal, 'Model discovery');
        dependencies.current();
        throwIfAIRequestAborted(dependencies.signal, 'Model discovery');
    };
    current();
    const fallback = choices('fallback', null);
    if (!bounded(fallback)) throw new Error('Native model choices exceed the supported bounds');
    if (!gate.provider || !canDiscoverAIModels({ provider: gate.provider, consent: { [gate.provider]: gate.consent },
        aiEnabled: gate.aiEnabled, aiProvider: gate.aiProvider })) return { ...fallback, status: 'unavailable' };
    try {
        current();
        const credential = (await dependencies.readCredential() ?? '').trim();
        current();
        const baseUrl = gate.provider === 'openai' ? gate.baseUrl?.trim() ?? '' : '';
        const kind = gate.kind(credential, baseUrl);
        if (!kind) return { ...fallback, status: 'unavailable' };
        const fetched = await fetchProviderModels(gate.provider, { apiKey: credential, baseUrl, kind,
            fetchImpl: abortableAIFetch(dependencies.fetch, dependencies.signal) });
        current();
        if (fetched.length === 0) return fallback;
        const loaded = choices('loaded', fetched);
        return bounded(loaded) ? loaded : fallback;
    } catch {
        current();
        return fallback;
    }
}

export async function discoverNativeAITextModels(input: NativeAITextModelDiscoveryInput,
    dependencies: NativeAITextModelDiscoveryDependencies): Promise<NativeAITextModelDiscoveryResult> {
    return discoverModels({ provider: input.provider, baseUrl: input.baseUrl, consent: input.consent,
        aiEnabled: input.enabled, aiProvider: input.provider,
        kind: (credential, baseUrl) => canFetchAIChatModels({ isFossBuild: input.isFossBuild,
            provider: input.provider, apiKey: credential, baseUrl }) ? 'chat' : null,
    }, dependencies, (status, fetched) => ({ status,
        modelOptions: mergeModelOptions(fetched, input.modelOptions, input.model),
        copilotModelOptions: mergeModelOptions(fetched, input.copilotModelOptions, input.copilotModel),
    }));
}

export async function discoverNativeVoiceModels(input: NativeVoiceModelDiscoveryInput,
    dependencies: NativeAITextModelDiscoveryDependencies): Promise<NativeVoiceModelDiscoveryResult> {
    const provider = !input.isFossBuild && (input.provider === 'openai' || input.provider === 'gemini') ? input.provider : null;
    return discoverModels({ provider, baseUrl: input.baseUrl, consent: input.consent,
        aiEnabled: input.aiEnabled, aiProvider: input.aiProvider,
        kind: (credential, baseUrl) => provider ? getSpeechModelListKind({ provider, apiKey: credential, baseUrl }) : null,
    }, dependencies, (status, fetched) => ({ status, modelOptions: mergeModelOptions(fetched, input.modelOptions, input.model) }));
}
