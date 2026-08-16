import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, test, vi } from 'vitest';

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

import { ToastProvider, ToastViewport, useToast, useToastBottomOffset } from './toast-context';

const QUEUE_GAP_MS = 120;
const TOAST_SWIPE_TARGET_TEST_ID = 'toast-swipe-dismiss-target';
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

    test.each([
        ['right', 96],
        ['left', -96],
    ])('dismisses the visible toast after a horizontal swipe %s', (_direction, dx) => {
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
            toastControls.showToast({ message: `Swipe ${_direction}`, durationMs: 10_000 });
        });

        const swipeTarget = renderedTree.root.findByProps({ testID: TOAST_SWIPE_TARGET_TEST_ID });

        expect(getRenderedText(renderedTree)).toContain(`Swipe ${_direction}`);

        act(() => {
            swipeTarget.props.onResponderRelease?.({}, { dx, dy: 4, vx: 0.2 });
        });

        expect(getRenderedText(renderedTree)).not.toContain(`Swipe ${_direction}`);
    });

    it('renders the toast in the topmost mounted viewport instead of the root overlay', () => {
        let controls: ToastControls | null = null;
        let tree: ReactTestRenderer | null = null;

        const render = (withViewport: boolean) => (
            <ToastProvider>
                <ToastHarness onReady={(value) => {
                    controls = value;
                }}
                />
                {withViewport && <ToastViewport />}
            </ToastProvider>
        );

        act(() => {
            tree = create(render(true));
        });

        expect(controls).not.toBeNull();
        expect(tree).not.toBeNull();
        if (!controls || !tree) return;
        const toastControls = controls as ToastControls;
        const renderedTree = tree as ReactTestRenderer;

        act(() => {
            toastControls.showToast({ message: 'Modal toast', durationMs: 10_000 });
        });

        // Exactly one toast instance: the viewport renders it, the root overlay stays empty.
        expect(getRenderedText(renderedTree).match(/Modal toast/g)).toHaveLength(1);

        // Unmounting the viewport (modal closes) hands the toast back to the root overlay.
        act(() => {
            renderedTree.update(render(false));
        });

        expect(getRenderedText(renderedTree)).toContain('Modal toast');
    });

    it('lifts the root overlay above a registered bottom bar, but not modal viewports (#1044)', () => {
        let controls: ToastControls | null = null;
        let tree: ReactTestRenderer | null = null;

        function TabBarStub() {
            useToastBottomOffset(88);
            return null;
        }

        const render = (withViewport: boolean) => (
            <ToastProvider>
                <ToastHarness onReady={(value) => {
                    controls = value;
                }}
                />
                <TabBarStub />
                {withViewport && <ToastViewport />}
            </ToastProvider>
        );

        act(() => {
            tree = create(render(false));
        });
        expect(controls).not.toBeNull();
        expect(tree).not.toBeNull();
        if (!controls || !tree) return;
        const toastControls = controls as ToastControls;
        const renderedTree = tree as ReactTestRenderer;

        act(() => {
            toastControls.showToast({ message: 'Offset toast', durationMs: 10_000 });
        });

        // Root overlay: offset (88) + gap, not the plain safe-area padding.
        const viewport = renderedTree.root
            .findByProps({ testID: TOAST_SWIPE_TARGET_TEST_ID })
            .parent!;
        const paddingOf = (node: typeof viewport) => Object.assign(
            {},
            ...[node.props.style].flat(Infinity).filter(Boolean),
        ).paddingBottom;
        expect(paddingOf(viewport)).toBe(100);

        // A modal viewport has no tab bar under it: plain padding again.
        act(() => {
            renderedTree.update(render(true));
        });
        const modalViewport = renderedTree.root
            .findByProps({ testID: TOAST_SWIPE_TARGET_TEST_ID })
            .parent!;
        expect(paddingOf(modalViewport)).toBe(32);
    });
});
