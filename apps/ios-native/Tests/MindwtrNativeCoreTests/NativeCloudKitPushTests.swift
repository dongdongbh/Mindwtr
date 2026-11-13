import XCTest
@testable import MindwtrNativeCore

final class NativeCloudKitPushTests: XCTestCase {
    private func zonePayload(subscription: String) -> [AnyHashable: Any] {
        ["aps": ["content-available": 1],
         "ck": ["ce": 2, "cid": "iCloud.tech.dongdongbh.mindwtr", "nid": UUID().uuidString.lowercased(),
                "fet": ["dbs": 1, "sid": subscription, "zid": "MindwtrZone", "zoid": "_defaultOwner"]]]
    }
    private let openGate = NativeAutomaticSyncGate(foreground: true, locked: false, busy: false, contextClean: true, syncRunning: false, ready: true)

    func testOnlyTheMindwtrZoneSubscriptionCountsAsACloudKitChange() {
        XCTAssertTrue(NativeCloudKitPushInbox.isZoneChange(zonePayload(subscription: "MindwtrZoneSubscription")))
        XCTAssertFalse(NativeCloudKitPushInbox.isZoneChange(zonePayload(subscription: "AnotherSubscription")))
        XCTAssertFalse(NativeCloudKitPushInbox.isZoneChange(["aps": ["alert": "Reminder", "sound": "default"]]))
        XCTAssertFalse(NativeCloudKitPushInbox.isZoneChange([:]))
    }

    func testAPushWaitsWhileBusyLockedInTheBackgroundOrSyncingAndThenSyncsOnce() {
        var inbox = NativeCloudKitPushInbox()
        XCTAssertFalse(inbox.take(openGate), "No push, no sync")
        inbox.note()
        let closed = [
            NativeAutomaticSyncGate(foreground: true, locked: false, busy: true, contextClean: true, syncRunning: false, ready: true),
            NativeAutomaticSyncGate(foreground: true, locked: true, busy: false, contextClean: true, syncRunning: false, ready: true),
            NativeAutomaticSyncGate(foreground: false, locked: false, busy: false, contextClean: true, syncRunning: false, ready: true),
            NativeAutomaticSyncGate(foreground: true, locked: false, busy: false, contextClean: false, syncRunning: false, ready: true),
            NativeAutomaticSyncGate(foreground: true, locked: false, busy: false, contextClean: true, syncRunning: true, ready: true),
            NativeAutomaticSyncGate(foreground: true, locked: false, busy: false, contextClean: true, syncRunning: false, ready: false),
        ]
        for gate in closed {
            XCTAssertFalse(gate.open)
            XCTAssertFalse(inbox.take(gate), "A closed gate refuses the sync: \(gate)")
            XCTAssertTrue(inbox.pending, "A refused push stays pending")
        }
        inbox.note()
        XCTAssertTrue(inbox.take(openGate), "Two pushes while closed start one sync")
        XCTAssertFalse(inbox.pending)
        XCTAssertFalse(inbox.take(openGate))
    }
}
