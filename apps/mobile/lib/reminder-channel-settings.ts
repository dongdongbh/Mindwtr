import { REMINDER_NOTIFICATION_CHANNEL, REMINDER_NOTIFICATION_CHANNEL_NAME } from '@mindwtr/core';
import { startActivityAsync, ActivityAction } from 'expo-intent-launcher';
import { ensureReminderNotificationChannel } from '@/modules/notification-open-intents';
import { logInfo } from './app-log';

export async function openReminderChannelSettings(): Promise<void> {
  const { applicationId } = await import('expo-application');
  if (!applicationId) throw new Error('Android application ID unavailable');
  await ensureReminderNotificationChannel(REMINDER_NOTIFICATION_CHANNEL, REMINDER_NOTIFICATION_CHANNEL_NAME);
  await startActivityAsync(ActivityAction.CHANNEL_NOTIFICATION_SETTINGS, {
    extra: {
      'android.provider.extra.APP_PACKAGE': applicationId,
      'android.provider.extra.CHANNEL_ID': REMINDER_NOTIFICATION_CHANNEL,
    },
  });
  void logInfo('Reminder channel settings opened', {
    scope: 'notifications', force: true, extra: { releaseCheck: 'v1.3.9/reminder-channel-settings' },
  });
}
