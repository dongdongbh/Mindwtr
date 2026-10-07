// The device-local sync keys the mobile apps keep in their key-value store (React Native's
// AsyncStorage, RKStorage on Android). The native Android app reads and writes these same keys
// in place, so an upgrade needs no migration and an RN recovery build still finds the config.
// Never rename one: a renamed key reads as "not configured" on every upgraded device.

export const SYNC_PATH_KEY = '@mindwtr_sync_path';
export const SYNC_PATH_BOOKMARK_KEY = '@mindwtr_sync_path_bookmark';
export const SYNC_BACKEND_KEY = '@mindwtr_sync_backend';
export const WEBDAV_URL_KEY = '@mindwtr_webdav_url';
export const WEBDAV_USERNAME_KEY = '@mindwtr_webdav_username';
export const WEBDAV_PASSWORD_KEY = '@mindwtr_webdav_password';
export const WEBDAV_ALLOW_INSECURE_HTTP_KEY = '@mindwtr_webdav_allow_insecure_http';
export const WEBDAV_ALLOW_WEAK_FINGERPRINT_KEY = '@mindwtr_webdav_allow_weak_fingerprint';
export const CLOUD_URL_KEY = '@mindwtr_cloud_url';
export const CLOUD_TOKEN_KEY = '@mindwtr_cloud_token';
export const CLOUD_PROVIDER_KEY = '@mindwtr_cloud_provider';
export const CLOUD_PROVIDER_DROPBOX = 'dropbox' as const;
export const CLOUD_ALLOW_INSECURE_HTTP_KEY = '@mindwtr_cloud_allow_insecure_http';
export const DROPBOX_LAST_REV_KEY = '@mindwtr_dropbox_last_rev';
/** Device-local sync-encryption state (state + discovered salt/params). NEVER synced,
 *  never a content-signature field — see sync-encryption-local-state.ts. Non-secret on purpose:
 *  the salt and KDF params are in every artifact header anyway. */
export const SYNC_ENCRYPTION_STATE_KEY = '@mindwtr_sync_encryption_state_v1';
/** The derived 32-byte sync-encryption key, base64. Secret — routed to the platform
 *  keystore by the secure sync config (sync-secret-storage.ts). The passphrase itself is
 *  never persisted. */
export const SYNC_ENCRYPTION_KEY_KEY = '@mindwtr_sync_encryption_key_v1';
export const CLOUDKIT_CHANGE_TOKEN_KEY = '@mindwtr_cloudkit_change_token';
export const CLOUDKIT_SEEDED_KEY = '@mindwtr_cloudkit_seeded';
export const CLOUDKIT_ZONE_CREATED_KEY = '@mindwtr_cloudkit_zone_created';
/** Legacy record of the interval expo-background-task was registered with.
 *  Automatic scheduling uses one fixed policy now; this record remains only so
 *  older registrations can be recognized and migrated safely. */
export const BACKGROUND_SYNC_LAST_REGISTERED_INTERVAL_KEY = '@mindwtr_background_sync_last_registered_interval';

/** Device-local record of consecutive background-sync failures, so a run that
 *  cannot succeed (a wrong password) stops costing a full failing cycle every
 *  15 minutes. Never synced; cleared by the first background run that works. */
export const BACKGROUND_SYNC_FAILURE_STATE_KEY = '@mindwtr_background_sync_failure_state_v1';

export type LegacyBackgroundSyncInterval = 'off' | '15m' | '1h' | '6h';

/** The host's asynchronous key-value store (AsyncStorage on RN). Every write must be
 *  durable when its promise resolves. */
export type SyncKeyValueStoragePort = {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
    removeItem(key: string): Promise<void>;
};
