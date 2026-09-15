import AsyncStorage from '@react-native-async-storage/async-storage';
import type { OnDeviceClarificationBackend } from './on-device-clarification';

export type NanoClarificationBackend = OnDeviceClarificationBackend;

const STORAGE_KEY = 'mindwtr:nanoClarificationBackend:v1';

export async function readNanoClarificationBackend(): Promise<NanoClarificationBackend> {
  try {
    return (await AsyncStorage.getItem(STORAGE_KEY)) === 'on-device' ? 'on-device' : 'configured';
  } catch {
    return 'configured';
  }
}

export async function writeNanoClarificationBackend(backend: NanoClarificationBackend): Promise<void> {
  try {
    if (backend === 'on-device') {
      await AsyncStorage.setItem(STORAGE_KEY, backend);
    } else {
      await AsyncStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // Device-local preference durability is optional; the safe default remains configured.
  }
}
