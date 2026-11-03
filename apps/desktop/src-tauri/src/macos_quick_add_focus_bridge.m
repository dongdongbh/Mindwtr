#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>
#import <objc/runtime.h>
#import <stdbool.h>


@interface MindwtrQuickAddPanel : NSPanel
@end

@implementation MindwtrQuickAddPanel


- (BOOL)canBecomeKeyWindow {
    return YES;
}
@end


static void mindwtr_quick_add_run_on_main(dispatch_block_t block) {
    if ([NSThread isMainThread]) {
        block();
        return;
    }
    dispatch_async(dispatch_get_main_queue(), block);
}


bool mindwtr_macos_make_quick_add_panel(void *ns_window) {
    if (ns_window == NULL) {
        return false;
    }

    NSWindow *window = (__bridge NSWindow *)ns_window;
    Class panelClass = [MindwtrQuickAddPanel class];


    if (class_getInstanceSize(panelClass) > class_getInstanceSize(object_getClass(window))) {
        return false;
    }

    mindwtr_quick_add_run_on_main(^{
        object_setClass(window, panelClass);
        [window setStyleMask:[window styleMask] | NSWindowStyleMaskNonactivatingPanel];


        [window setHidesOnDeactivate:NO];


        [window setCollectionBehavior:[window collectionBehavior] |
                                      NSWindowCollectionBehaviorCanJoinAllSpaces |
                                      NSWindowCollectionBehaviorFullScreenAuxiliary];
    });

    return true;
}


bool mindwtr_macos_present_quick_add_panel(void *ns_window) {
    if (ns_window == NULL) {
        return false;
    }

    NSWindow *window = (__bridge NSWindow *)ns_window;
    if (![window isKindOfClass:[MindwtrQuickAddPanel class]]) {
        return false;
    }

    mindwtr_quick_add_run_on_main(^{
        [window orderFrontRegardless];
        [window makeKeyWindow];
    });

    return true;
}
