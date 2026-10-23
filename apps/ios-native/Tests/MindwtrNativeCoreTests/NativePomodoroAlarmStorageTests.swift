import Foundation
import XCTest
@testable import MindwtrNativeCore

final class NativePomodoroAlarmStorageTests: XCTestCase {
    private var container: URL!
    private var current: NativeDeviceKV?
    private let bundle = "tech.dongdongbh.mindwtr.pomodoro-alarm-tests"
    private let alarmName = "mindwtr:native:pomodoro-alarms:v1"
    private let backend = "@mindwtr_sync_backend"
    private var manifest: URL {
        container.appendingPathComponent("Library/Application Support/\(bundle)/RCTAsyncLocalStorage_V1/manifest.json")
    }
    private enum Injected: Error { case failure }

    override func setUpWithError() throws {
        #if os(macOS)
        let base = FileManager.default.homeDirectoryForCurrentUser
        #else
        let base = try XCTUnwrap(FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first)
        #endif
        container = base.appendingPathComponent(".mindwtr-native-tests/pomodoro-alarm-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: container, withIntermediateDirectories: true)
    }
    override func tearDownWithError() throws {
        current?.close(); current = nil
        if let container { try FileManager.default.removeItem(at: container) }
    }
    private func open() throws -> NativeDeviceKV {
        let store = try NativeDeviceKV(containerURL: container, bundleIdentifier: bundle)
        current = store
        return store
    }
    private func seed(_ value: String?) throws {
        var object = ["unknown": "keep", "mindwtr-data": "ordinary backup", "mindwtr:pomodoro-state": "legacy state"]
        if let value { object[alarmName] = value }
        try FileManager.default.createDirectory(at: manifest.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]).write(to: manifest)
    }
    private func bytes() throws -> Data { try Data(contentsOf: manifest) }

    func testCASPreservesUnrelatedValuesColdReadsAndSkipsExactNoop() throws {
        try seed(nil)
        let store = try open(), before = try bytes()
        XCTAssertNil(try store.readPomodoroAlarmState()); XCTAssertFalse(store.hasPendingPomodoroAlarmMutation)
        XCTAssertEqual(try bytes(), before)
        var promotions = 0; store.faults.beforePromotion = { promotions += 1 }
        XCTAssertThrowsError(try store.compareAndSetPomodoroAlarmState(expected: "", next: "after"))
        XCTAssertEqual(try bytes(), before); XCTAssertEqual(promotions, 0)
        try store.compareAndSetPomodoroAlarmState(expected: nil, next: "")
        XCTAssertEqual(try store.readPomodoroAlarmState(), "")
        XCTAssertThrowsError(try store.compareAndSetPomodoroAlarmState(expected: nil, next: "after"))
        let raw = "\u{FEFF}  raw state é e\u{301} 🧠\n"
        try store.compareAndSetPomodoroAlarmState(expected: "", next: raw)
        XCTAssertEqual(promotions, 2); XCTAssertFalse(store.hasPendingPomodoroAlarmMutation)
        let after = try bytes()
        store.faults.beforePromotion = { throw Injected.failure }
        try store.compareAndSetPomodoroAlarmState(expected: raw, next: raw)
        XCTAssertEqual(try bytes(), after); XCTAssertFalse(store.hasPendingPomodoroAlarmMutation)
        store.close(); current = nil
        let cold = try open()
        XCTAssertEqual(try cold.readPomodoroAlarmState().map { Data($0.utf8) }, Data(raw.utf8))
        XCTAssertEqual(try cold.get("unknown"), "keep")
        XCTAssertEqual(try cold.get("mindwtr-data"), "ordinary backup")
        XCTAssertEqual(try cold.get("mindwtr:pomodoro-state"), "legacy state")
    }

    func testCASUsesUnicodeBytesAndGenericMutationsCannotReachPrivateCell() throws {
        let composed = "café", decomposed = "cafe\u{301}"
        try seed(composed)
        let store = try open(), before = try bytes(); var promotions = 0
        store.faults.beforePromotion = { promotions += 1 }
        XCTAssertThrowsError(try store.compareAndSetPomodoroAlarmState(expected: decomposed, next: "after"))
        XCTAssertThrowsError(try store.set(alarmName, "after"))
        XCTAssertThrowsError(try store.remove(alarmName))
        XCTAssertThrowsError(try store.multiSet([(backend, "cloud"), (alarmName, "after")]))
        XCTAssertThrowsError(try store.multiRemove([backend, alarmName]))
        XCTAssertEqual(try bytes(), before); XCTAssertEqual(promotions, 0)
        try store.compareAndSetPomodoroAlarmState(expected: composed, next: decomposed)
        XCTAssertEqual(promotions, 1)
        XCTAssertEqual(try store.readPomodoroAlarmState().map { Data($0.utf8) }, Data(decomposed.utf8))
        XCTAssertThrowsError(try store.compareAndSetPomodoroAlarmState(expected: composed, next: composed))
        XCTAssertFalse(store.hasPendingPomodoroAlarmMutation)
    }

    func testUTF8BoundsRefuseBeforePublicationAndAcceptExactLimit() throws {
        try seed(nil)
        let store = try open(), before = try bytes(); var promotions = 0
        store.faults.beforePromotion = { promotions += 1 }
        for tooLarge in [String(repeating: "a", count: 1024 * 1024 + 1), String(repeating: "🧠", count: 262_145)] {
            XCTAssertThrowsError(try store.compareAndSetPomodoroAlarmState(expected: tooLarge, next: "after"))
            XCTAssertThrowsError(try store.compareAndSetPomodoroAlarmState(expected: nil, next: tooLarge))
        }
        XCTAssertEqual(try bytes(), before); XCTAssertEqual(promotions, 0); XCTAssertFalse(store.hasPendingPomodoroAlarmMutation)
        let boundary = String(repeating: "🧠", count: 262_144)
        try store.compareAndSetPomodoroAlarmState(expected: nil, next: boundary)
        XCTAssertEqual(try store.readPomodoroAlarmState()?.utf8.count, 1024 * 1024); XCTAssertEqual(promotions, 1)
        store.faults.beforePromotion = { throw Injected.failure }
        try store.compareAndSetPomodoroAlarmState(expected: boundary, next: boundary)
        XCTAssertFalse(store.hasPendingPomodoroAlarmMutation)
    }

    func testReadRefusesOversizedStateWithoutRepair() throws {
        try seed(String(repeating: "x", count: 1024 * 1024 + 1))
        let store = try open(), before = try bytes()
        XCTAssertThrowsError(try store.readPomodoroAlarmState())
        XCTAssertEqual(try bytes(), before); XCTAssertFalse(store.hasPendingPomodoroAlarmMutation)
    }

    func testPublicationFailureRetainsExactByteRequestUntilRetry() throws {
        let initial = "before", next = "cafe\u{301}"
        for cut in ["before", "after", "readback"] {
            try seed(initial)
            let store = try open(), original = try bytes(); var promotions = 0
            store.faults.beforePromotion = { promotions += 1; if cut == "before" { throw Injected.failure } }
            if cut == "after" { store.faults.afterPromotion = { throw Injected.failure } }
            if cut == "readback" { store.faults.beforeReadback = { throw Injected.failure } }
            XCTAssertThrowsError(try store.compareAndSetPomodoroAlarmState(expected: initial, next: next))
            XCTAssertTrue(store.hasPendingPomodoroAlarmMutation)
            XCTAssertFalse(store.hasPendingAppleRemindersImportMutation); XCTAssertFalse(store.hasPendingReminderMutation)
            XCTAssertFalse(store.hasPendingCalendarSettingMutation); XCTAssertFalse(store.hasPendingCalendarPushMutation)
            let uncertain = try bytes()
            if cut == "before" { XCTAssertEqual(uncertain, original) }
            XCTAssertThrowsError(try store.readPomodoroAlarmState())
            XCTAssertThrowsError(try store.compareAndSetPomodoroAlarmState(expected: initial, next: "café"))
            XCTAssertThrowsError(try store.compareAndSetPomodoroAlarmState(expected: next, next: next))
            XCTAssertThrowsError(try store.set(backend, "webdav"))
            XCTAssertEqual(try bytes(), uncertain); XCTAssertTrue(store.hasPendingPomodoroAlarmMutation)
            store.faults.beforePromotion = { promotions += 1 }; store.faults.afterPromotion = nil; store.faults.beforeReadback = nil
            try store.compareAndSetPomodoroAlarmState(expected: initial, next: next)
            XCTAssertFalse(store.hasPendingPomodoroAlarmMutation); XCTAssertEqual(promotions, cut == "before" ? 2 : 1)
            if cut != "before" { XCTAssertEqual(try bytes(), uncertain) }
            store.close(); current = nil
            let cold = try open()
            XCTAssertEqual(try cold.readPomodoroAlarmState().map { Data($0.utf8) }, Data(next.utf8))
            XCTAssertEqual(try cold.get("unknown"), "keep"); XCTAssertEqual(try cold.get("mindwtr:pomodoro-state"), "legacy state")
            cold.close(); current = nil
        }
    }

    func testCASRefusesUnrelatedPendingMutation() throws {
        try seed("before")
        let store = try open()
        store.faults.afterPromotion = { throw Injected.failure }
        XCTAssertThrowsError(try store.set(backend, "cloud")); XCTAssertFalse(store.hasPendingPomodoroAlarmMutation)
        let uncertain = try bytes()
        XCTAssertThrowsError(try store.compareAndSetPomodoroAlarmState(expected: "before", next: "after"))
        XCTAssertEqual(try bytes(), uncertain)
        store.faults.afterPromotion = nil; try store.set(backend, "cloud")
        XCTAssertEqual(try store.readPomodoroAlarmState(), "before")
    }
}
