import { describe, expect, it } from 'vitest';

import { getPreferredDesktopAudioCaptureBackend } from './audio-capture-backend';

describe('getPreferredDesktopAudioCaptureBackend', () => {
    it('prefers the native recorder for non-flatpak tauri installs', () => {
        expect(
            getPreferredDesktopAudioCaptureBackend({
                isTauriRuntime: true,
                isFlatpakRuntime: false,
            })
        ).toBe('native');
    });

    it('prefers the native recorder inside flatpak tauri installs', () => {
        expect(
            getPreferredDesktopAudioCaptureBackend({
                isTauriRuntime: true,
                isFlatpakRuntime: true,
            })
        ).toBe('native');
    });

    it('uses the web recorder outside tauri', () => {
        expect(
            getPreferredDesktopAudioCaptureBackend({
                isTauriRuntime: false,
                isFlatpakRuntime: false,
            })
        ).toBe('web');
    });
});
