import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildGtdSettingsModel, getTranslator } from '@mindwtr/core';

import { AndroidCaptureIntentSection } from './android-capture-intent-section';


const nativeMocks = vi.hoisted(() => ({
    getCaptureIntentConfig: vi.fn(),
    isSupported: vi.fn(() => true),
    setCaptureIntentEnabled: vi.fn(),
}));
const clipboardMocks = vi.hoisted(() => ({ setStringAsync: vi.fn() }));
const showToast = vi.hoisted(() => vi.fn());

vi.mock('@/modules/android-widget', () => nativeMocks);
vi.mock('expo-clipboard', () => clipboardMocks);
vi.mock('@/hooks/use-theme-colors', () => ({
    useThemeColors: () => ({ bg: '#000', cardBg: '#111', border: '#222', text: '#fff', secondaryText: '#999', tint: '#36f' }),
}));
vi.mock('@/contexts/toast-context', () => ({ useToast: () => ({ showToast }) }));
vi.mock('./settings.hooks', async () => {
    const core = await vi.importActual<typeof import('@mindwtr/core')>('@mindwtr/core');
    const t = core.getTranslator('en');
    return { useSettingsLocalization: () => ({ tr: (key: string) => core.resolveI18nText(t, key) }) };
});

const TOKEN = 'cd'.repeat(32);
const settle = async () => {
    await Promise.resolve();
    await Promise.resolve();
};

const corePanel = (enabled?: boolean | null) => buildGtdSettingsModel({
    settings: {},
    areas: [],
    taskOpenMode: 'automatic',
    ...(enabled === undefined ? {} : { captureIntent: { enabled } }),
    t: getTranslator('en'),
}).capture.captureIntent;

const texts = (node: renderer.ReactTestRendererJSON | renderer.ReactTestRendererJSON[] | string | null): string[] => {
    if (node === null) return [];
    if (typeof node === 'string') return [node];
    if (Array.isArray(node)) return node.flatMap(texts);
    return (node.children ?? []).flatMap((child) => texts(child as renderer.ReactTestRendererJSON | string));
};

async function render() {
    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
        tree = renderer.create(<AndroidCaptureIntentSection />);
        await settle();
    });
    return tree;
}


function drawn(tree: renderer.ReactTestRenderer) {
    const toggle = tree.root.findByProps({ testID: 'android-capture-intent-switch' }).props;
    return { texts: texts(tree.toJSON()), value: toggle.value, disabled: toggle.disabled };
}
function expected(panel: NonNullable<ReturnType<typeof corePanel>>) {
    return {
        texts: [panel.label, panel.description, ...(panel.token ? [panel.token.label, TOKEN, panel.token.copyLabel] : [])],
        value: panel.value,
        disabled: panel.disabled,
    };
}

describe('automation capture card: React Native and core', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        nativeMocks.isSupported.mockReturnValue(true);
        nativeMocks.setCaptureIntentEnabled.mockImplementation(async (enabled: boolean) => (
            enabled ? { enabled: true, token: TOKEN } : { enabled: false, token: null }
        ));
        clipboardMocks.setStringAsync.mockResolvedValue(true);
    });

    it('is absent on both without a capture intent', async () => {
        nativeMocks.isSupported.mockReturnValue(false);
        expect((await render()).toJSON()).toBeNull();
        expect(corePanel()).toBeNull();
    });

    it('draws the same card off, on with the token row, and unreadable', async () => {
        nativeMocks.getCaptureIntentConfig.mockResolvedValue({ enabled: false, token: null });
        expect(drawn(await render())).toEqual(expected(corePanel(false)!));

        nativeMocks.getCaptureIntentConfig.mockResolvedValue({ enabled: true, token: TOKEN });
        expect(drawn(await render())).toEqual(expected(corePanel(true)!));

        nativeMocks.getCaptureIntentConfig.mockRejectedValue(new Error('corrupt'));
        expect(drawn(await render())).toEqual(expected(corePanel(null)!));
        expect(showToast).toHaveBeenLastCalledWith({ message: corePanel(null)!.messages.loadFailed, tone: 'error' });
    });

    it('shows the same toasts for a copy, a failed copy and a failed switch', async () => {
        const { messages } = corePanel(true)!;
        nativeMocks.getCaptureIntentConfig.mockResolvedValue({ enabled: true, token: TOKEN });
        const tree = await render();

        await act(async () => {
            tree.root.findByProps({ testID: 'android-capture-intent-copy' }).props.onPress();
            await settle();
        });
        expect(showToast).toHaveBeenLastCalledWith({ message: messages.copied, tone: 'info' });

        clipboardMocks.setStringAsync.mockRejectedValueOnce(new Error('denied'));
        await act(async () => {
            tree.root.findByProps({ testID: 'android-capture-intent-copy' }).props.onPress();
            await settle();
        });
        expect(showToast).toHaveBeenLastCalledWith({ message: messages.copyFailed, tone: 'error' });

        nativeMocks.setCaptureIntentEnabled.mockRejectedValueOnce(new Error('disk full'));
        await act(async () => {
            tree.root.findByProps({ testID: 'android-capture-intent-switch' }).props.onValueChange(false);
            await settle();
        });
        expect(showToast).toHaveBeenLastCalledWith({ message: messages.updateFailed, tone: 'error' });
    });
});
