import { forwardRef, useLayoutEffect, useRef, useState, type TextareaHTMLAttributes } from 'react';

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

        const nextMinHeight = isFocused ? (focusedMinHeight ?? minHeight) : minHeight;
        node.style.height = '0px';
        const nextHeight = Math.max(nextMinHeight, Math.min(node.scrollHeight, maxHeight));
        node.style.height = `${nextHeight}px`;
        node.style.overflowY = node.scrollHeight > maxHeight ? 'auto' : 'hidden';
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
