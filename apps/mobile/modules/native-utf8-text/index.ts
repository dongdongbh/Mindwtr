import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

export interface NativeUtf8TextNative {
    /** Strict UTF-8 text of a base64 body, as TextDecoder would give it; null when the bytes are not valid UTF-8. */
    decodeBase64Utf8(base64: string): string | null;
}

let nativeModule: NativeUtf8TextNative | null | undefined;

export function getNativeUtf8TextNative(): NativeUtf8TextNative | null {
    if (Platform.OS !== 'ios') return null;
    if (nativeModule !== undefined) return nativeModule;
    try {
        const candidate = requireOptionalNativeModule<NativeUtf8TextNative>('MindwtrNativeUtf8Text');
        nativeModule = candidate && typeof candidate.decodeBase64Utf8 === 'function' ? candidate : null;
    } catch {
        nativeModule = null;
    }
    return nativeModule;
}
