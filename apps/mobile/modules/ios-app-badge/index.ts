import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';

export interface IosAppBadgeNative {
    isBadgeAuthorized(): Promise<boolean>;
    requestBadgeAuthorization(): Promise<boolean>;
    setBadgeCount(count: number): Promise<void>;
}

let nativeModule: IosAppBadgeNative | null | undefined;

export function getIosAppBadgeNative(): IosAppBadgeNative | null {
    if (Platform.OS !== 'ios') return null;
    if (nativeModule !== undefined) return nativeModule;
    try {
        const candidate = requireOptionalNativeModule<IosAppBadgeNative>('MindwtrIosAppBadge');
        nativeModule = candidate
            && typeof candidate.isBadgeAuthorized === 'function'
            && typeof candidate.requestBadgeAuthorization === 'function'
            && typeof candidate.setBadgeCount === 'function'
            ? candidate : null;
    } catch {
        nativeModule = null;
    }
    return nativeModule;
}
