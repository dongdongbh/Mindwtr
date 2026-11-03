


import AsyncStorage from '@react-native-async-storage/async-storage';
import { buildSyncLocationScope, readSyncLocationScope } from '@mindwtr/core';

export { buildSyncLocationScope };


export const readActiveSyncLocationScope = async (): Promise<string | null> => readSyncLocationScope(AsyncStorage);
