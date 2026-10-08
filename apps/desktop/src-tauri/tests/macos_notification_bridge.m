#import <AppKit/AppKit.h>
#import <UserNotifications/UserNotifications.h>
#import <assert.h>
#import <stdatomic.h>
#import "../src/macos_notification_bridge.m"

static atomic_int presentations;
static atomic_int responses;
static atomic_int settings;
@interface PriorDelegate : NSObject <UNUserNotificationCenterDelegate>
@end
@implementation PriorDelegate
- (void)userNotificationCenter:(UNUserNotificationCenter *)center willPresentNotification:(UNNotification *)notification withCompletionHandler:(void (^)(UNNotificationPresentationOptions))completion {
    atomic_fetch_add(&presentations, 1);
    completion(UNNotificationPresentationOptionBadge);
}
- (void)userNotificationCenter:(UNUserNotificationCenter *)center didReceiveNotificationResponse:(UNNotificationResponse *)response withCompletionHandler:(void (^)(void))completion {
    atomic_fetch_add(&responses, 1);
    completion();
}
- (void)userNotificationCenter:(UNUserNotificationCenter *)center openSettingsForNotification:(UNNotification *)notification {
    atomic_fetch_add(&settings, 1);
}
@end

@interface TestNotification : NSObject
@property (strong) UNNotificationRequest *request;
@end
@implementation TestNotification
@end

static void regression(UNUserNotificationCenter *center, PriorDelegate *prior) {
    MindwtrReplacingNotificationDelegate *delegate = [[MindwtrReplacingNotificationDelegate alloc] init];
    delegate.previous = prior;
    UNMutableNotificationContent *content = [[UNMutableNotificationContent alloc] init];
    content.userInfo = @{@"mindwtrReplacingReminder": @YES};
    TestNotification *notification = [[TestNotification alloc] init];
    notification.request = [UNNotificationRequest requestWithIdentifier:@"test" content:content trigger:nil];
    __block UNNotificationPresentationOptions options;
    [delegate userNotificationCenter:center willPresentNotification:(UNNotification *)notification withCompletionHandler:^(UNNotificationPresentationOptions result) { options = result; }];
    assert((options & UNNotificationPresentationOptionSound) != 0);
    assert((options & UNNotificationPresentationOptionBadge) != 0);
    assert((options & UNNotificationPresentationOptionBanner) != 0);
    assert((options & UNNotificationPresentationOptionList) != 0);
    assert(atomic_load(&presentations) == 1);
    content.userInfo = @{};
    notification.request = [UNNotificationRequest requestWithIdentifier:@"foreign" content:content trigger:nil];
    [delegate userNotificationCenter:center willPresentNotification:(UNNotification *)notification withCompletionHandler:^(UNNotificationPresentationOptions result) { options = result; }];
    assert(options == UNNotificationPresentationOptionBadge);
    __block BOOL forwarded = NO;
    [delegate userNotificationCenter:center didReceiveNotificationResponse:(UNNotificationResponse *)[[NSObject alloc] init] withCompletionHandler:^{ forwarded = YES; }];
    assert(forwarded && atomic_load(&responses) == 1);
    [delegate userNotificationCenter:center openSettingsForNotification:nil];
    assert(atomic_load(&settings) == 1);
    delegate.previous = nil;
    [delegate userNotificationCenter:center willPresentNotification:(UNNotification *)notification withCompletionHandler:^(UNNotificationPresentationOptions result) { options = result; }];
    assert(options == 0);
    char *error = mindwtr_macos_send_replacing_notification(NULL, NULL, NULL);
    assert(error != NULL && strcmp(error, "Invalid notification call") == 0);
    free(error);
    error = mindwtr_macos_send_replacing_notification("", NULL, "test");
    assert(error != NULL && strcmp(error, "Invalid notification text") == 0);
    free(error);
    puts("PASS synthetic delegate: own presentation, foreign preservation, response/settings forwarding, no-prior fallback; native invalid-input errors");
    fflush(stdout);
}

static void sendTest(const char *tag, const char *body) {
    char *error = mindwtr_macos_send_replacing_notification("Mindwtr PR1348 test", body, tag);
    if (error != NULL) {
        fprintf(stderr, "SEND_ERROR %s\n", error);
        free(error);
        exit(2);
    }
}

static NSArray<UNNotification *> *delivered(UNUserNotificationCenter *center) {
    dispatch_semaphore_t done = dispatch_semaphore_create(0);
    __block NSArray *items;
    [center getDeliveredNotificationsWithCompletionHandler:^(NSArray *notifications) {
        items = notifications;
        dispatch_semaphore_signal(done);
    }];
    assert(dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC)) == 0);
    return items;
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc > 1 && strcmp(argv[1], "unbundled") == 0) {
            dispatch_async(dispatch_get_global_queue(QOS_CLASS_DEFAULT, 0), ^{
                char *error = mindwtr_macos_send_replacing_notification("test", NULL, "test");
                assert(error != NULL && strcmp(error, "The notification center needs an app bundle") == 0);
                free(error);
                puts("PASS unbundled executable returns native error instead of aborting");
                exit(0);
            });
            dispatch_main();
        }
        NSApplication *app = [NSApplication sharedApplication];
        [app setActivationPolicy:NSApplicationActivationPolicyRegular];
        UNUserNotificationCenter *center = [UNUserNotificationCenter currentNotificationCenter];
        PriorDelegate *prior = [[PriorDelegate alloc] init];
        center.delegate = prior;
        BOOL shouldSend = argc > 1 && strcmp(argv[1], "test") == 0;
        NSWindow *window;
        if (shouldSend) {
            window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 360, 120)
                styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
            window.title = @"Mindwtr notification regression";
            [window makeKeyAndOrderFront:nil];
        }
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
            if (argc > 1 && strcmp(argv[1], "regression") == 0) {
                regression(center, prior);
                exit(0);
            }
            dispatch_semaphore_t done = dispatch_semaphore_create(0);
            __block UNAuthorizationStatus status;
            [center getNotificationSettingsWithCompletionHandler:^(UNNotificationSettings *value) {
                status = value.authorizationStatus;
                printf("AUTH status=%ld alert=%ld sound=%ld\n", (long)status, (long)value.alertSetting, (long)value.soundSetting);
                fflush(stdout);
                dispatch_semaphore_signal(done);
            }];
            assert(dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC)) == 0);
            if (argc > 1 && strcmp(argv[1], "request") == 0) {
                puts("PERMISSION_PROMPT awaiting protected user choice in mindwtr-test desktop");
                fflush(stdout);
                [center requestAuthorizationWithOptions:(UNAuthorizationOptionAlert | UNAuthorizationOptionSound) completionHandler:^(BOOL allowed, NSError *error) {
                    printf("PERMISSION_RESULT allowed=%d code=%ld\n", allowed, (long)error.code);
                    fflush(stdout);
                    exit(error == nil && allowed ? 0 : 3);
                }];
                return;
            }
            if (!shouldSend) exit(0);
            if (status != UNAuthorizationStatusAuthorized) {
                puts("BLOCKED protected notification permission needed");
                exit(3);
            }
            const char *a = "mindwtr-pr1348-test-a";
            const char *b = "mindwtr-pr1348-test-b";
            [NSThread sleepForTimeInterval:0.5];
            sendTest(a, "first");
            sendTest(b, "other task");
            [NSThread sleepForTimeInterval:2];
            sendTest(a, "replacement");
            [NSThread sleepForTimeInterval:2];
            NSInteger countA = 0, countB = 0;
            for (UNNotification *item in delivered(center)) {
                if ([item.request.identifier isEqualToString:@"mindwtr-pr1348-test-a"]) {
                    countA++;
                    assert([item.request.content.body isEqualToString:@"replacement"]);
                }
                if ([item.request.identifier isEqualToString:@"mindwtr-pr1348-test-b"]) countB++;
            }
            assert(countA == 1 && countB == 1);
            __block BOOL active;
            dispatch_sync(dispatch_get_main_queue(), ^{ active = app.isActive; });
            assert(active && atomic_load(&presentations) >= 3);
            assert(center.delegate != prior);
            __block BOOL forwarded = NO;
            [center.delegate userNotificationCenter:center didReceiveNotificationResponse:(UNNotificationResponse *)[[NSObject alloc] init] withCompletionHandler:^{ forwarded = YES; }];
            assert(forwarded && atomic_load(&responses) == 1);
            [center.delegate userNotificationCenter:center openSettingsForNotification:nil];
            assert(atomic_load(&settings) == 1);
            printf("PASS replacement=1 unrelated=1 responseForward=1 settingsForward=1 foregroundCallbacks=%d active=%d\n", atomic_load(&presentations), active);
            [center removeDeliveredNotificationsWithIdentifiers:@[@"mindwtr-pr1348-test-a", @"mindwtr-pr1348-test-b"]];
            fflush(stdout);
            exit(0);
        });
        [app activateIgnoringOtherApps:YES];
        [app run];
    }
}
