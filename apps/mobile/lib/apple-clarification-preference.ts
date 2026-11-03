import AsyncStorage from '@react-native-async-storage/async-storage';

export type AppleClarificationBackend = 'configured' | 'on-device';

const STORAGE_KEY = 'mindwtr:appleClarificationBackend:v1';

export async function readAppleClarificationBackend(): Promise<AppleClarificationBackend> {
  try {
    return (await AsyncStorage.getItem(STORAGE_KEY)) === 'on-device' ? 'on-device' : 'configured';
  } catch {
    return 'configured';
  }
}

export async function writeAppleClarificationBackend(backend: AppleClarificationBackend): Promise<void> {
  try {
    if (backend === 'on-device') {
      await AsyncStorage.setItem(STORAGE_KEY, backend);
    } else {
      await AsyncStorage.removeItem(STORAGE_KEY);
    }
  } catch {

  }
}
