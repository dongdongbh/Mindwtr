// Mobile's reader for core's `buildSyncLocationScope` — one stable string naming the sync
// backend + location this device is pointed at, read from the device's own config.
//
// Two consumers, and they must agree byte-for-byte:
//   - attachment presence reconciliation (#1119) — "has the backend configuration changed
//     under the stamp?"
//   - sync-encryption discovery states (#1138) — "was this lock set for the location we are
//     about to sync against?"
//
// The derivation itself lives in core so desktop TS uses the same one and Rust has a single
// shape to mirror. No secret is included: the string is written into plain AsyncStorage and
// into the device-local encryption sidecar.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { buildSyncLocationScope } from '@mindwtr/core';

import {
    CLOUD_PROVIDER_KEY,
    CLOUD_URL_KEY,
    SYNC_BACKEND_KEY,
    SYNC_PATH_KEY,
    WEBDAV_URL_KEY,
    WEBDAV_USERNAME_KEY,
} from './sync-constants';

export { buildSyncLocationScope };

/** The scope of the configuration currently persisted on this device. `null` means the
 *  configuration could not be read at all, which every caller treats as doubt: attachment
 *  reconciliation runs, and an encryption lock stays in force. */
export const readActiveSyncLocationScope = async (): Promise<string | null> => {
    try {
        const [backend, webdavUrl, webdavUsername, cloudProvider, cloudUrl, syncPath] = await Promise.all([
            AsyncStorage.getItem(SYNC_BACKEND_KEY),
            AsyncStorage.getItem(WEBDAV_URL_KEY),
            AsyncStorage.getItem(WEBDAV_USERNAME_KEY),
            AsyncStorage.getItem(CLOUD_PROVIDER_KEY),
            AsyncStorage.getItem(CLOUD_URL_KEY),
            AsyncStorage.getItem(SYNC_PATH_KEY),
        ]);
        return buildSyncLocationScope({
            backend,
            webdavUrl,
            webdavUsername,
            cloudProvider,
            cloudUrl,
            syncPath,
        });
    } catch {
        return null;
    }
};
