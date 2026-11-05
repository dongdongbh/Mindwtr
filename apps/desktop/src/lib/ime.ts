type ImeKeyboardEvent = {
    key: string;
    isComposing?: boolean;
    keyCode?: number;
    nativeEvent?: {
        isComposing?: boolean;
        keyCode?: number;
    };
};


export function isImeComposing(event: ImeKeyboardEvent): boolean {
    const nativeEvent = event.nativeEvent ?? event;
    return nativeEvent.isComposing === true
        || nativeEvent.keyCode === 229
        || event.key === 'Process';
}
