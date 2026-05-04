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

const applyAlarmDuplicateToastPatchToSource = (original) => original.replace(
  `        if (contain) {
            Toast.makeText(mContext, "You have already set this Alarm", Toast.LENGTH_SHORT).show();
        }

`,
  `        // Duplicate alarms are reported to JS via promise rejection. Mindwtr retries silently.
`
);

const applyAlarmDuplicateToastPatch = (filePath) => patchFile(filePath, applyAlarmDuplicateToastPatchToSource);

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

const applyAlarmCompleteConstantsPatchToSource = (original) => {
  if (original.includes('NOTIFICATION_ACTION_COMPLETE')) return original;
  return original.replace(
    '    static final String NOTIFICATION_ACTION_SNOOZE = "ACTION_SNOOZE";',
    '    static final String NOTIFICATION_ACTION_SNOOZE = "ACTION_SNOOZE";\n    static final String NOTIFICATION_ACTION_COMPLETE = "ACTION_COMPLETE";'
  );
};

const applyAlarmCompleteConstantsPatch = (filePath) => patchFile(filePath, applyAlarmCompleteConstantsPatchToSource);

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

const applyAlarmCompleteUtilPatch = (filePath) => patchFile(filePath, applyAlarmCompleteUtilPatchToSource);

const applyAlarmCompleteReceiverPatchToSource = (original) => {
  let next = original;

  if (!next.includes('import android.os.Bundle;')) {
    next = next.replace('import android.content.Intent;\n', 'import android.content.Intent;\nimport android.os.Bundle;\n');
  }

  if (next.includes('case Constants.NOTIFICATION_ACTION_COMPLETE')) return next;

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

const applyAlarmCompleteReceiverPatch = (filePath) => patchFile(filePath, applyAlarmCompleteReceiverPatchToSource);

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

  next = next.replace(
    /@"has_button": \[contentInfo\.userInfo objectForKey:@"has_button"\],\n                @"schedule_type":/g,
    '@"has_button": [contentInfo.userInfo objectForKey:@"has_button"],\n                @"has_complete_action": [contentInfo.userInfo objectForKey:@"has_complete_action"],\n                @"schedule_type":'
  );

  next = next.replace(
    /@"has_button": details\[@"has_button"\],\n                @"schedule_type":/g,
    '@"has_button": details[@"has_button"],\n                @"has_complete_action": details[@"has_complete_action"],\n                @"schedule_type":'
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

const applyAlarmIosCompleteActionPatch = (filePath) => patchFile(filePath, applyAlarmIosCompleteActionPatchToSource);

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

  const withAndroidPatches = withDangerousMod(withManifestEntries, [
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
      const alarmConstantsCandidates = getAndroidSourceCandidates(projectRoot, 'Constants.java');

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
        if (applyAlarmDuplicateToastPatch(candidate)) {
          logPatchedCandidate('alarm-duplicate-toast-patch', candidate);
        }
        if (applyAlarmReminderBehaviorPatch(candidate)) {
          logPatchedCandidate('alarm-reminder-behavior-patch', candidate);
        }
        if (applyAlarmCompleteUtilPatch(candidate)) {
          logPatchedCandidate('alarm-complete-action-util-patch', candidate);
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
        }
        if (applyAlarmCompleteReceiverPatch(candidate)) {
          logPatchedCandidate('alarm-complete-action-receiver-patch', candidate);
        }
      }

      for (const candidate of alarmConstantsCandidates) {
        if (applyAlarmCompleteConstantsPatch(candidate)) {
          logPatchedCandidate('alarm-complete-action-constants-patch', candidate);
          break;
        }
      }
      return cfg;
    },
  ]);

  return withDangerousMod(withAndroidPatches, [
    'ios',
    async (cfg) => {
      const projectRoot = cfg.modRequest.projectRoot;
      for (const candidate of getIosSourceCandidates(projectRoot)) {
        if (applyAlarmIosCompleteActionPatch(candidate)) {
          logPatchedCandidate('alarm-ios-complete-action-patch', candidate);
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
  applyAlarmDuplicateToastPatchToSource,
  applyAlarmReminderBehaviorPatchToSource,
  applyAlarmAudioInterfacePatchToSource,
  applyAlarmDismissReceiverPatchToSource,
  applyAlarmReceiverPatchToSource,
  applyAlarmCompleteConstantsPatchToSource,
  applyAlarmCompleteUtilPatchToSource,
  applyAlarmCompleteReceiverPatchToSource,
  applyAlarmIosCompleteActionPatchToSource,
};
