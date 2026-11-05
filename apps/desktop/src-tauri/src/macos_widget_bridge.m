#import <Foundation/Foundation.h>
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>

static NSNotificationName const MindwtrMacOSWidgetCaptureNotification =
    @"tech.dongdongbh.mindwtr.widget.quick-capture";
static id mindwtrMacOSWidgetCaptureObserver = nil;

typedef void (*MindwtrMacOSWidgetCaptureCallback)(void);


bool mindwtr_macos_install_widget_capture_listener(
    const char *app_group_cstr,
    MindwtrMacOSWidgetCaptureCallback callback
) {
    if (!app_group_cstr || !callback) return false;

    NSString *groupId = [NSString stringWithUTF8String:app_group_cstr];
    if (!groupId) return false;

    NSDistributedNotificationCenter *center = [NSDistributedNotificationCenter defaultCenter];
    @synchronized(center) {
        if (mindwtrMacOSWidgetCaptureObserver) return true;

        mindwtrMacOSWidgetCaptureObserver = [center
            addObserverForName:MindwtrMacOSWidgetCaptureNotification
            object:groupId
            queue:[NSOperationQueue mainQueue]
            usingBlock:^(__unused NSNotification *notification) {
                callback();
            }];
    }

    return mindwtrMacOSWidgetCaptureObserver != nil;
}


char *mindwtr_macos_widget_container_path(const char *app_group_cstr) {
    if (!app_group_cstr) return NULL;

    NSString *groupId = [NSString stringWithUTF8String:app_group_cstr];
    NSFileManager *fileManager = [NSFileManager defaultManager];
    NSURL *containerURL = [fileManager containerURLForSecurityApplicationGroupIdentifier:groupId];
    if (!containerURL) return NULL;

    const char *path = [[containerURL path] UTF8String];
    if (!path) return NULL;

    return strdup(path);
}


void mindwtr_macos_widget_free_string(char *ptr) {
    free(ptr);
}
