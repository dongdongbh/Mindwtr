# Dropbox Sync

Mindwtr supports direct Dropbox sync in supported desktop/mobile builds.

This uses Dropbox OAuth with **App Folder** access, so Mindwtr only reads/writes data under:

- `/Apps/Mindwtr/data.json`
- `/Apps/Mindwtr/attachments/*`

---

## Availability

- **Desktop (official builds):** Supported
- **Mobile (official builds):** Supported
- **Expo Go:** Not supported for Dropbox OAuth
- **FOSS builds:** Dropbox sync may be disabled

If Dropbox is disabled in your build, use [[Data and Sync]] (File Sync) or [[Cloud Sync]] (self-hosted) instead.

---

## User Setup (Official Builds)

1. Open **Settings → Sync**.
2. Set **Sync backend** to **Cloud**.
3. Set **Cloud provider** to **Dropbox**.
4. Click/Tap **Connect Dropbox** and complete OAuth in your browser.
5. Back in Mindwtr, use **Test connection**.
6. Run **Sync**.

After first sync, verify the app folder exists in Dropbox:

- `/Apps/Mindwtr/data.json`
- `/Apps/Mindwtr/attachments/`

---

## Self-Build Setup

If you build Mindwtr yourself, you must provide a Dropbox app key at build time.

### 1. Create Dropbox App

In Dropbox App Console:

- App type: **Scoped access**
- Access type: **App folder**
- Scopes: `files.content.read`, `files.content.write`, `files.metadata.read`
- Enable public client / PKCE flow

### 2. Add Redirect URIs

- Mobile: `mindwtr://redirect`
- Desktop: `http://127.0.0.1:53682/oauth/dropbox/callback`

### 3. Inject app key during build

- Desktop: `VITE_DROPBOX_APP_KEY=<your_app_key>`
- Mobile: `DROPBOX_APP_KEY=<your_app_key>`

For macOS App Store builds, the desktop OAuth callback uses a local loopback listener on `127.0.0.1:53682`, so the app entitlement set must include `com.apple.security.network.server`.

In CI/release workflows, set repository variables or secrets:

- `VITE_DROPBOX_APP_KEY`
- `DROPBOX_APP_KEY`

---

## Troubleshooting

### `Invalid redirect_uri`

Make sure the URI shown in Mindwtr matches Dropbox app settings exactly.

### HTTP 401 / token invalid

Token is expired/revoked or was issued for another app key. Reconnect Dropbox.

### No Dropbox option in settings

Your build likely has Dropbox disabled (common in FOSS builds) or missing build-time app key.

### App appears connected but sync does not run

Use **Test connection** first. If successful, run **Sync** and check logs in [[Diagnostics and Logs]].

---

## Security & Privacy

- Mindwtr requests only App Folder access, not full Dropbox account access.
- OAuth tokens are stored locally on device.
- Mindwtr developer does not proxy Dropbox requests or receive your Dropbox token.

See:

- [[Data and Sync]]
- `docs/PRIVACY.md` in the repository
