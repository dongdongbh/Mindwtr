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

  return next;
};

const applyGradleCompatPatch = (filePath) => patchFile(filePath, applyGradleCompatPatchToSource);

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

const applyAlarmPendingIntentPatch = (filePath) => patchFile(filePath, applyAlarmPendingIntentPatchToSource);

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

const applyAlarmReminderBehaviorPatch = (filePath) => patchFile(filePath, applyAlarmReminderBehaviorPatchToSource);

const applyAlarmAudioInterfacePatchToSource = (original) => {
  return original.replace(
    '        uri = Settings.System.DEFAULT_ALARM_ALERT_URI;',
    '        uri = Settings.System.DEFAULT_NOTIFICATION_URI;'
  );
};

const applyAlarmAudioInterfacePatch = (filePath) => patchFile(filePath, applyAlarmAudioInterfacePatchToSource);

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

const applyAlarmDismissReceiverPatch = (filePath) => patchFile(filePath, applyAlarmDismissReceiverPatchToSource);

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

const applyAlarmReceiverPatch = (filePath) => patchFile(filePath, applyAlarmReceiverPatchToSource);

const getAndroidSourceCandidates = (projectRoot, fileName) => [
  path.join(projectRoot, 'node_modules', 'react-native-alarm-notification', 'android', 'src', 'main', 'java', 'com', 'emekalites', 'react', 'alarm', 'notification', fileName),
  path.join(projectRoot, '..', '..', 'node_modules', 'react-native-alarm-notification', 'android', 'src', 'main', 'java', 'com', 'emekalites', 'react', 'alarm', 'notification', fileName),
];

const logPatchedCandidate = (label, candidate) => {
  // eslint-disable-next-line no-console
  console.log(`[${label}] patched ${candidate}`);
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

function withAlarmNotificationGradlePatch(config) {
  const withManifestEntries = withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults;
    const application = manifest.manifest.application?.[0];
    if (!application) {
      return cfg;
    }

    ensurePermission(manifest, 'android.permission.RECEIVE_BOOT_COMPLETED');

    ensureReceiver(
      application,
      'com.emekalites.react.alarm.notification.AlarmReceiver',
      {
        'android:enabled': 'true',
        'android:exported': 'true',
      },
      ['ACTION_DISMISS', 'ACTION_SNOOZE']
    );

    ensureReceiver(
      application,
      'com.emekalites.react.alarm.notification.AlarmDismissReceiver',
      {
        'android:enabled': 'true',
        'android:exported': 'true',
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

    return cfg;
  });

  return withDangerousMod(withManifestEntries, [
    'android',
    async (cfg) => {
      const projectRoot = cfg.modRequest.projectRoot;
      const gradleCandidates = [
        path.join(projectRoot, 'node_modules', 'react-native-alarm-notification', 'android', 'build.gradle'),
        path.join(projectRoot, '..', '..', 'node_modules', 'react-native-alarm-notification', 'android', 'build.gradle'),
      ];
      const alarmUtilCandidates = getAndroidSourceCandidates(projectRoot, 'AlarmUtil.java');
      const alarmAudioCandidates = getAndroidSourceCandidates(projectRoot, 'AudioInterface.java');
      const dismissReceiverCandidates = getAndroidSourceCandidates(projectRoot, 'AlarmDismissReceiver.java');
      const alarmReceiverCandidates = getAndroidSourceCandidates(projectRoot, 'AlarmReceiver.java');

      for (const candidate of gradleCandidates) {
        if (applyGradleCompatPatch(candidate)) {
          logPatchedCandidate('alarm-gradle-patch', candidate);
          break;
        }
      }

      for (const candidate of alarmUtilCandidates) {
        if (applyAlarmPendingIntentPatch(candidate)) {
          logPatchedCandidate('alarm-pending-intent-patch', candidate);
        }
        if (applyAlarmReminderBehaviorPatch(candidate)) {
          logPatchedCandidate('alarm-reminder-behavior-patch', candidate);
        }
      }

      for (const candidate of alarmAudioCandidates) {
        if (applyAlarmAudioInterfacePatch(candidate)) {
          logPatchedCandidate('alarm-audio-interface-patch', candidate);
        }
      }

      for (const candidate of dismissReceiverCandidates) {
        if (applyAlarmDismissReceiverPatch(candidate)) {
          logPatchedCandidate('alarm-dismiss-receiver-patch', candidate);
          break;
        }
      }

      for (const candidate of alarmReceiverCandidates) {
        if (applyAlarmReceiverPatch(candidate)) {
          logPatchedCandidate('alarm-receiver-patch', candidate);
          break;
        }
      }
      return cfg;
    },
  ]);
}

module.exports = withAlarmNotificationGradlePatch;
module.exports.__testables = {
  applyGradleCompatPatchToSource,
  applyAlarmPendingIntentPatchToSource,
  applyAlarmReminderBehaviorPatchToSource,
  applyAlarmAudioInterfacePatchToSource,
  applyAlarmDismissReceiverPatchToSource,
  applyAlarmReceiverPatchToSource,
};
