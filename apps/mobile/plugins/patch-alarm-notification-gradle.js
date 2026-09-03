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

  // Removed in modern Gradle.
  next = next.replace(/^\s*apply plugin: 'maven'\s*$/gm, '');

  // AGP 8 expects modern compileSdk DSL.
  next = next.replace(
    "compileSdkVersion safeExtGet('compileSdkVersion', DEFAULT_COMPILE_SDK_VERSION)",
    "compileSdk safeExtGet('compileSdkVersion', DEFAULT_COMPILE_SDK_VERSION)"
  );

  // Legacy publishing tasks rely on deprecated configurations (e.g. compile).
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
    // Snooze persists the rescheduled reminder as its own alarm row instead of
    // mutating the original. The JS reschedule cycle only tracks alarms it
    // scheduled (keyed by their original row id); the past-due task would
    // otherwise be reaped on the next cycle, cancelling the snoozed alarm
    // before it fires. An independent row is invisible to that reconciliation.
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
  // Android's lock screen "hide sensitive content" setting only redacts
  // notifications marked VISIBILITY_PRIVATE; the library ships reminders as
  // VISIBILITY_PUBLIC, which keeps task titles visible on the locked phone
  // no matter what the user chose (#823).
  return original.replace(
    '.setVisibility(NotificationCompat.VISIBILITY_PUBLIC)',
    '.setVisibility(NotificationCompat.VISIBILITY_PRIVATE)'
  );
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

// The action intents only ever carried the DB row id (`alarm.getId()`),
// which `removeFiredNotification` resolves back to the notification's real
// post id (`alarm.getAlarmId()`) via a DB lookup — `sendNotification` posts
// every reminder under `notificationID = alarm.getAlarmId()`. A later
// reschedule cycle that deletes the row before a stale notification is
// tapped makes that lookup fail silently, so the tray notification never
// clears (#1028). Carry the post id as its own extra so the receiver can
// clear the notification directly, without needing the row to still exist.
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

  // Each insertion above is an independent .replace() — none is atomic with
  // the others, so one silently drifting (e.g. a comment landing on the
  // completeIntent anchor) must not pass as "the patch applied" just because
  // the other three still matched. Assert every marker this transform owns.
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

// Hardens the three notification action cases against a dead alarm row (the
// row was deleted by a reschedule cycle after the notification was posted
// but before it was tapped — #1028). Every case now: logs a receipt (action,
// id, whether the row was found), and on a dead row still clears the tray
// notification and stops the sound instead of silently doing nothing.
// COMPLETE still delivers its payload (built from intent extras, which
// already carry the full bundle via putExtras) and still emits/caches
// OnNotificationOpened. DISMISS still emits OnNotificationDismissed with the
// intent's id. SNOOZE degrades to a plain dismiss on a dead row — the JS
// reschedule cycle owns alarm state and will re-add anything still due, so
// the receiver must not try to reconstruct or reschedule from nothing.
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

  // applyAlarmCompleteReceiverPatchToSource inserts this case through two
  // different paths depending on whether it already existed: a fresh
  // full-case insert (what a pristine install goes through — e.g. CI, which
  // never has a pre-patched node_modules) leaves TWO blank lines before
  // removeFiredNotification; an incremental cache-block-only insert into an
  // already-present case leaves ONE (what a dev machine's already-patched
  // node_modules can carry from an earlier prebuild). Try the pipeline-fresh
  // (canonical) shape first, then the other — see #1028 correction.
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

  // Each case above is rewritten by its own .replace() — one anchor drifting
  // (e.g. upstream touching just the SNOOZE case) must not pass silently
  // while the other two cases still applied. Assert every case's receipt.
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

const getAndroidSourceCandidates = (projectRoot, fileName) => [
  path.join(projectRoot, 'node_modules', 'react-native-alarm-notification', 'android', 'src', 'main', 'java', 'com', 'emekalites', 'react', 'alarm', 'notification', fileName),
  path.join(projectRoot, '..', '..', 'node_modules', 'react-native-alarm-notification', 'android', 'src', 'main', 'java', 'com', 'emekalites', 'react', 'alarm', 'notification', fileName),
];

const getIosSourceCandidates = (projectRoot) => [
  path.join(projectRoot, 'node_modules', 'react-native-alarm-notification', 'ios', 'RnAlarmNotification.m'),
  path.join(projectRoot, '..', '..', 'node_modules', 'react-native-alarm-notification', 'ios', 'RnAlarmNotification.m'),
];

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
    if ([mindwtrActionIdentifier isEqualToString:@"complete"]) {
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

  // ?: @NO on both injected values: these land inside an Objective-C @{...}
  // dictionary literal, where a nil value raises NSInvalidArgumentException
  // and rejects the whole scheduleAlarm call. The task-reminder path always
  // passes has_complete_action, so the crash only hit callers that omit it —
  // the pomodoro completion alert never scheduled on iOS because of exactly
  // this (#888).
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

  return next;
};

// The stock iOS module derives every notification identifier from the epoch
// SECOND it was created in (`timeIntervalSince1970` cast to long), and
// UNUserNotificationCenter replaces a pending request when a new one reuses
// its identifier. Any two alarms scheduled within the same wall-clock second
// therefore silently cancel each other — a batch reschedule eats its own
// task reminders, and a pomodoro completion alert scheduled in the same
// second as a task alarm never fires (#888). Replace the id with
// milliseconds plus a rotating counter so identifiers are unique.
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

// Upstream declares the cancel methods as `(NSInteger *)id` — a POINTER to an
// integer, not an integer. Under the New Architecture the interop layer
// (ObjCTurboModule::setInvocationArg) picks the marshalling branch by ObjC
// argument encoding: `@encode(NSInteger)` ("q") writes the converted integer,
// anything else falls through to writing the raw `double` bytes. `NSInteger *`
// encodes as "^q", so the method receives the IEEE-754 bit pattern of the id
// (~4.8e18 for a real ~1.75e15 identifier) and
// removePendingNotificationRequestsWithIdentifiers gets a string that matches
// nothing. Cancelling a pending iOS reminder was therefore a silent no-op, so
// every reschedule left the previous request pending and one occurrence fired
// as a stack of duplicates (#1020). Sibling `removeFiredNotification` already
// takes `(NSInteger)` by value, which is why clearing *delivered*
// notifications kept working and hid the bug.
const applyAlarmIosDeletePendingPatchToSource = (original) => original.replace(
  /RCT_EXPORT_METHOD\((deleteAlarm|deleteRepeatingAlarm): \(NSInteger \*\)id\)/g,
  'RCT_EXPORT_METHOD($1: (NSInteger)id)'
);

const logPatchedCandidate = (label, candidate) => {
  console.log(`[${label}] patched ${candidate}`);
};

// --- Declarative patch registry -------------------------------------------
//
// Each entry fully describes one patch: which file(s) it targets, whether a
// failure to apply is tolerable, whether to keep trying candidates after one
// succeeds, and how to recognise "already applied" (for idempotent re-runs
// and to tell a genuine no-op apart from an already-satisfied patch).
//
// `required: true` (the default — see `isRequired` below) means `applyPatches`
// throws, naming the patch id, if the patch neither changed a candidate file
// nor found its `appliedMarker` in one. That turns a silent no-op (upstream
// shifted a character, the patch stopped applying, reminders quietly break)
// into a loud prebuild failure instead. Only `alarm-duplicate-toast` is
// declared non-required: losing it just brings back a native "already set"
// Toast on a duplicate-schedule attempt — a cosmetic regression, not a broken
// or dropped reminder.
//
// `firstMatchOnly` reproduces the exact break/no-break behaviour the old
// per-candidate loops had (see the handoff for this task): candidates are
// [locally-installed, hoisted-to-root] copies of the same upstream file, and
// today's code is inconsistent about whether it stops at the first one that
// applies or keeps going. This registry *declares* what was already
// happening rather than changing it.
// Android 12+ (API 31) lets the user revoke "Alarms & reminders". AlarmUtil's
// setExactOrAllowWhileIdle then degrades to an inexact alarm, which lands
// reminders and the pomodoro alert up to ~30 s late (#528). Nothing upstream
// exposes that state to JS, so the settings screens cannot offer the system
// permission screen. Fully qualified names keep the patch out of the import
// block.
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
    // Original loop broke after the first successful write.
    firstMatchOnly: true,
    appliedMarker: "implementation project(':notification-open-intents')",
  },
  {
    id: 'alarm-pending-intent',
    platform: 'android',
    getCandidates: androidJavaCandidates('AlarmUtil.java'),
    transform: applyAlarmPendingIntentPatchToSource,
    required: true,
    // Original AlarmUtil.java loop never broke — all 8 patches applied to every candidate.
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
    // Cosmetic: losing this patch brings back a native "already set" Toast on
    // a duplicate schedule attempt. No reminder is delayed, dropped, or
    // mis-scheduled, so this is the one patch that may silently no-op.
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
    // Same marker the exact-repeat patch below already depends on internally.
    appliedMarker: 'private void setExactOrAllowWhileIdle(',
  },
  {
    id: 'alarm-exact-repeat-util',
    platform: 'android',
    getCandidates: androidJavaCandidates('AlarmUtil.java'),
    // Same transform as `alarm-exact-repeat-receiver` below — it no-ops on
    // whichever file's anchors it doesn't recognise. Declared as two
    // registry entries (not one) because the two files can independently
    // fail: AlarmUtil.java could patch fine while AlarmReceiver.java's rearm
    // hook silently doesn't, which would otherwise mask a real regression
    // (a repeating reminder that fires once and never re-arms).
    transform: applyAlarmExactRepeatPatchToSource,
    required: true,
    firstMatchOnly: false,
    appliedMarker: 'MAX_REPEAT_SEARCH_STEPS',
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
    // Must run after alarm-complete-action-util: it extends that block's
    // action intents with a NotificationId extra.
    firstMatchOnly: false,
    appliedMarker: 'void clearNotification(int notificationId)',
  },
  {
    id: 'alarm-audio-interface',
    platform: 'android',
    getCandidates: androidJavaCandidates('AudioInterface.java'),
    transform: applyAlarmAudioInterfacePatchToSource,
    required: true,
    // Original AudioInterface.java loop never broke either (single patch, both candidates tried).
    firstMatchOnly: false,
    appliedMarker: 'Settings.System.DEFAULT_NOTIFICATION_URI',
  },
  {
    id: 'alarm-dismiss-receiver',
    platform: 'android',
    getCandidates: androidJavaCandidates('AlarmDismissReceiver.java'),
    transform: applyAlarmDismissReceiverPatchToSource,
    required: true,
    // Original loop broke after the first successful write.
    firstMatchOnly: true,
    appliedMarker: 'if (ANModule.getReactAppContext() != null) {\n                ANModule.getReactAppContext().getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class).emit("OnNotificationDismissed"',
  },
  {
    id: 'alarm-receiver-dismiss-guard',
    platform: 'android',
    getCandidates: androidJavaCandidates('AlarmReceiver.java'),
    transform: applyAlarmReceiverPatchToSource,
    required: true,
    // Original AlarmReceiver.java loop never broke — all 3 patches applied to every candidate.
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
    // Must run after alarm-receiver-dismiss-guard and
    // alarm-complete-action-receiver: it rewrites the case blocks those
    // produce.
    firstMatchOnly: false,
    appliedMarker: 'Log.d(TAG, "ACTION_SNOOZE id="',
  },
  {
    id: 'alarm-complete-action-constants',
    platform: 'android',
    getCandidates: androidJavaCandidates('Constants.java'),
    transform: applyAlarmCompleteConstantsPatchToSource,
    required: true,
    // Original loop broke after the first successful write.
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
    id: 'alarm-ios-complete-action',
    platform: 'ios',
    getCandidates: iosSourceCandidates,
    transform: applyAlarmIosCompleteActionPatchToSource,
    required: true,
    // Original loop broke after the first successful write.
    firstMatchOnly: true,
    appliedMarker: 'RCT_EXPORT_METHOD(consumePendingNotificationOpenPayload',
  },
  {
    id: 'alarm-ios-unique-identifier',
    platform: 'ios',
    getCandidates: iosSourceCandidates,
    transform: applyAlarmIosUniqueIdentifierPatchToSource,
    required: true,
    // Original loop broke after the first successful write.
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
];

// A patch is required unless it explicitly opts out.
const isRequired = (patch) => patch.required !== false;

// Applies every patch in `patches` (default: the full registry) to whichever
// candidate file(s) each one resolves against `projectRoot`. Preserves the
// exact write/break semantics the old per-candidate loops had — the only
// addition is `satisfied` bookkeeping used to decide whether a `required`
// patch that never wrote anything was already applied (marker present, fine)
// or has silently stopped matching upstream (marker absent — throw).
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

  // Every alarm PendingIntent is created by this app, so AlarmManager and our
  // own notification actions reach these receivers on the creator's identity
  // and do not need them exported. Exported they would let any installed app
  // cancel reminders or fire stored alarms early — AlarmIds are small and
  // sequential.
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

  // Stays exported: BOOT_COMPLETED is a protected broadcast only the system
  // can send, and reminders have to be rescheduled after a reboot.
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
  PATCHES,
  applyPatches,
};
