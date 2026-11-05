import Foundation
import MindwtrNativeCore

@MainActor
func publishAndAcknowledgeProductionWidgetCompletions(snapshot: NativeWidgetFamilySnapshot,
    settled: [MindwtrWidgetPendingAction], store: MindwtrWidgetActionStore,
    publisher: NativeWidgetFamilyPublisher, current: () -> Bool, didPublish: () -> Void,
    reload: (String) -> Void) throws {
    guard current() else { throw CancellationError() }
    try publisher.publish(snapshot) { _ in }
    didPublish()
    defer {
        if current() {
            for kind in NativeWidgetFamilyPublisher.kinds { reload(kind) }
        }
    }
    for action in settled {
        guard current() else { throw CancellationError() }
        try store.acknowledgeForNative(action) {
            guard current() else { throw CancellationError() }
        }
    }
    guard current() else { throw CancellationError() }
}
