import { expect, it, vi } from 'vitest';
import { openReminderChannelSettings } from './reminder-channel-settings';

const { createChannel, launch } = vi.hoisted(() => ({
  createChannel: vi.fn(),
  launch: vi.fn(),
}));
vi.mock('@/modules/notification-open-intents', () => ({ ensureReminderNotificationChannel: createChannel }));
vi.mock('expo-application', () => ({ applicationId: 'tech.dongdongbh.mindwtr.dev' }));
vi.mock('expo-intent-launcher', () => ({
  startActivityAsync: launch,
  ActivityAction: { CHANNEL_NOTIFICATION_SETTINGS: 'android.settings.CHANNEL_NOTIFICATION_SETTINGS' },
}));
vi.mock('./app-log', () => ({ logInfo: vi.fn() }));

it('ensures the timed reminder channel before opening its settings for this installed app', async () => {
  await openReminderChannelSettings();
  expect(createChannel).toHaveBeenCalledWith('mindwtr_reminders_v2', 'Mindwtr reminders');
  expect(createChannel.mock.invocationCallOrder[0]).toBeLessThan(launch.mock.invocationCallOrder[0]);
  expect(launch).toHaveBeenCalledWith('android.settings.CHANNEL_NOTIFICATION_SETTINGS', {
    extra: {
      'android.provider.extra.APP_PACKAGE': 'tech.dongdongbh.mindwtr.dev',
      'android.provider.extra.CHANNEL_ID': 'mindwtr_reminders_v2',
    },
  });
});
