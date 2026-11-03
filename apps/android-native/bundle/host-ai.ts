import { logInfo, logWarn, type NativeAIHost } from '@mindwtr/core';


type KeyValue = {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    remove(key: string): Promise<void>;
};


type Secrets = {
    getSecret(key: string): Promise<string | null>;
    setSecret(key: string, value: string): Promise<void>;
    deleteSecret(key: string): Promise<void>;
};


export const createNativeAI = (keyValue: KeyValue, secrets: () => Secrets, isFossBuild: boolean): NativeAIHost => ({

    platform: { isFossBuild },
    storage: {
        getItem: (key) => keyValue.get(key),
        setItem: (key, value) => keyValue.set(key, value),
        removeItem: (key) => keyValue.remove(key),
    },
    secrets: {
        get: (key) => secrets().getSecret(key),
        set: (key, value) => secrets().setSecret(key, value),
        delete: (key) => secrets().deleteSecret(key),
    },
    log: {
        warn: (message) => { try { logWarn(message, { scope: 'ai' }); } catch {                                                    } },
        info: (message, context) => { try { logInfo(message, { scope: context.scope, context: context.extra }); } catch {                } },
    },
});
