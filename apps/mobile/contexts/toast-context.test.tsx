import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, test, vi } from 'vitest';
import { ToastProvider, ToastViewport, useToast, useToastBottomOffset, type ToastOptions } from './toast-context';

// Android's "Time to take action" (AccessibilityManager.getRecommendedTimeoutMillis); iOS answers the time it was given.
const recommendedTimeout = vi.hoisted(() => vi.fn(async (original: number) => original));

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
        AccessibilityInfo: { ...actual.AccessibilityInfo, getRecommendedTimeoutMillis: recommendedTimeout },
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


const QUEUE_GAP_MS = 120;
const TOAST_SWIPE_TARGET_TEST_ID = 'toast-swipe-dismiss-target';
type ToastControls = {
    showToast: (options: ToastOptions) => void;
    dismissToast: () => void;
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
        recommendedTimeout.mockReset();
        recommendedTimeout.mockImplementation(async (original: number) => original);
    });

    const mount = () => {
        let controls: ToastControls | null = null;
        let tree: ReactTestRenderer | null = null;
        act(() => {
            tree = create(<ToastProvider><ToastHarness onReady={(value) => { controls = value; }} /></ToastProvider>);
        });
        return { controls: controls as unknown as ToastControls, tree: tree as unknown as ReactTestRenderer };
    };

    // Native Android (o2f) keeps an action toast for the user's "Time to take action", never below RN's 5.2 s; RN used 5.2 s always.
    it('keeps a toast with Undo for the accessibility time to take action, never below 5.2 s', async () => {
        recommendedTimeout.mockResolvedValue(20_000);
        const { controls, tree } = mount();
        await act(async () => { controls.showToast({ message: 'Task marked Done', actionLabel: 'Undo', onAction: () => undefined }); });
        expect(recommendedTimeout).toHaveBeenCalledWith(5200);
        act(() => { vi.advanceTimersByTime(6_000); });
        expect(getRenderedText(tree)).toContain('Task marked Done');
        act(() => { vi.advanceTimersByTime(14_000); });
        expect(getRenderedText(tree)).not.toContain('Task marked Done');

        recommendedTimeout.mockResolvedValue(1_000);
        await act(async () => { controls.showToast({ message: 'Moved to Trash', actionLabel: 'Undo', onAction: () => undefined }); });
        act(() => { vi.advanceTimersByTime(5_000); });
        expect(getRenderedText(tree)).toContain('Moved to Trash');
        act(() => { vi.advanceTimersByTime(200); });
        expect(getRenderedText(tree)).not.toContain('Moved to Trash');
    });

    it('asks nothing for a toast with no action', async () => {
        const { controls } = mount();
        await act(async () => { controls.showToast({ message: 'Saved' }); });
        expect(recommendedTimeout).not.toHaveBeenCalled();
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
        ['right', 96, false],
        ['left', -96, false],
        ['right in a modal', 96, true],
        ['left in a modal', -96, true],
    ])('dismisses the visible toast after a horizontal swipe %s', (_direction, dx, withViewport) => {
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
        if (withViewport) {
            act(() => {
                renderedTree.update(
                    <ToastProvider>
                        <ToastHarness onReady={() => undefined} />
                        <ToastViewport />
                    </ToastProvider>
                );
            });
        }

        act(() => {
            toastControls.showToast({ message: `Swipe ${_direction}`, durationMs: 10_000 });
        });

        const swipeTarget = renderedTree.root.findByProps({ testID: TOAST_SWIPE_TARGET_TEST_ID });

        expect(getRenderedText(renderedTree)).toContain(`Swipe ${_direction}`);
        // A native Modal claims unhandled starts; waiting for a move loses the
        // gesture before this toast can ever become the responder.
        expect(swipeTarget.props.onStartShouldSetResponder({}, {})).toBe(true);

        act(() => {
            swipeTarget.props.onResponderRelease?.({}, { dx, dy: 4, vx: 0.2 });
        });

        expect(getRenderedText(renderedTree)).not.toContain(`Swipe ${_direction}`);
    });

    test.each([
        ['tap', { dx: 0, dy: 0, vx: 0 }],
        ['short drag', { dx: 30, dy: 2, vx: 0.1 }],
        ['vertical swipe', { dx: 80, dy: 180, vx: 0.7 }],
    ])('keeps the toast visible after a %s', (_kind, gesture) => {
        let controls!: ToastControls;
        let tree!: ReactTestRenderer;
        act(() => {
            tree = create(<ToastProvider><ToastHarness onReady={(value) => { controls = value; }} /><ToastViewport /></ToastProvider>);
        });
        act(() => { controls.showToast({ message: 'Still visible', durationMs: 10_000 }); });
        const target = tree.root.findByProps({ testID: TOAST_SWIPE_TARGET_TEST_ID });
        act(() => {
            target.props.onResponderMove({}, gesture);
            target.props.onResponderRelease({}, gesture);
        });
        expect(getRenderedText(tree)).toContain('Still visible');
    });

    it('keeps advancing the queue when dismissal repeats during the gap', () => {
        let controls!: ToastControls;
        let tree!: ReactTestRenderer;
        act(() => {
            tree = create(<ToastProvider><ToastHarness onReady={(value) => { controls = value; }} /></ToastProvider>);
        });
        act(() => {
            controls.showToast({ message: 'First', durationMs: 10_000 });
            controls.showToast({ message: 'Second', durationMs: 10_000 });
        });
        act(() => { controls.dismissToast(); });
        act(() => { controls.dismissToast(); });
        act(() => { vi.advanceTimersByTime(QUEUE_GAP_MS); });
        expect(getRenderedText(tree)).not.toContain('First');
        expect(getRenderedText(tree)).toContain('Second');
        act(() => { controls.dismissToast(); });
        expect(getRenderedText(tree)).not.toContain('Second');
    });

    it('keeps the Undo action usable inside an inline modal viewport', async () => {
        let controls!: ToastControls;
        let tree!: ReactTestRenderer;
        const undo = vi.fn();
        act(() => {
            tree = create(
                <ToastProvider>
                    <ToastHarness onReady={(value) => { controls = value; }} />
                    <ToastViewport inline />
                </ToastProvider>
            );
        });
        act(() => { controls.showToast({ message: 'Filed', actionLabel: 'Undo', onAction: undo }); });
        const target = tree.root.findByProps({ testID: TOAST_SWIPE_TARGET_TEST_ID });
        // Inline viewports occupy normal layout space instead of covering controls.
        const flatten = (style: unknown) => Object.assign({}, ...[style].flat(Infinity).filter(Boolean));
        expect(flatten(target.parent!.props.style).position).not.toBe('absolute');
        expect(flatten(target.parent!.parent!.props.style).position).not.toBe('absolute');
        const action = target.findByProps({ accessibilityRole: 'button' });
        await act(async () => { await action.props.onPress(); });
        expect(undo).toHaveBeenCalledOnce();
        expect(getRenderedText(tree)).not.toContain('Filed');
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
