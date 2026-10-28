import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLanguage } from '../contexts/language-context';
import {
    applyNativeEngage,
    createAppLockIdleTracker,
    lockApp,
    turnOffAppLockWhenUnavailable,
    unlockApp,
    useAppLockStore,
    type AppLockOutcome,
} from '../lib/app-lock';
import { isMacRuntime, isTauriRuntime } from '../lib/runtime';

/** Ctrl+Shift+L / Cmd+Shift+L. Shift keeps it off AltGr layouts and out of text input. */
export function isAppLockShortcut(event: Pick<KeyboardEvent, 'altKey' | 'code' | 'ctrlKey' | 'metaKey' | 'shiftKey'>): boolean {
    return (event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && event.code === 'KeyL';
}

/**
 * Makes every child of <body> except the lock screen inert and hidden from
 * assistive tech, including portals (dialogs, menus) added while locked. The
 * React tree beneath stays mounted, so unsaved edits survive the lock.
 */
function hideEverythingBut(keep: HTMLElement): () => void {
    const changed = new Map<Element, boolean>();
    const hide = (element: Element) => {
        if (element === keep || changed.has(element) || element.tagName === 'SCRIPT') return;
        changed.set(element, element.hasAttribute('aria-hidden'));
        element.setAttribute('inert', '');
        if (!element.hasAttribute('aria-hidden')) element.setAttribute('aria-hidden', 'true');
    };
    Array.from(document.body.children).forEach(hide);
    const observer = new MutationObserver((records) => {
        records.forEach((record) => record.addedNodes.forEach((node) => {
            if (node instanceof Element) hide(node);
        }));
    });
    observer.observe(document.body, { childList: true });
    return () => {
        observer.disconnect();
        changed.forEach((hadAriaHidden, element) => {
            element.removeAttribute('inert');
            if (!hadAriaHidden) element.removeAttribute('aria-hidden');
        });
    };
}

function outcomeMessageKey(outcome: AppLockOutcome): string | null {
    if (outcome === 'cancelled') return 'appLock.cancelled';
    if (outcome === 'failed') return 'appLock.failed';
    if (outcome === 'unavailable') return 'appLock.osCheckUnavailable';
    return null;
}

/**
 * The lock screen plus the triggers that engage it. Mounted next to the app
 * (not around it), from the first render, so nothing unmounts on lock.
 */
export function AppLockGate() {
    const { t } = useLanguage();
    const enabled = useAppLockStore((state) => state.enabled);
    const locked = useAppLockStore((state) => state.locked);
    const trigger = useAppLockStore((state) => state.trigger);
    const authInFlight = useAppLockStore((state) => state.authInFlight);
    const [message, setMessage] = useState<string | null>(null);
    // The OS check answered "unavailable": offer the way out (Rust re-checks).
    const [checkUnavailable, setCheckUnavailable] = useState(false);
    const overlayRef = useRef<HTMLDivElement>(null);
    const autoPromptRef = useRef<'armed' | 'waiting' | 'done'>('waiting');

    useLayoutEffect(() => {
        if (!locked || !overlayRef.current) return;
        const restore = hideEverythingBut(overlayRef.current);
        // Drives the print rule in index.css: only the lock screen prints.
        document.documentElement.setAttribute('data-app-locked', 'true');
        overlayRef.current.focus();
        return () => {
            document.documentElement.removeAttribute('data-app-locked');
            restore();
        };
    }, [locked]);

    const unlock = async () => {
        setMessage(null);
        // macOS shows the reason after "Mindwtr is trying to …".
        const outcome = await unlockApp(t(isMacRuntime() ? 'appLock.macUnlockReason' : 'appLock.prompt'));
        setCheckUnavailable(outcome === 'unavailable');
        const key = outcomeMessageKey(outcome);
        if (key) setMessage(t(key));
    };

    const turnOff = async () => {
        const outcome = await turnOffAppLockWhenUnavailable();
        if (outcome === 'success') return;
        // The check is available again: stay locked and use Unlock.
        setCheckUnavailable(false);
        setMessage(t('appLock.cancelled'));
    };

    // Auto-prompt once per lock, only when the user came back: at startup and
    // after an away lock as soon as the window has focus; after a manual or idle
    // lock only once focus has left and returned. Never while unfocused.
    useEffect(() => {
        if (!locked) {
            autoPromptRef.current = 'waiting';
            setMessage(null);
            setCheckUnavailable(false);
            return;
        }
        if (trigger === 'startup' || trigger === 'away' || !document.hasFocus()) autoPromptRef.current = 'armed';
        const tryPrompt = () => {
            if (autoPromptRef.current !== 'armed' || !document.hasFocus()) return;
            autoPromptRef.current = 'done';
            void unlock();
        };
        // Leaving and coming back re-arms it, even after a cancelled prompt.
        // The prompt's own blur happens while authInFlight, so it does not.
        const onBlur = () => {
            if (!useAppLockStore.getState().authInFlight) {
                autoPromptRef.current = 'armed';
            }
        };
        // A timer, not requestAnimationFrame: rAF stalls in a hidden window.
        const timer = window.setTimeout(tryPrompt, 0);
        window.addEventListener('focus', tryPrompt);
        window.addEventListener('blur', onBlur);
        return () => {
            window.clearTimeout(timer);
            window.removeEventListener('focus', tryPrompt);
            window.removeEventListener('blur', onBlur);
        };
    }, [locked, trigger]);

    useEffect(() => {
        if (!enabled) return;
        const tracker = createAppLockIdleTracker();
        const onInput = () => tracker.input();
        const onKeyDown = (event: KeyboardEvent) => {
            if (!isAppLockShortcut(event)) return;
            event.preventDefault();
            event.stopPropagation();
            lockApp('manual');
        };
        const inputEvents = ['pointerdown', 'pointermove', 'keydown', 'wheel'] as const;
        inputEvents.forEach((name) => window.addEventListener(name, onInput, { capture: true, passive: true }));
        window.addEventListener('keydown', onKeyDown, true);
        let disposed = false;
        const unlisteners: Array<() => void> = [];
        if (isTauriRuntime()) {
            void import('@tauri-apps/api/event').then(async ({ listen }) => {
                const handles = await Promise.all([
                    listen<string>('app-lock-engaged', (event) => applyNativeEngage(event.payload)),
                ]);
                if (disposed) handles.forEach((unlisten) => unlisten());
                else unlisteners.push(...handles);
            }).catch(() => undefined);
        }
        return () => {
            disposed = true;
            tracker.dispose();
            inputEvents.forEach((name) => window.removeEventListener(name, onInput, { capture: true }));
            window.removeEventListener('keydown', onKeyDown, true);
            unlisteners.forEach((unlisten) => unlisten());
        };
    }, [enabled]);

    if (!locked) return null;
    return createPortal(
        <div
            ref={overlayRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="app-lock-title"
            tabIndex={-1}
            data-testid="app-lock-screen"
            data-app-lock-screen=""
            className="fixed inset-0 flex flex-col items-center justify-center gap-4 bg-background text-foreground outline-none"
            style={{ zIndex: 2147483647 }}
        >
            <img src="/logo.png" alt="" className="h-14 w-14 rounded-xl" />
            <h1 id="app-lock-title" className="text-lg font-semibold">{t('appLock.title')}</h1>
            <button
                type="button"
                onClick={() => void unlock()}
                disabled={authInFlight}
                className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
            >
                {authInFlight ? t('appLock.authenticating') : t('appLock.unlock')}
            </button>
            <p role="status" className="min-h-5 text-sm text-muted-foreground">{message ?? ''}</p>
            {checkUnavailable && (
                <button
                    type="button"
                    onClick={() => void turnOff()}
                    className="rounded-md border border-border px-4 py-2 text-sm hover:bg-muted/60"
                >
                    {t('appLock.turnOff')}
                </button>
            )}
        </div>,
        document.body,
    );
}
