package com.emekalites.react.alarm.notification;

import android.app.Application;
import android.app.Notification;
import android.app.NotificationManager;
import android.service.notification.StatusBarNotification;
import android.test.InstrumentationTestCase;
import java.util.Calendar;
import java.util.HashMap;
import java.util.Map;
import tech.dongdongbh.mindwtr.notificationopenintents.NotificationOpenPayloadStore;

/** Run only against Mindwtr Dev. Uses the installed alarm code and Android notification manager. */
public class ReminderActionsDeviceTest extends InstrumentationTestCase {
    private static final String TASK = "pr1346-device-reminder";
    private Application app;
    private AlarmUtil util;
    private AlarmDatabase db;
    private NotificationManager manager;
    @Override public void setUp() throws Exception {
        super.setUp();
        app = (Application) getInstrumentation().getTargetContext().getApplicationContext();
        assertEquals("tech.dongdongbh.mindwtr.dev", app.getPackageName());
        util = new AlarmUtil(app);
        db = new AlarmDatabase(app);
        manager = app.getSystemService(NotificationManager.class);
    }
    private AlarmModel alarm(String task, int id, String kind) {
        AlarmModel alarm = new AlarmModel();
        alarm.setAlarmId(id);
        alarm.setTitle("Reminder device check " + id);
        alarm.setMessage("Disposable reminder validation");
        alarm.setChannel("pr1346-device-check");
        alarm.setTag("mindwtr-reminder:task:" + task);
        alarm.setData("taskId==>" + task + ";;kind==>" + kind + ";;alarmKey==>task:" + task + ":r" + id + ";;notificationActionComplete==>true;;");
        alarm.setHasButton(true);
        alarm.setPlaySound(false);
        Calendar later = Calendar.getInstance(); later.add(Calendar.MINUTE, 10);
        util.setAlarmFromCalendar(alarm, later);
        alarm.setId(db.insert(alarm));
        return alarm;
    }
    private StatusBarNotification shown(String task) throws Exception {
        for (int i = 0; i < 40; i++) {
            for (StatusBarNotification item : manager.getActiveNotifications())
                if (("mindwtr-reminder:task:" + task).equals(item.getTag())) return item;
            Thread.sleep(50);
        }
        fail("No notification for " + task); return null;
    }
    private void press(Notification notification, String label) throws Exception {
        for (Notification.Action action : notification.actions) {
            if (label.contentEquals(action.title)) { action.actionIntent.send(); return; }
        }
        fail("Missing action " + label);
    }
    private int matchingAlarms(String task) {
        int count = 0;
        for (AlarmModel alarm : db.getAlarmList(1))
            if (alarm.getData() != null && alarm.getData().contains("taskId==>" + task + ";;")) count++;
        return count;
    }
    private void cleanup() {
        for (AlarmModel alarm : db.getAlarmList(1)) {
            if (alarm.getData() != null && alarm.getData().contains(TASK)) util.cancelAlarm(alarm, true);
        }
        for (StatusBarNotification item : manager.getActiveNotifications())
            if (item.getTag() != null && item.getTag().contains(TASK)) manager.cancel(item.getTag(), item.getId());
        for (Map<String,String> item : NotificationOpenPayloadStore.peekCompletions(app))
            if (TASK.equals(item.get("taskId"))) NotificationOpenPayloadStore.acknowledgeCompletion(app, item.get("actionId"));
    }
    public void testNotificationActions() throws Exception {
        cleanup();
        try {
            AlarmModel first = alarm(TASK, 1346001, "task-reminder");
            util.sendNotification(first); shown(TASK);
            AlarmModel second = alarm(TASK, 1346101, "task-reminder");
            util.sendNotification(second);
            Thread.sleep(500);
            StatusBarNotification current = shown(TASK);
            int count = 0;
            for (StatusBarNotification item : manager.getActiveNotifications())
                if (current.getTag().equals(item.getTag())) count++;
            assertEquals(1, count);
            assertEquals(second.getTitle(), current.getNotification().extras.getString(Notification.EXTRA_TITLE));
            assertEquals(0, current.getNotification().flags & Notification.FLAG_ONLY_ALERT_ONCE);
            util.clearNotification(first.getAlarmId());
            assertEquals(second.getTitle(), shown(TASK).getNotification().extras.getString(Notification.EXTRA_TITLE));
            press(current.getNotification(), "DISMISS");
            Thread.sleep(500);
            for (StatusBarNotification item : manager.getActiveNotifications()) assertFalse(current.getTag().equals(item.getTag()));
            assertTrue("Dismiss must retain later reminders", matchingAlarms(TASK) > 0);

            AlarmModel snooze = alarm(TASK, 1346201, "task-reminder");
            util.sendNotification(snooze);
            Notification snoozeNotification = shown(TASK).getNotification();
            db.delete(snooze.getId()); // Reminder reconciliation has removed the fired row.
            int beforeSnooze = matchingAlarms(TASK);
            press(snoozeNotification, "SNOOZE");
            for (int i = 0; i < 40 && matchingAlarms(TASK) <= beforeSnooze; i++) Thread.sleep(50);
            assertTrue("Dead-row Snooze must create another alarm", matchingAlarms(TASK) > beforeSnooze);

            AlarmModel done = alarm(TASK, 1346301, "task-reminder");
            AlarmModel pomodoro = alarm(TASK, 1346401, "pomodoro"); pomodoro.setTag(""); db.update(pomodoro);
            util.sendNotification(done);
            press(shown(TASK).getNotification(), "COMPLETE");
            for (int i = 0; i < 60 && matchingAlarms(TASK) > 1; i++) Thread.sleep(50);
            assertEquals("Done cancels task reminders but preserves Pomodoro", 1, matchingAlarms(TASK));
            assertNotNull(db.getAlarm(pomodoro.getId()));
            boolean queued = false;
            for (Map<String,String> item : NotificationOpenPayloadStore.peekCompletions(app))
                if (TASK.equals(item.get("taskId"))) queued = true;
            assertTrue("Cold Done must survive on disk", queued);
        } finally { cleanup(); }
    }
    // Run these methods in separate instrumentation invocations, killing the app between them.
    public void testSeedDurableQueue() {
        cleanup();
        for (int i = 0; i < 55; i++) {
            Map<String,String> payload = new HashMap<>();
            payload.put("taskId", TASK); payload.put("alarmKey", "queue-" + i);
            NotificationOpenPayloadStore.persistCompletion(app, payload);
            NotificationOpenPayloadStore.persistCompletion(app, payload);
        }
        long count = NotificationOpenPayloadStore.peekCompletions(app).stream().filter(x -> TASK.equals(x.get("taskId"))).count();
        assertEquals(55L, count);
    }
    public void testReplayDurableQueue() {
        java.util.List<Map<String,String>> pending = NotificationOpenPayloadStore.peekCompletions(app);
        assertEquals(55L, pending.stream().filter(x -> TASK.equals(x.get("taskId"))).count());
        Map<String,String> first = pending.stream().filter(x -> TASK.equals(x.get("taskId"))).findFirst().get();
        NotificationOpenPayloadStore.acknowledgeCompletion(app, first.get("actionId"));
        assertEquals(54L, NotificationOpenPayloadStore.peekCompletions(app).stream().filter(x -> TASK.equals(x.get("taskId"))).count());
        cleanup();
    }
}
