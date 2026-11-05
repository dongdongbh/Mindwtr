#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <objc/runtime.h>


@interface MWFabricUnmountGuard : NSObject
@end

@implementation MWFabricUnmountGuard

static void (*MWOriginalUnmountChildComponentView)(id, SEL, UIView *, NSInteger);

static void MWGuardedUnmountChildComponentView(id self, SEL _cmd, UIView *childComponentView, NSInteger index)
{
  @try {
    MWOriginalUnmountChildComponentView(self, _cmd, childComponentView, index);
  } @catch (NSException *exception) {


    NSLog(@"[MWFabricUnmountGuard] recovered from %@ unmounting %@ at index %ld of %@: %@",
          exception.name,
          childComponentView,
          (long)index,
          self,
          exception.reason);
    [childComponentView removeFromSuperview];
  }
}

+ (void)load
{
  Class componentViewClass = NSClassFromString(@"RCTViewComponentView");
  SEL selector = NSSelectorFromString(@"unmountChildComponentView:index:");
  Method method = componentViewClass ? class_getInstanceMethod(componentViewClass, selector) : NULL;
  if (method == NULL) {
    return;
  }

  MWOriginalUnmountChildComponentView =
      (void (*)(id, SEL, UIView *, NSInteger))method_setImplementation(method, (IMP)MWGuardedUnmountChildComponentView);
}

@end
