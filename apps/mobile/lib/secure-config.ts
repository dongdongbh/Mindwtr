import AsyncStorage from '@react-native-async-storage/async-storage';
import { createSecureSyncConfigStore, type SecureSyncConfigStore } from '@mindwtr/core/sync-secret-storage';

import { secureSecretStorage, secureSecretVault } from './secure-secret-store';


export { isSecretConfigKey } from '@mindwtr/core/sync-secret-storage';

const secureConfig: SecureSyncConfigStore = createSecureSyncConfigStore({
    storage: {
        getItem: (key) => AsyncStorage.getItem(key),
        setItem: (key, value) => AsyncStorage.setItem(key, value),
        removeItem: (key) => AsyncStorage.removeItem(key),
    },
    secrets: secureSecretStorage,
    vault: secureSecretVault,
});

export const getSecureConfigValue = (key: string): Promise<string | null> =>
    secureConfig.getSecureConfigValue(key);

export const setSecureConfigValue = (key: string, value: string): Promise<void> =>
    secureConfig.setSecureConfigValue(key, value);

export const deleteSecureConfigValue = (key: string): Promise<void> =>
    secureConfig.deleteSecureConfigValue(key);
