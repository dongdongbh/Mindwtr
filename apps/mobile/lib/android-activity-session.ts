import { Platform } from 'react-native';

import { getAndroidActivitySession } from '@/modules/android-window-layout';

const MAX_RETAINED_OWNERS = 32;
const MAX_OWNER_ID_LENGTH = 160;
const MAX_OBSERVED_ACTIVITIES = 8;
export const ANDROID_ACTIVITY_SESSION_TTL_MS = 5 * 60_000;

type RetainedActivitySession = {
  createdAt: number;
  eligibleActivityId: number | null;
  sourceActivityId: number;
  sourceGeneration: number;
  value: unknown;
};

export type AndroidActivitySessionRecovery<T> = {
  value: T;
};

const retainedSessions = new Map<string, RetainedActivitySession>();
const activityGenerations = new Map<number, number>();
let currentActivityId: number | null = null;
let currentActivityGeneration = 0;

const isValidOwnerId = (ownerId: string): boolean => (
  ownerId.length > 0 && ownerId.length <= MAX_OWNER_ID_LENGTH
);

const getActivitySession = (activityId?: number) => {
  if (Platform.OS !== 'android') return null;
  try {
    const session = getAndroidActivitySession(activityId);
    if (!session || !Number.isSafeInteger(session.activityId) || session.activityId < 0) return null;
    return session;
  } catch {
    return null;
  }
};

const pruneOldestOwner = (): void => {
  if (retainedSessions.size < MAX_RETAINED_OWNERS) return;
  const oldestOwnerId = retainedSessions.keys().next().value;
  if (typeof oldestOwnerId === 'string') retainedSessions.delete(oldestOwnerId);
};

const pruneRetainedSessions = (nowMs: number, generation: number): void => {
  for (const [ownerId, retained] of retainedSessions) {
    const replacementGeneration = retained.sourceGeneration + 1;
    if (nowMs - retained.createdAt > ANDROID_ACTIVITY_SESSION_TTL_MS
        || generation > replacementGeneration) {
      retainedSessions.delete(ownerId);
    }
  }
};

const observeCurrentActivity = () => {
  const session = getActivitySession();
  if (!session) return null;
  if (session.activityId !== currentActivityId) {
    currentActivityId = session.activityId;
    currentActivityGeneration += 1;
    activityGenerations.set(session.activityId, currentActivityGeneration);
    while (activityGenerations.size > MAX_OBSERVED_ACTIVITIES) {
      const oldestActivityId = activityGenerations.keys().next().value;
      if (typeof oldestActivityId !== 'number') break;
      activityGenerations.delete(oldestActivityId);
    }
    pruneRetainedSessions(Date.now(), currentActivityGeneration);
  }
  return { generation: currentActivityGeneration, session };
};

/**
 * True only during the old Activity's verified configuration-change teardown.
 * The optional native capability fails closed so ordinary unmounts retain no UI
 * state or attachment ownership.
 */
export function getCurrentAndroidActivityId(): number | null {
  return observeCurrentActivity()?.session.activityId ?? null;
}

export function isAndroidActivityChangingConfigurations(activityId?: number | null): boolean {
  if (activityId === null) return false;
  const session = getActivitySession(activityId);
  if (!session || (activityId !== undefined && session.activityId !== activityId)) return false;
  return session.isChangingConfigurations === true;
}

/** Keep one process-local snapshot while Android replaces the current Activity. */
export function retainAndroidActivitySession<T>(
  ownerId: string,
  value: T,
  sourceActivityId?: number | null,
): boolean {
  if (!isValidOwnerId(ownerId)) return false;
  if (sourceActivityId === null) {
    retainedSessions.delete(ownerId);
    return false;
  }
  const session = getActivitySession(sourceActivityId);
  if (!session?.isChangingConfigurations
      || (sourceActivityId !== undefined && session.activityId !== sourceActivityId)) {
    retainedSessions.delete(ownerId);
    return false;
  }
  const sourceGeneration = activityGenerations.get(session.activityId);
  if (sourceGeneration === undefined) {
    retainedSessions.delete(ownerId);
    return false;
  }
  const current = observeCurrentActivity();
  if (current && current.session.activityId !== session.activityId
      && current.generation !== sourceGeneration + 1) {
    retainedSessions.delete(ownerId);
    return false;
  }
  if (!retainedSessions.has(ownerId)) pruneOldestOwner();
  retainedSessions.set(ownerId, {
    createdAt: Date.now(),
    eligibleActivityId: current?.session.activityId !== session.activityId
      ? current?.session.activityId ?? null
      : null,
    sourceActivityId: session.activityId,
    sourceGeneration,
    value,
  });
  return true;
}

/**
 * Consume a snapshot only in a different Activity in the same JS process.
 * Reading never replays within the Activity that captured it.
 */
export function takeAndroidActivitySession<T>(
  ownerId: string,
  validate: (value: unknown) => value is T,
): AndroidActivitySessionRecovery<T> | null {
  if (!isValidOwnerId(ownerId)) return null;
  const retained = retainedSessions.get(ownerId);
  if (!retained) return null;

  // Every attempted restore is one-shot, including invalid or unavailable
  // native state, so a rejected snapshot cannot surface on a later mount.
  retainedSessions.delete(ownerId);
  const current = observeCurrentActivity();
  if (!current
      || Date.now() - retained.createdAt > ANDROID_ACTIVITY_SESSION_TTL_MS
      || retained.sourceActivityId === current.session.activityId
      || current.generation !== retained.sourceGeneration + 1
      || (retained.eligibleActivityId !== null
        && retained.eligibleActivityId !== current.session.activityId)) return null;
  try {
    return validate(retained.value) ? { value: retained.value } : null;
  } catch {
    return null;
  }
}

export function clearAndroidActivitySession(ownerId: string): void {
  if (!isValidOwnerId(ownerId)) return;
  retainedSessions.delete(ownerId);
}
