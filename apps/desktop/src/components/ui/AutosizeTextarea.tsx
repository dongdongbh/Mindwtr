import { forwardRef, useLayoutEffect, useRef, useState, type TextareaHTMLAttributes } from 'react';
import { captureScrollSnapshot, restoreScrollSnapshot } from '../../lib/scroll-preservation';

type AutosizeTextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & {
    minHeight?: number;
    focusedMinHeight?: number;
    maxHeight?: number;
};

export const AutosizeTextarea = forwardRef<HTMLTextAreaElement, AutosizeTextareaProps>(function AutosizeTextarea(
    {
        minHeight = 96,
        focusedMinHeight,
        maxHeight = 420,
        onBlur,
        onFocus,
        style,
        ...props
    },
    forwardedRef,
) {
    const internalRef = useRef<HTMLTextAreaElement | null>(null);
    const [isFocused, setIsFocused] = useState(false);
    const previousValueRef = useRef<string | null>(null);

    const setRefs = (node: HTMLTextAreaElement | null) => {
        internalRef.current = node;
        if (typeof forwardedRef === 'function') {
            forwardedRef(node);
            return;
        }
        if (forwardedRef) {
            forwardedRef.current = node;
        }
    };

    useLayoutEffect(() => {
        const node = internalRef.current;
        if (!node) return;

        const scrollSnapshot = captureScrollSnapshot(node);
        const nextMinHeight = isFocused ? (focusedMinHeight ?? minHeight) : minHeight;
        const value = String(props.value ?? '');
        const previousValue = previousValueRef.current;
        previousValueRef.current = value;
        // Typing only adds text, so the box can only grow. Skip the height reset
        // there: it relayouts and repaints the whole editor on every keystroke,
        // which WebKitGTK paints slowly inside the Focus card (#1454).
        // ponytail: a same-length edit that removes a line keeps the old height until the next deletion.
        const canOnlyGrow = previousValue !== null && value !== previousValue && value.length >= previousValue.length;
        if (!canOnlyGrow) node.style.height = 'auto';
        const nextHeight = Math.max(nextMinHeight, Math.min(node.scrollHeight, maxHeight));
        node.style.height = `${nextHeight}px`;
        node.style.overflowY = node.scrollHeight > maxHeight ? 'auto' : 'hidden';
        restoreScrollSnapshot(scrollSnapshot);
    }, [focusedMinHeight, isFocused, maxHeight, minHeight, props.value]);

    return (
        <textarea
            {...props}
            ref={setRefs}
            rows={props.rows ?? 4}
            style={style}
            onFocus={(event) => {
                setIsFocused(true);
                onFocus?.(event);
            }}
            onBlur={(event) => {
                setIsFocused(false);
                onBlur?.(event);
            }}
        />
    );
});
