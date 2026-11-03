import WidgetKit
import SwiftUI

@main
@MainActor
enum MindwtrWidgetsEntryPoint {
    static func main() {


        if #available(iOSApplicationExtension 17.0, iOS 17.0, *) {
            MindwtrWidgetsBundle.main()
        } else {
            MindwtrLegacyWidgetsBundle.main()
        }
    }
}

@available(iOSApplicationExtension 17.0, iOS 17.0, *)
struct MindwtrWidgetsBundle: WidgetBundle {
    var body: some Widget {
        MindwtrTasksWidget()
        MindwtrCompactWidget()
        MindwtrFocusLockWidget()
        MindwtrCaptureLockWidget()
        if #available(iOSApplicationExtension 18.0, iOS 18.0, *) {
            MindwtrCaptureControl()
        }
    }
}

struct MindwtrLegacyWidgetsBundle: WidgetBundle {
    var body: some Widget {
        MindwtrLegacyTasksWidget()
        MindwtrCompactWidget()

        MindwtrFocusLockWidget()
        MindwtrCaptureLockWidget()
    }
}
