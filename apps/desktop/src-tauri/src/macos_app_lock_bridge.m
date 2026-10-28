#import <Foundation/Foundation.h>
#import <LocalAuthentication/LocalAuthentication.h>
#include <stdbool.h>

/// True when the Mac can run the owner check (Touch ID or the account password).
bool mindwtr_app_lock_available(void) {
    @autoreleasepool {
        LAContext *context = [[LAContext alloc] init];
        NSError *error = nil;
        return [context canEvaluatePolicy:LAPolicyDeviceOwnerAuthentication error:&error];
    }
}

/// Runs the owner check and blocks the calling (background) thread until the
/// user answers. 0 success, 1 cancelled, 2 failed, 3 unavailable.
int mindwtr_app_lock_authenticate(const char *reason_cstr) {
    @autoreleasepool {
        LAContext *context = [[LAContext alloc] init];
        NSError *availabilityError = nil;
        if (![context canEvaluatePolicy:LAPolicyDeviceOwnerAuthentication error:&availabilityError]) {
            return 3;
        }
        NSString *reason = reason_cstr ? [NSString stringWithUTF8String:reason_cstr] : nil;
        if (reason.length == 0) reason = @"unlock Mindwtr";

        dispatch_semaphore_t done = dispatch_semaphore_create(0);
        __block int outcome = 2;
        [context evaluatePolicy:LAPolicyDeviceOwnerAuthentication
                localizedReason:reason
                          reply:^(BOOL success, NSError *error) {
            if (success) {
                outcome = 0;
            } else if (error.code == LAErrorUserCancel || error.code == LAErrorSystemCancel
                       || error.code == LAErrorAppCancel) {
                outcome = 1;
            } else if (error.code == LAErrorPasscodeNotSet) {
                outcome = 3;
            } else {
                outcome = 2;
            }
            dispatch_semaphore_signal(done);
        }];
        dispatch_semaphore_wait(done, DISPATCH_TIME_FOREVER);
        return outcome;
    }
}
