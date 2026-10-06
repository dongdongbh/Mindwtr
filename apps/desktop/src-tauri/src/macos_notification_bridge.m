#import <Foundation/Foundation.h>
#import <UserNotifications/UserNotifications.h>
#import <string.h>

@interface MindwtrReplacingNotificationDelegate : NSObject <UNUserNotificationCenterDelegate>
@property (atomic, strong) id<UNUserNotificationCenterDelegate> previous;
@end

@implementation MindwtrReplacingNotificationDelegate
- (void)userNotificationCenter:(UNUserNotificationCenter *)center
      willPresentNotification:(UNNotification *)notification
        withCompletionHandler:(void (^)(UNNotificationPresentationOptions))completion {
    UNNotificationPresentationOptions options = 0;
    if ([notification.request.content.userInfo[@"mindwtrReplacingReminder"] boolValue]) {
        options = UNNotificationPresentationOptionSound;
        if (@available(macOS 11.0, *)) {
            options |= UNNotificationPresentationOptionBanner | UNNotificationPresentationOptionList;
        } else {
            options |= UNNotificationPresentationOptionAlert;
        }
    }
    id<UNUserNotificationCenterDelegate> previous = self.previous;
    if ([previous respondsToSelector:_cmd]) {
        [previous userNotificationCenter:center willPresentNotification:notification
                  withCompletionHandler:^(UNNotificationPresentationOptions priorOptions) {
            completion(priorOptions | options);
        }];
    } else {
        completion(options);
    }
}

- (void)userNotificationCenter:(UNUserNotificationCenter *)center
 didReceiveNotificationResponse:(UNNotificationResponse *)response
          withCompletionHandler:(void (^)(void))completion {
    id<UNUserNotificationCenterDelegate> previous = self.previous;
    if ([previous respondsToSelector:_cmd]) {
        [previous userNotificationCenter:center didReceiveNotificationResponse:response
                  withCompletionHandler:completion];
    } else {
        completion();
    }
}

- (void)userNotificationCenter:(UNUserNotificationCenter *)center
  openSettingsForNotification:(UNNotification *)notification {
    id<UNUserNotificationCenterDelegate> previous = self.previous;
    if ([previous respondsToSelector:_cmd]) {
        [previous userNotificationCenter:center openSettingsForNotification:notification];
    }
}
@end

// Called on Rust's blocking pool, never the UI/runtime thread. NULL means the native add
// completed successfully; an allocated error string belongs to the Rust caller.
char *mindwtr_macos_send_replacing_notification(const char *title, const char *body, const char *identifier) {
    if (title == NULL || identifier == NULL || [NSThread isMainThread]) {
        return strdup("Invalid notification call");
    }
    @autoreleasepool {
        NSString *tag = [NSString stringWithUTF8String:identifier];
        NSString *titleText = [NSString stringWithUTF8String:title];
        NSString *bodyText = body == NULL ? @"" : [NSString stringWithUTF8String:body];
        if (tag.length == 0 || titleText.length == 0 || bodyText == nil) {
            return strdup("Invalid notification text");
        }
        NSBundle *bundle = [NSBundle mainBundle];
        if (bundle.bundleIdentifier.length == 0 || ![bundle.bundleURL.pathExtension isEqualToString:@"app"]) {
            return strdup("The notification center needs an app bundle");
        }
        UNUserNotificationCenter *center;
        @try {
            center = [UNUserNotificationCenter currentNotificationCenter];
        } @catch (NSException *exception) {
            // An unbundled `tauri dev` executable has no notification-center identity.
            return strdup("The notification center needs an app bundle");
        }
        if (center == nil) {
            return strdup("The notification center is unavailable");
        }
        static MindwtrReplacingNotificationDelegate *delegate;
        static NSLock *sendLock;
        static dispatch_once_t onceToken;
        dispatch_once(&onceToken, ^{
            delegate = [[MindwtrReplacingNotificationDelegate alloc] init];
            sendLock = [[NSLock alloc] init];
        });
        // ponytail: serialize sends globally; per-tag locks only if reminder throughput matters.
        [sendLock lock];
        dispatch_sync(dispatch_get_main_queue(), ^{
            if (center.delegate != delegate) {
                delegate.previous = center.delegate;
                center.delegate = delegate;
            }
        });

        // The desktop plugin reports Granted without checking macOS authorization.
        dispatch_semaphore_t finished = dispatch_semaphore_create(0);
        __block BOOL granted = NO;
        __block NSError *nativeError = nil;
        [center requestAuthorizationWithOptions:(UNAuthorizationOptionAlert | UNAuthorizationOptionSound)
                             completionHandler:^(BOOL allowed, NSError *error) {
            granted = allowed;
            nativeError = error;
            dispatch_semaphore_signal(finished);
        }];
        dispatch_semaphore_wait(finished, DISPATCH_TIME_FOREVER);
        if (!granted || nativeError != nil) {
            [sendLock unlock];
            if (nativeError == nil) return strdup("Notification permission denied");
            return strdup([[NSString stringWithFormat:@"Notification authorization failed (code %ld)",
                            (long)nativeError.code] UTF8String]);
        }

        UNMutableNotificationContent *content = [[UNMutableNotificationContent alloc] init];
        content.title = titleText;
        content.body = bodyText;
        content.sound = [UNNotificationSound defaultSound];
        content.userInfo = @{@"mindwtrReplacingReminder": @YES};
        UNNotificationRequest *request = [UNNotificationRequest requestWithIdentifier:tag content:content trigger:nil];
        // Remove only this task's delivered reminder so the replacement alerts again.
        [center removeDeliveredNotificationsWithIdentifiers:@[tag]];
        [center addNotificationRequest:request withCompletionHandler:^(NSError *error) {
            nativeError = error;
            dispatch_semaphore_signal(finished);
        }];
        dispatch_semaphore_wait(finished, DISPATCH_TIME_FOREVER);
        [sendLock unlock];
        if (nativeError != nil) {
            // Include the native code, never payload text or localized descriptions.
            return strdup([[NSString stringWithFormat:@"Notification delivery failed (code %ld)",
                            (long)nativeError.code] UTF8String]);
        }
        return NULL;
    }
}
