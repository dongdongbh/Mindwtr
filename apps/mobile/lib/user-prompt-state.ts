import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  LOCAL_USER_PROMPT_STATE_KEY,
  readLocalUserPromptState as readCoreLocalUserPromptState,
  recordLocalPromptActivity as recordCoreLocalPromptActivity,
  updateLocalUserPromptState as updateCoreLocalUserPromptState,
  writeLocalUserPromptState as writeCoreLocalUserPromptState,
  type UserPromptState,
} from '@mindwtr/core';

// Core's (user-prompts.ts) on RN's AsyncStorage, shared with the native hosts.
export { LOCAL_USER_PROMPT_STATE_KEY };

export async function readLocalUserPromptState(): Promise<UserPromptState> {
  return readCoreLocalUserPromptState(AsyncStorage);
}

export async function writeLocalUserPromptState(promptState: UserPromptState): Promise<void> {
  await writeCoreLocalUserPromptState(AsyncStorage, promptState);
}

export async function updateLocalUserPromptState(
  updater: (promptState: UserPromptState) => UserPromptState,
): Promise<UserPromptState> {
  return updateCoreLocalUserPromptState(AsyncStorage, updater);
}

export async function recordLocalPromptActivity(nowMs = Date.now()): Promise<UserPromptState> {
  return recordCoreLocalPromptActivity(AsyncStorage, nowMs);
}
