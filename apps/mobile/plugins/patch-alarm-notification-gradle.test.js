import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));

const plugin = require('./patch-alarm-notification-gradle');

const { PATCHES, applyPatches, applyAlarmManifestEntries } = plugin.__testables;

const ALARM_RECEIVER = 'com.emekalites.react.alarm.notification.AlarmReceiver';
const ALARM_DISMISS_RECEIVER = 'com.emekalites.react.alarm.notification.AlarmDismissReceiver';
const ALARM_BOOT_RECEIVER = 'com.emekalites.react.alarm.notification.AlarmBootReceiver';

// Every pure transform used to be its own named export in `__testables`; now
// each one lives on its PATCHES entry instead. Pulling them out by id keeps
// every test below unchanged — only the import mechanism moved.
const transformFor = (id) => {
  const patch = PATCHES.find((entry) => entry.id === id);
  if (!patch) throw new Error(`No PATCHES entry with id "${id}"`);
  return patch.transform;
};

const applyGradleCompatPatchToSource = transformFor('gradle-compat');
const applyAlarmPendingIntentPatchToSource = transformFor('alarm-pending-intent');
const applyAlarmDuplicateToastPatchToSource = transformFor('alarm-duplicate-toast');
const applyAlarmTimingPatchToSource = transformFor('alarm-timing');
// Same function as 'alarm-exact-repeat-receiver' — see PATCHES for why the
// one transform gets two registry entries (one per file it patches).
const applyAlarmExactRepeatPatchToSource = transformFor('alarm-exact-repeat-util');
const applyAlarmReminderBehaviorPatchToSource = transformFor('alarm-reminder-behavior');
const applyAlarmLockScreenPrivacyPatchToSource = transformFor('alarm-lock-screen-privacy');
const applyAlarmAudioInterfacePatchToSource = transformFor('alarm-audio-interface');
const applyAlarmDismissReceiverPatchToSource = transformFor('alarm-dismiss-receiver');
const applyAlarmReceiverPatchToSource = transformFor('alarm-receiver-dismiss-guard');
const applyAlarmCompleteConstantsPatchToSource = transformFor('alarm-complete-action-constants');
const applyAlarmTaskOpenIntentPatchToSource = transformFor('alarm-task-open-intent');
const applyAlarmCompleteUtilPatchToSource = transformFor('alarm-complete-action-util');
const applyAlarmCompleteReceiverPatchToSource = transformFor('alarm-complete-action-receiver');
const applyAlarmDeadRowUtilPatchToSource = transformFor('alarm-dead-row-util');
const applyAlarmActionDeadRowPatchToSource = transformFor('alarm-dead-row-actions');
const applyAlarmExactPermissionModulePatchToSource = transformFor('alarm-exact-permission-module');
const applyAlarmDeliveredNotificationModulePatchToSource = transformFor('alarm-delivered-notification-module');
const applyAlarmIosCompleteActionPatchToSource = transformFor('alarm-ios-complete-action');
const applyAlarmIosColdStartHeaderPatchToSource = transformFor('alarm-ios-cold-start-header');
const applyAlarmIosUniqueIdentifierPatchToSource = transformFor('alarm-ios-unique-identifier');
const applyAlarmIosDeletePendingPatchToSource = transformFor('alarm-ios-delete-pending-arg');
const applyAlarmIosPendingKindPatchToSource = transformFor('alarm-ios-pending-kind');
const applyAlarmIosReminderThreadPatchToSource = transformFor('alarm-ios-reminder-thread');
const applyAlarmIosCompleteCancelsTaskPatchToSource = transformFor('alarm-ios-complete-cancels-task');
const applyAlarmReminderSlotPatchToSource = transformFor('alarm-reminder-slot');
const applyAlarmReminderActionsUtilPatchToSource = transformFor('alarm-reminder-actions-util');
const applyAlarmReminderActionsReceiverPatchToSource = transformFor('alarm-reminder-actions-receiver');

const installedAlarmPackage = path.join(testDirectory, '..', '..', '..', 'node_modules', 'react-native-alarm-notification');

// The installed package with the whole registry applied, as the prebuild leaves it.
const patchInstalledPackage = () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alarm-patch-chain-'));
  const projectRoot = path.join(tmpRoot, 'apps', 'mobile');
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, 'node_modules'), { recursive: true });
  fs.cpSync(installedAlarmPackage, path.join(tmpRoot, 'node_modules', 'react-native-alarm-notification'), { recursive: true });
  applyPatches(projectRoot, PATCHES);
  const read = (...segments) => fs.readFileSync(path.join(tmpRoot, 'node_modules', 'react-native-alarm-notification', ...segments), 'utf8');
  return { tmpRoot, read };
};

it('guards a stale one-shot before native delivery and consumes a fired row', () => {
  const util = transformFor('alarm-stale-once-util')(`class AlarmUtil {
    void setAlarm(AlarmModel alarm) {
        Calendar calendar = getCalendarFromAlarm(alarm);
    }
    Calendar getCalendarFromAlarm(AlarmModel alarm) { return null; }
    AlarmDatabase getAlarmDB() { return null; }
    void snoozeAlarm(AlarmModel alarm) {
        int snoozedAlarmRowId = getAlarmDB().insert(alarm);
    }
}`);
  const receiver = transformFor('alarm-stale-once-receiver')(`class AlarmReceiver {
    void onReceive() {
                        alarm = alarmDB.getAlarm(id);

                        alarmUtil.sendNotification(alarm);

                        if ("repeat".equals(alarm.getScheduleType())) {
                            alarmUtil.rescheduleRepeatingAlarm(alarm);
                        }
    }
}`);
  expect(util).toContain('boolean discardStaleOneShot(AlarmModel alarm)');
  expect(util).toContain('getAlarmDB().delete(alarm.getId());');
  expect(util).toContain('if (discardStaleOneShot(alarm)) return;');
  expect(util).toContain('alarm.setActive(1);\n        int snoozedAlarmRowId = getAlarmDB().insert(alarm);');
  expect(receiver.indexOf('alarmUtil.discardStaleOneShot(alarm)')).toBeLessThan(receiver.indexOf('alarmUtil.sendNotification(alarm)'));
  expect(receiver).toContain('alarm.setActive(0);');
  expect(receiver).toContain('alarmDB.update(alarm);');
});

it('runs the patched Java guard across old, recent, future, repeated and invalid alarms', () => {
  const transformed = transformFor('alarm-stale-once-util')(`class AlarmUtil {
    void setAlarm(AlarmModel alarm) {
        Calendar calendar = getCalendarFromAlarm(alarm);
    }
    void snoozeAlarm(AlarmModel alarm) {
        int snoozedAlarmRowId = getAlarmDB().insert(alarm);
    }
}`);
  const guard = transformed.slice(
    transformed.indexOf('    boolean discardStaleOneShot(AlarmModel alarm) {'),
    transformed.indexOf('    void setAlarm(AlarmModel alarm) {')
  );
  const installedUtil = fs.readFileSync(path.join(
    testDirectory, '..', '..', '..', 'node_modules', 'react-native-alarm-notification',
    'android', 'src', 'main', 'java', 'com', 'emekalites', 'react', 'alarm', 'notification', 'AlarmUtil.java'
  ), 'utf8');
  const calendarMethod = installedUtil.slice(
    installedUtil.indexOf('    Calendar getCalendarFromAlarm(AlarmModel alarm) {'),
    installedUtil.indexOf('    void setAlarmFromCalendar(AlarmModel alarm, Calendar calendar) {')
  );
  const java = `import java.util.*;
class AlarmModel {
  final int id; final String scheduleType;
  int year, month, day, hour, minute, second;
  AlarmModel(int id, String scheduleType, Calendar at) {
    this.id=id; this.scheduleType=scheduleType;
    year=at.get(Calendar.YEAR); month=at.get(Calendar.MONTH)+1; day=at.get(Calendar.DAY_OF_MONTH);
    hour=at.get(Calendar.HOUR_OF_DAY); minute=at.get(Calendar.MINUTE); second=at.get(Calendar.SECOND);
  }
  int getId() { return id; }
  String getScheduleType() { return scheduleType; }
  int getYear() { return year; } int getMonth() { return month; } int getDay() { return day; }
  int getHour() { return hour; } int getMinute() { return minute; } int getSecond() { return second; }
}
class AlarmDatabase { int deleted=0; void delete(int id) { deleted=id; } }
public class GuardCheck {
  final AlarmDatabase db = new AlarmDatabase();
  AlarmDatabase getAlarmDB() { return db; }
${calendarMethod}
${guard}
  static Calendar hoursFromNow(int hours) { Calendar c=Calendar.getInstance(); c.add(Calendar.HOUR_OF_DAY,hours); return c; }
  static Calendar millisFromNow(long delta) { Calendar c=Calendar.getInstance(); c.setTimeInMillis(c.getTimeInMillis()+delta); return c; }
  static void check(boolean ok) { if (!ok) throw new AssertionError(); }
  public static void main(String[] args) {
    GuardCheck g=new GuardCheck();
    check(g.discardStaleOneShot(new AlarmModel(1,"once",hoursFromNow(-25))) && g.db.deleted==1);
    g.db.deleted=0;
    check(!g.discardStaleOneShot(new AlarmModel(2,"once",hoursFromNow(-23))) && g.db.deleted==0);
    check(!g.discardStaleOneShot(new AlarmModel(6,"once",millisFromNow(-86400000L+5000L))) && g.db.deleted==0);
    check(g.discardStaleOneShot(new AlarmModel(7,"once",millisFromNow(-86400000L-5000L))) && g.db.deleted==7);
    g.db.deleted=0;
    check(!g.discardStaleOneShot(new AlarmModel(3,"once",hoursFromNow(1))) && g.db.deleted==0);
    check(!g.discardStaleOneShot(new AlarmModel(4,"repeat",hoursFromNow(-25))) && g.db.deleted==0);
    AlarmModel invalid=new AlarmModel(5,"once",hoursFromNow(0)); invalid.month=13;
    check(g.discardStaleOneShot(invalid) && g.db.deleted==5);
  }
}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alarm-java-guard-'));
  try {
    fs.writeFileSync(path.join(dir, 'GuardCheck.java'), java);
    const compile = spawnSync('javac', ['GuardCheck.java'], { cwd: dir, encoding: 'utf8' });
    expect(compile.status, compile.stderr).toBe(0);
    const run = spawnSync('java', ['GuardCheck'], { cwd: dir, encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('patch-alarm-notification-gradle', () => {
  it('exposes only a type-checked pending notification kind on iOS and converges', () => {
    const input = `static NSDictionary *RCTFormatUNNotificationRequest(UNNotificationRequest *request)
{
    NSMutableDictionary *formattedNotification = [NSMutableDictionary dictionary];
    UNNotificationContent *content = request.content;
    formattedNotification[@"id"] = request.identifier;
    return formattedNotification;
}`;
    const output = applyAlarmIosPendingKindPatchToSource(input);
    expect(output).toContain('[pendingData isKindOfClass:[NSDictionary class]]');
    expect(output).toContain('[pendingKind isKindOfClass:[NSString class]]');
    expect(output).toContain('formattedNotification[@"data"] = @{ @"kind": pendingKind };');
    expect(output).not.toContain('formattedNotification[@"data"] = pendingData');
    expect(applyAlarmIosPendingKindPatchToSource(output)).toBe(output);
  });

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

  it('removes the native duplicate alarm toast so JS retries stay silent', () => {
    const input = `    boolean checkAlarm(ArrayList<AlarmModel> alarms, AlarmModel alarm) {
        boolean contain = false;

        if (contain) {
            Toast.makeText(mContext, "You have already set this Alarm", Toast.LENGTH_SHORT).show();
        }

        return contain;
    }`;

    const output = applyAlarmDuplicateToastPatchToSource(input);

    expect(output).not.toContain('Toast.makeText');
    expect(output).toContain('Duplicate alarms are reported to JS via promise rejection');
    expect(output).toContain('return contain;');
  });

  it('patches Android task reminder timing for exact delivery and sane snooze', () => {
    const input = `class AlarmUtil {
    private AlarmManager getAlarmManager() {
        return (AlarmManager) mContext.getSystemService(Context.ALARM_SERVICE);
    }

    void setAlarm(Alarm alarm, AlarmManager alarmManager, Calendar calendar, PendingIntent alarmIntent) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            alarmManager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, calendar.getTimeInMillis(), alarmIntent);
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
            alarmManager.setExact(AlarmManager.RTC_WAKEUP, calendar.getTimeInMillis(), alarmIntent);
        } else {
            alarmManager.set(AlarmManager.RTC_WAKEUP, calendar.getTimeInMillis(), alarmIntent);
        }
    }

    void snoozeAlarm(AlarmModel alarm) {
        Calendar calendar = getCalendarFromAlarm(alarm);

        this.stopAlarmSound();

        calendar.add(Calendar.MINUTE, alarm.getSnoozeInterval());

        setAlarmFromCalendar(alarm, calendar);

        long time = System.currentTimeMillis() / 1000;

        alarm.setAlarmId((int) time);

        getAlarmDB().update(alarm);

        Log.e(TAG, "snooze data - " + alarm.toString());
    }
}`;

    const output = applyAlarmTimingPatchToSource(input);

    expect(output).toContain('private void setExactOrAllowWhileIdle');
    expect(output).toContain('alarmManager.canScheduleExactAlarms()');
    expect(output).toContain('alarmManager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAtMillis, alarmIntent);');
    expect(output).toContain('alarmManager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, triggerAtMillis, alarmIntent);');
    expect(output).toContain('setExactOrAllowWhileIdle(alarmManager, calendar.getTimeInMillis(), alarmIntent);');
    expect(output).not.toContain('alarmManager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, calendar.getTimeInMillis(), alarmIntent);');
    expect(output).toContain('Calendar calendar = Calendar.getInstance();');
    expect(output).not.toContain('Calendar calendar = getCalendarFromAlarm(alarm);');
    expect(output).toContain('int firedNotificationId = alarm.getAlarmId();');
    expect(output).toContain('getNotificationManager().cancel(firedNotificationId);');
    expect(output.indexOf('int firedNotificationId = alarm.getAlarmId();')).toBeLessThan(output.indexOf('alarm.setAlarmId((int) time);'));
    // Snooze schedules an independent alarm row so the JS reschedule cycle cannot reap it.
    expect(output).toContain('int snoozedAlarmRowId = getAlarmDB().insert(alarm);');
    expect(output).toContain('alarm.setId(snoozedAlarmRowId);');
    expect(output).not.toContain('getAlarmDB().update(alarm);');
    expect(output.indexOf('getNotificationManager().cancel(firedNotificationId);')).toBeGreaterThan(output.indexOf('int snoozedAlarmRowId = getAlarmDB().insert(alarm);'));
  });

  it('schedules repeating alarms as exact one-shots and advances stale boot times by wall clock', () => {
    const input = `class AlarmUtil {
    private void setExactOrAllowWhileIdle(AlarmManager alarmManager, long triggerAtMillis, PendingIntent alarmIntent) {
    }

    void setAlarm(AlarmModel alarm) {
        Calendar calendar = getCalendarFromAlarm(alarm);
        int alarmId = alarm.getAlarmId();
        Intent intent = new Intent(mContext, AlarmReceiver.class);
        intent.putExtra("PendingId", alarm.getId());
        PendingIntent alarmIntent = PendingIntent.getBroadcast(mContext, alarmId, intent, getImmutableFlag());
        AlarmManager alarmManager = this.getAlarmManager();
        String scheduleType = alarm.getScheduleType();

        if (scheduleType.equals("once")) {
            setExactOrAllowWhileIdle(alarmManager, calendar.getTimeInMillis(), alarmIntent);
        } else if (scheduleType.equals("repeat")) {
            long interval = this.getInterval(alarm.getInterval(), alarm.getIntervalValue());

            alarmManager.setRepeating(AlarmManager.RTC_WAKEUP, calendar.getTimeInMillis(), interval, alarmIntent);
        }
    }

    void snoozeAlarm(AlarmModel alarm) {
        Calendar calendar = Calendar.getInstance();
        PendingIntent alarmIntent = null;
        AlarmManager alarmManager = this.getAlarmManager();
        String scheduleType = alarm.getScheduleType();

        if (scheduleType.equals("once")) {
            setExactOrAllowWhileIdle(alarmManager, calendar.getTimeInMillis(), alarmIntent);
        } else if (scheduleType.equals("repeat")) {
            long interval = this.getInterval(alarm.getInterval(), alarm.getIntervalValue());

            alarmManager.setRepeating(AlarmManager.RTC_WAKEUP, calendar.getTimeInMillis(), interval, alarmIntent);
        }
    }

    long getInterval(String interval, int value) {
        return 0;
    }
}

class AlarmBootReceiver {
    void onReceive(ArrayList<AlarmModel> alarms, AlarmUtil alarmUtil) {
        for (AlarmModel alarm : alarms) {
            alarmUtil.setAlarm(alarm);
        }
    }
}`;

    const output = applyAlarmExactRepeatPatchToSource(input);

    expect(output).not.toContain('alarmManager.setRepeating(');
    expect(output.match(/setExactOrAllowWhileIdle\(alarmManager, calendar\.getTimeInMillis\(\), alarmIntent\);/g)).toHaveLength(4);
    expect(output).toContain('boolean advanced = advanceRepeatingAlarmToFuture(alarm, calendar);');
    expect(output).toContain('setAlarmFromCalendar(alarm, calendar);');
    expect(output).toContain('getAlarmDB().update(alarm);');
    expect(output).toContain('occurrence.add(Calendar.MINUTE, (int) totalAmount);');
    expect(output).toContain('occurrence.add(Calendar.HOUR_OF_DAY, (int) totalAmount);');
    expect(output).toContain('occurrence.add(Calendar.DAY_OF_YEAR, occurrenceCount);');
    expect(output).toContain('occurrence.add(Calendar.WEEK_OF_YEAR, occurrenceCount);');
    expect(output).toContain('searchSteps < MAX_REPEAT_SEARCH_STEPS');
    expect(output).toContain('MAX_REPEAT_SEARCH_STEPS = 64');
    expect(output).toContain('alarmUtil.setAlarm(alarm);');
    expect(output).toContain('void rescheduleRepeatingAlarm(AlarmModel alarm)');
    const rescheduleSource = output.slice(
      output.indexOf('void rescheduleRepeatingAlarm(AlarmModel alarm)'),
      output.indexOf('void setAlarm(AlarmModel alarm)')
    );
    expect(rescheduleSource).toContain('getAlarmDB().update(alarm);');
    expect(rescheduleSource).toContain('setAlarm(alarm);');
    expect(rescheduleSource).not.toContain('getAlarmDB().insert(alarm)');
    expect(rescheduleSource).not.toContain('alarm.setAlarmId(');
    expect(rescheduleSource).not.toContain('alarm.setId(');
    expect(output).toContain('int alarmId = alarm.getAlarmId();');
    expect(output).toContain('intent.putExtra("PendingId", alarm.getId());');
    expect(output).toContain('PendingIntent.getBroadcast(mContext, alarmId, intent, getImmutableFlag());');
    expect(applyAlarmExactRepeatPatchToSource(output)).toBe(output);
  });

  it('re-arms the next repeating occurrence after the receiver fires', () => {
    const input = `class AlarmReceiver {
    void onReceive(Context context, Intent intent) {
        alarm = alarmDB.getAlarm(id);

        alarmUtil.sendNotification(alarm);

        ArrayList<AlarmModel> alarms = alarmDB.getAlarmList(1);
    }
}`;

    const output = applyAlarmExactRepeatPatchToSource(input);

    expect(output).toContain('if ("repeat".equals(alarm.getScheduleType())) {');
    expect(output).toContain('alarmUtil.rescheduleRepeatingAlarm(alarm);');
    expect(output.indexOf('alarmUtil.rescheduleRepeatingAlarm(alarm);')).toBeGreaterThan(output.indexOf('alarmUtil.sendNotification(alarm);'));
    expect(applyAlarmExactRepeatPatchToSource(output)).toBe(output);
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

  it('marks reminder notifications private so the lock screen can redact them', () => {
    const input = `            NotificationCompat.Builder mBuilder = new NotificationCompat.Builder(mContext, channelID)
                    .setSmallIcon(smallIconResId)
                    .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                    .setCategory(NotificationCompat.CATEGORY_REMINDER);`;

    const output = applyAlarmLockScreenPrivacyPatchToSource(input);

    expect(output).toContain('.setVisibility(NotificationCompat.VISIBILITY_PRIVATE)');
    expect(output).not.toContain('VISIBILITY_PUBLIC');
    expect(applyAlarmLockScreenPrivacyPatchToSource(output)).toBe(output);
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

  it('adds an Android complete notification action from task reminder data', () => {
    const constants = applyAlarmCompleteConstantsPatchToSource(`class Constants {
    static final String NOTIFICATION_ACTION_SNOOZE = "ACTION_SNOOZE";
}`);
    expect(constants).toContain('NOTIFICATION_ACTION_COMPLETE');

    const openIntent = applyAlarmTaskOpenIntentPatchToSource(`import android.media.MediaPlayer;
class AlarmUtil {
    void send(Alarm alarm, Bundle bundle, Intent intent, Context mContext, int notificationID) {
            PendingIntent pendingIntent = PendingIntent.getActivity(mContext, notificationID, intent, getUpdateCurrentImmutableFlags());
    }
}`);
    expect(openIntent).toContain('import android.net.Uri;');
    expect(openIntent).toContain('String taskId = bundle.getString("taskId")');
    expect(openIntent).toContain('intent.setAction(Intent.ACTION_VIEW)');
    expect(openIntent).toContain('Uri.parse("mindwtr:///focus")');
    expect(openIntent).toContain('.appendQueryParameter("taskId", taskId)');
    expect(openIntent).toContain('.appendQueryParameter("taskTab", "view")');

    const util = applyAlarmCompleteUtilPatchToSource(`import static com.emekalites.react.alarm.notification.Constants.NOTIFICATION_ACTION_DISMISS;
import static com.emekalites.react.alarm.notification.Constants.NOTIFICATION_ACTION_SNOOZE;
class AlarmUtil {
    void send(Alarm alarm, Bundle bundle, NotificationCompat.Builder mBuilder, Context mContext, int notificationID) {
            if (alarm.isHasButton()) {
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
    }
}`);
    expect(util).toContain('NOTIFICATION_ACTION_COMPLETE');
    expect(util).toContain('notificationActionComplete');
    expect(util).toContain('"COMPLETE"');

    const receiver = applyAlarmCompleteReceiverPatchToSource(`import android.content.Intent;
class AlarmReceiver {
    void onReceive(Context context, Intent intent) {
                switch (action) {
                    case Constants.NOTIFICATION_ACTION_DISMISS:
                        id = intent.getExtras().getInt("AlarmId");
                }
    }
}`);
    expect(receiver).toContain('case Constants.NOTIFICATION_ACTION_COMPLETE');
    expect(receiver).toContain('payload.putString("actionIdentifier", "complete")');
    expect(receiver).toContain('NotificationOpenPayloadStore.cache(pendingPayload)');
    expect(receiver).toContain('emit("OnNotificationOpened"');
  });

  it('carries the tray notification post id on every action intent so a dead alarm row can still be cleared (#1028)', () => {
    const input = `class AlarmUtil {
    private NotificationManager getNotificationManager() {
        return null;
    }

    void send(Alarm alarm, Bundle bundle, NotificationCompat.Builder mBuilder, Context mContext, int notificationID) {
            if (alarm.isHasButton()) {
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
    }

    void removeAllFiredNotifications() {
        getNotificationManager().cancelAll();
    }
}`;

    const output = applyAlarmDeadRowUtilPatchToSource(input);

    // Every action intent gets the notification's real post id, not just the
    // DB row id it already carried — removeFiredNotification(id) resolves
    // the row id back to the post id via a DB lookup, which fails silently
    // once the row is gone.
    expect(output).toContain('completeIntent.putExtra("NotificationId", notificationID);');
    expect(output).toContain('snoozeIntent.putExtra("NotificationId", notificationID);');
    expect(output).toContain('dismissIntent.putExtra("NotificationId", notificationID);');
    expect(output.indexOf('completeIntent.putExtra("AlarmId"')).toBeLessThan(output.indexOf('completeIntent.putExtra("NotificationId"'));
    expect(output).toContain('void clearNotification(int notificationId)');
    expect(output).toContain('getNotificationManager().cancel(notificationId);');
    // Idempotent: a second pass leaves the patched source untouched.
    expect(applyAlarmDeadRowUtilPatchToSource(output)).toBe(output);
  });

  it('throws naming the missing marker when one action-intent anchor silently drifts', () => {
    // Same fixture as above, except the completeIntent anchor picked up a
    // trailing comment (as if upstream reformatted just that one line). The
    // other two intents and the clearNotification helper still patch fine,
    // so a bare "did anything change" check would pass this through with the
    // dead-row fix silently missing from the COMPLETE action — the one that
    // matters most, since it's the one that delivers the task payload.
    const input = `class AlarmUtil {
    private NotificationManager getNotificationManager() {
        return null;
    }

    void send(Alarm alarm, Bundle bundle, NotificationCompat.Builder mBuilder, Context mContext, int notificationID) {
            if (alarm.isHasButton()) {
                boolean hasCompleteAction = "true".equals(bundle.getString("notificationActionComplete"));
                if (hasCompleteAction) {
                    Intent completeIntent = new Intent(mContext, AlarmReceiver.class);
                    completeIntent.setAction(NOTIFICATION_ACTION_COMPLETE);
                    completeIntent.putExtra("AlarmId", alarm.getId()); // vendor reformat
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
    }

    void removeAllFiredNotifications() {
        getNotificationManager().cancelAll();
    }
}`;

    expect(() => applyAlarmDeadRowUtilPatchToSource(input)).toThrow(
      'alarm-dead-row-util: expected marker not found after transform: completeIntent.putExtra("NotificationId", notificationID);'
    );
  });

  it('hardens all three notification actions against a dead alarm row (#1028)', () => {
    const input = `class AlarmReceiver {
    void onReceive(Context context, Intent intent) {
            String action = intent.getAction();
            if (action != null) {
                switch (action) {
                    case Constants.NOTIFICATION_ACTION_SNOOZE:
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

                    case Constants.NOTIFICATION_ACTION_COMPLETE:
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

                    case Constants.NOTIFICATION_ACTION_DISMISS:
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
                }
            }
    }
}`;

    const output = applyAlarmActionDeadRowPatchToSource(input);

    // (a) every case gets a null-alarm branch that clears the tray notification.
    const snoozeCase = output.slice(output.indexOf('NOTIFICATION_ACTION_SNOOZE'), output.indexOf('NOTIFICATION_ACTION_COMPLETE'));
    const completeCase = output.slice(output.indexOf('NOTIFICATION_ACTION_COMPLETE'), output.indexOf('NOTIFICATION_ACTION_DISMISS'));
    const dismissCase = output.slice(output.indexOf('NOTIFICATION_ACTION_DISMISS'));

    expect(snoozeCase).toContain('if (alarm != null) {');
    expect(snoozeCase).toContain('alarmUtil.clearNotification(intent.getExtras().getInt("NotificationId"));');
    expect(completeCase).toContain('if (alarm != null) {');
    expect(completeCase).toContain('alarmUtil.clearNotification(intent.getExtras().getInt("NotificationId"));');
    expect(dismissCase).toContain('if (alarm != null) {');
    expect(dismissCase).toContain('alarmUtil.clearNotification(intent.getExtras().getInt("NotificationId"));');

    // Every case receipts before doing anything else.
    expect(output).toContain('Log.d(TAG, "ACTION_SNOOZE id=" + id + " alarmFound=" + (alarm != null));');
    expect(output).toContain('Log.d(TAG, "ACTION_COMPLETE id=" + id + " alarmFound=" + (alarm != null));');
    expect(output).toContain('Log.d(TAG, "ACTION_DISMISS id=" + id + " alarmFound=" + (alarm != null));');

    // (b) COMPLETE's dead-row path builds the payload from intent extras,
    // falling back to the intent's own id instead of dereferencing a null alarm.
    expect(completeCase).toContain('payload.putString("id", String.valueOf(alarm != null ? alarm.getId() : id));');
    expect(completeCase).toContain('payload.putAll(intent.getExtras());');
    expect(completeCase).toContain('emit("OnNotificationOpened"');

    // (c) SNOOZE's dead-row path never inserts/updates an alarm row — it
    // degrades to a plain dismiss instead of reconstructing schedule state.
    const snoozeDeadRowBranch = snoozeCase.slice(snoozeCase.indexOf('else if (intent.getExtras()'));
    expect(snoozeDeadRowBranch).not.toContain('getAlarmDB().insert(');
    expect(snoozeDeadRowBranch).not.toContain('getAlarmDB().update(');
    expect(snoozeDeadRowBranch).not.toContain('alarmUtil.snoozeAlarm(');

    // DISMISS still emits with the intent's id, not a dereferenced null alarm.
    expect(dismissCase).toContain('emit("OnNotificationDismissed", "{\\"id\\": \\"" + id + "\\"}");');

    // Idempotent: a second pass leaves the patched source untouched.
    expect(applyAlarmActionDeadRowPatchToSource(output)).toBe(output);
  });

  it('throws naming the missing marker when one case anchor silently drifts', () => {
    // Same fixture as above, except the SNOOZE case's removeFiredNotification
    // line picked up a trailing comment (as if upstream touched just that one
    // case). COMPLETE and DISMISS still patch fine — a build that only
    // re-checks "did the file change" would succeed on the first prebuild and
    // only throw on the *next* one, once the idempotency guard's early-return
    // marker is present but the SNOOZE case never actually got hardened.
    const input = `class AlarmReceiver {
    void onReceive(Context context, Intent intent) {
            String action = intent.getAction();
            if (action != null) {
                switch (action) {
                    case Constants.NOTIFICATION_ACTION_SNOOZE:
                        id = intent.getExtras().getInt("SnoozeAlarmId");

                        try {
                            alarm = alarmDB.getAlarm(id);
                            alarmUtil.snoozeAlarm(alarm);
                            Log.e(TAG, "alarm snoozed: " + alarm.toString());

                            alarmUtil.removeFiredNotification(alarm.getId()); // vendor reformat
                        } catch (Exception e) {
                            alarmUtil.stopAlarmSound();
                            e.printStackTrace();
                        }
                        break;

                    case Constants.NOTIFICATION_ACTION_COMPLETE:
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

                    case Constants.NOTIFICATION_ACTION_DISMISS:
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
                }
            }
    }
}`;

    expect(() => applyAlarmActionDeadRowPatchToSource(input)).toThrow(
      'alarm-dead-row-actions: expected marker not found after transform: Log.d(TAG, "ACTION_SNOOZE id="'
    );
  });

  it('keeps warm notification opens live while caching cold responses for the root owner', () => {
    const input = `#import "RnAlarmNotification.h"

static NSString *const kLocalNotificationReceived = @"LocalNotificationReceived";
static id _sharedInstance = nil;

API_AVAILABLE(ios(10.0))
static NSDictionary *RCTFormatUNNotification(UNNotification *notification) {
    NSMutableDictionary *formattedNotification = [NSMutableDictionary dictionary];
    UNNotificationContent *content = notification.request.content;

    formattedNotification[@"id"] = notification.request.identifier;
    formattedNotification[@"data"] = RCTNullIfNil([content.userInfo objectForKey:@"data"]);

    return formattedNotification;
}

static NSDateComponents *parseDate(NSString *dateString) {
    return nil;
}

static NSString *stringify(NSDictionary *notification) {
    return @"{}";
}

@implementation RnAlarmNotification

RCT_EXPORT_MODULE(RNAlarmNotification);

+ (void)didReceiveNotificationResponse:(UNNotificationResponse *)response
API_AVAILABLE(ios(10.0)) {
    NSLog(@"show notification");
    [[UIApplication sharedApplication] setIdleTimerDisabled:NO];
    if ([response.notification.request.content.categoryIdentifier isEqualToString:@"CUSTOM_ACTIONS"]) {
       if ([response.actionIdentifier isEqualToString:@"SNOOZE_ACTION"]) {
           [RnAlarmNotification snoozeAlarm:response.notification];
       } else if ([response.actionIdentifier isEqualToString:@"DISMISS_ACTION"]) {
           NSLog(@"do dismiss");
           [RnAlarmNotification stopSound];

           NSMutableDictionary *notification = [NSMutableDictionary dictionary];
           notification[@"id"] = response.notification.request.identifier;

           [[NSNotificationCenter defaultCenter] postNotificationName:kLocalNotificationDismissed
                                                               object:self
                                                             userInfo:notification];
       }
    }

    // send notification
    [[NSNotificationCenter defaultCenter] postNotificationName:kLocalNotificationReceived
                                                        object:self
                                                      userInfo:RCTFormatUNNotification(response.notification)];
}

- (void)startObserving {
}

- (void)demo {
            if([details[@"has_button"] isEqualToNumber: [NSNumber numberWithInt: 1]]){
                content.categoryIdentifier = @"CUSTOM_ACTIONS";
            }
            content.userInfo = @{
                @"has_button": details[@"has_button"],
                @"schedule_type": details[@"schedule_type"]
            };
            content.userInfo = @{
                @"has_button": [contentInfo.userInfo objectForKey:@"has_button"],
                @"schedule_type": [contentInfo.userInfo objectForKey:@"schedule_type"]
            };

        UNNotificationAction* snoozeAction = [UNNotificationAction
              actionWithIdentifier:@"SNOOZE_ACTION"
              title:@"SNOOZE"
              options:UNNotificationActionOptionNone];

        UNNotificationAction* stopAction = [UNNotificationAction
              actionWithIdentifier:@"DISMISS_ACTION"
              title:@"DISMISS"
              options:UNNotificationActionOptionForeground];

        UNNotificationCategory* customCategory = [UNNotificationCategory
            categoryWithIdentifier:@"CUSTOM_ACTIONS"
            actions:@[snoozeAction, stopAction]
            intentIdentifiers:@[]
            options:UNNotificationCategoryOptionNone];
}

@end`;

    const output = applyAlarmIosCompleteActionPatchToSource(input);

    expect(output).toContain('RCTFormatUNNotificationWithAction');
    expect(output).toContain('consumePendingNotificationOpenPayload');
    expect(output).toContain('actionWithIdentifier:@"COMPLETE_ACTION"');
    expect(output).toContain('cachePendingNotificationOpenPayload(formattedNotification)');
    expect(output).toContain('cacheForColdStart:(BOOL)cacheForColdStart');
    expect(output).toContain('[RnAlarmNotification didReceiveNotificationResponse:response cacheForColdStart:NO]');
    expect(output).toContain('if (cacheForColdStart || [mindwtrActionIdentifier isEqualToString:@"complete"])');
    const warmEntry = output.slice(
      output.indexOf('+ (void)didReceiveNotificationResponse:(UNNotificationResponse *)response'),
      output.indexOf('+ (void)didReceiveNotificationResponse:(UNNotificationResponse *)response\n                     cacheForColdStart:'),
    );
    expect(warmEntry).not.toContain('cachePendingNotificationOpenPayload');
    expect(warmEntry.match(/cacheForColdStart:NO/g)).toHaveLength(1);
    const coldCapableOwner = output.slice(
      output.indexOf('+ (void)didReceiveNotificationResponse:(UNNotificationResponse *)response\n                     cacheForColdStart:'),
      output.indexOf('- (void)startObserving'),
    );
    expect(coldCapableOwner).toContain(
      'if (cacheForColdStart || [mindwtrActionIdentifier isEqualToString:@"complete"])',
    );
    expect(coldCapableOwner.match(/\[RnAlarmNotification snoozeAlarm:/g)).toHaveLength(1);
    expect(coldCapableOwner.match(/removeDeliveredNotificationsWithIdentifiers:/g)).toHaveLength(1);
    // Nil-safe injection: a caller omitting has_complete_action (the pomodoro
    // path) must not raise NSInvalidArgumentException from the userInfo
    // dictionary literal (#888).
    expect(output).toContain('@"has_complete_action": (details[@"has_complete_action"] ?: @NO)');
    expect(output).toContain('@"has_complete_action": ([contentInfo.userInfo objectForKey:@"has_complete_action"] ?: @NO)');
    expect(output).not.toContain('@"has_complete_action": details[@"has_complete_action"],');
  });

  it('declares the cold-start notification response overload in the maintained header', () => {
    const input = `#import <UserNotifications/UserNotifications.h>

@interface RnAlarmNotification : NSObject
+ (void)didReceiveNotificationResponse:(UNNotificationResponse *)response API_AVAILABLE(ios(10.0));
@end`;

    const output = applyAlarmIosColdStartHeaderPatchToSource(input);

    expect(output).toContain('cacheForColdStart:(BOOL)cacheForColdStart');
    expect(applyAlarmIosColdStartHeaderPatchToSource(output)).toBe(output);
  });

  it('makes iOS notification identifiers unique instead of epoch-second shared', () => {
    const input = `#import "RnAlarmNotification.h"

static id _sharedInstance = nil;

@implementation RnAlarmNotification

- (void)snoozeDemo {
            NSString *alarmId = [NSString stringWithFormat: @"%ld", (long) NSDate.date.timeIntervalSince1970];
}

- (void)scheduleDemo {
            NSString *alarmId = [NSString stringWithFormat: @"%ld", (long) NSDate.date.timeIntervalSince1970];
}

- (void)sendDemo {
            NSString *alarmId = [NSString stringWithFormat: @"%ld", (long) NSDate.date.timeIntervalSince1970];
}

@end`;

    const output = applyAlarmIosUniqueIdentifierPatchToSource(input);

    expect(output).toContain('static int64_t mindwtrAlarmIdCounter = 0;');
    expect(output).not.toContain('@"%ld", (long) NSDate.date.timeIntervalSince1970');
    const rewrittenSites = output.match(/mindwtrAlarmIdCounter = \(mindwtrAlarmIdCounter \+ 1\) % 1000;/g) ?? [];
    expect(rewrittenSites).toHaveLength(3);
    expect(output).toContain('((int64_t)(NSDate.date.timeIntervalSince1970 * 1000.0)) * 1000 + mindwtrAlarmIdCounter');
    // Idempotent: a second pass leaves the patched source untouched.
    expect(applyAlarmIosUniqueIdentifierPatchToSource(output)).toBe(output);
  });

  it('takes the iOS cancel ids by value so pending requests are actually removed', () => {
    const input = `RCT_EXPORT_METHOD(deleteAlarm: (NSInteger *)id){
    NSArray *array = [NSArray arrayWithObjects:[NSString stringWithFormat:@"%li", (long)id], nil];
}

RCT_EXPORT_METHOD(deleteRepeatingAlarm: (NSInteger *)id){
    NSArray *array = [NSArray arrayWithObjects:[NSString stringWithFormat:@"%li", (long)id], nil];
}

RCT_EXPORT_METHOD(removeFiredNotification: (NSInteger)id){
}`;

    const output = applyAlarmIosDeletePendingPatchToSource(input);

    expect(output).toContain('RCT_EXPORT_METHOD(deleteAlarm: (NSInteger)id)');
    expect(output).toContain('RCT_EXPORT_METHOD(deleteRepeatingAlarm: (NSInteger)id)');
    expect(output).not.toContain('(NSInteger *)id');
    // The sibling that already took its id by value must be left alone.
    expect(output).toContain('RCT_EXPORT_METHOD(removeFiredNotification: (NSInteger)id)');
    // Idempotent: a second pass leaves the patched source untouched.
    expect(applyAlarmIosDeletePendingPatchToSource(output)).toBe(output);
  });

  it('posts a task\'s reminders into one replaceable slot and routes every cancel path through it', () => {
    if (!fs.existsSync(installedAlarmPackage)) return;
    const { tmpRoot, read } = patchInstalledPackage();
    try {
      const util = read('android', 'src', 'main', 'java', 'com', 'emekalites', 'react', 'alarm', 'notification', 'AlarmUtil.java');
      expect(util).toContain('postReminderNotification(mNotificationManager, alarm.getTag(), notificationID, notification);');
      expect(util).toContain('cancelPostedNotification(firedNotificationId);');
      expect(util).toContain('cancelPostedNotification(alarm.getAlarmId());');
      expect(util).toMatch(/void clearNotification\(int notificationId\) \{\n {8}cancelPostedNotification\(notificationId\);/);
      // Every tray post and cancel goes through the slot helpers; only they touch the manager by id.
      const outsideHelpers = util.replace(util.slice(util.indexOf('    // Mindwtr reminder notification slots'), util.indexOf('    void removeFiredNotification(int id) {')), '');
      expect(outsideHelpers).not.toMatch(/\.notify\(/);
      expect(outsideHelpers).not.toMatch(/getNotificationManager\(\)\.cancel\(/);
      expect(applyAlarmReminderSlotPatchToSource(util)).toBe(util);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it('replaces a task\'s shown reminder and clears its slot only while that reminder is the one shown (compiled)', () => {
    if (!fs.existsSync(installedAlarmPackage)) return;
    const { tmpRoot, read } = patchInstalledPackage();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alarm-java-slot-'));
    try {
      const util = read('android', 'src', 'main', 'java', 'com', 'emekalites', 'react', 'alarm', 'notification', 'AlarmUtil.java');
      const helpersStart = util.indexOf('    // Mindwtr reminder notification slots');
      // The slot helpers alone: the task reminder actions after them need the alarm database.
      const helpersEnd = [util.indexOf('    // Mindwtr task reminder actions'), util.indexOf('    void removeFiredNotification(int id) {')]
        .filter((index) => index > helpersStart)
        .reduce((first, index) => Math.min(first, index));
      const helpers = util.slice(helpersStart, helpersEnd);
      fs.mkdirSync(path.join(dir, 'android', 'content'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'android', 'content', 'SharedPreferences.java'), `package android.content;
public interface SharedPreferences {
  boolean contains(String key); int getInt(String key, int fallback); String getString(String key, String fallback); Editor edit();
  interface Editor { Editor putInt(String key, int value); Editor putString(String key, String value); Editor remove(String key); Editor clear(); boolean commit(); }
}`);
      fs.writeFileSync(path.join(dir, 'AlarmUtil.java'), `import java.util.*;
class Notification {}
class NotificationManager {
  final List<String> log = new ArrayList<>();
  void notify(int id, Notification n) { log.add("notify " + id); }
  void notify(String tag, int id, Notification n) { log.add("notify " + tag + " " + id); }
  void cancel(int id) { log.add("cancel " + id); }
  void cancel(String tag, int id) { log.add("cancel " + tag + " " + id); }
}
class Prefs implements android.content.SharedPreferences {
  final Map<String, Object> values = new HashMap<>();
  public boolean contains(String key) { return values.containsKey(key); }
  public int getInt(String key, int fallback) { Object v = values.get(key); return v == null ? fallback : (Integer) v; }
  public String getString(String key, String fallback) { Object v = values.get(key); return v == null ? fallback : (String) v; }
  public Editor edit() {
    final Map<String, Object> puts = new HashMap<>(); final Set<String> removes = new HashSet<>(); final boolean[] clear = { false };
    return new Editor() {
      public Editor putInt(String k, int v) { puts.put(k, v); removes.remove(k); return this; }
      public Editor putString(String k, String v) { puts.put(k, v); removes.remove(k); return this; }
      public Editor remove(String k) { removes.add(k); puts.remove(k); return this; }
      public Editor clear() { clear[0] = true; return this; }
      public boolean commit() { if (clear[0]) values.clear(); for (String k : removes) values.remove(k); values.putAll(puts); return true; }
    };
  }
}
class Context {
  static final int MODE_PRIVATE = 0;
  final Prefs prefs = new Prefs();
  Prefs getSharedPreferences(String name, int mode) { return prefs; }
}
public class AlarmUtil {
  final Context mContext = new Context();
  final NotificationManager manager = new NotificationManager();
  NotificationManager getNotificationManager() { return manager; }
${helpers}
  void expect(String... entries) {
    if (!manager.log.equals(Arrays.asList(entries))) throw new AssertionError(manager.log + " != " + Arrays.asList(entries));
    manager.log.clear();
  }
  public static void main(String[] args) {
    AlarmUtil u = new AlarmUtil();
    Notification n = new Notification();
    u.postReminderNotification(u.manager, "", 5, n);
    u.expect("notify 5");
    u.postReminderNotification(u.manager, "mindwtr-reminder:task:a", 10, n);
    u.postReminderNotification(u.manager, "mindwtr-reminder:task:a", 11, n);
    u.expect("notify mindwtr-reminder:task:a 1", "notify mindwtr-reminder:task:a 1");
    if (u.mContext.prefs.contains("slot:10")) throw new AssertionError("replaced reminder stays in the ledger");
    u.postReminderNotification(u.manager, "mindwtr-reminder:task:b", 20, n);
    u.expect("notify mindwtr-reminder:task:b 1");
    u.cancelPostedNotification(10);
    u.expect("cancel 10");
    u.cancelPostedNotification(11);
    u.expect("cancel 11", "cancel mindwtr-reminder:task:a 1");
    u.cancelPostedNotification(11);
    u.expect("cancel 11");
    u.cancelPostedNotification(5);
    u.expect("cancel 5");
    u.cancelPostedNotification(20);
    u.expect("cancel 20", "cancel mindwtr-reminder:task:b 1");
    if (!u.mContext.prefs.values.isEmpty()) throw new AssertionError("ledger not empty: " + u.mContext.prefs.values);
  }
}`);
      const compile = spawnSync('javac', ['android/content/SharedPreferences.java', 'AlarmUtil.java'], { cwd: dir, encoding: 'utf8' });
      expect(compile.status, compile.stderr).toBe(0);
      const run = spawnSync('java', ['AlarmUtil'], { cwd: dir, encoding: 'utf8' });
      expect(run.status, run.stderr).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  }, 60_000);

  it('throws naming the anchor when a reminder slot cancel path drifts', () => {
    const source = `    void snoozeAlarm(AlarmModel alarm) {
        getNotificationManager().cancel(firedNotificationId);
    }
    void removeFiredNotification(int id) {
    }
`;
    expect(() => applyAlarmReminderSlotPatchToSource(source)).toThrow(/alarm-reminder-slot: expected anchor not found/);
    expect(applyAlarmReminderSlotPatchToSource('class AlarmUtil {}')).toBe('class AlarmUtil {}');
  });

  it('makes Snooze from the intent\'s alarm and makes Done cancel the task\'s other reminders', () => {
    if (!fs.existsSync(installedAlarmPackage)) return;
    const { tmpRoot, read } = patchInstalledPackage();
    try {
      const javaDir = ['android', 'src', 'main', 'java', 'com', 'emekalites', 'react', 'alarm', 'notification'];
      const util = read(...javaDir, 'AlarmUtil.java');
      const receiver = read(...javaDir, 'AlarmReceiver.java');
      expect(util).toContain('snoozeIntent.putExtra("SnoozeAlarm", new com.google.gson.Gson().toJson(alarm));');
      expect(util).toContain('completeIntent.putExtra("ReminderTag", alarm.getTag() == null ? "" : alarm.getTag());');

      // Snooze: a live row first, then the intent's alarm, and only without either a plain dismiss.
      const snoozeCase = receiver.slice(receiver.indexOf('case Constants.NOTIFICATION_ACTION_SNOOZE:'), receiver.indexOf('case Constants.NOTIFICATION_ACTION_COMPLETE:'));
      const order = ['alarmUtil.snoozeAlarm(alarm);', 'alarmUtil.snoozeAlarm(carried);', 'alarmUtil.clearNotification('].map((call) => snoozeCase.indexOf(call));
      expect(order.every((index) => index >= 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);

      // Every receipt is committed before alarm cancellation and warm/cold delivery.
      const completeCase = receiver.slice(receiver.indexOf('case Constants.NOTIFICATION_ACTION_COMPLETE:'), receiver.indexOf('case Constants.NOTIFICATION_ACTION_DISMISS:'));
      const persistIndex = completeCase.indexOf('NotificationOpenPayloadStore.persistCompletion(context, pendingPayload)');
      expect(persistIndex).toBeGreaterThan(-1);
      for (const operation of ['NotificationOpenPayloadStore.cache(', 'alarmUtil.removeFiredNotification(', 'alarmUtil.cancelAlarm(', 'cancelTaskReminders(', 'emit("OnNotificationOpened"', 'context.startActivity(']) {
        expect(completeCase.indexOf(operation), operation).toBeGreaterThan(persistIndex);
      }
      expect(completeCase).toContain('payload.putString("actionId", completionReceipt);');
      expect(receiver.match(/persistCompletion/g)).toHaveLength(1);

      expect(applyAlarmReminderActionsUtilPatchToSource(util)).toBe(util);
      expect(applyAlarmReminderActionsReceiverPatchToSource(receiver)).toBe(receiver);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it('matches Done to the same task\'s reminders only, never the Pomodoro alert (compiled)', () => {
    if (!fs.existsSync(installedAlarmPackage)) return;
    const { tmpRoot, read } = patchInstalledPackage();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alarm-java-task-'));
    try {
      const util = read('android', 'src', 'main', 'java', 'com', 'emekalites', 'react', 'alarm', 'notification', 'AlarmUtil.java');
      const start = util.indexOf('    static boolean isReminderOfTask(');
      const helper = util.slice(start, util.indexOf('\n    }\n', start) + 7);
      fs.writeFileSync(path.join(dir, 'TaskMatch.java'), `public class TaskMatch {
${helper}
  static void check(boolean ok, String what) { if (!ok) throw new AssertionError(what); }
  public static void main(String[] args) {
    String tag = "mindwtr-reminder:task:a";
    check(isReminderOfTask(tag, null, tag, "a"), "same tag");
    check(!isReminderOfTask("mindwtr-reminder:task:b", "taskId==>b;;kind==>task-reminder;;", tag, "a"), "other task");
    check(isReminderOfTask("", "taskId==>a;;kind==>task-reminder;;alarmKey==>task:a:r3;;", tag, "a"), "untagged repeat of the task");
    check(isReminderOfTask(null, "kind==>task-review;;taskId==>a;;", "", "a"), "review reminder of the task");
    check(!isReminderOfTask("", "kind==>pomodoro;;taskId==>a;;", tag, "a"), "Pomodoro alert");
    check(!isReminderOfTask("", "taskId==>ab;;kind==>task-reminder;;", tag, "a"), "id prefix");
    check(!isReminderOfTask("", null, "", ""), "nothing to match");
    check(!isReminderOfTask("", "taskId==>a;;kind==>task-reminder;;", "", null), "no task id");
  }
}`);
      const compile = spawnSync('javac', ['TaskMatch.java'], { cwd: dir, encoding: 'utf8' });
      expect(compile.status, compile.stderr).toBe(0);
      const run = spawnSync('java', ['TaskMatch'], { cwd: dir, encoding: 'utf8' });
      expect(run.status, run.stderr).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  }, 60_000);

  it('throws naming the anchor when a reminder action anchor drifts', () => {
    const util = `    void removeFiredNotification(int id) {
    }
`;
    expect(() => applyAlarmReminderActionsUtilPatchToSource(util)).toThrow(/alarm-reminder-actions-util: expected anchor not found/);
    const receiver = 'switch (action) { case Constants.NOTIFICATION_ACTION_COMPLETE: break; }';
    expect(() => applyAlarmReminderActionsReceiverPatchToSource(receiver)).toThrow(/alarm-reminder-actions-receiver: expected anchor not found/);
  });

  it('threads a task\'s iOS reminders together and collapses each thread to its newest delivery', () => {
    if (!fs.existsSync(installedAlarmPackage)) return;
    const { tmpRoot, read } = patchInstalledPackage();
    try {
      const module = read('ios', 'RnAlarmNotification.m');
      // scheduleAlarm and sendNotification take the tag; the repeat re-arm and snooze keep it.
      expect(module.match(/content\.threadIdentifier = details\[@"tag"\];/g)).toHaveLength(2);
      expect(module.match(/content\.threadIdentifier = contentInfo\.threadIdentifier;/g)).toHaveLength(2);
      expect(module).toContain('RCT_EXPORT_METHOD(collapseDeliveredReminderNotifications){');
      expect(module).toContain('if (![thread hasPrefix:@"mindwtr-reminder:"]) continue;');
      expect(applyAlarmIosReminderThreadPatchToSource(module)).toBe(module);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it('exposes iOS task reminder cancellation after saving without eager Done cancellation, across prebuilds', () => {
    if (!fs.existsSync(installedAlarmPackage)) return;
    const { tmpRoot, read } = patchInstalledPackage();
    try {
      // patchInstalledPackage ran one pass; a second prebuild runs the registry again on the patched files.
      applyPatches(path.join(tmpRoot, 'apps', 'mobile'), PATCHES);
      const module = read('ios', 'RnAlarmNotification.m');
      const completeBranch = module.slice(module.indexOf('isEqualToString:@"COMPLETE_ACTION"'), module.indexOf('isEqualToString:@"SNOOZE_ACTION"'));
      expect(completeBranch).not.toContain('mindwtrRemoveTaskReminders');
      expect(module.match(/RCT_EXPORT_METHOD\(cancelTaskReminderNotifications:/g)).toHaveLength(1);
      expect(module.match(/static BOOL mindwtrIsReminderOfTask\(/g)).toHaveLength(1);
      expect(module).toContain('[(NSString *)kind hasPrefix:@"task-"]');
      expect(module).toContain('[(NSString *)kind isEqualToString:@"pomodoro"]) return NO;');
      expect(module).toContain('dispatch_group_notify(group, dispatch_get_main_queue(), ^{ resolve(nil); });');
      expect(applyAlarmIosCompleteCancelsTaskPatchToSource(module)).toBe(module);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it('upgrades the earlier iOS eager-cancel patch to saved completion cancellation', () => {
    const input = `// Mindwtr task reminder cancel: old injected helper
static BOOL mindwtrIsReminderOfTask() { return YES; }
static void mindwtrRemoveTaskReminders() {}
static NSString *stringify(NSDictionary *notification) {
}
           mindwtrRemoveTaskReminders(response.notification);
RCT_EXPORT_METHOD(removeAllFiredNotifications){
}`;
    const output = applyAlarmIosCompleteCancelsTaskPatchToSource(input);
    expect(output).not.toContain('mindwtrRemoveTaskReminders');
    expect(output.match(/static BOOL mindwtrIsReminderOfTask\(/g)).toHaveLength(1);
    expect(output.match(/RCT_EXPORT_METHOD\(cancelTaskReminderNotifications:/g)).toHaveLength(1);
    expect(applyAlarmIosCompleteCancelsTaskPatchToSource(output)).toBe(output);
  });

  it('keeps the Gradle compatibility rewrite in place', () => {
    const input = `apply plugin: 'maven'
buildscript {
  dependencies {
    classpath 'com.android.tools.build:gradle:3.4.1'
  }
}

android {
  compileSdkVersion safeExtGet('compileSdkVersion', DEFAULT_COMPILE_SDK_VERSION)
}

dependencies {
    //noinspection GradleDynamicVersion
    implementation 'com.facebook.react:react-native:+'  // From node_modules
    implementation 'com.google.code.gson:gson:2.8.6'
}

afterEvaluate { project ->
  // legacy publishing tasks
}`;

    const output = applyGradleCompatPatchToSource(input);

    expect(output).not.toContain("apply plugin: 'maven'");
    expect(output).toContain("compileSdk safeExtGet('compileSdkVersion', DEFAULT_COMPILE_SDK_VERSION)");
    expect(output).not.toContain('afterEvaluate { project ->');
    expect(output.slice(0, output.indexOf('android {'))).not.toContain('notification-open-intents');
    expect(output).toContain("classpath 'com.android.tools.build:gradle:3.4.1'");
    expect(output).toContain("implementation project(':notification-open-intents')");
    expect(output.indexOf("classpath 'com.android.tools.build:gradle:3.4.1'")).toBeLessThan(output.indexOf("implementation project(':notification-open-intents')"));
    expect(applyGradleCompatPatchToSource(output).match(/notification-open-intents/g)).toHaveLength(2);
  });
});

describe('PATCHES registry completeness', () => {
  // Pinned verbatim from the original per-candidate loops this task replaced
  // (17 (file, transform) call sites from 16 distinct transforms —
  // applyAlarmExactRepeatPatchToSource was called against both AlarmUtil.java
  // and AlarmReceiver.java, hence 17 sites from 16 functions). This list is
  // NOT derived from PATCHES: a test that only iterates PATCHES would shrink
  // in lockstep with a bug that silently drops a registry entry and never
  // catch it. Pinning the old list independently is what makes a dropped
  // entry visible.
  const ORIGINAL_CALL_SITES = [
    ['build.gradle', 'applyGradleCompatPatchToSource'],
    ['AlarmUtil.java', 'applyAlarmPendingIntentPatchToSource'],
    ['AlarmUtil.java', 'applyAlarmTaskOpenIntentPatchToSource'],
    ['AlarmUtil.java', 'applyAlarmDuplicateToastPatchToSource'],
    ['AlarmUtil.java', 'applyAlarmTimingPatchToSource'],
    ['AlarmUtil.java', 'applyAlarmExactRepeatPatchToSource'],
    ['AlarmUtil.java', 'applyAlarmStaleOnceUtilPatchToSource'],
    ['AlarmUtil.java', 'applyAlarmReminderBehaviorPatchToSource'],
    ['AlarmUtil.java', 'applyAlarmLockScreenPrivacyPatchToSource'],
    ['AlarmUtil.java', 'applyAlarmCompleteUtilPatchToSource'],
    ['AudioInterface.java', 'applyAlarmAudioInterfacePatchToSource'],
    ['AlarmDismissReceiver.java', 'applyAlarmDismissReceiverPatchToSource'],
    ['AlarmReceiver.java', 'applyAlarmReceiverPatchToSource'],
    ['AlarmReceiver.java', 'applyAlarmExactRepeatPatchToSource'],
    ['AlarmReceiver.java', 'applyAlarmStaleOnceReceiverPatchToSource'],
    ['AlarmReceiver.java', 'applyAlarmCompleteReceiverPatchToSource'],
    ['Constants.java', 'applyAlarmCompleteConstantsPatchToSource'],
    ['RnAlarmNotification.m', 'applyAlarmIosCompleteActionPatchToSource'],
    ['RnAlarmNotification.h', 'applyAlarmIosColdStartHeaderPatchToSource'],
    ['RnAlarmNotification.m', 'applyAlarmIosUniqueIdentifierPatchToSource'],
    // Added after the collapse (#1020), pinned here for the same reason as the
    // original sites: dropping it silently restores the duplicate-reminder leak.
    ['RnAlarmNotification.m', 'applyAlarmIosDeletePendingPatchToSource'],
    ['RnAlarmNotification.m', 'applyAlarmIosPendingKindPatchToSource'],
    ['RnAlarmNotification.m', 'applyAlarmIosReminderThreadPatchToSource'],
    ['RnAlarmNotification.m', 'applyAlarmIosCompleteCancelsTaskPatchToSource'],
    // Added for #1028: dropping either silently restores the dead-row silent
    // no-op on a notification action tap.
    ['AlarmUtil.java', 'applyAlarmDeadRowUtilPatchToSource'],
    ['AlarmReceiver.java', 'applyAlarmActionDeadRowPatchToSource'],
    // Added for #528: dropping it leaves JS unable to see that "Alarms &
    // reminders" is denied, so the settings screens silently stop offering the
    // fix and every reminder stays inexact.
    ['ANModule.java', 'applyAlarmExactPermissionModulePatchToSource'],
    // Added for the expired-then-withdrawn reminder: dropping it leaves a
    // delivered reminder in the tray after its task is completed.
    ['ANModule.java', 'applyAlarmDeliveredNotificationModulePatchToSource'],
    // Added for repeat reminders: dropping either brings back one notification
    // per occurrence (a 10-minute repeat stacks six an hour) instead of one per task.
    ['AlarmUtil.java', 'applyAlarmReminderSlotPatchToSource'],
    // Added for the reminder buttons: dropping one brings back a Snooze that never
    // reminds again, or a Done after which the task's next repeat still fires.
    ['AlarmUtil.java', 'applyAlarmReminderActionsUtilPatchToSource'],
    ['AlarmReceiver.java', 'applyAlarmReminderActionsReceiverPatchToSource'],
  ];

  it('has exactly one registry entry per original call site — none dropped in the collapse', () => {
    const fakeRoot = '/fake-project-root';
    const actual = PATCHES.map((patch) => {
      const [firstCandidate] = patch.getCandidates(fakeRoot);
      return [path.basename(firstCandidate), patch.transform.name];
    });
    const normalize = (pairs) => pairs.map(([file, name]) => `${file}::${name}`).sort();
    expect(normalize(actual)).toEqual(normalize(ORIGINAL_CALL_SITES));
  });

  it('every entry declares required/firstMatchOnly explicitly', () => {
    expect(PATCHES).toHaveLength(31);
    for (const patch of PATCHES) {
      expect(typeof patch.id).toBe('string');
      expect(typeof patch.required).toBe('boolean');
      expect(typeof patch.firstMatchOnly).toBe('boolean');
      expect(typeof patch.transform).toBe('function');
      expect(typeof patch.getCandidates).toBe('function');
    }
  });
});

describe('applyPatches (registry-driven fixture tree)', () => {
  const androidJavaPath = (projectRoot, fileName) => path.join(
    projectRoot,
    'node_modules',
    'react-native-alarm-notification',
    'android',
    'src',
    'main',
    'java',
    'com',
    'emekalites',
    'react',
    'alarm',
    'notification',
    fileName
  );

  const writeFixture = (filePath, content) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  };

  it("throws naming the patch id when a required patch's anchor no longer matches upstream", () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alarm-patch-fixture-'));
    try {
      writeFixture(
        androidJavaPath(projectRoot, 'AudioInterface.java'),
        `class AudioInterface {
    void init(Context context) {
        uri = Settings.System.SOME_RENAMED_URI_UPSTREAM;
    }
}`
      );

      const audioPatch = PATCHES.find((patch) => patch.id === 'alarm-audio-interface');
      expect(audioPatch.required).toBe(true);
      expect(() => applyPatches(projectRoot, [audioPatch])).toThrow(/alarm-audio-interface/);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('does not throw when a declared-optional patch fails to match (alarm-duplicate-toast)', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alarm-patch-fixture-'));
    try {
      writeFixture(
        androidJavaPath(projectRoot, 'AlarmUtil.java'),
        'class AlarmUtil {\n    // upstream rewrote checkAlarm entirely, no Toast left to remove\n}'
      );

      const toastPatch = PATCHES.find((patch) => patch.id === 'alarm-duplicate-toast');
      expect(toastPatch.required).toBe(false);
      expect(() => applyPatches(projectRoot, [toastPatch])).not.toThrow();
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('running applyPatches twice against the real installed package succeeds both times and converges', () => {
    const realPackageRoot = path.join(testDirectory, '..', '..', '..', 'node_modules', 'react-native-alarm-notification');
    if (!fs.existsSync(realPackageRoot)) {
      // react-native-alarm-notification isn't installed in this environment
      // (e.g. a pruned/production install) — nothing to verify against.
      return;
    }

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alarm-patch-real-'));
    try {
      // Mirror the real monorepo layout (apps/mobile, two levels below the
      // repo root) so the hoisted candidate path resolves the same way it
      // does during the actual prebuild.
      const projectRoot = path.join(tmpRoot, 'apps', 'mobile');
      const hoistedDest = path.join(tmpRoot, 'node_modules', 'react-native-alarm-notification');
      fs.mkdirSync(projectRoot, { recursive: true });
      fs.mkdirSync(path.dirname(hoistedDest), { recursive: true });
      fs.cpSync(realPackageRoot, hoistedDest, { recursive: true });

      const snapshot = () => PATCHES
        .flatMap((patch) => patch.getCandidates(projectRoot))
        .filter((candidate) => fs.existsSync(candidate))
        .sort()
        .map((candidate) => `${candidate}\n${fs.readFileSync(candidate, 'utf8')}`)
        .join('\n---\n');

      expect(() => applyPatches(projectRoot, PATCHES)).not.toThrow();
      const afterFirstRun = snapshot();

      expect(() => applyPatches(projectRoot, PATCHES)).not.toThrow();
      const afterSecondRun = snapshot();

      expect(afterSecondRun).toBe(afterFirstRun);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  }, 30_000);

  // The mechanism behind #1020, stated as an invariant rather than as one
  // method's spelling: under the New Architecture the interop marshals a
  // numeric argument by ObjC encoding, and only a by-value scalar ("q") gets
  // the converted integer. A pointer-typed scalar ("^q") silently receives the
  // raw double bit pattern instead, so the method runs with a garbage id and
  // reports no error. Any exported method that takes an id this way is a
  // silent no-op waiting to happen — assert none survive the patch pass.
  it('leaves no pointer-typed scalar arguments in the patched iOS module', () => {
    const realPackageRoot = path.join(testDirectory, '..', '..', '..', 'node_modules', 'react-native-alarm-notification');
    if (!fs.existsSync(realPackageRoot)) return;

    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alarm-patch-ptr-'));
    try {
      const projectRoot = path.join(tmpRoot, 'apps', 'mobile');
      const hoistedDest = path.join(tmpRoot, 'node_modules', 'react-native-alarm-notification');
      fs.mkdirSync(projectRoot, { recursive: true });
      fs.mkdirSync(path.dirname(hoistedDest), { recursive: true });
      fs.cpSync(realPackageRoot, hoistedDest, { recursive: true });

      applyPatches(projectRoot, PATCHES);

      const iosSource = fs.readFileSync(path.join(hoistedDest, 'ios', 'RnAlarmNotification.m'), 'utf8');
      const pointerScalarArgs = iosSource.match(
        /RCT_EXPORT_METHOD\([^)]*\(\s*(?:NSInteger|NSUInteger|int|long|double|float|BOOL)\s*\*\s*\)/g
      ) ?? [];
      expect(pointerScalarArgs).toEqual([]);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe('alarm manifest entries', () => {
  const receiverNamed = (manifest, name) => (
    manifest.manifest.application[0].receiver.find((entry) => entry?.$?.['android:name'] === name)
  );

  it('keeps the alarm action receivers unexported and the boot receiver exported', () => {
    const manifest = { manifest: { application: [{}] } };

    applyAlarmManifestEntries(manifest);

    expect(receiverNamed(manifest, ALARM_RECEIVER).$['android:exported']).toBe('false');
    expect(receiverNamed(manifest, ALARM_DISMISS_RECEIVER).$['android:exported']).toBe('false');
    // BOOT_COMPLETED is a protected broadcast, so this one has to stay exported
    // or reminders never survive a reboot.
    expect(receiverNamed(manifest, ALARM_BOOT_RECEIVER).$['android:exported']).toBe('true');
  });

  it('flips an already-exported alarm receiver back to unexported', () => {
    const manifest = {
      manifest: {
        application: [
          {
            receiver: [
              { $: { 'android:name': ALARM_RECEIVER, 'android:enabled': 'true', 'android:exported': 'true' } },
              { $: { 'android:name': ALARM_DISMISS_RECEIVER, 'android:enabled': 'true', 'android:exported': 'true' } },
            ],
          },
        ],
      },
    };

    applyAlarmManifestEntries(manifest);

    expect(receiverNamed(manifest, ALARM_RECEIVER).$['android:exported']).toBe('false');
    expect(receiverNamed(manifest, ALARM_DISMISS_RECEIVER).$['android:exported']).toBe('false');
  });

  it('still registers the action filters our own PendingIntents target', () => {
    const manifest = { manifest: { application: [{}] } };

    applyAlarmManifestEntries(manifest);

    const actions = receiverNamed(manifest, ALARM_RECEIVER)['intent-filter'][0].action
      .map((action) => action.$['android:name']);
    expect(actions).toEqual(['ACTION_DISMISS', 'ACTION_SNOOZE', 'ACTION_COMPLETE']);
  });
});

describe('pristine react-native-alarm-notification@1.8.0 fixture (#1028 correction)', () => {
  // Verbatim bytes from `npm pack react-native-alarm-notification@1.8.0`
  // (sha512-4PrFdorpF49Rt...rk2a43ANkZAfg== — matches bun.lock's pinned
  // integrity for the dependency). This is what CI's fresh install produces,
  // as opposed to whatever this machine's node_modules happens to hold —
  // which can be stale-patched from an earlier prebuild and silently differ
  // in whitespace from a truly fresh install (#1028: the COMPLETE case's
  // anchor matched a dev machine's stale copy but not this pristine shape,
  // and CI caught it; this fixture is what would have caught it locally).
  const PRISTINE_ALARM_UTIL_JAVA = "package com.emekalites.react.alarm.notification;\n\nimport android.app.AlarmManager;\nimport android.app.Application;\nimport android.app.Notification;\nimport android.app.NotificationChannel;\nimport android.app.NotificationManager;\nimport android.app.PendingIntent;\nimport android.content.ComponentName;\nimport android.content.Context;\nimport android.content.Intent;\nimport android.content.pm.ApplicationInfo;\nimport android.content.pm.PackageManager;\nimport android.content.res.Resources;\nimport android.graphics.Bitmap;\nimport android.graphics.BitmapFactory;\nimport android.graphics.Color;\nimport android.media.MediaPlayer;\nimport android.os.Build;\nimport android.os.Bundle;\nimport android.os.VibrationEffect;\nimport android.os.Vibrator;\nimport android.util.Log;\nimport android.widget.Toast;\n\nimport androidx.core.app.NotificationCompat;\n\nimport com.facebook.react.bridge.WritableMap;\nimport com.facebook.react.bridge.WritableNativeMap;\n\nimport org.json.JSONException;\nimport org.json.JSONObject;\n\nimport java.util.ArrayList;\nimport java.util.Calendar;\nimport java.util.GregorianCalendar;\nimport java.util.Iterator;\n\nimport static com.emekalites.react.alarm.notification.Constants.ADD_INTENT;\nimport static com.emekalites.react.alarm.notification.Constants.NOTIFICATION_ACTION_DISMISS;\nimport static com.emekalites.react.alarm.notification.Constants.NOTIFICATION_ACTION_SNOOZE;\n\nclass AlarmUtil {\n    private static final String TAG = AlarmUtil.class.getSimpleName();\n\n    private Context mContext;\n    private AudioInterface audioInterface;\n    static final long[] DEFAULT_VIBRATE_PATTERN = {0, 250, 250, 250};\n\n    AlarmUtil(Application context) {\n        mContext = context;\n\n        audioInterface = AudioInterface.getInstance();\n        audioInterface.init(mContext);\n    }\n\n    private Class getMainActivityClass() {\n        String packageName = mContext.getPackageName();\n        Intent launchIntent = mContext.getPackageManager().getLaunchIntentForPackage(packageName);\n        String className = launchIntent.getComponent().getClassName();\n        Log.e(TAG, \"main activity classname: \" + className);\n        try {\n            return Class.forName(className);\n        } catch (ClassNotFoundException e) {\n            e.printStackTrace();\n            return null;\n        }\n    }\n\n    private AlarmManager getAlarmManager() {\n        return (AlarmManager) mContext.getSystemService(Context.ALARM_SERVICE);\n    }\n\n    private AlarmDatabase getAlarmDB() {\n        return new AlarmDatabase(mContext);\n    }\n\n    private NotificationManager getNotificationManager() {\n        return (NotificationManager) mContext.getSystemService(Context.NOTIFICATION_SERVICE);\n    }\n\n    private void playAlarmSound(String name, String names, boolean shouldLoop, double volume) {\n        float number = (float) volume;\n\n        MediaPlayer mediaPlayer = audioInterface.getSingletonMedia(name, names);\n        mediaPlayer.setLooping(shouldLoop);\n        mediaPlayer.setVolume(number, number);\n        mediaPlayer.start();\n\n        mediaPlayer.setOnCompletionListener(new MediaPlayer.OnCompletionListener() {\n            @Override\n            public void onCompletion(MediaPlayer mp) {\n                try {\n                    mp.stop();\n                    mp.reset();\n                    mp.release();\n                    Log.e(TAG, \"release media player\");\n                } catch (Exception e) {\n                    e.printStackTrace();\n                }\n            }\n        });\n    }\n\n    boolean checkAlarm(ArrayList<AlarmModel> alarms, AlarmModel alarm) {\n        boolean contain = false;\n        for (AlarmModel aAlarm : alarms) {\n            if (aAlarm.getHour() == alarm.getHour() && aAlarm.getMinute() == alarm.getMinute() && aAlarm.getDay() == alarm.getDay() && aAlarm.getMonth() == alarm.getMonth() && aAlarm.getYear() == alarm.getYear() && aAlarm.getActive() == 1) {\n                contain = true;\n                break;\n            }\n        }\n\n        if (contain) {\n            Toast.makeText(mContext, \"You have already set this Alarm\", Toast.LENGTH_SHORT).show();\n        }\n\n        return contain;\n    }\n\n    void setBootReceiver() {\n        ArrayList<AlarmModel> alarms = getAlarmDB().getAlarmList(1);\n        if (alarms.size() > 0) {\n            enableBootReceiver(mContext);\n        } else {\n            disableBootReceiver(mContext);\n        }\n    }\n\n    void setAlarm(AlarmModel alarm) {\n        Calendar calendar = getCalendarFromAlarm(alarm);\n\n        Log.e(TAG, alarm.getAlarmId() + \" - \" + calendar.getTime().toString());\n\n        int alarmId = alarm.getAlarmId();\n\n        Intent intent = new Intent(mContext, AlarmReceiver.class);\n        intent.putExtra(\"intentType\", ADD_INTENT);\n        intent.putExtra(\"PendingId\", alarm.getId());\n\n        PendingIntent alarmIntent = PendingIntent.getBroadcast(mContext, alarmId, intent, 0);\n        AlarmManager alarmManager = this.getAlarmManager();\n\n        String scheduleType = alarm.getScheduleType();\n\n        if (scheduleType.equals(\"once\")) {\n            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {\n                alarmManager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, calendar.getTimeInMillis(), alarmIntent);\n            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {\n                alarmManager.setExact(AlarmManager.RTC_WAKEUP, calendar.getTimeInMillis(), alarmIntent);\n            } else {\n                alarmManager.set(AlarmManager.RTC_WAKEUP, calendar.getTimeInMillis(), alarmIntent);\n            }\n        } else if (scheduleType.equals(\"repeat\")) {\n            long interval = this.getInterval(alarm.getInterval(), alarm.getIntervalValue());\n\n            alarmManager.setRepeating(AlarmManager.RTC_WAKEUP, calendar.getTimeInMillis(), interval, alarmIntent);\n        } else {\n            Log.d(TAG, \"Schedule type should either be once or repeat\");\n            return;\n        }\n\n        this.setBootReceiver();\n    }\n\n    void snoozeAlarm(AlarmModel alarm) {\n        Calendar calendar = getCalendarFromAlarm(alarm);\n\n        this.stopAlarmSound();\n\n        // set snooze interval\n        calendar.add(Calendar.MINUTE, alarm.getSnoozeInterval());\n\n        setAlarmFromCalendar(alarm, calendar);\n\n        long time = System.currentTimeMillis() / 1000;\n\n        alarm.setAlarmId((int) time);\n\n        getAlarmDB().update(alarm);\n\n        Log.e(TAG, \"snooze data - \" + alarm.toString());\n\n        int alarmId = alarm.getAlarmId();\n\n        Intent intent = new Intent(mContext, AlarmReceiver.class);\n        intent.putExtra(\"intentType\", ADD_INTENT);\n        intent.putExtra(\"PendingId\", alarm.getId());\n\n        PendingIntent alarmIntent = PendingIntent.getBroadcast(mContext, alarmId, intent, 0);\n        AlarmManager alarmManager = this.getAlarmManager();\n\n        String scheduleType = alarm.getScheduleType();\n\n        if (scheduleType.equals(\"once\")) {\n            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {\n                alarmManager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, calendar.getTimeInMillis(), alarmIntent);\n            } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {\n                alarmManager.setExact(AlarmManager.RTC_WAKEUP, calendar.getTimeInMillis(), alarmIntent);\n            } else {\n                alarmManager.set(AlarmManager.RTC_WAKEUP, calendar.getTimeInMillis(), alarmIntent);\n            }\n        } else if (scheduleType.equals(\"repeat\")) {\n            long interval = this.getInterval(alarm.getInterval(), alarm.getIntervalValue());\n\n            alarmManager.setRepeating(AlarmManager.RTC_WAKEUP, calendar.getTimeInMillis(), interval, alarmIntent);\n        } else {\n            Log.d(TAG, \"Schedule type should either be once or repeat\");\n        }\n    }\n\n    long getInterval(String interval, int value) {\n        long duration = 1;\n\n        switch (interval) {\n            case \"minutely\":\n                duration = value;\n                break;\n            case \"hourly\":\n                duration = 60 * value;\n                break;\n            case \"daily\":\n                duration = 60 * 24;\n                break;\n            case \"weekly\":\n                duration = 60 * 24 * 7;\n                break;\n        }\n\n        return duration * 60 * 1000;\n    }\n\n    void doCancelAlarm(int id) {\n        try {\n            AlarmModel alarm = getAlarmDB().getAlarm(id);\n            this.cancelAlarm(alarm, false);\n        } catch (Exception e) {\n            e.printStackTrace();\n        }\n    }\n\n    void deleteAlarm(int id) {\n        try {\n            AlarmModel alarm = getAlarmDB().getAlarm(id);\n            this.cancelAlarm(alarm, true);\n        } catch (Exception e) {\n            e.printStackTrace();\n        }\n    }\n\n    void deleteRepeatingAlarm(int id) {\n        try {\n            AlarmModel alarm = getAlarmDB().getAlarm(id);\n\n            String scheduleType = alarm.getScheduleType();\n            if (scheduleType.equals(\"repeat\")) {\n                this.stopAlarm(alarm);\n            }\n        } catch (Exception e) {\n            e.printStackTrace();\n        }\n    }\n\n    void cancelAlarm(AlarmModel alarm, boolean delete) {\n        String scheduleType = alarm.getScheduleType();\n        if (scheduleType.equals(\"once\") || delete) {\n            this.stopAlarm(alarm);\n        }\n    }\n\n    void stopAlarm(AlarmModel alarm) {\n        AlarmManager alarmManager = this.getAlarmManager();\n\n        int alarmId = alarm.getAlarmId();\n\n        Intent intent = new Intent(mContext, AlarmReceiver.class);\n        PendingIntent alarmIntent = PendingIntent.getBroadcast(mContext, alarmId, intent, PendingIntent.FLAG_UPDATE_CURRENT);\n        alarmManager.cancel(alarmIntent);\n\n        getAlarmDB().delete(alarm.getId());\n\n        this.stopAlarmSound();\n\n        this.setBootReceiver();\n    }\n\n    Calendar getCalendarFromAlarm(AlarmModel alarm) {\n        Calendar calendar = new GregorianCalendar();\n        calendar.set(Calendar.HOUR_OF_DAY, alarm.getHour());\n        calendar.set(Calendar.MINUTE, alarm.getMinute());\n        calendar.set(Calendar.SECOND, alarm.getSecond());\n        calendar.set(Calendar.DAY_OF_MONTH, alarm.getDay());\n        calendar.set(Calendar.MONTH, alarm.getMonth() - 1);\n        calendar.set(Calendar.YEAR, alarm.getYear());\n        return calendar;\n    }\n\n    void setAlarmFromCalendar(AlarmModel alarm, Calendar calendar) {\n        alarm.setSecond(calendar.get(Calendar.SECOND));\n        alarm.setMinute(calendar.get(Calendar.MINUTE));\n        alarm.setHour(calendar.get(Calendar.HOUR_OF_DAY));\n        alarm.setDay(calendar.get(Calendar.DAY_OF_MONTH));\n        alarm.setMonth(calendar.get(Calendar.MONTH) + 1);\n        alarm.setYear(calendar.get(Calendar.YEAR));\n    }\n\n    private void enableBootReceiver(Context context) {\n        ComponentName receiver = new ComponentName(context, AlarmBootReceiver.class);\n        PackageManager pm = context.getPackageManager();\n\n        int setting = pm.getComponentEnabledSetting(receiver);\n        if (setting == PackageManager.COMPONENT_ENABLED_STATE_DISABLED) {\n            pm.setComponentEnabledSetting(receiver,\n                    PackageManager.COMPONENT_ENABLED_STATE_ENABLED,\n                    PackageManager.DONT_KILL_APP);\n        }\n    }\n\n    private void disableBootReceiver(Context context) {\n        ComponentName receiver = new ComponentName(context, AlarmBootReceiver.class);\n        PackageManager pm = context.getPackageManager();\n\n        pm.setComponentEnabledSetting(receiver,\n                PackageManager.COMPONENT_ENABLED_STATE_DISABLED,\n                PackageManager.DONT_KILL_APP);\n    }\n\n    private PendingIntent createOnDismissedIntent(Context context, int notificationId) {\n        Intent intent = new Intent(context, AlarmDismissReceiver.class);\n        intent.putExtra(Constants.DISMISSED_NOTIFICATION_ID, notificationId);\n        return PendingIntent.getBroadcast(context.getApplicationContext(), notificationId, intent, 0);\n    }\n\n    void sendNotification(AlarmModel alarm) {\n        try {\n            Class intentClass = getMainActivityClass();\n\n            if (intentClass == null) {\n                Log.e(TAG, \"No activity class found for the notification\");\n                return;\n            }\n\n            boolean playSound = alarm.isPlaySound();\n            if (playSound) {\n                this.playAlarmSound(alarm.getSoundName(), alarm.getSoundNames(), alarm.isLoopSound(), alarm.getVolume());\n            }\n\n            NotificationManager mNotificationManager = getNotificationManager();\n            int notificationID = alarm.getAlarmId();\n\n            // title\n            String title = alarm.getTitle();\n            if (title == null || title.equals(\"\")) {\n                ApplicationInfo appInfo = mContext.getApplicationInfo();\n                title = mContext.getPackageManager().getApplicationLabel(appInfo).toString();\n            }\n\n            // message\n            String message = alarm.getMessage();\n            if (message == null || message.equals(\"\")) {\n                Log.d(TAG, \"Cannot send to notification centre because there is no 'message' found\");\n                return;\n            }\n\n            // channel\n            String channelID = alarm.getChannel();\n            if (channelID == null || channelID.equals(\"\")) {\n                Log.d(TAG, \"Cannot send to notification centre because there is no 'channel' found\");\n                return;\n            }\n\n            Resources res = mContext.getResources();\n            String packageName = mContext.getPackageName();\n\n            //icon\n            int smallIconResId;\n            String smallIcon = alarm.getSmallIcon();\n            if (smallIcon != null && !smallIcon.equals(\"\")) {\n                smallIconResId = res.getIdentifier(smallIcon, \"mipmap\", packageName);\n            } else {\n                smallIconResId = res.getIdentifier(\"ic_launcher\", \"mipmap\", packageName);\n            }\n\n            Intent intent = new Intent(mContext, intentClass);\n            intent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);\n\n            Bundle bundle = new Bundle();\n            if (alarm.getData() != null && !alarm.getData().equals(\"\")) {\n                String[] datum = alarm.getData().split(\";;\");\n                for (String item : datum) {\n                    String[] data = item.split(\"==>\");\n                    bundle.putString(data[0], data[1]);\n                }\n\n                intent.putExtras(bundle);\n            }\n\n            PendingIntent pendingIntent = PendingIntent.getActivity(mContext, notificationID, intent, PendingIntent.FLAG_UPDATE_CURRENT);\n\n            NotificationCompat.Builder mBuilder = new NotificationCompat.Builder(mContext, channelID)\n                    .setSmallIcon(smallIconResId)\n                    .setContentTitle(title)\n                    .setContentText(message)\n                    .setTicker(alarm.getTicker())\n                    .setPriority(NotificationCompat.PRIORITY_MAX)\n                    .setAutoCancel(alarm.isAutoCancel())\n                    .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)\n                    .setCategory(NotificationCompat.CATEGORY_ALARM)\n                    .setSound(null)\n                    .setDeleteIntent(createOnDismissedIntent(mContext, alarm.getId()));\n\n            long vibration = (long) alarm.getVibration();\n\n            long[] vibrationPattern = vibration == 0 ? DEFAULT_VIBRATE_PATTERN : new long[]{0, vibration, 1000, vibration};\n\n            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {\n                NotificationChannel mChannel = new NotificationChannel(channelID, \"Alarm Notify\", NotificationManager.IMPORTANCE_HIGH);\n                mChannel.enableLights(true);\n\n                String color = alarm.getColor();\n                if (color != null && !color.equals(\"\")) {\n                    mChannel.setLightColor(Color.parseColor(color));\n                }\n\n                if(!mChannel.canBypassDnd()){\n                    mChannel.setBypassDnd(alarm.isBypassDnd());\n                }\n\n                mChannel.setVibrationPattern(null);\n\n                // play vibration\n                if (alarm.isVibrate()) {\n                    Vibrator vibrator = (Vibrator) mContext.getSystemService(Context.VIBRATOR_SERVICE);\n                    if (vibrator.hasVibrator()) {\n                        vibrator.vibrate(VibrationEffect.createWaveform(vibrationPattern, 0));\n                    }\n                }\n\n                mNotificationManager.createNotificationChannel(mChannel);\n                mBuilder.setChannelId(channelID);\n            } else {\n                // set vibration\n                mBuilder.setVibrate(alarm.isVibrate() ? vibrationPattern : null);\n            }\n\n            //color\n            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {\n                String color = alarm.getColor();\n                if (color != null && !color.equals(\"\")) {\n                    mBuilder.setColor(Color.parseColor(color));\n                }\n            }\n\n            mBuilder.setContentIntent(pendingIntent);\n\n            if (alarm.isHasButton()) {\n                Intent dismissIntent = new Intent(mContext, AlarmReceiver.class);\n                dismissIntent.setAction(NOTIFICATION_ACTION_DISMISS);\n                dismissIntent.putExtra(\"AlarmId\", alarm.getId());\n                PendingIntent pendingDismiss = PendingIntent.getBroadcast(mContext, notificationID, dismissIntent, PendingIntent.FLAG_UPDATE_CURRENT);\n                NotificationCompat.Action dismissAction = new NotificationCompat.Action(android.R.drawable.ic_lock_idle_alarm, \"DISMISS\", pendingDismiss);\n                mBuilder.addAction(dismissAction);\n\n                Intent snoozeIntent = new Intent(mContext, AlarmReceiver.class);\n                snoozeIntent.setAction(NOTIFICATION_ACTION_SNOOZE);\n                snoozeIntent.putExtra(\"SnoozeAlarmId\", alarm.getId());\n                PendingIntent pendingSnooze = PendingIntent.getBroadcast(mContext, notificationID, snoozeIntent, PendingIntent.FLAG_UPDATE_CURRENT);\n                NotificationCompat.Action snoozeAction = new NotificationCompat.Action(R.drawable.ic_snooze, \"SNOOZE\", pendingSnooze);\n                mBuilder.addAction(snoozeAction);\n            }\n\n            //use big text\n            if (alarm.isUseBigText()) {\n                mBuilder = mBuilder.setStyle(new NotificationCompat.BigTextStyle().bigText(message));\n            }\n\n            //large icon\n            String largeIcon = alarm.getLargeIcon();\n            if (largeIcon != null && !largeIcon.equals(\"\") && Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {\n                int largeIconResId = res.getIdentifier(largeIcon, \"mipmap\", packageName);\n                Bitmap largeIconBitmap = BitmapFactory.decodeResource(res, largeIconResId);\n                if (largeIconResId != 0) {\n                    mBuilder.setLargeIcon(largeIconBitmap);\n                }\n            }\n\n            // set tag and push notification\n            Notification notification = mBuilder.build();\n\n            String tag = alarm.getTag();\n            if (tag != null && !tag.equals(\"\")) {\n                mNotificationManager.notify(tag, notificationID, notification);\n            } else {\n                Log.e(TAG, \"notification done\");\n                mNotificationManager.notify(notificationID, notification);\n            }\n        } catch (Exception e) {\n            Log.e(TAG, \"failed to send notification\", e);\n        }\n    }\n\n    void removeFiredNotification(int id) {\n        try {\n            AlarmModel alarm = getAlarmDB().getAlarm(id);\n            getNotificationManager().cancel(alarm.getAlarmId());\n        } catch (Exception e) {\n            e.printStackTrace();\n        }\n    }\n\n    void removeAllFiredNotifications() {\n        getNotificationManager().cancelAll();\n    }\n\n    void stopAlarmSound() {\n        try {\n            Log.e(TAG, \"stop vibration and alarm sound\");\n            Vibrator vibrator = (Vibrator) mContext.getSystemService(Context.VIBRATOR_SERVICE);\n            if (vibrator.hasVibrator()) {\n                vibrator.cancel();\n            }\n            audioInterface.stopPlayer();\n        } catch (Exception e) {\n            e.printStackTrace();\n        }\n    }\n\n    ArrayList<AlarmModel> getAlarms() {\n        return getAlarmDB().getAlarmList(1);\n    }\n\n    WritableMap convertJsonToMap(JSONObject jsonObject) throws JSONException {\n        WritableMap map = new WritableNativeMap();\n\n        Iterator<String> iterator = jsonObject.keys();\n        while (iterator.hasNext()) {\n            String key = iterator.next();\n            Object value = jsonObject.get(key);\n            if (value instanceof JSONObject) {\n                map.putMap(key, convertJsonToMap((JSONObject) value));\n            } else if (value instanceof Boolean) {\n                map.putBoolean(key, (Boolean) value);\n            } else if (value instanceof Integer) {\n                map.putInt(key, (Integer) value);\n            } else if (value instanceof Double) {\n                map.putDouble(key, (Double) value);\n            } else if (value instanceof String) {\n                map.putString(key, (String) value);\n            } else {\n                map.putString(key, value.toString());\n            }\n        }\n        return map;\n    }\n}\n";
  const PRISTINE_ALARM_RECEIVER_JAVA = "package com.emekalites.react.alarm.notification;\n\nimport android.app.Application;\nimport android.content.BroadcastReceiver;\nimport android.content.Context;\nimport android.content.Intent;\nimport android.util.Log;\n\nimport com.facebook.react.modules.core.DeviceEventManagerModule;\n\nimport java.util.ArrayList;\n\npublic class AlarmReceiver extends BroadcastReceiver {\n    private static final String TAG = AlarmReceiver.class.getSimpleName();\n\n    AlarmModel alarm;\n\n    int id;\n\n    @Override\n    public void onReceive(Context context, Intent intent) {\n        if (intent != null) {\n            final AlarmDatabase alarmDB = new AlarmDatabase(context);\n            AlarmUtil alarmUtil = new AlarmUtil((Application) context.getApplicationContext());\n\n            try {\n                String intentType = intent.getExtras().getString(\"intentType\");\n                if (Constants.ADD_INTENT.equals(intentType)) {\n                    id = intent.getExtras().getInt(\"PendingId\");\n\n                    try {\n                        alarm = alarmDB.getAlarm(id);\n\n                        alarmUtil.sendNotification(alarm);\n\n                        ArrayList<AlarmModel> alarms = alarmDB.getAlarmList(1);\n                        alarmUtil.setBootReceiver();\n\n                        Log.d(TAG, \"alarm start: \" + alarm.toString() + \", alarms left: \" + alarms.size());\n                    } catch (Exception e) {\n                        alarmUtil.stopAlarmSound();\n                        e.printStackTrace();\n                    }\n                }\n\n            } catch (Exception e) {\n                e.printStackTrace();\n            }\n\n            String action = intent.getAction();\n            if (action != null) {\n                Log.e(TAG, \"ACTION: \" + action);\n                switch (action) {\n                    case Constants.NOTIFICATION_ACTION_SNOOZE:\n                        id = intent.getExtras().getInt(\"SnoozeAlarmId\");\n\n                        try {\n                            alarm = alarmDB.getAlarm(id);\n                            alarmUtil.snoozeAlarm(alarm);\n                            Log.e(TAG, \"alarm snoozed: \" + alarm.toString());\n\n                            alarmUtil.removeFiredNotification(alarm.getId());\n                        } catch (Exception e) {\n                            alarmUtil.stopAlarmSound();\n                            e.printStackTrace();\n                        }\n                        break;\n\n                    case Constants.NOTIFICATION_ACTION_DISMISS:\n                        id = intent.getExtras().getInt(\"AlarmId\");\n\n                        try {\n                            alarm = alarmDB.getAlarm(id);\n                            Log.e(TAG, \"alarm cancelled: \" + alarm.toString());\n\n                            // emit notification dismissed\n                            ANModule.getReactAppContext().getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class).emit(\"OnNotificationDismissed\", \"{\\\"id\\\": \\\"\" + alarm.getId() + \"\\\"}\");\n\n                            alarmUtil.removeFiredNotification(alarm.getId());\n                            \n                            alarmUtil.cancelAlarm(alarm, false);\n                        } catch (Exception e) {\n                            alarmUtil.stopAlarmSound();\n                            e.printStackTrace();\n                        }\n                        break;\n                }\n            }\n        }\n    }\n}\n";

  const androidJavaPath = (projectRoot, fileName) => path.join(
    projectRoot,
    'node_modules',
    'react-native-alarm-notification',
    'android',
    'src',
    'main',
    'java',
    'com',
    'emekalites',
    'react',
    'alarm',
    'notification',
    fileName
  );

  it('applies the full AlarmUtil/AlarmReceiver patch chain to pristine sources and converges on a second pass', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'alarm-patch-pristine-'));
    try {
      const writeFixture = (filePath, content) => {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content);
      };
      writeFixture(androidJavaPath(projectRoot, 'AlarmUtil.java'), PRISTINE_ALARM_UTIL_JAVA);
      writeFixture(androidJavaPath(projectRoot, 'AlarmReceiver.java'), PRISTINE_ALARM_RECEIVER_JAVA);

      // Only the patches that target these two files — the other registry
      // entries target files this fixture doesn't provide (build.gradle,
      // AudioInterface.java, etc.) and would fail on missing candidates,
      // which isn't what this test is checking.
      const relevantPatches = PATCHES.filter((patch) => {
        const [firstCandidate] = patch.getCandidates(projectRoot);
        return firstCandidate.endsWith('AlarmUtil.java') || firstCandidate.endsWith('AlarmReceiver.java');
      });

      expect(() => applyPatches(projectRoot, relevantPatches)).not.toThrow();

      const utilOut1 = fs.readFileSync(androidJavaPath(projectRoot, 'AlarmUtil.java'), 'utf8');
      const receiverOut1 = fs.readFileSync(androidJavaPath(projectRoot, 'AlarmReceiver.java'), 'utf8');

      // Every marker each new (#1028) transform is responsible for actually landed.
      expect(utilOut1).toContain('completeIntent.putExtra("NotificationId", notificationID);');
      expect(utilOut1).toContain('snoozeIntent.putExtra("NotificationId", notificationID);');
      expect(utilOut1).toContain('dismissIntent.putExtra("NotificationId", notificationID);');
      expect(utilOut1).toContain('void clearNotification(int notificationId)');
      expect(utilOut1).toContain('// Mindwtr reminder notification slots');
      expect(utilOut1).toContain('// Mindwtr task reminder actions');
      expect(receiverOut1).toContain('cancelTaskReminders(reminderTag');
      expect(receiverOut1).toContain('Log.d(TAG, "ACTION_SNOOZE id="');
      expect(receiverOut1).toContain('Log.d(TAG, "ACTION_COMPLETE id="');
      expect(receiverOut1).toContain('Log.d(TAG, "ACTION_DISMISS id="');

      expect(() => applyPatches(projectRoot, relevantPatches)).not.toThrow();
      const utilOut2 = fs.readFileSync(androidJavaPath(projectRoot, 'AlarmUtil.java'), 'utf8');
      const receiverOut2 = fs.readFileSync(androidJavaPath(projectRoot, 'AlarmReceiver.java'), 'utf8');
      expect(utilOut2).toBe(utilOut1);
      expect(receiverOut2).toBe(receiverOut1);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe('applyAlarmExactPermissionModulePatchToSource', () => {
  const PRISTINE_AN_MODULE_JAVA = `package com.emekalites.react.alarm.notification;

public class ANModule extends ReactContextBaseJavaModule {
    @ReactMethod
    public void removeFiredNotification(int id) {
        alarmUtil.removeFiredNotification(id);
    }

    @ReactMethod
    public void removeAllFiredNotifications() {
        alarmUtil.removeAllFiredNotifications();
    }
}`;

  it('exposes canScheduleExactAlarms to JS, guarded by the API level', () => {
    const output = applyAlarmExactPermissionModulePatchToSource(PRISTINE_AN_MODULE_JAVA);

    expect(output).toContain('public void canScheduleExactAlarms(Promise promise)');
    expect(output).toContain('android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.S');
    expect(output).toContain('alarmManager != null && alarmManager.canScheduleExactAlarms()');
    // Fully qualified so the patch never has to touch the import block.
    expect(output).toContain('android.content.Context.ALARM_SERVICE');
    expect(output).not.toContain('import android.app.AlarmManager;');
    // The method it anchors on survives.
    expect(output).toContain('public void removeAllFiredNotifications()');
  });

  it('is idempotent', () => {
    const once = applyAlarmExactPermissionModulePatchToSource(PRISTINE_AN_MODULE_JAVA);
    expect(applyAlarmExactPermissionModulePatchToSource(once)).toBe(once);
  });

  it('leaves an unrecognised source untouched so the registry marker check reports it', () => {
    const unexpected = 'public class ANModule extends ReactContextBaseJavaModule {}';
    expect(applyAlarmExactPermissionModulePatchToSource(unexpected)).toBe(unexpected);
  });
});

describe('applyAlarmDeliveredNotificationModulePatchToSource', () => {
  const PRISTINE_AN_MODULE_JAVA = `package com.emekalites.react.alarm.notification;

public class ANModule extends ReactContextBaseJavaModule {
    @ReactMethod
    public void removeFiredNotification(int id) {
        alarmUtil.removeFiredNotification(id);
    }

    @ReactMethod
    public void removeAllFiredNotifications() {
        alarmUtil.removeAllFiredNotifications();
    }
}`;

  it('exposes the post id of a row and a clear by post id to JS', () => {
    const output = applyAlarmDeliveredNotificationModulePatchToSource(PRISTINE_AN_MODULE_JAVA);

    expect(output).toContain('public void getNotificationId(int id, Promise promise)');
    expect(output).toContain('promise.resolve(alarm.getAlarmId());');
    expect(output).toContain('promise.resolve(null);');
    expect(output).toContain('public void clearNotification(int notificationId)');
    expect(output).toContain('alarmUtil.clearNotification(notificationId);');
    expect(output).toContain('public void removeAllFiredNotifications()');
  });

  it('composes with the exact-permission patch on the same anchor', () => {
    const output = applyAlarmDeliveredNotificationModulePatchToSource(
      applyAlarmExactPermissionModulePatchToSource(PRISTINE_AN_MODULE_JAVA),
    );
    expect(output).toContain('public void canScheduleExactAlarms(Promise promise)');
    expect(output).toContain('public void clearNotification(int notificationId)');
  });

  it('is idempotent', () => {
    const once = applyAlarmDeliveredNotificationModulePatchToSource(PRISTINE_AN_MODULE_JAVA);
    expect(applyAlarmDeliveredNotificationModulePatchToSource(once)).toBe(once);
  });

  it('leaves an unrecognised source untouched so the registry marker check reports it', () => {
    const unexpected = 'public class ANModule extends ReactContextBaseJavaModule {}';
    expect(applyAlarmDeliveredNotificationModulePatchToSource(unexpected)).toBe(unexpected);
  });
});
