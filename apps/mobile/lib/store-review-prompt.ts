import Constants from 'expo-constants';
import * as StoreReview from 'expo-store-review';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  attemptStoreReviewAfterPositiveMoment,
  type UserPromptPlatform,
} from '@mindwtr/core';

import { logWarn } from '@/lib/app-log';

type MobileReviewPromptExtraConfig = {
  isFossBuild?: boolean | string;
};

function getPromptPlatform(): UserPromptPlatform {
  if (Platform.OS === 'ios' || Platform.OS === 'android') return Platform.OS;
  if (Platform.OS === 'web') return 'web';
  return 'unknown';
}

function isFossBuild(): boolean {
  const extraConfig = Constants.expoConfig?.extra as MobileReviewPromptExtraConfig | undefined;
  return extraConfig?.isFossBuild === true || extraConfig?.isFossBuild === 'true';
}

function isStoreReviewPromptBuildEligible(): boolean {
  if (Constants.appOwnership === 'expo') return false;
  if (isFossBuild()) return false;
  return Platform.OS === 'ios' || Platform.OS === 'android';
}

async function hasNativeReviewAction(): Promise<boolean> {
  try {
    return await StoreReview.hasAction();
  } catch (error) {
    void logWarn('Failed to check native store review availability', {
      scope: 'store-review',
      extra: { error: error instanceof Error ? error.message : String(error) },
    });
    return false;
  }
}

export async function maybeRequestStoreReviewAfterPositiveMoment(nowMs = Date.now()): Promise<boolean> {
  // Core's gate and attempt record (user-prompts.ts), shared with the native hosts.
  if (!await attemptStoreReviewAfterPositiveMoment({
    buildEligible: isStoreReviewPromptBuildEligible(),
    platform: getPromptPlatform(),
    storage: AsyncStorage,
    hasNativeReviewAction,
    nowMs,
  })) {
    return false;
  }

  try {
    await StoreReview.requestReview();
    return true;
  } catch (error) {
    void logWarn('Native store review request failed', {
      scope: 'store-review',
      extra: { error: error instanceof Error ? error.message : String(error) },
    });
    return false;
  }
}

export async function requestStoreReviewForTesting(): Promise<boolean> {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return false;
  const storeReviewAvailable = await hasNativeReviewAction();
  if (!storeReviewAvailable) return false;

  try {
    await StoreReview.requestReview();
    return true;
  } catch (error) {
    void logWarn('Native store review test request failed', {
      scope: 'store-review',
      extra: { error: error instanceof Error ? error.message : String(error) },
    });
    return false;
  }
}
