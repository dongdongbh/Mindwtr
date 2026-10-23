import { requireOptionalNativeModule, type NativeModule } from 'expo-modules-core';
import { findNodeHandle, Platform, type TextInput } from 'react-native';

interface ModalKeyboardModule extends NativeModule {
  getModalKeyboardInsetAsync?(viewTag: number): Promise<number | null>;
}

const native = Platform.OS === 'android'
  ? requireOptionalNativeModule<ModalKeyboardModule>('MindwtrSystemBars')
  : null;

export async function measureAndroidModalKeyboardInset(input: TextInput): Promise<number | null> {
  try {
    if (!native?.getModalKeyboardInsetAsync) return null;
    const tag = findNodeHandle(input);
    if (tag === null) return null;
    const inset = await native.getModalKeyboardInsetAsync(tag);
    return typeof inset === 'number' && Number.isFinite(inset) && inset >= 0 ? inset : null;
  } catch {
    // Old development clients and detached inputs keep the existing event path.
    return null;
  }
}
