import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

vi.mock('@/hooks/use-theme-colors', () => ({
    useThemeColors: () => ({
        success: '#16a34a',
        warning: '#d97706',
        danger: '#dc2626',
        tint: '#2563eb',
        cardBg: '#ffffff',
        border: '#d1d5db',
        text: '#111827',
        secondaryText: '#6b7280',
        bg: '#f9fafb',
    }),
}));

vi.mock('@/lib/app-log', () => ({
    logError: vi.fn(),
}));

vi.mock('react-native', async () => {
    const actual = await vi.importActual<typeof import('react-native')>('react-native');
    class MockAnimatedValue {
        _value: number;

        constructor(value: number) {
            this._value = value;
        }

        stopAnimation() {
            return undefined;
        }

        setValue(value: number) {
            this._value = value;
        }
    }
    const createAnimation = () => ({
        start: (callback?: () => void) => callback?.(),
        stop: () => undefined,
    });
    return {
        ...actual,
        Animated: {
            ...actual.Animated,
            Value: MockAnimatedValue,
            timing: vi.fn(() => createAnimation()),
            parallel: vi.fn(() => createAnimation()),
        },
        Easing: {
            out: (value: unknown) => value,
            quad: 'quad',
            cubic: 'cubic',
        },
    };
});

import { ToastProvider, useToast } from './toast-context';

const QUEUE_GAP_MS = 120;
type ToastControls = {
    showToast: (options: { message: string; durationMs?: number }) => void;
};

const getRenderedText = (tree: ReactTestRenderer): string => JSON.stringify(tree.toJSON());

function ToastHarness({ onReady }: { onReady: (controls: ToastControls) => void }) {
    const controls = useToast();

    React.useEffect(() => {
        onReady(controls);
    }, [controls, onReady]);

    return null;
}

describe('ToastProvider', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    it('queues new toasts instead of replacing the current toast', () => {
        let controls: ToastControls | null = null;
        let tree: ReactTestRenderer | null = null;

        act(() => {
            tree = create(
                <ToastProvider>
                    <ToastHarness onReady={(value) => {
                        controls = value;
                    }}
                    />
                </ToastProvider>
            );
        });

        expect(controls).not.toBeNull();
        expect(tree).not.toBeNull();
        if (!controls || !tree) return;
        const toastControls = controls as ToastControls;
        const renderedTree = tree as ReactTestRenderer;

        act(() => {
            toastControls.showToast({ message: 'First toast', durationMs: 100 });
            toastControls.showToast({ message: 'Second toast', durationMs: 100 });
        });

        expect(getRenderedText(renderedTree)).toContain('First toast');
        expect(getRenderedText(renderedTree)).not.toContain('Second toast');

        act(() => {
            vi.advanceTimersByTime(100 + QUEUE_GAP_MS);
        });

        expect(getRenderedText(renderedTree)).not.toContain('First toast');
        expect(getRenderedText(renderedTree)).toContain('Second toast');

        act(() => {
            vi.advanceTimersByTime(100);
        });

        expect(getRenderedText(renderedTree)).not.toContain('Second toast');
    });
});
