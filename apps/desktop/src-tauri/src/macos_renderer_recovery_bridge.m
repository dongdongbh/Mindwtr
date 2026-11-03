#import <AppKit/AppKit.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>
#import <stdbool.h>
#import <string.h>

typedef void (*MindwtrRendererEvent)(int windowKind, int event);

enum {
    MindwtrRendererInstalled = 0,
    MindwtrRendererAutoReloadStarted = 1,
    MindwtrRendererReloadFinished = 2,
    MindwtrRendererReloadUnavailable = 3,
    MindwtrRendererManualReloadRequired = 4,
    MindwtrRendererManualReloadStarted = 5,
    MindwtrRendererFallbackDismissed = 6,
    MindwtrRendererReloadFailed = 7,
    MindwtrRendererFallbackUnavailable = 8,
};

static char crashCountKey;
static char reloadNavigationKey;
static char alertOpenKey;
static char windowKindKey;
static MindwtrRendererEvent logEvent;
static void (*originalTermination)(id, SEL, WKWebView *);
static void (*originalFinish)(id, SEL, WKWebView *, WKNavigation *);
static void (*originalFailure)(id, SEL, WKWebView *, WKNavigation *, NSError *);
static void (*originalProvisionalFailure)(id, SEL, WKWebView *, WKNavigation *, NSError *);

static void emit(WKWebView *webView, int event) {
    if (logEvent != NULL) {
        NSNumber *kind = objc_getAssociatedObject(webView, &windowKindKey);
        logEvent(kind.intValue, event);
    }
}

static void showFallback(WKWebView *webView) {
    if ([objc_getAssociatedObject(webView, &alertOpenKey) boolValue]) {
        return;
    }
    objc_setAssociatedObject(webView, &alertOpenKey, @YES, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    __weak WKWebView *weakWebView = webView;

    dispatch_async(dispatch_get_main_queue(), ^{
        WKWebView *view = weakWebView;
        NSWindow *window = view.window;
        if (window == nil) {
            if (view != nil) {
                objc_setAssociatedObject(view, &alertOpenKey, @NO, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
                emit(view, MindwtrRendererFallbackUnavailable);
            }
            return;
        }

        NSAlert *alert = [NSAlert new];
        alert.messageText = @"Mindwtr's display stopped unexpectedly";
        alert.informativeText = @"Saved data is retained. Edits not saved before the interruption may be lost. Reload this window to try again; an interrupted File Sync may need an app restart.";
        [alert addButtonWithTitle:@"Reload Window"];
        [alert addButtonWithTitle:@"Later"];
        if (!window.isVisible) {
            [window makeKeyAndOrderFront:nil];
        }
        [NSApp activateIgnoringOtherApps:YES];
        [alert beginSheetModalForWindow:window completionHandler:^(NSModalResponse response) {
            WKWebView *currentView = weakWebView;
            if (currentView == nil) {
                return;
            }
            objc_setAssociatedObject(currentView, &alertOpenKey, @NO, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
            if (response != NSAlertFirstButtonReturn) {
                emit(currentView, MindwtrRendererFallbackDismissed);
                return;
            }
            emit(currentView, MindwtrRendererManualReloadStarted);
            WKNavigation *navigation = [currentView reload];
            objc_setAssociatedObject(currentView, &reloadNavigationKey, navigation, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
            if (navigation == nil) {
                emit(currentView, MindwtrRendererReloadUnavailable);
                showFallback(currentView);
            }
        }];
    });
}

static void rendererTerminated(id self, SEL command, WKWebView *webView) {

    originalTermination(self, command, webView);

    objc_setAssociatedObject(webView, &reloadNavigationKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    NSUInteger crashes = [objc_getAssociatedObject(webView, &crashCountKey) unsignedIntegerValue] + 1;
    objc_setAssociatedObject(webView, &crashCountKey, @(crashes), OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    if (crashes == 1) {
        emit(webView, MindwtrRendererAutoReloadStarted);
        WKNavigation *navigation = [webView reload];
        objc_setAssociatedObject(webView, &reloadNavigationKey, navigation, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
        if (navigation == nil) {
            emit(webView, MindwtrRendererReloadUnavailable);
            showFallback(webView);
        }
        return;
    }
    emit(webView, MindwtrRendererManualReloadRequired);
    showFallback(webView);
}

static void rendererDidFinish(id self, SEL command, WKWebView *webView, WKNavigation *navigation) {
    if (originalFinish != NULL) {
        originalFinish(self, command, webView, navigation);
    }
    if (navigation != nil && navigation == objc_getAssociatedObject(webView, &reloadNavigationKey)) {
        objc_setAssociatedObject(webView, &reloadNavigationKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
        emit(webView, MindwtrRendererReloadFinished);
    }
}

static void rendererDidFail(id self, SEL command, WKWebView *webView,
                            WKNavigation *navigation, NSError *error) {
    if (command == @selector(webView:didFailProvisionalNavigation:withError:)) {
        if (originalProvisionalFailure != NULL) {
            originalProvisionalFailure(self, command, webView, navigation, error);
        }
    } else if (originalFailure != NULL) {
        originalFailure(self, command, webView, navigation, error);
    }
    if (navigation != nil && navigation == objc_getAssociatedObject(webView, &reloadNavigationKey)) {
        objc_setAssociatedObject(webView, &reloadNavigationKey, nil, OBJC_ASSOCIATION_RETAIN_NONATOMIC);

        emit(webView, MindwtrRendererReloadFailed);
        showFallback(webView);
    }
}

bool mindwtr_macos_install_renderer_recovery(void *rawWebView, int kind,
                                              MindwtrRendererEvent callback) {
    if (rawWebView == NULL || callback == NULL || ![NSThread isMainThread]) {
        return false;
    }
    WKWebView *webView = (__bridge WKWebView *)rawWebView;
    id delegate = webView.navigationDelegate;
    Class base = object_getClass(delegate);
    if (base == Nil || strcmp(class_getName(base), "WryNavigationDelegate") != 0) {
        return false;
    }

    SEL terminated = @selector(webViewWebContentProcessDidTerminate:);
    Method termination = class_getInstanceMethod(base, terminated);
    Method finish = class_getInstanceMethod(base, @selector(webView:didFinishNavigation:));
    if (termination == NULL || finish == NULL) {
        return false;
    }
    Class subclass = objc_getClass("MindwtrRecoverableNavigationDelegate");
    if (subclass == Nil) {
        subclass = objc_allocateClassPair(base, "MindwtrRecoverableNavigationDelegate", 0);
        if (subclass == Nil ||
            !class_addMethod(subclass, terminated, (IMP)rendererTerminated,
                             method_getTypeEncoding(termination)) ||
            !class_addMethod(subclass, @selector(webView:didFinishNavigation:),
                             (IMP)rendererDidFinish, method_getTypeEncoding(finish)) ||
            !class_addMethod(subclass, @selector(webView:didFailNavigation:withError:),
                             (IMP)rendererDidFail, "v@:@@@") ||
            !class_addMethod(subclass, @selector(webView:didFailProvisionalNavigation:withError:),
                             (IMP)rendererDidFail, "v@:@@@")) {
            if (subclass != Nil) {
                objc_disposeClassPair(subclass);
            }
            return false;
        }
        objc_registerClassPair(subclass);
        originalTermination = (void (*)(id, SEL, WKWebView *))method_getImplementation(termination);
        originalFinish = (void (*)(id, SEL, WKWebView *, WKNavigation *))method_getImplementation(finish);
        Method failure = class_getInstanceMethod(base, @selector(webView:didFailNavigation:withError:));
        Method provisionalFailure = class_getInstanceMethod(base, @selector(webView:didFailProvisionalNavigation:withError:));
        originalFailure = failure == NULL ? NULL : (void (*)(id, SEL, WKWebView *, WKNavigation *, NSError *))method_getImplementation(failure);
        originalProvisionalFailure = provisionalFailure == NULL ? NULL : (void (*)(id, SEL, WKWebView *, WKNavigation *, NSError *))method_getImplementation(provisionalFailure);
    } else if (class_getSuperclass(subclass) != base || originalTermination == NULL) {
        return false;
    }

    logEvent = callback;
    objc_setAssociatedObject(webView, &windowKindKey, @(kind), OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    object_setClass(delegate, subclass);
    emit(webView, MindwtrRendererInstalled);
    return true;
}
