import { describe, expect, it } from 'vitest';
import { initializeSandboxRuntime } from '@mindwtr/core';
import { isSandboxNativeCommandAllowed } from './tauri-invoke';

describe('sandbox native command policy', () => {
    it('allows window lifecycle commands and rejects personal-data commands', () => {
        initializeSandboxRuntime(true);

        expect(isSandboxNativeCommandAllowed('notify_ui_ready')).toBe(true);
        expect(isSandboxNativeCommandAllowed('quit_app')).toBe(true);
        expect(isSandboxNativeCommandAllowed('save_data')).toBe(false);
        expect(isSandboxNativeCommandAllowed('import_attachment')).toBe(false);
        expect(isSandboxNativeCommandAllowed('set_tray_tooltip')).toBe(false);
    });
});
