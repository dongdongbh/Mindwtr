type ElementScrollSnapshot = {
    kind: 'element';
    target: HTMLElement;
    scrollLeft: number;
    scrollTop: number;
};

type WindowScrollSnapshot = {
    kind: 'window';
    scrollLeft: number;
    scrollTop: number;
};

export type ScrollSnapshot = ElementScrollSnapshot | WindowScrollSnapshot;

function addElementSnapshot(
    snapshots: ScrollSnapshot[],
    seen: Set<EventTarget>,
    element: HTMLElement | null | undefined,
    options?: { force?: boolean },
) {
    if (!element || seen.has(element)) return;
    const canScroll = element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth;
    const hasOffset = element.scrollTop !== 0 || element.scrollLeft !== 0;
    if (!options?.force && !canScroll && !hasOffset) return;

    seen.add(element);
    snapshots.push({
        kind: 'element',
        target: element,
        scrollLeft: element.scrollLeft,
        scrollTop: element.scrollTop,
    });
}

export function captureScrollSnapshot(anchor?: Element | null): ScrollSnapshot[] {
    if (typeof window === 'undefined' || typeof document === 'undefined') return [];

    const snapshots: ScrollSnapshot[] = [];
    const seen = new Set<EventTarget>();
    snapshots.push({
        kind: 'window',
        scrollLeft: window.scrollX,
        scrollTop: window.scrollY,
    });

    addElementSnapshot(snapshots, seen, document.scrollingElement as HTMLElement | null, { force: true });
    addElementSnapshot(snapshots, seen, document.querySelector<HTMLElement>('[data-main-content]'), { force: true });

    let node = anchor instanceof HTMLElement ? anchor : null;
    while (node) {
        addElementSnapshot(snapshots, seen, node);
        node = node.parentElement;
    }

    return snapshots;
}

export function restoreScrollSnapshot(snapshots: readonly ScrollSnapshot[]) {
    if (typeof window === 'undefined') return;

    snapshots.forEach((snapshot) => {
        if (snapshot.kind === 'window') {
            if (window.scrollX === snapshot.scrollLeft && window.scrollY === snapshot.scrollTop) return;
            try {
                window.scrollTo(snapshot.scrollLeft, snapshot.scrollTop);
            } catch {

            }
            return;
        }
        snapshot.target.scrollLeft = snapshot.scrollLeft;
        snapshot.target.scrollTop = snapshot.scrollTop;
    });
}

export function restoreScrollSnapshotSoon(snapshots: readonly ScrollSnapshot[]) {
    restoreScrollSnapshot(snapshots);
    if (typeof window === 'undefined') return;
    const restore = () => restoreScrollSnapshot(snapshots);
    if (typeof window.requestAnimationFrame === 'function') {
        window.requestAnimationFrame(restore);
    }
    window.setTimeout(restore, 0);
}

export function focusElementWithoutScroll(element: HTMLElement, snapshots = captureScrollSnapshot(element)) {
    try {
        element.focus({ preventScroll: true });
    } catch {
        element.focus();
    }
    restoreScrollSnapshot(snapshots);
}

export function keepTextareaSelectionVisible(textarea: HTMLTextAreaElement, paddingLines = 1) {
    const selectionStart = textarea.selectionStart ?? textarea.value.length;
    if (textarea.clientHeight <= 0) return;

    if (selectionStart >= textarea.value.length && textarea.scrollHeight > textarea.clientHeight) {
        textarea.scrollTop = Math.max(0, textarea.scrollHeight - textarea.clientHeight);
        return;
    }

    const linesBeforeCursor = textarea.value.slice(0, selectionStart).split('\n').length - 1;
    const computed = window.getComputedStyle(textarea);
    const lineHeight = Number.parseFloat(computed.lineHeight) || 24;
    const padding = lineHeight * paddingLines;
    const cursorTop = linesBeforeCursor * lineHeight;
    const cursorBottom = cursorTop + lineHeight;
    const visibleTop = textarea.scrollTop;
    const visibleBottom = visibleTop + textarea.clientHeight;

    if (cursorTop < visibleTop + padding) {
        textarea.scrollTop = Math.max(0, cursorTop - padding);
        return;
    }
    if (cursorBottom > visibleBottom - padding) {
        textarea.scrollTop = Math.max(0, cursorBottom - textarea.clientHeight + padding);
    }
}
