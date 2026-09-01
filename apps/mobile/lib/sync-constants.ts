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
export const CLOUD_ALLOW_INSECURE_HTTP_KEY = '@mindwtr_cloud_allow_insecure_http';
export const DROPBOX_LAST_REV_KEY = '@mindwtr_dropbox_last_rev';
/** Device-local sync-encryption state (state + discovered salt/params). NEVER synced,
 *  never a content-signature field — see sync-encryption-state.ts. Non-secret on purpose:
 *  the salt and KDF params are in every artifact header anyway. */
export const SYNC_ENCRYPTION_STATE_KEY = '@mindwtr_sync_encryption_state_v1';
/** The derived 32-byte sync-encryption key, base64. Secret — routed to the platform
 *  keystore by secure-config.ts. The passphrase itself is never persisted. */
export const SYNC_ENCRYPTION_KEY_KEY = '@mindwtr_sync_encryption_key_v1';
export const CLOUDKIT_CHANGE_TOKEN_KEY = '@mindwtr_cloudkit_change_token';
export const CLOUDKIT_SEEDED_KEY = '@mindwtr_cloudkit_seeded';
export const CLOUDKIT_ZONE_CREATED_KEY = '@mindwtr_cloudkit_zone_created';
/** Device-local background-sync scheduling. NEVER synced, like hiddenSidebarViews
 *  — see background-sync-task.ts for the value type and fallback. */
export const BACKGROUND_SYNC_INTERVAL_KEY = '@mindwtr_background_sync_interval';
/** The interval expo-background-task is actually registered with right now, so a
 *  changed setting can be detected and re-registered (see background-sync-task.ts). */
export const BACKGROUND_SYNC_LAST_REGISTERED_INTERVAL_KEY = '@mindwtr_background_sync_last_registered_interval';

// Kept here (rather than background-sync-task.ts) so UI code can import the value
// type and option list without pulling in expo-task-manager/expo-background-task,
// which that module registers a task against at import time.
export type BackgroundSyncInterval = 'off' | '15m' | '1h' | '6h';
export const MOBILE_BACKGROUND_SYNC_INTERVAL_OPTIONS: readonly BackgroundSyncInterval[] = ['off', '15m', '1h', '6h'];
