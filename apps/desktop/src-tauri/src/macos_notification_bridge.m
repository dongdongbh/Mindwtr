#import <Foundation/Foundation.h>
#import <stdbool.h>

// A task's reminders replace one another instead of stacking. `tauri-plugin-notification`
// (notify-rust, mac-notification-sys) gives no notification an identifier, so every reminder is
// a new one. NSUserNotification keys a delivered notification by `identifier`: the task's
// earlier notification is removed and the new one delivered under the same identifier, so the
// task keeps one notification and the reminder alerts again. Deprecated, like the plugin's own
// backend, but it needs no new permission.
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"

@interface MindwtrReplacingNotificationDelegate : NSObject <NSUserNotificationCenterDelegate>
@end

@implementation MindwtrReplacingNotificationDelegate
// Without this, a reminder that fires while Mindwtr is frontmost goes straight to the
// Notification Center with no banner (mac-notification-sys' delegate presents it too).
- (BOOL)userNotificationCenter:(NSUserNotificationCenter *)center
     shouldPresentNotification:(NSUserNotification *)notification {
    return YES;
}
@end

// Returns false when no notification center is available, so the caller can fall back to the
// plugin and still show the reminder.
bool mindwtr_macos_send_replacing_notification(const char *title, const char *body, const char *identifier) {
    if (title == NULL || identifier == NULL) {
        return false;
    }
    @autoreleasepool {
        NSUserNotificationCenter *center = [NSUserNotificationCenter defaultUserNotificationCenter];
        if (center == nil) {
            return false;
        }
        // The center keeps its delegate weakly.
        static MindwtrReplacingNotificationDelegate *delegate = nil;
        static dispatch_once_t onceToken;
        dispatch_once(&onceToken, ^{
            delegate = [[MindwtrReplacingNotificationDelegate alloc] init];
        });
        center.delegate = delegate;

        NSString *key = [NSString stringWithUTF8String:identifier];
        NSString *titleText = [NSString stringWithUTF8String:title];
        if (key == nil || titleText == nil) {
            return false;
        }
        for (NSUserNotification *delivered in center.deliveredNotifications) {
            if ([delivered.identifier isEqualToString:key]) {
                [center removeDeliveredNotification:delivered];
            }
        }

        NSUserNotification *notification = [[NSUserNotification alloc] init];
        notification.identifier = key;
        notification.title = titleText;
        if (body != NULL) {
            notification.informativeText = [NSString stringWithUTF8String:body];
        }
        notification.soundName = NSUserNotificationDefaultSoundName;
        [center deliverNotification:notification];
        return true;
    }
}

#pragma clang diagnostic pop
