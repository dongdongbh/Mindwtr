const fs = require('fs');
const path = require('path');
const { withAndroidManifest, withDangerousMod } = require('@expo/config-plugins');

const patchFile = (filePath, transform) => {
  if (!fs.existsSync(filePath)) return false;
  const original = fs.readFileSync(filePath, 'utf8');
  const next = transform(original);
  if (next === original) return false;
  fs.writeFileSync(filePath, next);
  return true;
};

const applyGradleCompatPatchToSource = (original) => {
  let next = original;


  next = next.replace(/^\s*apply plugin: 'maven'\s*$/gm, '');


  next = next.replace(
    "compileSdkVersion safeExtGet('compileSdkVersion', DEFAULT_COMPILE_SDK_VERSION)",
    "compileSdk safeExtGet('compileSdkVersion', DEFAULT_COMPILE_SDK_VERSION)"
  );


  const marker = 'afterEvaluate { project ->';
  const markerIndex = next.indexOf(marker);
  if (markerIndex >= 0) {
    next = `${next.slice(0, markerIndex).trimEnd()}\n\n// Legacy publishing tasks removed for modern Gradle compatibility.\n`;
  }

  if (
    !next.includes("project(':notification-open-intents')")
    && next.includes('dependencies {')
  ) {
    const reactNativeDependencyIndex = next.search(/implementation ['"]com\.facebook\.react:react-native:\+['"]/);
    if (reactNativeDependencyIndex >= 0) {
      const dependencyBlockStart = next.lastIndexOf('dependencies {', reactNativeDependencyIndex);
      const dependencyBlockEnd = next.indexOf('\n}', reactNativeDependencyIndex);
      if (dependencyBlockStart >= 0 && dependencyBlockEnd >= 0) {
        next = `${next.slice(0, dependencyBlockEnd)}
    if (rootProject.findProject(':notification-open-intents') != null) {
        implementation project(':notification-open-intents')
    }
${next.slice(dependencyBlockEnd)}`;
      }
    }
  }

  return next;
};

const applyAlarmPendingIntentPatchToSource = (original) => {
  let next = original;
  const helperMarker = '    private NotificationManager getNotificationManager() {';
  if (!next.includes('getUpdateCurrentImmutableFlags()') && next.includes(helperMarker)) {
    next = next.replace(
      helperMarker,
      `    private int getImmutableFlag() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            return PendingIntent.FLAG_IMMUTABLE;
        }
        return 0;
    }

    private int getUpdateCurrentImmutableFlags() {
        return PendingIntent.FLAG_UPDATE_CURRENT | getImmutableFlag();
    }

${helperMarker}`
    );
  }

  next = next.replace(
    /PendingIntent\.getBroadcast\(([^;]*?),\s*PendingIntent\.FLAG_UPDATE_CURRENT\)/g,
    'PendingIntent.getBroadcast($1, getUpdateCurrentImmutableFlags())'
  );
  next = next.replace(
    /PendingIntent\.getActivity\(([^;]*?),\s*PendingIntent\.FLAG_UPDATE_CURRENT\)/g,
    'PendingIntent.getActivity($1, getUpdateCurrentImmutableFlags())'
  );
  next = next.replace(
    /PendingIntent\.getBroadcast\(([^;]*?),\s*0\)/g,
    'PendingIntent.getBroadcast($1, getImmutableFlag())'
  );
  next = next.replace(
    /PendingIntent\.getActivity\(([^;]*?),\s*0\)/g,
    'PendingIntent.getActivity($1, getImmutableFlag())'
  );

  return next;
};

const applyAlarmDuplicateToastPatchToSource = (original) => original.replace(
  `        if (contain) {
            Toast.makeText(mContext, "You have already set this Alarm", Toast.LENGTH_SHORT).show();
        }

`,
  `        // Duplicate alarms are reported to JS via promise rejection. Mindwtr retries silently.
`
);

const applyAlarmTimingPatchToSource = (original) => {
  let next = original;
  const alarmManagerHelperMarker = `    private AlarmManager getAlarmManager() {
        return (AlarmManager) mContext.getSystemService(Context.ALARM_SERVICE);
    }
`;

  if (!next.includes('setExactOrAllowWhileIdle(') && next.includes(alarmManagerHelperMarker)) {
    next = next.replace(
      alarmManagerHelperMarker,
      `${alarmManagerHelperMarker}
    private void setExactOrAllowWhileIdle(AlarmManager alarmManager, long triggerAtMillis, PendingIntent alarmIntent) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            if (alarmManager.canScheduleExactAlarms()) {
                alarmManager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAtMillis, alarmIntent);
            } else {
                alarmManager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAtMillis, alarmIntent);
            }
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            alarmManager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAtMillis, alarmIntent);
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
            alarmManager.setExact(AlarmManager.RTC_WAKEUP, triggerAtMillis, alarmIntent);
        } else {
            alarmManager.set(AlarmManager.RTC_WAKEUP, triggerAtMillis, alarmIntent);
        }
    }
`
    );
  }

  next = next.replace(
    /^([ \t]*)if \(Build\.VERSION\.SDK_INT >= Build\.VERSION_CODES\.M\) \{\n\1[ \t]{4}alarmManager\.setAndAllowWhileIdle\(AlarmManager\.RTC_WAKEUP, calendar\.getTimeInMillis\(\), alarmIntent\);\n\1\} else if \(Build\.VERSION\.SDK_INT >= Build\.VERSION_CODES\.KITKAT\) \{\n\1[ \t]{4}alarmManager\.setExact\(AlarmManager\.RTC_WAKEUP, calendar\.getTimeInMillis\(\), alarmIntent\);\n\1\} else \{\n\1[ \t]{4}alarmManager\.set\(AlarmManager\.RTC_WAKEUP, calendar\.getTimeInMillis\(\), alarmIntent\);\n\1\}\n/gm,
    '$1setExactOrAllowWhileIdle(alarmManager, calendar.getTimeInMillis(), alarmIntent);\n'
  );
  next = next.replace(
    `    void snoozeAlarm(AlarmModel alarm) {
        Calendar calendar = getCalendarFromAlarm(alarm);
`,
    `    void snoozeAlarm(AlarmModel alarm) {
        Calendar calendar = Calendar.getInstance();
`
  );
  const firedNotificationIdMarker = 'int firedNotificationId = alarm.getAlarmId();';
  if (!next.includes(firedNotificationIdMarker)) {
    const withFiredNotificationId = next.replace(
      `    void snoozeAlarm(AlarmModel alarm) {
        Calendar calendar = Calendar.getInstance();

        this.stopAlarmSound();
`,
      `    void snoozeAlarm(AlarmModel alarm) {
        Calendar calendar = Calendar.getInstance();

        this.stopAlarmSound();

        int firedNotificationId = alarm.getAlarmId();
`
    );
    if (withFiredNotificationId !== next) {
      next = withFiredNotificationId;
    }
  }
  if (
    next.includes(firedNotificationIdMarker)
    && !next.includes('int snoozedAlarmRowId = getAlarmDB().insert(alarm);')
  ) {


    next = next.replace(
      `        getAlarmDB().update(alarm);

        Log.e(TAG, "snooze data - " + alarm.toString());
`,
      `        int snoozedAlarmRowId = getAlarmDB().insert(alarm);
        alarm.setId(snoozedAlarmRowId);

        getNotificationManager().cancel(firedNotificationId);

        Log.e(TAG, "snooze data - " + alarm.toString());
`
    );
  }

  return next;
};

const applyAlarmExactRepeatPatchToSource = (original) => {
  let next = original;
  const alarmUtilMarker = '    void setAlarm(AlarmModel alarm) {';
  const exactHelperMarker = '    private void setExactOrAllowWhileIdle(';
  const repeatAdvanceMarker = '    private static final int MAX_REPEAT_SEARCH_STEPS';

  if (next.includes(alarmUtilMarker) && !next.includes(exactHelperMarker)) {
    throw new Error('Alarm exact repeat patch requires the alarm timing patch to run first');
  }

  if (next.includes(alarmUtilMarker) && !next.includes(repeatAdvanceMarker)) {
    next = next.replace(
      alarmUtilMarker,
      `    private static final int MAX_REPEAT_SEARCH_STEPS = 64;

    private Calendar getRepeatingOccurrence(AlarmModel alarm, Calendar calendar, int occurrenceCount) {
        if (occurrenceCount <= 0) {
            throw new IllegalArgumentException("Repeat occurrence count must be positive");
        }

        Calendar occurrence = (Calendar) calendar.clone();
        int intervalValue = alarm.getIntervalValue();
        long totalAmount;

        switch (alarm.getInterval()) {
            case "minutely":
                if (intervalValue <= 0) {
                    throw new IllegalArgumentException("Repeat interval value must be positive");
                }
                totalAmount = (long) intervalValue * occurrenceCount;
                if (totalAmount > Integer.MAX_VALUE) {
                    throw new IllegalStateException("Repeat alarm is too stale to advance safely");
                }
                occurrence.add(Calendar.MINUTE, (int) totalAmount);
                break;
            case "hourly":
                if (intervalValue <= 0) {
                    throw new IllegalArgumentException("Repeat interval value must be positive");
                }
                totalAmount = (long) intervalValue * occurrenceCount;
                if (totalAmount > Integer.MAX_VALUE) {
                    throw new IllegalStateException("Repeat alarm is too stale to advance safely");
                }
                occurrence.add(Calendar.HOUR_OF_DAY, (int) totalAmount);
                break;
            case "daily":
                occurrence.add(Calendar.DAY_OF_YEAR, occurrenceCount);
                break;
            case "weekly":
                occurrence.add(Calendar.WEEK_OF_YEAR, occurrenceCount);
                break;
            default:
                throw new IllegalArgumentException("Unsupported repeat interval: " + alarm.getInterval());
        }
        return occurrence;
    }

    private boolean advanceRepeatingAlarmToFuture(AlarmModel alarm, Calendar calendar) {
        Calendar now = Calendar.getInstance();
        if (calendar.after(now)) {
            return false;
        }

        int previousOccurrence = 0;
        int futureOccurrence = 1;
        int searchSteps = 0;
        Calendar future = null;

        while (searchSteps < MAX_REPEAT_SEARCH_STEPS) {
            future = getRepeatingOccurrence(alarm, calendar, futureOccurrence);
            searchSteps++;
            if (future.after(now)) {
                break;
            }
            previousOccurrence = futureOccurrence;
            if (futureOccurrence > Integer.MAX_VALUE / 2) {
                throw new IllegalStateException("Repeat alarm is too stale to advance safely");
            }
            futureOccurrence *= 2;
        }

        if (future == null || !future.after(now)) {
            throw new IllegalStateException("Could not advance repeating alarm into the future");
        }

        while (previousOccurrence + 1 < futureOccurrence && searchSteps < MAX_REPEAT_SEARCH_STEPS) {
            int candidateOccurrence = previousOccurrence + (futureOccurrence - previousOccurrence) / 2;
            Calendar candidate = getRepeatingOccurrence(alarm, calendar, candidateOccurrence);
            searchSteps++;
            if (candidate.after(now)) {
                futureOccurrence = candidateOccurrence;
                future = candidate;
            } else {
                previousOccurrence = candidateOccurrence;
            }
        }

        if (previousOccurrence + 1 < futureOccurrence) {
            throw new IllegalStateException("Could not find the next repeating alarm occurrence");
        }
        calendar.setTime(future.getTime());
        return true;
    }

    void rescheduleRepeatingAlarm(AlarmModel alarm) {
        if (!"repeat".equals(alarm.getScheduleType())) {
            return;
        }

        Calendar calendar = getCalendarFromAlarm(alarm);
        calendar.setTime(getRepeatingOccurrence(alarm, calendar, 1).getTime());
        advanceRepeatingAlarmToFuture(alarm, calendar);
        setAlarmFromCalendar(alarm, calendar);
        getAlarmDB().update(alarm);

        // setAlarm reuses the same row id and alarmId-backed PendingIntent.
        setAlarm(alarm);
    }

${alarmUtilMarker}`
    );
  }

  const inexactRepeatBranch = `        } else if (scheduleType.equals("repeat")) {
            long interval = this.getInterval(alarm.getInterval(), alarm.getIntervalValue());

            alarmManager.setRepeating(AlarmManager.RTC_WAKEUP, calendar.getTimeInMillis(), interval, alarmIntent);
`;
  const exactRepeatBranch = `        } else if (scheduleType.equals("repeat")) {
            boolean advanced = advanceRepeatingAlarmToFuture(alarm, calendar);
            if (advanced) {
                setAlarmFromCalendar(alarm, calendar);
                getAlarmDB().update(alarm);
            }
            setExactOrAllowWhileIdle(alarmManager, calendar.getTimeInMillis(), alarmIntent);
`;
  next = next.split(inexactRepeatBranch).join(exactRepeatBranch);

  if (next.includes(alarmUtilMarker) && next.includes('alarmManager.setRepeating(')) {
    throw new Error('Alarm exact repeat patch could not replace every setRepeating schedule path');
  }

  const receiverRearmMarker = 'alarmUtil.rescheduleRepeatingAlarm(alarm);';
  if (!next.includes(receiverRearmMarker)) {
    next = next.replace(
      /^([ \t]*)alarmUtil\.sendNotification\(alarm\);$/m,
      (_, indentation) => `${indentation}alarmUtil.sendNotification(alarm);

${indentation}if ("repeat".equals(alarm.getScheduleType())) {
${indentation}    alarmUtil.rescheduleRepeatingAlarm(alarm);
${indentation}}`
    );
  }

  return next;
};


const applyAlarmStaleOnceUtilPatchToSource = (original) => {
  let next = original;
  const marker = '    void setAlarm(AlarmModel alarm) {';
  if (!next.includes(marker)) return next;
  if (!next.includes('boolean discardStaleOneShot(AlarmModel alarm)')) next = next.replace(marker, `    boolean discardStaleOneShot(AlarmModel alarm) {
        if (!"once".equals(alarm.getScheduleType())) return false;
        // ponytail: 24 h grace preserves short offline periods; revisit if task
        // state is made available to the native receiver.
        Calendar fireTime = getCalendarFromAlarm(alarm);
        fireTime.setLenient(false);
        long latenessMs;
        try {
            latenessMs = System.currentTimeMillis() - fireTime.getTimeInMillis();
        } catch (IllegalArgumentException invalidDate) {
            getAlarmDB().delete(alarm.getId());
            return true;
        }
        if (latenessMs <= 24L * 60L * 60L * 1000L) return false;
        getAlarmDB().delete(alarm.getId());
        return true;
    }

${marker}
        if (discardStaleOneShot(alarm)) return;`);
  const snoozeRow = '        int snoozedAlarmRowId = getAlarmDB().insert(alarm);';
  if (next.includes(snoozeRow) && !next.includes('alarm.setActive(1);\n' + snoozeRow)) {
    next = next.replace(snoozeRow, '        alarm.setActive(1);\n' + snoozeRow);
  }
  if (!next.includes('alarm.setActive(1);\n' + snoozeRow)) {
    throw new Error('alarm-stale-once-util: independent snooze row anchor missing');
  }
  return next;
};

const applyAlarmStaleOnceReceiverPatchToSource = (original) => {
  if (original.includes('alarmUtil.discardStaleOneShot(alarm)')) return original;
  const marker = `                        alarm = alarmDB.getAlarm(id);

                        alarmUtil.sendNotification(alarm);`;
  if (!original.includes(marker)) return original;
  let next = original.replace(marker, `                        alarm = alarmDB.getAlarm(id);
                        if (alarm == null || alarm.getActive() != 1 || alarmUtil.discardStaleOneShot(alarm)) return;

                        alarmUtil.sendNotification(alarm);`);
  const repeatMarker = `                        if ("repeat".equals(alarm.getScheduleType())) {
                            alarmUtil.rescheduleRepeatingAlarm(alarm);
                        }`;
  if (!next.includes(repeatMarker)) throw new Error('alarm-stale-once-receiver: repeat anchor missing');
  next = next.replace(repeatMarker, `${repeatMarker} else {
                            alarm.setActive(0);
                            alarmDB.update(alarm);
                        }`);
  return next;
};

const applyAlarmReminderBehaviorPatchToSource = (original) => {
  let next = original;

  next = next.replace(
    /\s*boolean playSound = alarm\.isPlaySound\(\);\s*if \(playSound\) {\s*this\.playAlarmSound\(alarm\.getSoundName\(\), alarm\.getSoundNames\(\), alarm\.isLoopSound\(\), alarm\.getVolume\(\)\);\s*}\s*/m,
    '\n            boolean playSound = alarm.isPlaySound();\n'
  );
  next = next.replace(
    '        uri = Settings.System.DEFAULT_ALARM_ALERT_URI;',
    '        uri = Settings.System.DEFAULT_NOTIFICATION_URI;'
  );
  next = next.replace(
    '.setPriority(NotificationCompat.PRIORITY_MAX)',
    '.setPriority(NotificationCompat.PRIORITY_DEFAULT)'
  );
  next = next.replace(
    '.setCategory(NotificationCompat.CATEGORY_ALARM)',
    '.setCategory(NotificationCompat.CATEGORY_REMINDER)'
  );
  next = next.replace(
    '.setSound(null)',
    '.setSound(playSound ? android.provider.Settings.System.DEFAULT_NOTIFICATION_URI : null)'
  );
  next = next.replace(
    'NotificationChannel mChannel = new NotificationChannel(channelID, "Alarm Notify", NotificationManager.IMPORTANCE_HIGH);',
    'NotificationChannel mChannel = new NotificationChannel(channelID, "Mindwtr reminders", NotificationManager.IMPORTANCE_DEFAULT);'
  );
  next = next.replace(
    `                mChannel.setVibrationPattern(null);

                // play vibration
                if (alarm.isVibrate()) {
                    Vibrator vibrator = (Vibrator) mContext.getSystemService(Context.VIBRATOR_SERVICE);
                    if (vibrator.hasVibrator()) {
                        vibrator.vibrate(VibrationEffect.createWaveform(vibrationPattern, 0));
                    }
                }
`,
    `                mChannel.enableVibration(alarm.isVibrate());
                mChannel.setVibrationPattern(alarm.isVibrate() ? vibrationPattern : null);
                mChannel.setSound(playSound ? android.provider.Settings.System.DEFAULT_NOTIFICATION_URI : null, null);
`
  );
  next = next.replace(
    'vibrator.vibrate(VibrationEffect.createWaveform(vibrationPattern, 0));',
    'vibrator.vibrate(VibrationEffect.createWaveform(vibrationPattern, -1));'
  );

  return next;
};

const applyAlarmLockScreenPrivacyPatchToSource = (original) => {


  return original.replace(
    '.setVisibility(NotificationCompat.VISIBILITY_PUBLIC)',
    '.setVisibility(NotificationCompat.VISIBILITY_PRIVATE)'
  );
};

const POMODORO_WHEN_ANCHOR = '                    .setDeleteIntent(createOnDismissedIntent(mContext, alarm.getId()));\n';
const applyAlarmPomodoroWhenPatchToSource = (original) => {


  if (original.includes('String pomodoroEndsAtMs = bundle.getString("endsAtMs");')) return original;
  if (!original.includes(POMODORO_WHEN_ANCHOR)) return original;
  return original.replace(POMODORO_WHEN_ANCHOR, `${POMODORO_WHEN_ANCHOR}
            String pomodoroEndsAtMs = bundle.getString("endsAtMs");
            if ("pomodoro".equals(bundle.getString("kind")) && pomodoroEndsAtMs != null) {
                try {
                    mBuilder.setWhen(Long.parseLong(pomodoroEndsAtMs)).setShowWhen(true);
                } catch (NumberFormatException ignored) {
                    // A malformed stamp keeps the delivery time.
                }
            }
`);
};

const applyAlarmAudioInterfacePatchToSource = (original) => {
  return original.replace(
    '        uri = Settings.System.DEFAULT_ALARM_ALERT_URI;',
    '        uri = Settings.System.DEFAULT_NOTIFICATION_URI;'
  );
};

const applyAlarmDismissReceiverPatchToSource = (original) => {
  let next = original;

  next = next.replace(
    `        try {
            if (ANModule.getReactAppContext() != null) {
                int notificationId = intent.getExtras().getInt(Constants.DISMISSED_NOTIFICATION_ID);
                ANModule.getReactAppContext().getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class).emit("OnNotificationDismissed", "{\\"id\\": \\"" + notificationId + "\\"}");

                alarmUtil.removeFiredNotification(notificationId);

                alarmUtil.doCancelAlarm(notificationId);
            }
        } catch (Exception e) {`,
    `        try {
            int notificationId = intent.getExtras().getInt(Constants.DISMISSED_NOTIFICATION_ID);
            if (ANModule.getReactAppContext() != null) {
                ANModule.getReactAppContext().getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class).emit("OnNotificationDismissed", "{\\"id\\": \\"" + notificationId + "\\"}");
            }
            alarmUtil.removeFiredNotification(notificationId);
            alarmUtil.doCancelAlarm(notificationId);
            alarmUtil.stopAlarmSound();
        } catch (Exception e) {`
  );

  return next;
};

const applyAlarmReceiverPatchToSource = (original) => {
  let next = original;

  next = next.replace(
    `                            // emit notification dismissed
                            ANModule.getReactAppContext().getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class).emit("OnNotificationDismissed", "{\\"id\\": \\"" + alarm.getId() + "\\"}");
`,
    `                            // emit notification dismissed
                            if (ANModule.getReactAppContext() != null) {
                                ANModule.getReactAppContext().getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class).emit("OnNotificationDismissed", "{\\"id\\": \\"" + alarm.getId() + "\\"}");
                            }
`
  );

  return next;
};

const applyAlarmCompleteConstantsPatchToSource = (original) => {
  if (original.includes('NOTIFICATION_ACTION_COMPLETE')) return original;
  return original.replace(
    '    static final String NOTIFICATION_ACTION_SNOOZE = "ACTION_SNOOZE";',
    '    static final String NOTIFICATION_ACTION_SNOOZE = "ACTION_SNOOZE";\n    static final String NOTIFICATION_ACTION_COMPLETE = "ACTION_COMPLETE";'
  );
};

const applyAlarmTaskOpenIntentPatchToSource = (original) => {
  let next = original;

  if (!next.includes('import android.net.Uri;')) {
    next = next.replace('import android.media.MediaPlayer;\n', 'import android.media.MediaPlayer;\nimport android.net.Uri;\n');
  }

  if (next.includes('mindwtr:///focus')) return next;

  return next.replace(
    `            PendingIntent pendingIntent = PendingIntent.getActivity(mContext, notificationID, intent, getUpdateCurrentImmutableFlags());
`,
    `            String taskId = bundle.getString("taskId");
            if (taskId != null && !taskId.equals("")) {
                String openToken = bundle.getString("alarmKey");
                if (openToken == null || openToken.equals("")) {
                    openToken = String.valueOf(alarm.getId());
                }
                intent.setAction(Intent.ACTION_VIEW);
                intent.setData(Uri.parse("mindwtr:///focus")
                        .buildUpon()
                        .appendQueryParameter("taskId", taskId)
                        .appendQueryParameter("openToken", openToken)
                        .appendQueryParameter("taskTab", "view")
                        .build());
            }

            PendingIntent pendingIntent = PendingIntent.getActivity(mContext, notificationID, intent, getUpdateCurrentImmutableFlags());
`
  );
};

const applyAlarmCompleteUtilPatchToSource = (original) => {
  let next = original;

  if (!next.includes('NOTIFICATION_ACTION_COMPLETE')) {
    next = next.replace(
      'import static com.emekalites.react.alarm.notification.Constants.NOTIFICATION_ACTION_SNOOZE;',
      'import static com.emekalites.react.alarm.notification.Constants.NOTIFICATION_ACTION_SNOOZE;\nimport static com.emekalites.react.alarm.notification.Constants.NOTIFICATION_ACTION_COMPLETE;'
    );
  }

  if (next.includes('notificationActionComplete')) return next;

  return next.replace(
    `            if (alarm.isHasButton()) {
                Intent dismissIntent = new Intent(mContext, AlarmReceiver.class);
                dismissIntent.setAction(NOTIFICATION_ACTION_DISMISS);
                dismissIntent.putExtra("AlarmId", alarm.getId());
                PendingIntent pendingDismiss = PendingIntent.getBroadcast(mContext, notificationID, dismissIntent, getUpdateCurrentImmutableFlags());
                NotificationCompat.Action dismissAction = new NotificationCompat.Action(android.R.drawable.ic_lock_idle_alarm, "DISMISS", pendingDismiss);
                mBuilder.addAction(dismissAction);

                Intent snoozeIntent = new Intent(mContext, AlarmReceiver.class);
                snoozeIntent.setAction(NOTIFICATION_ACTION_SNOOZE);
                snoozeIntent.putExtra("SnoozeAlarmId", alarm.getId());
                PendingIntent pendingSnooze = PendingIntent.getBroadcast(mContext, notificationID, snoozeIntent, getUpdateCurrentImmutableFlags());
                NotificationCompat.Action snoozeAction = new NotificationCompat.Action(R.drawable.ic_snooze, "SNOOZE", pendingSnooze);
                mBuilder.addAction(snoozeAction);
            }
`,
    `            if (alarm.isHasButton()) {
                boolean hasCompleteAction = "true".equals(bundle.getString("notificationActionComplete"));
                if (hasCompleteAction) {
                    Intent completeIntent = new Intent(mContext, AlarmReceiver.class);
                    completeIntent.setAction(NOTIFICATION_ACTION_COMPLETE);
                    completeIntent.putExtra("AlarmId", alarm.getId());
                    completeIntent.putExtras(bundle);
                    PendingIntent pendingComplete = PendingIntent.getBroadcast(mContext, notificationID + 2, completeIntent, getUpdateCurrentImmutableFlags());
                    NotificationCompat.Action completeAction = new NotificationCompat.Action(android.R.drawable.checkbox_on_background, "COMPLETE", pendingComplete);
                    mBuilder.addAction(completeAction);
                }

                Intent snoozeIntent = new Intent(mContext, AlarmReceiver.class);
                snoozeIntent.setAction(NOTIFICATION_ACTION_SNOOZE);
                snoozeIntent.putExtra("SnoozeAlarmId", alarm.getId());
                PendingIntent pendingSnooze = PendingIntent.getBroadcast(mContext, notificationID + 1, snoozeIntent, getUpdateCurrentImmutableFlags());
                NotificationCompat.Action snoozeAction = new NotificationCompat.Action(R.drawable.ic_snooze, "SNOOZE", pendingSnooze);
                mBuilder.addAction(snoozeAction);

                Intent dismissIntent = new Intent(mContext, AlarmReceiver.class);
                dismissIntent.setAction(NOTIFICATION_ACTION_DISMISS);
                dismissIntent.putExtra("AlarmId", alarm.getId());
                PendingIntent pendingDismiss = PendingIntent.getBroadcast(mContext, notificationID, dismissIntent, getUpdateCurrentImmutableFlags());
                NotificationCompat.Action dismissAction = new NotificationCompat.Action(android.R.drawable.ic_lock_idle_alarm, "DISMISS", pendingDismiss);
                mBuilder.addAction(dismissAction);
            }
`
  );
};

const applyAlarmCompleteReceiverPatchToSource = (original) => {
  let next = original;

  if (!next.includes('import android.os.Bundle;')) {
    next = next.replace('import android.content.Intent;\n', 'import android.content.Intent;\nimport android.os.Bundle;\n');
  }
  if (!next.includes('import java.util.LinkedHashMap;')) {
    next = next.replace('import com.facebook.react.modules.core.DeviceEventManagerModule;\n', 'import com.facebook.react.modules.core.DeviceEventManagerModule;\n\nimport java.util.LinkedHashMap;\n');
  }
  if (!next.includes('import tech.dongdongbh.mindwtr.notificationopenintents.NotificationOpenPayloadStore;')) {
    next = next.replace('import java.util.LinkedHashMap;\n', 'import java.util.LinkedHashMap;\n\nimport tech.dongdongbh.mindwtr.notificationopenintents.NotificationOpenPayloadStore;\n');
  }

  const pendingPayloadCacheBlock = `                            LinkedHashMap<String, String> pendingPayload = new LinkedHashMap<>();
                            for (String key : payload.keySet()) {
                                Object value = payload.get(key);
                                if (value != null) {
                                    pendingPayload.put(key, String.valueOf(value));
                                }
                            }
                            NotificationOpenPayloadStore.cache(pendingPayload);
`;

  if (next.includes('case Constants.NOTIFICATION_ACTION_COMPLETE')) {
    if (!next.includes('NotificationOpenPayloadStore.cache(pendingPayload)')) {
      next = next.replace(
        `                            payload.putString("actionIdentifier", "complete");

                            alarmUtil.removeFiredNotification(alarm.getId());
`,
        `                            payload.putString("actionIdentifier", "complete");
${pendingPayloadCacheBlock}
                            alarmUtil.removeFiredNotification(alarm.getId());
`
      );
    }
    return next;
  }

  return next.replace(
    `                    case Constants.NOTIFICATION_ACTION_DISMISS:
                        id = intent.getExtras().getInt("AlarmId");
`,
    `                    case Constants.NOTIFICATION_ACTION_COMPLETE:
                        id = intent.getExtras().getInt("AlarmId");

                        try {
                            alarm = alarmDB.getAlarm(id);
                            Bundle payload = new Bundle();
                            if (intent.getExtras() != null) {
                                payload.putAll(intent.getExtras());
                            }
                            payload.putString("id", String.valueOf(alarm.getId()));
                            if (payload.getString("alarmKey") == null && payload.getString("taskId") != null) {
                                payload.putString("alarmKey", "task:" + payload.getString("taskId"));
                            }
                            payload.putString("actionIdentifier", "complete");
${pendingPayloadCacheBlock}

                            alarmUtil.removeFiredNotification(alarm.getId());
                            alarmUtil.cancelAlarm(alarm, false);
                            alarmUtil.stopAlarmSound();

                            if (ANModule.getReactAppContext() != null) {
                                ANModule.getReactAppContext().getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class).emit("OnNotificationOpened", BundleJSONConverter.convertToJSON(payload).toString());
                            } else {
                                Intent launchIntent = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
                                if (launchIntent != null) {
                                    launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
                                    launchIntent.putExtras(payload);
                                    context.startActivity(launchIntent);
                                }
                            }
                        } catch (Exception e) {
                            alarmUtil.stopAlarmSound();
                            e.printStackTrace();
                        }
                        break;

                    case Constants.NOTIFICATION_ACTION_DISMISS:
                        id = intent.getExtras().getInt("AlarmId");
`
  );
};


const applyAlarmDeadRowUtilPatchToSource = (original) => {
  let next = original;

  next = next.replace(
    '                    completeIntent.putExtra("AlarmId", alarm.getId());\n                    completeIntent.putExtras(bundle);',
    '                    completeIntent.putExtra("AlarmId", alarm.getId());\n                    completeIntent.putExtra("NotificationId", notificationID);\n                    completeIntent.putExtras(bundle);'
  );
  next = next.replace(
    '                snoozeIntent.putExtra("SnoozeAlarmId", alarm.getId());\n                PendingIntent pendingSnooze',
    '                snoozeIntent.putExtra("SnoozeAlarmId", alarm.getId());\n                snoozeIntent.putExtra("NotificationId", notificationID);\n                PendingIntent pendingSnooze'
  );
  next = next.replace(
    '                dismissIntent.putExtra("AlarmId", alarm.getId());\n                PendingIntent pendingDismiss',
    '                dismissIntent.putExtra("AlarmId", alarm.getId());\n                dismissIntent.putExtra("NotificationId", notificationID);\n                PendingIntent pendingDismiss'
  );

  const removeAllMarker = `    void removeAllFiredNotifications() {
        getNotificationManager().cancelAll();
    }
`;
  if (!next.includes('void clearNotification(int notificationId)') && next.includes(removeAllMarker)) {
    next = next.replace(
      removeAllMarker,
      `${removeAllMarker}
    // Cancels a tray notification by its post id directly, with no DB
    // lookup — for a receiver action whose alarm row is already gone (#1028).
    void clearNotification(int notificationId) {
        getNotificationManager().cancel(notificationId);
    }
`
    );
  }


  const requiredMarkers = [
    'completeIntent.putExtra("NotificationId", notificationID);',
    'snoozeIntent.putExtra("NotificationId", notificationID);',
    'dismissIntent.putExtra("NotificationId", notificationID);',
    'void clearNotification(int notificationId)',
  ];
  for (const marker of requiredMarkers) {
    if (!next.includes(marker)) {
      throw new Error(`alarm-dead-row-util: expected marker not found after transform: ${marker}`);
    }
  }

  return next;
};


const applyAlarmActionDeadRowPatchToSource = (original) => {
  if (original.includes('Log.d(TAG, "ACTION_SNOOZE id="')) return original;

  let next = original;

  next = next.replace(
    `                    case Constants.NOTIFICATION_ACTION_SNOOZE:
                        id = intent.getExtras().getInt("SnoozeAlarmId");

                        try {
                            alarm = alarmDB.getAlarm(id);
                            alarmUtil.snoozeAlarm(alarm);
                            Log.e(TAG, "alarm snoozed: " + alarm.toString());

                            alarmUtil.removeFiredNotification(alarm.getId());
                        } catch (Exception e) {
                            alarmUtil.stopAlarmSound();
                            e.printStackTrace();
                        }
                        break;
`,
    `                    case Constants.NOTIFICATION_ACTION_SNOOZE:
                        id = intent.getExtras().getInt("SnoozeAlarmId");

                        try {
                            alarm = alarmDB.getAlarm(id);
                            Log.d(TAG, "ACTION_SNOOZE id=" + id + " alarmFound=" + (alarm != null));
                            if (alarm != null) {
                                alarmUtil.snoozeAlarm(alarm);
                                Log.e(TAG, "alarm snoozed: " + alarm.toString());

                                alarmUtil.removeFiredNotification(alarm.getId());
                            } else if (intent.getExtras().containsKey("NotificationId")) {
                                // Dead row: degrade snooze to dismiss instead of
                                // reconstructing schedule state from nothing. The JS
                                // reschedule cycle re-adds anything still due.
                                alarmUtil.clearNotification(intent.getExtras().getInt("NotificationId"));
                                alarmUtil.stopAlarmSound();
                            } else {
                                alarmUtil.removeFiredNotification(id);
                                alarmUtil.stopAlarmSound();
                            }
                        } catch (Exception e) {
                            alarmUtil.stopAlarmSound();
                            e.printStackTrace();
                        }
                        break;
`
  );


  const completeCaseOld = `                    case Constants.NOTIFICATION_ACTION_COMPLETE:
                        id = intent.getExtras().getInt("AlarmId");

                        try {
                            alarm = alarmDB.getAlarm(id);
                            Bundle payload = new Bundle();
                            if (intent.getExtras() != null) {
                                payload.putAll(intent.getExtras());
                            }
                            payload.putString("id", String.valueOf(alarm.getId()));
                            if (payload.getString("alarmKey") == null && payload.getString("taskId") != null) {
                                payload.putString("alarmKey", "task:" + payload.getString("taskId"));
                            }
                            payload.putString("actionIdentifier", "complete");
                            LinkedHashMap<String, String> pendingPayload = new LinkedHashMap<>();
                            for (String key : payload.keySet()) {
                                Object value = payload.get(key);
                                if (value != null) {
                                    pendingPayload.put(key, String.valueOf(value));
                                }
                            }
                            NotificationOpenPayloadStore.cache(pendingPayload);

                            alarmUtil.removeFiredNotification(alarm.getId());
                            alarmUtil.cancelAlarm(alarm, false);
                            alarmUtil.stopAlarmSound();

                            if (ANModule.getReactAppContext() != null) {
                                ANModule.getReactAppContext().getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class).emit("OnNotificationOpened", BundleJSONConverter.convertToJSON(payload).toString());
                            } else {
                                Intent launchIntent = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
                                if (launchIntent != null) {
                                    launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
                                    launchIntent.putExtras(payload);
                                    context.startActivity(launchIntent);
                                }
                            }
                        } catch (Exception e) {
                            alarmUtil.stopAlarmSound();
                            e.printStackTrace();
                        }
                        break;
`;
  const completeCaseOldCanonical = completeCaseOld.replace(
    'NotificationOpenPayloadStore.cache(pendingPayload);\n\n                            alarmUtil.removeFiredNotification',
    'NotificationOpenPayloadStore.cache(pendingPayload);\n\n\n                            alarmUtil.removeFiredNotification'
  );
  const completeCaseHardened = `                    case Constants.NOTIFICATION_ACTION_COMPLETE:
                        id = intent.getExtras().getInt("AlarmId");

                        try {
                            alarm = alarmDB.getAlarm(id);
                            Log.d(TAG, "ACTION_COMPLETE id=" + id + " alarmFound=" + (alarm != null));
                            Bundle payload = new Bundle();
                            if (intent.getExtras() != null) {
                                payload.putAll(intent.getExtras());
                            }
                            payload.putString("id", String.valueOf(alarm != null ? alarm.getId() : id));
                            if (payload.getString("alarmKey") == null && payload.getString("taskId") != null) {
                                payload.putString("alarmKey", "task:" + payload.getString("taskId"));
                            }
                            payload.putString("actionIdentifier", "complete");
                            LinkedHashMap<String, String> pendingPayload = new LinkedHashMap<>();
                            for (String key : payload.keySet()) {
                                Object value = payload.get(key);
                                if (value != null) {
                                    pendingPayload.put(key, String.valueOf(value));
                                }
                            }
                            NotificationOpenPayloadStore.cache(pendingPayload);

                            if (alarm != null) {
                                alarmUtil.removeFiredNotification(alarm.getId());
                                alarmUtil.cancelAlarm(alarm, false);
                            } else if (intent.getExtras().containsKey("NotificationId")) {
                                alarmUtil.clearNotification(intent.getExtras().getInt("NotificationId"));
                            } else {
                                alarmUtil.removeFiredNotification(id);
                            }
                            alarmUtil.stopAlarmSound();

                            if (ANModule.getReactAppContext() != null) {
                                ANModule.getReactAppContext().getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class).emit("OnNotificationOpened", BundleJSONConverter.convertToJSON(payload).toString());
                            } else {
                                Intent launchIntent = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
                                if (launchIntent != null) {
                                    launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
                                    launchIntent.putExtras(payload);
                                    context.startActivity(launchIntent);
                                }
                            }
                        } catch (Exception e) {
                            alarmUtil.stopAlarmSound();
                            e.printStackTrace();
                        }
                        break;
`;
  next = next.replace(completeCaseOldCanonical, completeCaseHardened);
  next = next.replace(completeCaseOld, completeCaseHardened);

  next = next.replace(
    `                    case Constants.NOTIFICATION_ACTION_DISMISS:
                        id = intent.getExtras().getInt("AlarmId");

                        try {
                            alarm = alarmDB.getAlarm(id);
                            Log.e(TAG, "alarm cancelled: " + alarm.toString());

                            // emit notification dismissed
                            if (ANModule.getReactAppContext() != null) {
                                ANModule.getReactAppContext().getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class).emit("OnNotificationDismissed", "{\\"id\\": \\"" + alarm.getId() + "\\"}");
                            }

                            alarmUtil.removeFiredNotification(alarm.getId());
                            ${''}
                            alarmUtil.cancelAlarm(alarm, false);
                        } catch (Exception e) {
                            alarmUtil.stopAlarmSound();
                            e.printStackTrace();
                        }
                        break;
`,
    `                    case Constants.NOTIFICATION_ACTION_DISMISS:
                        id = intent.getExtras().getInt("AlarmId");

                        try {
                            alarm = alarmDB.getAlarm(id);
                            Log.d(TAG, "ACTION_DISMISS id=" + id + " alarmFound=" + (alarm != null));

                            // emit notification dismissed
                            if (ANModule.getReactAppContext() != null) {
                                ANModule.getReactAppContext().getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class).emit("OnNotificationDismissed", "{\\"id\\": \\"" + id + "\\"}");
                            }

                            if (alarm != null) {
                                alarmUtil.removeFiredNotification(alarm.getId());
                                alarmUtil.cancelAlarm(alarm, false);
                            } else if (intent.getExtras().containsKey("NotificationId")) {
                                alarmUtil.clearNotification(intent.getExtras().getInt("NotificationId"));
                            } else {
                                alarmUtil.removeFiredNotification(id);
                            }
                            alarmUtil.stopAlarmSound();
                        } catch (Exception e) {
                            alarmUtil.stopAlarmSound();
                            e.printStackTrace();
                        }
                        break;
`
  );


  const requiredMarkers = [
    'Log.d(TAG, "ACTION_SNOOZE id="',
    'Log.d(TAG, "ACTION_COMPLETE id="',
    'Log.d(TAG, "ACTION_DISMISS id="',
  ];
  for (const marker of requiredMarkers) {
    if (!next.includes(marker)) {
      throw new Error(`alarm-dead-row-actions: expected marker not found after transform: ${marker}`);
    }
  }

  return next;
};


const REMINDER_SLOT_HELPERS = `    // Mindwtr reminder notification slots
    private static final int REMINDER_SLOT_NOTIFICATION_ID = 1;
    private static final String REMINDER_SLOT_PREFS = "mindwtr_reminder_notification_slots";

    private android.content.SharedPreferences getReminderSlotPrefs() {
        return mContext.getSharedPreferences(REMINDER_SLOT_PREFS, Context.MODE_PRIVATE);
    }

    // Posts a tagged reminder into its slot, replacing (and alerting again over)
    // the one shown there; an untagged notification posts under its own id.
    private void postReminderNotification(NotificationManager manager, String tag, int notificationId, Notification notification) {
        if (tag == null || tag.equals("")) {
            manager.notify(notificationId, notification);
            return;
        }
        synchronized (AlarmUtil.class) {
            android.content.SharedPreferences prefs = getReminderSlotPrefs();
            android.content.SharedPreferences.Editor editor = prefs.edit();
            String ownerKey = "owner:" + tag;
            if (prefs.contains(ownerKey)) {
                int previous = prefs.getInt(ownerKey, notificationId);
                if (previous != notificationId) editor.remove("slot:" + previous);
            }
            editor.putInt(ownerKey, notificationId).putString("slot:" + notificationId, tag).commit();
            manager.notify(tag, REMINDER_SLOT_NOTIFICATION_ID, notification);
        }
    }

    // Cancels what the alarm with this post id put in the tray: an untagged
    // notification, or its slot while it is still the reminder shown there.
    private void cancelPostedNotification(int notificationId) {
        NotificationManager manager = getNotificationManager();
        manager.cancel(notificationId);
        synchronized (AlarmUtil.class) {
            android.content.SharedPreferences prefs = getReminderSlotPrefs();
            String tag = prefs.getString("slot:" + notificationId, null);
            if (tag == null) return;
            android.content.SharedPreferences.Editor editor = prefs.edit().remove("slot:" + notificationId);
            String ownerKey = "owner:" + tag;
            if (prefs.contains(ownerKey) && prefs.getInt(ownerKey, 0) == notificationId) {
                manager.cancel(tag, REMINDER_SLOT_NOTIFICATION_ID);
                editor.remove(ownerKey);
            }
            editor.commit();
        }
    }

`;

const applyAlarmReminderSlotPatchToSource = (original) => {
  if (original.includes('// Mindwtr reminder notification slots')) return original;
  const removeFiredMarker = '    void removeFiredNotification(int id) {';
  if (!original.includes(removeFiredMarker)) return original;
  let next = original.replace(removeFiredMarker, `${REMINDER_SLOT_HELPERS}${removeFiredMarker}`);

  const replacements = [
    [
      `            String tag = alarm.getTag();
            if (tag != null && !tag.equals("")) {
                mNotificationManager.notify(tag, notificationID, notification);
            } else {
                Log.e(TAG, "notification done");
                mNotificationManager.notify(notificationID, notification);
            }
`,
      `            postReminderNotification(mNotificationManager, alarm.getTag(), notificationID, notification);
`,
    ],
    [
      `            AlarmModel alarm = getAlarmDB().getAlarm(id);
            getNotificationManager().cancel(alarm.getAlarmId());
`,
      `            AlarmModel alarm = getAlarmDB().getAlarm(id);
            cancelPostedNotification(alarm.getAlarmId());
`,
    ],
    [
      '        getNotificationManager().cancel(firedNotificationId);\n',
      '        cancelPostedNotification(firedNotificationId);\n',
    ],
    [
      `    void clearNotification(int notificationId) {
        getNotificationManager().cancel(notificationId);
    }
`,
      `    void clearNotification(int notificationId) {
        cancelPostedNotification(notificationId);
    }
`,
    ],
    [
      `    void removeAllFiredNotifications() {
        getNotificationManager().cancelAll();
    }
`,
      `    void removeAllFiredNotifications() {
        getNotificationManager().cancelAll();
        synchronized (AlarmUtil.class) {
            getReminderSlotPrefs().edit().clear().commit();
        }
    }
`,
    ],
  ];


  for (const [anchor, replacement] of replacements) {
    if (!next.includes(anchor)) {
      throw new Error(`alarm-reminder-slot: expected anchor not found: ${anchor.trim().split('\n')[0]}`);
    }
    next = next.replace(anchor, replacement);
  }
  if (next.includes('getNotificationManager().cancel(alarm.getAlarmId())') || next.includes('mNotificationManager.notify(notificationID, notification)')) {
    throw new Error('alarm-reminder-slot: a post or cancel path still bypasses the reminder slot');
  }
  return next;
};


const REMINDER_ACTION_HELPERS = `    // Mindwtr task reminder actions
    // Whether an alarm (its tag, and its data as "key==>value;;" pairs) is a reminder of the
    // task Done was tapped for.
    static boolean isReminderOfTask(String otherTag, String otherData, String tag, String taskId) {
        if (tag != null && !tag.equals("") && tag.equals(otherTag)) return true;
        if (taskId == null || taskId.equals("") || otherData == null) return false;
        String otherTaskId = null;
        String otherKind = null;
        for (String item : otherData.split(";;")) {
            int separator = item.indexOf("==>");
            if (separator < 0) continue;
            String key = item.substring(0, separator);
            String value = item.substring(separator + 3);
            if (key.equals("taskId")) otherTaskId = value;
            else if (key.equals("kind")) otherKind = value;
        }
        return taskId.equals(otherTaskId) && otherKind != null && otherKind.startsWith("task-");
    }

    // Done on a task's reminder: the task's other armed reminders (its remaining due-time
    // repeats, a snooze) never fire, even while the app has not seen the Done yet.
    int cancelTaskReminders(String tag, String taskId) {
        int cancelled = 0;
        for (AlarmModel other : getAlarmDB().getAlarmList(1)) {
            if (!isReminderOfTask(other.getTag(), other.getData(), tag, taskId)) continue;
            cancelAlarm(other, true);
            cancelled++;
        }
        return cancelled;
    }

`;

const replaceRequiredAnchors = (source, id, replacements) => {
  let next = source;
  for (const [anchor, replacement] of replacements) {
    if (!next.includes(anchor)) {
      throw new Error(`${id}: expected anchor not found: ${anchor.trim().split('\n')[0]}`);
    }
    next = next.replace(anchor, replacement);
  }
  return next;
};

const applyAlarmReminderActionsUtilPatchToSource = (original) => {
  if (original.includes('// Mindwtr task reminder actions')) return original;
  const removeFiredMarker = '    void removeFiredNotification(int id) {';
  if (!original.includes(removeFiredMarker)) return original;
  return replaceRequiredAnchors(original, 'alarm-reminder-actions-util', [
    [removeFiredMarker, `${REMINDER_ACTION_HELPERS}${removeFiredMarker}`],
    [
      '                completeIntent.putExtra("NotificationId", notificationID);\n',
      '                completeIntent.putExtra("NotificationId", notificationID);\n'
        + '                completeIntent.putExtra("ReminderTag", alarm.getTag() == null ? "" : alarm.getTag());\n',
    ],
    [
      '                snoozeIntent.putExtra("NotificationId", notificationID);\n',
      '                snoozeIntent.putExtra("NotificationId", notificationID);\n'
        + '                snoozeIntent.putExtra("SnoozeAlarm", new com.google.gson.Gson().toJson(alarm));\n',
    ],
  ]);
};

const applyAlarmReminderActionsReceiverReceiptPatchToSource = (original) => {
  if (original.includes('String completionReceipt = NotificationOpenPayloadStore.persistCompletion')) return original;
  if (!original.includes('case Constants.NOTIFICATION_ACTION_COMPLETE')) return original;

  if (original.includes('cancelTaskReminders(reminderTag')) {
    return replaceRequiredAnchors(original, 'alarm-reminder-actions-receiver', [[
      '                            NotificationOpenPayloadStore.cache(pendingPayload);',
      `                            String completionReceipt = NotificationOpenPayloadStore.persistCompletion(context, pendingPayload);
                            pendingPayload.put("actionId", completionReceipt);
                            payload.putString("actionId", completionReceipt);
                            NotificationOpenPayloadStore.cache(pendingPayload);`,
    ]]).replace('                                NotificationOpenPayloadStore.persistCompletion(context, pendingPayload);\n', '');
  }
  const completeStart = original.indexOf('case Constants.NOTIFICATION_ACTION_COMPLETE:');
  const beforeComplete = original.slice(0, completeStart);
  const patched = replaceRequiredAnchors(original.slice(completeStart), 'alarm-reminder-actions-receiver', [
    [
      '                            NotificationOpenPayloadStore.cache(pendingPayload);',
      `                            String completionReceipt = NotificationOpenPayloadStore.persistCompletion(context, pendingPayload);
                            pendingPayload.put("actionId", completionReceipt);
                            payload.putString("actionId", completionReceipt);
                            NotificationOpenPayloadStore.cache(pendingPayload);`,
    ],
    [
      `                            alarmUtil.stopAlarmSound();

                            if (ANModule.getReactAppContext() != null) {
                                ANModule.getReactAppContext().getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class).emit("OnNotificationOpened"`,
      `                            alarmUtil.stopAlarmSound();

                            String reminderTag = alarm != null ? alarm.getTag() : intent.getExtras().getString("ReminderTag");
                            int cancelledReminders = alarmUtil.cancelTaskReminders(reminderTag, payload.getString("taskId"));
                            Log.d(TAG, "ACTION_COMPLETE cancelled task reminders=" + cancelledReminders);

                            if (ANModule.getReactAppContext() != null) {
                                ANModule.getReactAppContext().getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class).emit("OnNotificationOpened"`,
    ],
  ]);
  return replaceRequiredAnchors(beforeComplete, 'alarm-reminder-actions-receiver', [
    [
      `                            } else if (intent.getExtras().containsKey("NotificationId")) {
                                // Dead row: degrade snooze to dismiss instead of`,
      `                            } else if (intent.getExtras().getString("SnoozeAlarm") != null) {
                                // Dead row: the intent carries the fired alarm, so the
                                // snooze is made from it instead of being dropped.
                                AlarmModel carried = new com.google.gson.Gson().fromJson(intent.getExtras().getString("SnoozeAlarm"), AlarmModel.class);
                                alarmUtil.snoozeAlarm(carried);
                                Log.d(TAG, "ACTION_SNOOZE snoozed from the intent's alarm");
                            } else if (intent.getExtras().containsKey("NotificationId")) {
                                // Dead row: degrade snooze to dismiss instead of`,
    ],
  ]) + patched;
};


const applyAlarmReminderActionsReceiverPatchToSource = (original) => {
  const next = applyAlarmReminderActionsReceiverReceiptPatchToSource(original);
  if (next.includes('tech.dongdongbh.mindwtr.androidwidget.CaptureSyncHeadlessService')) return next;
  if (!next.includes('case Constants.NOTIFICATION_ACTION_COMPLETE')) return next;
  const start = next.indexOf('case Constants.NOTIFICATION_ACTION_COMPLETE:');
  const end = next.indexOf('case Constants.NOTIFICATION_ACTION_DISMISS:', start);
  const completion = next.slice(start, end);
  const deliveryStart = completion.indexOf('                            if (ANModule.getReactAppContext() != null) {');
  const deliveryEnd = completion.indexOf('                        } catch (Exception e)', deliveryStart);
  if (deliveryStart < 0 || deliveryEnd < 0 || !completion.slice(deliveryStart, deliveryEnd).includes('context.startActivity(launchIntent);')) {
    throw new Error('alarm-reminder-actions-receiver: expected Done delivery anchor not found');
  }
  const delivery = `                            try {
                                Intent completionService = new Intent().setClassName(context.getPackageName(), "tech.dongdongbh.mindwtr.androidwidget.CaptureSyncHeadlessService");
                                context.startService(completionService);
                                com.facebook.react.HeadlessJsTaskService.acquireWakeLockNow(context);
                            } catch (RuntimeException error) {
                                // The receipt stays durable for the next app/scheduled wake.
                                Log.w(TAG, "Done background processing start refused: " + error.getClass().getSimpleName());
                            }
                            if (ANModule.getReactAppContext() != null) {
                                ANModule.getReactAppContext().getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class).emit("OnNotificationOpened", BundleJSONConverter.convertToJSON(payload).toString());
                            }
`;
  return next.slice(0, start) + completion.slice(0, deliveryStart) + delivery + completion.slice(deliveryEnd) + next.slice(end);
};

const getAndroidSourceCandidates = (projectRoot, fileName) => [
  path.join(projectRoot, 'node_modules', 'react-native-alarm-notification', 'android', 'src', 'main', 'java', 'com', 'emekalites', 'react', 'alarm', 'notification', fileName),
  path.join(projectRoot, '..', '..', 'node_modules', 'react-native-alarm-notification', 'android', 'src', 'main', 'java', 'com', 'emekalites', 'react', 'alarm', 'notification', fileName),
];

const getIosSourceCandidates = (projectRoot) => [
  path.join(projectRoot, 'node_modules', 'react-native-alarm-notification', 'ios', 'RnAlarmNotification.m'),
  path.join(projectRoot, '..', '..', 'node_modules', 'react-native-alarm-notification', 'ios', 'RnAlarmNotification.m'),
];

const getIosHeaderCandidates = (projectRoot) => [
  path.join(projectRoot, 'node_modules', 'react-native-alarm-notification', 'ios', 'RnAlarmNotification.h'),
  path.join(projectRoot, '..', '..', 'node_modules', 'react-native-alarm-notification', 'ios', 'RnAlarmNotification.h'),
];

const applyAlarmIosColdStartHeaderPatchToSource = (original) => {
  if (original.includes('cacheForColdStart:(BOOL)cacheForColdStart')) return original;
  return original.replace(
    '+ (void)didReceiveNotificationResponse:(UNNotificationResponse *)response API_AVAILABLE(ios(10.0));',
    `+ (void)didReceiveNotificationResponse:(UNNotificationResponse *)response API_AVAILABLE(ios(10.0));
+ (void)didReceiveNotificationResponse:(UNNotificationResponse *)response
                     cacheForColdStart:(BOOL)cacheForColdStart API_AVAILABLE(ios(10.0));`
  );
};

const applyAlarmIosCompleteActionPatchToSource = (original) => {
  let next = original;

  if (!next.includes('pendingNotificationOpenPayload')) {
    next = next.replace(
      'static id _sharedInstance = nil;\n',
      `static id _sharedInstance = nil;
static NSMutableDictionary *pendingNotificationOpenPayload = nil;
`
    );
  }

  if (!next.includes('cachePendingNotificationOpenPayload')) {
    next = next.replace(
      'static NSString *stringify(NSDictionary *notification) {',
      `static void cachePendingNotificationOpenPayload(NSDictionary *payload) {
    @synchronized([RnAlarmNotification class]) {
        pendingNotificationOpenPayload = [payload mutableCopy];
    }
}

static NSString *stringify(NSDictionary *notification) {`
    );
  }

  if (!next.includes('RCTFormatUNNotificationWithAction')) {
    next = next.replace(
      /API_AVAILABLE\(ios\(10\.0\)\)\nstatic NSDictionary \*RCTFormatUNNotification\(UNNotification \*notification\) \{[\s\S]*?\n\}\n\nstatic NSDateComponents \*parseDate/,
      `API_AVAILABLE(ios(10.0))
static NSDictionary *RCTFormatUNNotificationWithAction(UNNotification *notification, NSString *actionIdentifier) {
    NSMutableDictionary *formattedNotification = [NSMutableDictionary dictionary];
    UNNotificationContent *content = notification.request.content;

    formattedNotification[@"id"] = notification.request.identifier;
    formattedNotification[@"actionIdentifier"] = RCTNullIfNil(actionIdentifier);
    formattedNotification[@"data"] = RCTNullIfNil([content.userInfo objectForKey:@"data"]);

    return formattedNotification;
}

API_AVAILABLE(ios(10.0))
static NSDictionary *RCTFormatUNNotification(UNNotification *notification) {
    return RCTFormatUNNotificationWithAction(notification, @"open");
}

static NSDateComponents *parseDate`
    );
  }

  if (!next.includes('RCT_EXPORT_METHOD(consumePendingNotificationOpenPayload')) {
    next = next.replace(
      'RCT_EXPORT_MODULE(RNAlarmNotification);\n',
      `RCT_EXPORT_MODULE(RNAlarmNotification);

RCT_EXPORT_METHOD(consumePendingNotificationOpenPayload:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
    @synchronized([RnAlarmNotification class]) {
        if (pendingNotificationOpenPayload == nil) {
            resolve([NSNull null]);
            return;
        }
        NSDictionary *payload = [pendingNotificationOpenPayload copy];
        pendingNotificationOpenPayload = nil;
        resolve(payload);
    }
}
`
    );
  }

  next = next.replace(
    /\+ \(void\)didReceiveNotificationResponse:\(UNNotificationResponse \*\)response\nAPI_AVAILABLE\(ios\(10\.0\)\) \{[\s\S]*?\n\}\n\n- \(void\)startObserving/,
    `+ (void)didReceiveNotificationResponse:(UNNotificationResponse *)response
API_AVAILABLE(ios(10.0)) {
    [RnAlarmNotification didReceiveNotificationResponse:response cacheForColdStart:NO];
}

+ (void)didReceiveNotificationResponse:(UNNotificationResponse *)response
                     cacheForColdStart:(BOOL)cacheForColdStart
API_AVAILABLE(ios(10.0)) {
    NSLog(@"show notification");
    [[UIApplication sharedApplication] setIdleTimerDisabled:NO];
    NSString *mindwtrActionIdentifier = @"open";
    if ([response.notification.request.content.categoryIdentifier isEqualToString:@"CUSTOM_ACTIONS"]) {
       if ([response.actionIdentifier isEqualToString:@"COMPLETE_ACTION"]) {
           mindwtrActionIdentifier = @"complete";
           [RnAlarmNotification stopSound];
           [[UNUserNotificationCenter currentNotificationCenter] removeDeliveredNotificationsWithIdentifiers:@[response.notification.request.identifier]];
           [[UNUserNotificationCenter currentNotificationCenter] removePendingNotificationRequestsWithIdentifiers:@[response.notification.request.identifier]];
       } else if ([response.actionIdentifier isEqualToString:@"SNOOZE_ACTION"]) {
           mindwtrActionIdentifier = @"snooze";
           [RnAlarmNotification snoozeAlarm:response.notification];
       } else if ([response.actionIdentifier isEqualToString:@"DISMISS_ACTION"]) {
           mindwtrActionIdentifier = @"dismiss";
           NSLog(@"do dismiss");
           [RnAlarmNotification stopSound];

           NSMutableDictionary *notification = [NSMutableDictionary dictionary];
           notification[@"id"] = response.notification.request.identifier;

           [[NSNotificationCenter defaultCenter] postNotificationName:kLocalNotificationDismissed
                                                               object:self
                                                             userInfo:notification];
       }
    }

    NSDictionary *formattedNotification = RCTFormatUNNotificationWithAction(response.notification, mindwtrActionIdentifier);
    if (cacheForColdStart || [mindwtrActionIdentifier isEqualToString:@"complete"]) {
        cachePendingNotificationOpenPayload(formattedNotification);
    }
    [[NSNotificationCenter defaultCenter] postNotificationName:kLocalNotificationReceived
                                                        object:self
                                                      userInfo:formattedNotification];
}

- (void)startObserving`
  );

  next = next.replace(
    /if\(\[has_button isEqualToNumber: \[NSNumber numberWithInt: 1\]\]\)\{\n                content\.categoryIdentifier = @"CUSTOM_ACTIONS";\n            \}/g,
    'if([has_button isEqualToNumber: [NSNumber numberWithInt: 1]] || [[contentInfo.userInfo objectForKey:@"has_complete_action"] isEqualToNumber: [NSNumber numberWithInt: 1]]){\n                content.categoryIdentifier = @"CUSTOM_ACTIONS";\n            }'
  );

  next = next.replace(
    /if\(\[details\[@"has_button"\] isEqualToNumber: \[NSNumber numberWithInt: 1\]\]\)\{\n                content\.categoryIdentifier = @"CUSTOM_ACTIONS";\n            \}/g,
    'if([details[@"has_button"] isEqualToNumber: [NSNumber numberWithInt: 1]] || [details[@"has_complete_action"] isEqualToNumber: [NSNumber numberWithInt: 1]]){\n                content.categoryIdentifier = @"CUSTOM_ACTIONS";\n            }'
  );


  next = next.replace(
    /@"has_button": \[contentInfo\.userInfo objectForKey:@"has_button"\],\n                @"schedule_type":/g,
    '@"has_button": [contentInfo.userInfo objectForKey:@"has_button"],\n                @"has_complete_action": ([contentInfo.userInfo objectForKey:@"has_complete_action"] ?: @NO),\n                @"schedule_type":'
  );

  next = next.replace(
    /@"has_button": details\[@"has_button"\],\n                @"schedule_type":/g,
    '@"has_button": details[@"has_button"],\n                @"has_complete_action": (details[@"has_complete_action"] ?: @NO),\n                @"schedule_type":'
  );

  if (!next.includes('actionWithIdentifier:@"COMPLETE_ACTION"')) {
    next = next.replace(
      `        UNNotificationAction* snoozeAction = [UNNotificationAction
              actionWithIdentifier:@"SNOOZE_ACTION"`,
      `        UNNotificationAction* completeAction = [UNNotificationAction
              actionWithIdentifier:@"COMPLETE_ACTION"
              title:@"Complete"
              options:UNNotificationActionOptionNone];

        UNNotificationAction* snoozeAction = [UNNotificationAction
              actionWithIdentifier:@"SNOOZE_ACTION"`
    );
    next = next.replace(
      'actions:@[snoozeAction, stopAction]',
      'actions:@[completeAction, snoozeAction, stopAction]'
    );
  }


  next = next.replace(
    /(actionWithIdentifier:@"DISMISS_ACTION"\s+title:@"[^"]*"\s+options:)UNNotificationActionOptionForeground/g,
    '$1UNNotificationActionOptionNone'
  );

  return next;
};


const applyAlarmIosUniqueIdentifierPatchToSource = (original) => {
  let next = original;

  if (!next.includes('mindwtrAlarmIdCounter')) {
    next = next.replace(
      'static id _sharedInstance = nil;\n',
      'static id _sharedInstance = nil;\nstatic int64_t mindwtrAlarmIdCounter = 0;\n'
    );
  }

  next = next.replace(
    /NSString \*alarmId = \[NSString stringWithFormat: @"%ld", \(long\) NSDate\.date\.timeIntervalSince1970\];/g,
    `NSString *alarmId;
            @synchronized([RnAlarmNotification class]) {
                mindwtrAlarmIdCounter = (mindwtrAlarmIdCounter + 1) % 1000;
                alarmId = [NSString stringWithFormat: @"%lld", ((int64_t)(NSDate.date.timeIntervalSince1970 * 1000.0)) * 1000 + mindwtrAlarmIdCounter];
            }`
  );

  return next;
};


const applyAlarmIosDeletePendingPatchToSource = (original) => original.replace(
  /RCT_EXPORT_METHOD\((deleteAlarm|deleteRepeatingAlarm): \(NSInteger \*\)id\)/g,
  'RCT_EXPORT_METHOD($1: (NSInteger)id)'
);


const applyAlarmIosPendingKindPatchToSource = (original) => {
  if (original.includes('// Mindwtr pending notification kind')) return original;
  return original.replace(
    'formattedNotification[@"id"] = request.identifier;',
    `formattedNotification[@"id"] = request.identifier;
    // Mindwtr pending notification kind
    id pendingData = content.userInfo[@"data"];
    if ([pendingData isKindOfClass:[NSDictionary class]]) {
        id pendingKind = [(NSDictionary *)pendingData objectForKey:@"kind"];
        if ([pendingKind isKindOfClass:[NSString class]]) {
            formattedNotification[@"data"] = @{ @"kind": pendingKind };
        }
    }`
  );
};


const applyAlarmIosReminderThreadPatchToSource = (original) => {
  if (original.includes('// Mindwtr reminder threads')) return original;
  const removeAllMarker = 'RCT_EXPORT_METHOD(removeAllFiredNotifications){';
  const detailsBody = 'content.body = [NSString localizedUserNotificationStringForKey:details[@"message"] arguments:nil];';
  const copiedBody = 'content.body = contentInfo.body;';
  if (!original.includes(removeAllMarker) || !original.includes(detailsBody) || !original.includes(copiedBody)) return original;
  return original
    .split(detailsBody).join(`${detailsBody}
            if ([details[@"tag"] isKindOfClass:[NSString class]] && [(NSString *)details[@"tag"] length] > 0) {
                content.threadIdentifier = details[@"tag"];
            }`)
    .split(copiedBody).join(`${copiedBody}
            content.threadIdentifier = contentInfo.threadIdentifier;`)
    .replace(removeAllMarker, `// Mindwtr reminder threads: keeps only the newest delivered notification of
// each reminder thread, so a task's earlier reminders leave the tray.
RCT_EXPORT_METHOD(collapseDeliveredReminderNotifications:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject){
    if (@available(iOS 10.0, *)) {
        UNUserNotificationCenter *center = [UNUserNotificationCenter currentNotificationCenter];
        [center getDeliveredNotificationsWithCompletionHandler:^(NSArray<UNNotification *> * _Nonnull notifications) {
            NSMutableDictionary<NSString *, UNNotification *> *newest = [NSMutableDictionary dictionary];
            NSMutableArray<NSString *> *superseded = [NSMutableArray array];
            for (UNNotification *notification in notifications) {
                NSString *thread = notification.request.content.threadIdentifier;
                if (![thread hasPrefix:@"mindwtr-reminder:"]) continue;
                UNNotification *kept = newest[thread];
                if (kept == nil) {
                    newest[thread] = notification;
                } else if ([notification.date compare:kept.date] == NSOrderedDescending) {
                    [superseded addObject:kept.request.identifier];
                    newest[thread] = notification;
                } else {
                    [superseded addObject:notification.request.identifier];
                }
            }
            if (superseded.count > 0) {
                [center removeDeliveredNotificationsWithIdentifiers:superseded];
            }
            resolve(@(superseded.count));
        }];
    } else {
        resolve(@0);
    }
}

${removeAllMarker}`);
};

const logPatchedCandidate = (label, candidate) => {
  console.log(`[${label}] patched ${candidate}`);
};


const applyAlarmExactPermissionModulePatchToSource = (original) => {
  if (original.includes('public void canScheduleExactAlarms(')) return original;
  const marker = `    @ReactMethod
    public void removeAllFiredNotifications() {`;
  if (!original.includes(marker)) return original;
  return original.replace(
    marker,
    `    @ReactMethod
    public void canScheduleExactAlarms(Promise promise) {
        if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.S) {
            promise.resolve(true);
            return;
        }
        android.app.AlarmManager alarmManager = (android.app.AlarmManager) mReactContext
                .getSystemService(android.content.Context.ALARM_SERVICE);
        promise.resolve(alarmManager != null && alarmManager.canScheduleExactAlarms());
    }

${marker}`
  );
};

const applyAlarmBootRecoveryUtilPatchToSource = (original) => {
  const disabled = 'if (setting == PackageManager.COMPONENT_ENABLED_STATE_DISABLED) {';
  const enabled = 'if (setting != PackageManager.COMPONENT_ENABLED_STATE_ENABLED) {';
  const marker = '    private void enableBootReceiver(Context context) {';
  if (!original.includes(marker) || (!original.includes(disabled) && !original.includes(enabled))) {
    throw new Error('alarm-boot-recovery-util: boot enable anchor missing');
  }
  let next = original.replace(disabled, enabled);
  if (next.includes('boolean rearmFutureAlarm(int id)')) return next;
  return next.replace(marker, `    boolean rearmFutureAlarm(int id) {
        AlarmModel alarm = getAlarmDB().getAlarm(id);
        if (alarm == null || alarm.getActive() != 1) return false;
        String scheduleType = alarm.getScheduleType();
        if (!"once".equals(scheduleType) && !"repeat".equals(scheduleType)) return false;
        Calendar fireTime = getCalendarFromAlarm(alarm);
        fireTime.setLenient(false);
        if ("once".equals(scheduleType) && fireTime.getTimeInMillis() <= System.currentTimeMillis()) return false;
        // Reuse the existing row and alarmId-backed PendingIntent; never insert or replay a delivered one-shot.
        setAlarm(alarm);
        return true;
    }

${marker}`);
};

const applyAlarmBootRecoveryModulePatchToSource = (original) => {
  if (original.includes('public void rearmAlarms(')) return original;
  const marker = `    @ReactMethod
    public void removeAllFiredNotifications() {`;
  if (!original.includes(marker)) throw new Error('alarm-boot-recovery-module: method anchor missing');
  return original.replace(marker, `    @ReactMethod
    public void rearmAlarms(com.facebook.react.bridge.ReadableArray ids, Promise promise) {
        // Serialize row advancement with AlarmReceiver, which runs on the main thread.
        com.facebook.react.bridge.UiThreadUtil.runOnUiThread(() -> {
            int rearmed = 0;
            int skipped = 0;
            int failed = 0;
            java.util.HashSet<Integer> seen = new java.util.HashSet<>();
            for (int index = 0; index < ids.size(); index++) {
                try {
                    double value = ids.getDouble(index);
                    if (!Double.isFinite(value) || value <= 0 || value > Integer.MAX_VALUE || value != Math.floor(value)) {
                        failed++;
                        continue;
                    }
                    int id = (int) value;
                    if (!seen.add(id)) continue;
                    if (alarmUtil.rearmFutureAlarm(id)) rearmed++;
                    else skipped++;
                } catch (Exception error) {
                    failed++;
                }
            }
            try {
                alarmUtil.setBootReceiver();
                android.content.ComponentName receiver = new android.content.ComponentName(mReactContext, AlarmBootReceiver.class);
                boolean bootEnabled = mReactContext.getPackageManager().getComponentEnabledSetting(receiver)
                        == android.content.pm.PackageManager.COMPONENT_ENABLED_STATE_ENABLED;
                android.app.AlarmManager manager = (android.app.AlarmManager) mReactContext
                        .getSystemService(android.content.Context.ALARM_SERVICE);
                boolean exactAllowed = android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.S
                        || (manager != null && manager.canScheduleExactAlarms());
                WritableMap result = Arguments.createMap();
                result.putInt("requested", ids.size());
                result.putInt("rearmed", rearmed);
                result.putInt("skipped", skipped);
                result.putInt("failed", failed);
                result.putBoolean("bootEnabled", bootEnabled);
                result.putBoolean("exactAllowed", exactAllowed);
                promise.resolve(result);
            } catch (Exception error) {
                promise.reject("E_REARM_ALARMS_FAILED", error);
            }
        });
    }

${marker}`);
};


const applyAlarmDeliveredNotificationModulePatchToSource = (original) => {
  if (original.includes('public void clearNotification(int notificationId)')) return original;
  const marker = `    @ReactMethod
    public void removeAllFiredNotifications() {`;
  if (!original.includes(marker)) return original;
  return original.replace(
    marker,
    `    @ReactMethod
    public void getNotificationId(int id, Promise promise) {
        AlarmModel alarm = getAlarmDB().getAlarm(id);
        if (alarm == null) {
            promise.resolve(null);
            return;
        }
        promise.resolve(alarm.getAlarmId());
    }

    @ReactMethod
    public void clearNotification(int notificationId) {
        alarmUtil.clearNotification(notificationId);
    }

${marker}`
  );
};

const androidJavaCandidates = (fileName) => (projectRoot) => getAndroidSourceCandidates(projectRoot, fileName);

const androidGradleCandidates = (projectRoot) => [
  path.join(projectRoot, 'node_modules', 'react-native-alarm-notification', 'android', 'build.gradle'),
  path.join(projectRoot, '..', '..', 'node_modules', 'react-native-alarm-notification', 'android', 'build.gradle'),
];

const iosSourceCandidates = (projectRoot) => getIosSourceCandidates(projectRoot);

const PATCHES = [
  {
    id: 'gradle-compat',
    platform: 'android',
    getCandidates: androidGradleCandidates,
    transform: applyGradleCompatPatchToSource,
    required: true,

    firstMatchOnly: true,
    appliedMarker: "implementation project(':notification-open-intents')",
  },
  {
    id: 'alarm-pending-intent',
    platform: 'android',
    getCandidates: androidJavaCandidates('AlarmUtil.java'),
    transform: applyAlarmPendingIntentPatchToSource,
    required: true,

    firstMatchOnly: false,
    appliedMarker: 'getUpdateCurrentImmutableFlags()',
  },
  {
    id: 'alarm-task-open-intent',
    platform: 'android',
    getCandidates: androidJavaCandidates('AlarmUtil.java'),
    transform: applyAlarmTaskOpenIntentPatchToSource,
    required: true,
    firstMatchOnly: false,
    appliedMarker: 'mindwtr:///focus',
  },
  {
    id: 'alarm-duplicate-toast',
    platform: 'android',
    getCandidates: androidJavaCandidates('AlarmUtil.java'),
    transform: applyAlarmDuplicateToastPatchToSource,


    required: false,
    firstMatchOnly: false,
    appliedMarker: 'Duplicate alarms are reported to JS via promise rejection',
  },
  {
    id: 'alarm-timing',
    platform: 'android',
    getCandidates: androidJavaCandidates('AlarmUtil.java'),
    transform: applyAlarmTimingPatchToSource,
    required: true,
    firstMatchOnly: false,

    appliedMarker: 'private void setExactOrAllowWhileIdle(',
  },
  {
    id: 'alarm-exact-repeat-util',
    platform: 'android',
    getCandidates: androidJavaCandidates('AlarmUtil.java'),


    transform: applyAlarmExactRepeatPatchToSource,
    required: true,
    firstMatchOnly: false,
    appliedMarker: 'MAX_REPEAT_SEARCH_STEPS',
  },
  {
    id: 'alarm-stale-once-util',
    platform: 'android',
    getCandidates: androidJavaCandidates('AlarmUtil.java'),
    transform: applyAlarmStaleOnceUtilPatchToSource,
    required: true,
    firstMatchOnly: false,
    appliedMarker: 'boolean discardStaleOneShot(AlarmModel alarm)',
  },
  {
    id: 'alarm-reminder-behavior',
    platform: 'android',
    getCandidates: androidJavaCandidates('AlarmUtil.java'),
    transform: applyAlarmReminderBehaviorPatchToSource,
    required: true,
    firstMatchOnly: false,
    appliedMarker: '"Mindwtr reminders"',
  },
  {
    id: 'alarm-lock-screen-privacy',
    platform: 'android',
    getCandidates: androidJavaCandidates('AlarmUtil.java'),
    transform: applyAlarmLockScreenPrivacyPatchToSource,
    required: true,
    firstMatchOnly: false,
    appliedMarker: '.setVisibility(NotificationCompat.VISIBILITY_PRIVATE)',
  },
  {
    id: 'alarm-pomodoro-when',
    platform: 'android',
    getCandidates: androidJavaCandidates('AlarmUtil.java'),
    transform: applyAlarmPomodoroWhenPatchToSource,
    required: true,
    firstMatchOnly: false,
    appliedMarker: 'String pomodoroEndsAtMs = bundle.getString("endsAtMs");',
  },
  {
    id: 'alarm-complete-action-util',
    platform: 'android',
    getCandidates: androidJavaCandidates('AlarmUtil.java'),
    transform: applyAlarmCompleteUtilPatchToSource,
    required: true,
    firstMatchOnly: false,
    appliedMarker: 'notificationActionComplete',
  },
  {
    id: 'alarm-dead-row-util',
    platform: 'android',
    getCandidates: androidJavaCandidates('AlarmUtil.java'),
    transform: applyAlarmDeadRowUtilPatchToSource,
    required: true,


    firstMatchOnly: false,
    appliedMarker: 'void clearNotification(int notificationId)',
  },
  {
    id: 'alarm-reminder-slot',
    platform: 'android',
    getCandidates: androidJavaCandidates('AlarmUtil.java'),
    transform: applyAlarmReminderSlotPatchToSource,
    required: true,


    firstMatchOnly: false,
    appliedMarker: '// Mindwtr reminder notification slots',
  },
  {
    id: 'alarm-reminder-actions-util',
    platform: 'android',
    getCandidates: androidJavaCandidates('AlarmUtil.java'),
    transform: applyAlarmReminderActionsUtilPatchToSource,
    required: true,


    firstMatchOnly: false,
    appliedMarker: '// Mindwtr task reminder actions',
  },
  {
    id: 'alarm-audio-interface',
    platform: 'android',
    getCandidates: androidJavaCandidates('AudioInterface.java'),
    transform: applyAlarmAudioInterfacePatchToSource,
    required: true,

    firstMatchOnly: false,
    appliedMarker: 'Settings.System.DEFAULT_NOTIFICATION_URI',
  },
  {
    id: 'alarm-dismiss-receiver',
    platform: 'android',
    getCandidates: androidJavaCandidates('AlarmDismissReceiver.java'),
    transform: applyAlarmDismissReceiverPatchToSource,
    required: true,

    firstMatchOnly: true,
    appliedMarker: 'if (ANModule.getReactAppContext() != null) {\n                ANModule.getReactAppContext().getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class).emit("OnNotificationDismissed"',
  },
  {
    id: 'alarm-receiver-dismiss-guard',
    platform: 'android',
    getCandidates: androidJavaCandidates('AlarmReceiver.java'),
    transform: applyAlarmReceiverPatchToSource,
    required: true,

    firstMatchOnly: false,
    appliedMarker: 'if (ANModule.getReactAppContext() != null) {\n                                ANModule.getReactAppContext().getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class).emit("OnNotificationDismissed"',
  },
  {
    id: 'alarm-exact-repeat-receiver',
    platform: 'android',
    getCandidates: androidJavaCandidates('AlarmReceiver.java'),
    transform: applyAlarmExactRepeatPatchToSource,
    required: true,
    firstMatchOnly: false,
    appliedMarker: 'alarmUtil.rescheduleRepeatingAlarm(alarm);',
  },
  {
    id: 'alarm-stale-once-receiver',
    platform: 'android',
    getCandidates: androidJavaCandidates('AlarmReceiver.java'),
    transform: applyAlarmStaleOnceReceiverPatchToSource,
    required: true,
    firstMatchOnly: false,
    appliedMarker: 'alarmUtil.discardStaleOneShot(alarm)',
  },
  {
    id: 'alarm-complete-action-receiver',
    platform: 'android',
    getCandidates: androidJavaCandidates('AlarmReceiver.java'),
    transform: applyAlarmCompleteReceiverPatchToSource,
    required: true,
    firstMatchOnly: false,
    appliedMarker: 'case Constants.NOTIFICATION_ACTION_COMPLETE',
  },
  {
    id: 'alarm-dead-row-actions',
    platform: 'android',
    getCandidates: androidJavaCandidates('AlarmReceiver.java'),
    transform: applyAlarmActionDeadRowPatchToSource,
    required: true,


    firstMatchOnly: false,
    appliedMarker: 'Log.d(TAG, "ACTION_SNOOZE id="',
  },
  {
    id: 'alarm-reminder-actions-receiver',
    platform: 'android',
    getCandidates: androidJavaCandidates('AlarmReceiver.java'),
    transform: applyAlarmReminderActionsReceiverPatchToSource,
    required: true,

    firstMatchOnly: false,
    appliedMarker: 'tech.dongdongbh.mindwtr.androidwidget.CaptureSyncHeadlessService',
  },
  {
    id: 'alarm-complete-action-constants',
    platform: 'android',
    getCandidates: androidJavaCandidates('Constants.java'),
    transform: applyAlarmCompleteConstantsPatchToSource,
    required: true,

    firstMatchOnly: true,
    appliedMarker: 'NOTIFICATION_ACTION_COMPLETE',
  },
  {
    id: 'alarm-exact-permission-module',
    platform: 'android',
    getCandidates: androidJavaCandidates('ANModule.java'),
    transform: applyAlarmExactPermissionModulePatchToSource,
    required: true,
    firstMatchOnly: false,
    appliedMarker: 'public void canScheduleExactAlarms(',
  },
  {
    id: 'alarm-delivered-notification-module',
    platform: 'android',
    getCandidates: androidJavaCandidates('ANModule.java'),
    transform: applyAlarmDeliveredNotificationModulePatchToSource,
    required: true,
    firstMatchOnly: false,
    appliedMarker: 'public void clearNotification(int notificationId)',
  },
  {
    id: 'alarm-boot-recovery-util',
    platform: 'android',
    getCandidates: androidJavaCandidates('AlarmUtil.java'),
    transform: applyAlarmBootRecoveryUtilPatchToSource,
    required: true,
    firstMatchOnly: false,
    appliedMarker: 'boolean rearmFutureAlarm(int id)',
  },
  {
    id: 'alarm-boot-recovery-module',
    platform: 'android',
    getCandidates: androidJavaCandidates('ANModule.java'),
    transform: applyAlarmBootRecoveryModulePatchToSource,
    required: true,
    firstMatchOnly: false,
    appliedMarker: 'public void rearmAlarms(',
  },
  {
    id: 'alarm-ios-complete-action',
    platform: 'ios',
    getCandidates: iosSourceCandidates,
    transform: applyAlarmIosCompleteActionPatchToSource,
    required: true,

    firstMatchOnly: true,
    appliedMarker: 'RCT_EXPORT_METHOD(consumePendingNotificationOpenPayload',
  },
  {
    id: 'alarm-ios-cold-start-header',
    platform: 'ios',
    getCandidates: getIosHeaderCandidates,
    transform: applyAlarmIosColdStartHeaderPatchToSource,
    required: true,
    firstMatchOnly: true,
    appliedMarker: 'cacheForColdStart:(BOOL)cacheForColdStart',
  },
  {
    id: 'alarm-ios-unique-identifier',
    platform: 'ios',
    getCandidates: iosSourceCandidates,
    transform: applyAlarmIosUniqueIdentifierPatchToSource,
    required: true,

    firstMatchOnly: true,
    appliedMarker: 'mindwtrAlarmIdCounter',
  },
  {
    id: 'alarm-ios-delete-pending-arg',
    platform: 'ios',
    getCandidates: iosSourceCandidates,
    transform: applyAlarmIosDeletePendingPatchToSource,
    required: true,
    firstMatchOnly: true,
    appliedMarker: 'RCT_EXPORT_METHOD(deleteAlarm: (NSInteger)id)',
  },
  {
    id: 'alarm-ios-pending-kind',
    platform: 'ios',
    getCandidates: iosSourceCandidates,
    transform: applyAlarmIosPendingKindPatchToSource,
    required: true,
    firstMatchOnly: true,
    appliedMarker: '// Mindwtr pending notification kind',
  },

  {
    id: 'alarm-ios-reminder-thread',
    platform: 'ios',
    getCandidates: iosSourceCandidates,
    transform: applyAlarmIosReminderThreadPatchToSource,
    required: true,
    firstMatchOnly: true,
    appliedMarker: '// Mindwtr reminder threads',
  },


];


const isRequired = (patch) => patch.required !== false;


const applyPatches = (projectRoot, patches = PATCHES) => {
  for (const patch of patches) {
    let satisfied = false;
    for (const candidate of patch.getCandidates(projectRoot)) {
      if (patchFile(candidate, patch.transform)) {
        logPatchedCandidate(patch.id, candidate);
        satisfied = true;
        if (patch.firstMatchOnly) break;
        continue;
      }
      if (!satisfied && patch.appliedMarker && fs.existsSync(candidate)) {
        if (fs.readFileSync(candidate, 'utf8').includes(patch.appliedMarker)) {
          satisfied = true;
        }
      }
    }
    if (isRequired(patch) && !satisfied) {
      throw new Error(
        `Alarm-notification patch "${patch.id}" did not apply to any candidate file and its `
        + 'expected marker was not found either. react-native-alarm-notification likely changed '
        + `upstream — check the "${patch.id}" transform in patch-alarm-notification-gradle.js.`
      );
    }
  }
};

const ensurePermission = (manifest, name) => {
  if (!Array.isArray(manifest.manifest['uses-permission'])) {
    manifest.manifest['uses-permission'] = [];
  }
  const permissions = manifest.manifest['uses-permission'];
  const existing = permissions.find((permission) => permission?.$?.['android:name'] === name);
  if (existing) return;
  permissions.push({
    $: {
      'android:name': name,
    },
  });
};

const mergeIntentActions = (receiver, actions) => {
  if (!actions.length) return;
  if (!Array.isArray(receiver['intent-filter'])) {
    receiver['intent-filter'] = [];
  }
  if (!receiver['intent-filter'][0]) {
    receiver['intent-filter'][0] = {};
  }
  if (!Array.isArray(receiver['intent-filter'][0].action)) {
    receiver['intent-filter'][0].action = [];
  }
  const existing = new Set(
    receiver['intent-filter'][0].action
      .map((action) => action?.$?.['android:name'])
      .filter(Boolean)
  );
  actions.forEach((name) => {
    if (existing.has(name)) return;
    receiver['intent-filter'][0].action.push({
      $: {
        'android:name': name,
      },
    });
  });
};

const ensureReceiver = (application, name, attrs, actions = []) => {
  if (!Array.isArray(application.receiver)) {
    application.receiver = [];
  }
  let receiver = application.receiver.find((entry) => entry?.$?.['android:name'] === name);
  if (!receiver) {
    receiver = {
      $: {
        'android:name': name,
        ...attrs,
      },
    };
    application.receiver.push(receiver);
  } else {
    receiver.$ = {
      ...(receiver.$ || {}),
      ...attrs,
    };
  }
  mergeIntentActions(receiver, actions);
};

const applyAlarmManifestEntries = (manifest) => {
  const application = manifest.manifest.application?.[0];
  if (!application) {
    return;
  }

  ensurePermission(manifest, 'android.permission.RECEIVE_BOOT_COMPLETED');
  ensurePermission(manifest, 'android.permission.SCHEDULE_EXACT_ALARM');


  ensureReceiver(
    application,
    'com.emekalites.react.alarm.notification.AlarmReceiver',
    {
      'android:enabled': 'true',
      'android:exported': 'false',
    },
    ['ACTION_DISMISS', 'ACTION_SNOOZE', 'ACTION_COMPLETE']
  );

  ensureReceiver(
    application,
    'com.emekalites.react.alarm.notification.AlarmDismissReceiver',
    {
      'android:enabled': 'true',
      'android:exported': 'false',
    }
  );


  ensureReceiver(
    application,
    'com.emekalites.react.alarm.notification.AlarmBootReceiver',
    {
      'android:directBootAware': 'true',
      'android:enabled': 'false',
      'android:exported': 'true',
    },
    [
      'android.intent.action.BOOT_COMPLETED',
      'android.intent.action.QUICKBOOT_POWERON',
      'com.htc.intent.action.QUICKBOOT_POWERON',
      'android.intent.action.LOCKED_BOOT_COMPLETED',
    ]
  );
};

function withAlarmNotificationGradlePatch(config) {
  const withManifestEntries = withAndroidManifest(config, (cfg) => {
    applyAlarmManifestEntries(cfg.modResults);
    return cfg;
  });

  const withAndroidPatches = withDangerousMod(withManifestEntries, [
    'android',
    async (cfg) => {
      applyPatches(cfg.modRequest.projectRoot, PATCHES.filter((patch) => patch.platform === 'android'));
      return cfg;
    },
  ]);

  return withDangerousMod(withAndroidPatches, [
    'ios',
    async (cfg) => {
      applyPatches(cfg.modRequest.projectRoot, PATCHES.filter((patch) => patch.platform === 'ios'));
      return cfg;
    },
  ]);
}

module.exports = withAlarmNotificationGradlePatch;
module.exports.__testables = {
  applyAlarmManifestEntries,
  patchFile,
  getAndroidSourceCandidates,
  getIosSourceCandidates,
  getIosHeaderCandidates,
  PATCHES,
  applyPatches,
};
