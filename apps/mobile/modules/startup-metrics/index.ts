import { requireOptionalNativeModule } from 'expo-modules-core';
import { Platform } from 'react-native';


export async function reportFullyDrawn(): Promise<boolean> {
    if (Platform.OS !== 'android') return false;
    try {
        const native = requireOptionalNativeModule<{ reportFullyDrawnAsync(): Promise<boolean> }>('MindwtrStartupMetrics');
        return await native?.reportFullyDrawnAsync() ?? false;
    } catch { return false; }
}
