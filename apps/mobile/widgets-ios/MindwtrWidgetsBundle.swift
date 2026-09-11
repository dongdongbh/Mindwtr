import WidgetKit
import SwiftUI

@main
struct MindwtrWidgetsBundle: WidgetBundle {
    var body: some Widget {
        MindwtrTasksWidget()
        MindwtrCompactWidget()
        // These two offer no families before iOS 16, so they stay invisible on iOS 15.
        MindwtrFocusLockWidget()
        MindwtrCaptureLockWidget()
        if #available(iOSApplicationExtension 18.0, iOS 18.0, *) {
            MindwtrCaptureControl()
        }
    }
}
