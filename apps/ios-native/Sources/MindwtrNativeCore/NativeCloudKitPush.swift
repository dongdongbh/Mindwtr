import CloudKitAttachmentErrorClassifier
import Foundation

public struct NativeAutomaticSyncGate: Sendable, Equatable {
    public let foreground: Bool
    public let locked: Bool
    public let busy: Bool
    public let contextClean: Bool
    public let syncRunning: Bool
    public let ready: Bool

    public init(foreground: Bool, locked: Bool, busy: Bool, contextClean: Bool, syncRunning: Bool, ready: Bool) {
        self.foreground = foreground; self.locked = locked; self.busy = busy
        self.contextClean = contextClean; self.syncRunning = syncRunning; self.ready = ready
    }

    public var open: Bool { foreground && !locked && !busy && contextClean && !syncRunning && ready }
}

public struct NativeCloudKitPushInbox: Sendable {
    public private(set) var pending = false

    public init() {}

    public static func isZoneChange(_ userInfo: [AnyHashable: Any]) -> Bool {
        NativeCloudKitTransport.isZoneChangeNotification(userInfo)
    }

    public mutating func note() { pending = true }

    public mutating func take(_ gate: NativeAutomaticSyncGate) -> Bool {
        guard pending, gate.open else { return false }
        pending = false
        return true
    }
}
