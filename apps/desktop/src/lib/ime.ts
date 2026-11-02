type ImeKeyboardEvent = {
    key: string;
    isComposing?: boolean;
    keyCode?: number;
    nativeEvent?: {
        isComposing?: boolean;
        keyCode?: number;
    };
};

/** Accept native and React keyboard events, including WebKit's IME key code. */
export function isImeComposing(event: ImeKeyboardEvent): boolean {
    const nativeEvent = event.nativeEvent ?? event;
    return nativeEvent.isComposing === true
        || nativeEvent.keyCode === 229
        || event.key === 'Process';
}
