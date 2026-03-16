import { describe, expect, it } from 'vitest';

const plugin = require('./patch-alarm-notification-gradle');

const {
  applyGradleCompatPatchToSource,
  applyAlarmPendingIntentPatchToSource,
  applyAlarmReminderBehaviorPatchToSource,
  applyAlarmAudioInterfacePatchToSource,
  applyAlarmDismissReceiverPatchToSource,
  applyAlarmReceiverPatchToSource,
} = plugin.__testables;

describe('patch-alarm-notification-gradle', () => {
  it('patches AlarmUtil pending intent flags for Android 12+', () => {
    const input = `class AlarmUtil {
    private NotificationManager getNotificationManager() {
        return null;
    }

    void demo(Context context, Intent intent, int id) {
        PendingIntent.getBroadcast(context, id, intent, 0);
        PendingIntent.getActivity(context, id, intent, PendingIntent.FLAG_UPDATE_CURRENT);
    }
}`;

    const output = applyAlarmPendingIntentPatchToSource(input);

    expect(output).toContain('private int getImmutableFlag()');
    expect(output).toContain('PendingIntent.getBroadcast(context, id, intent, getImmutableFlag())');
    expect(output).toContain('PendingIntent.getActivity(context, id, intent, getUpdateCurrentImmutableFlags())');
  });

  it('patches AlarmUtil reminder behavior away from alarm semantics', () => {
    const input = `class AlarmUtil {
    void init() {
        uri = Settings.System.DEFAULT_ALARM_ALERT_URI;
    }

    void send(Alarm alarm, NotificationCompat.Builder builder, Vibrator vibrator) {
        boolean playSound = alarm.isPlaySound();
        if (playSound) {
            this.playAlarmSound(alarm.getSoundName(), alarm.getSoundNames(), alarm.isLoopSound(), alarm.getVolume());
        }
        NotificationChannel mChannel = new NotificationChannel(channelID, "Alarm Notify", NotificationManager.IMPORTANCE_HIGH);
                mChannel.setVibrationPattern(null);

                // play vibration
                if (alarm.isVibrate()) {
                    Vibrator vibrator = (Vibrator) mContext.getSystemService(Context.VIBRATOR_SERVICE);
                    if (vibrator.hasVibrator()) {
                        vibrator.vibrate(VibrationEffect.createWaveform(vibrationPattern, 0));
                    }
                }
        builder.setPriority(NotificationCompat.PRIORITY_MAX);
        builder.setCategory(NotificationCompat.CATEGORY_ALARM);
        builder.setSound(null);
    }
}`;

    const output = applyAlarmReminderBehaviorPatchToSource(input);

    expect(output).toContain('Settings.System.DEFAULT_NOTIFICATION_URI');
    expect(output).not.toContain('this.playAlarmSound(');
    expect(output).toContain('NotificationManager.IMPORTANCE_DEFAULT');
    expect(output).toContain('NotificationCompat.PRIORITY_DEFAULT');
    expect(output).toContain('NotificationCompat.CATEGORY_REMINDER');
    expect(output).toContain('.setSound(playSound ? android.provider.Settings.System.DEFAULT_NOTIFICATION_URI : null)');
    expect(output).toContain('mChannel.enableVibration(alarm.isVibrate());');
    expect(output).toContain('mChannel.setSound(playSound ? android.provider.Settings.System.DEFAULT_NOTIFICATION_URI : null, null);');
  });

  it('patches AudioInterface fallback sound away from the alarm tone', () => {
    const input = `class AudioInterface {
    void init(Context context) {
        uri = Settings.System.DEFAULT_ALARM_ALERT_URI;
    }
}`;

    const output = applyAlarmAudioInterfacePatchToSource(input);

    expect(output).toContain('Settings.System.DEFAULT_NOTIFICATION_URI');
    expect(output).not.toContain('Settings.System.DEFAULT_ALARM_ALERT_URI');
  });

  it('patches dismiss receiver to cancel alarms even without a React context', () => {
    const input = `        try {
            if (ANModule.getReactAppContext() != null) {
                int notificationId = intent.getExtras().getInt(Constants.DISMISSED_NOTIFICATION_ID);
                ANModule.getReactAppContext().getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class).emit("OnNotificationDismissed", "{\\"id\\": \\"" + notificationId + "\\"}");

                alarmUtil.removeFiredNotification(notificationId);

                alarmUtil.doCancelAlarm(notificationId);
            }
        } catch (Exception e) {`;

    const output = applyAlarmDismissReceiverPatchToSource(input);

    expect(output).not.toContain('if (ANModule.getReactAppContext() != null) {\n                int notificationId');
    expect(output).toContain('int notificationId = intent.getExtras().getInt(Constants.DISMISSED_NOTIFICATION_ID);');
    expect(output).toContain('alarmUtil.doCancelAlarm(notificationId);');
    expect(output).toContain('alarmUtil.stopAlarmSound();');
  });

  it('guards dismiss event emission when the React context is missing', () => {
    const input = `                            // emit notification dismissed
                            ANModule.getReactAppContext().getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class).emit("OnNotificationDismissed", "{\\"id\\": \\"" + alarm.getId() + "\\"}");
`;

    const output = applyAlarmReceiverPatchToSource(input);

    expect(output).toContain('if (ANModule.getReactAppContext() != null) {');
    expect(output).toContain('emit("OnNotificationDismissed"');
  });

  it('keeps the Gradle compatibility rewrite in place', () => {
    const input = `apply plugin: 'maven'
android {
  compileSdkVersion safeExtGet('compileSdkVersion', DEFAULT_COMPILE_SDK_VERSION)
}

afterEvaluate { project ->
  // legacy publishing tasks
}`;

    const output = applyGradleCompatPatchToSource(input);

    expect(output).not.toContain("apply plugin: 'maven'");
    expect(output).toContain("compileSdk safeExtGet('compileSdkVersion', DEFAULT_COMPILE_SDK_VERSION)");
    expect(output).not.toContain('afterEvaluate { project ->');
  });
});
