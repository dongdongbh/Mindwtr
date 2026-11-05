import XCTest
import Foundation
import Darwin
import CryptoKit
@testable import MindwtrNativeCore
#if os(iOS)
import AVFoundation
import UIKit
#endif

/// Default tests use synthetic backends; the explicit physical selector uses the real microphone.
final class NativeVoiceRecorderTests: XCTestCase {
    private var root: URL!
    private var files: NativeAttachmentFiles!
    private enum FixtureError: Error { case failed }

    override func setUpWithError() throws {
        let support = try XCTUnwrap(FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first)
        let fixture = support.appendingPathComponent("NativeVoiceRecorderTests/" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: fixture, withIntermediateDirectories: true)
        guard let physical = Darwin.realpath(fixture.path, nil) else { throw FixtureError.failed }
        defer { free(physical) }
        root = URL(fileURLWithPath: String(cString: physical), isDirectory: true)
        files = try NativeAttachmentFiles(libraryRoot: root)
    }
    override func tearDownWithError() throws { if let root { try FileManager.default.removeItem(at: root) } }
    private var cache: URL { root.appendingPathComponent("attachment-files/cache", isDirectory: true) }
    private func entries() throws -> [URL] { try FileManager.default.contentsOfDirectory(at: cache, includingPropertiesForKeys: nil) }
    /// Fixture metadata only: never include any path or recorded content.
    private func entrySummary() throws -> String {
        try entries().map { url in
            var value = stat()
            guard Darwin.lstat(url.path, &value) == 0 else { return "unavailable" }
            let kind = value.st_mode & mode_t(S_IFMT)
            return "kind=\(kind),size=\(value.st_size),links=\(value.st_nlink)"
        }.sorted().joined(separator: ";")
    }
    private func digest(_ bytes: Data) -> String { SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined() }

    private actor PermissionGate {
        private var permission: CheckedContinuation<Bool, Never>?
        private var waiting: CheckedContinuation<Void, Never>?
        func request() async -> Bool {
            await withCheckedContinuation { continuation in
                permission = continuation; waiting?.resume(); waiting = nil
            }
        }
        func requested() async {
            if permission != nil { return }
            await withCheckedContinuation { waiting = $0 }
        }
        func resolve(_ value: Bool) { permission?.resume(returning: value); permission = nil }
    }
    private final class Adapter: NativeVoiceRecordingAdapter {
        let url: URL
        let event: @Sendable (NativeVoiceRecorderEvent) -> Void
        let startBytes: Data, closeBytes: Data
        let failStart: Bool, failClose: Bool
        private var writer: FileHandle?
        private(set) var closeCount = 0
        init(url: URL, event: @escaping @Sendable (NativeVoiceRecorderEvent) -> Void,
             startBytes: Data, closeBytes: Data, failStart: Bool, failClose: Bool) {
            self.url = url; self.event = event; self.startBytes = startBytes; self.closeBytes = closeBytes
            self.failStart = failStart; self.failClose = failClose
        }
        func start() throws {
            writer = try FileHandle(forWritingTo: url)
            try writer?.write(contentsOf: startBytes)
            if failStart { throw FixtureError.failed }
        }
        func close() throws {
            guard closeCount == 0 else { return }; closeCount += 1
            try writer?.write(contentsOf: closeBytes)
            try writer?.close(); writer = nil
            if failClose { throw FixtureError.failed }
        }
    }
    private final class Backend: NativeVoiceRecorderBackend, @unchecked Sendable {
        let permission: @Sendable () async -> Bool
        var startBytes = Data("synthetic AAC fixture".utf8), closeBytes = Data("-closed".utf8)
        var failStart = false, failClose = false
        var beforeCreate: ((URL) throws -> Void)?
        private(set) var adapter: Adapter?
        private(set) var made = 0
        init(permission: @escaping @Sendable () async -> Bool = { true }) { self.permission = permission }
        func requestPermission() async -> Bool { await permission() }
        func makeRecorder(at url: URL, onEvent: @escaping @Sendable (NativeVoiceRecorderEvent) -> Void) throws
            -> any NativeVoiceRecordingAdapter {
            try beforeCreate?(url)
            let selected = Adapter(url: url, event: onEvent, startBytes: startBytes, closeBytes: closeBytes,
                                   failStart: failStart, failClose: failClose)
            adapter = selected; made += 1; return selected
        }
    }
    private func session(_ recorder: NativeVoiceRecorder) async throws -> NativeVoiceRecordingSession {
        try await recorder.begin(presentationID: UUID(), captureID: UUID())
    }
    private func assertStopFailure(_ recorder: NativeVoiceRecorder, _ selected: NativeVoiceRecordingSession,
                                   _ expected: NativeVoiceRecordingError, file: StaticString = #filePath, line: UInt = #line) async {
        do { _ = try await recorder.stop(selected); XCTFail("Expected fixed refusal", file: file, line: line) }
        catch { XCTAssertEqual(error as? NativeVoiceRecordingError, expected, file: file, line: line) }
    }

    func testBeginDoesNotAskPermissionOrCreateFileAndDenialPreservesTextCapture() async throws {
        let backend = Backend(permission: { false }), recorder = NativeVoiceRecorder(files: files, backend: backend)
        let selected = try await session(recorder)
        XCTAssertTrue(try entries().isEmpty); XCTAssertEqual(backend.made, 0)
        do { try await recorder.start(selected); XCTFail("Permission denial must refuse") }
        catch { XCTAssertEqual(error as? NativeVoiceRecordingError, .permissionDenied) }
        XCTAssertTrue(try entries().isEmpty); XCTAssertEqual(backend.made, 0)
        await assertStopFailure(recorder, selected, .permissionDenied)
        XCTAssertFalse(FileManager.default.fileExists(atPath: files.managedRoot.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("core.sqlite.pending.json").path))
    }
    func testCancelDuringPermissionWaitFencesLateGrantWithoutStartingRecorder() async throws {
        let gate = PermissionGate(), backend = Backend(permission: { await gate.request() })
        let recorder = NativeVoiceRecorder(files: files, backend: backend), selected = try await session(recorder)
        let start = Task { try await recorder.start(selected) }
        await gate.requested(); try await recorder.cancel(selected); await gate.resolve(true)
        do { try await start.value; XCTFail("Cancelled owner cannot accept late permission") }
        catch { XCTAssertEqual(error as? NativeVoiceRecordingError, .cancelled) }
        XCTAssertEqual(backend.made, 0); XCTAssertTrue(try entries().isEmpty)
    }
    func testCancelledStartTaskCannotAcceptLatePermissionGrant() async throws {
        let gate = PermissionGate(), backend = Backend(permission: { await gate.request() })
        let recorder = NativeVoiceRecorder(files: files, backend: backend), selected = try await session(recorder)
        let start = Task { try await recorder.start(selected) }
        await gate.requested(); start.cancel(); await gate.resolve(true)
        do { try await start.value; XCTFail("Cancelled task cannot start microphone") }
        catch { XCTAssertEqual(error as? NativeVoiceRecordingError, .cancelled) }
        XCTAssertEqual(backend.made, 0); XCTAssertTrue(try entries().isEmpty)
    }
    func testStopDrainsFinalBytesReturnsOneImmutableSourceAndLaterCancelKeepsIt() async throws {
        let backend = Backend(), recorder = NativeVoiceRecorder(files: files, backend: backend)
        let selected = try await session(recorder); try await recorder.start(selected)
        let first = try await recorder.stop(selected), second = try await recorder.stop(selected)
        let bytes = backend.startBytes + backend.closeBytes, url = try XCTUnwrap(URL(string: first.proof.sourceURI))
        XCTAssertEqual(backend.adapter?.closeCount, 1); XCTAssertEqual(first.proof.identity, second.proof.identity)
        XCTAssertEqual(first.session, selected); XCTAssertEqual(first.mimeType, "audio/mp4"); XCTAssertEqual(first.size, Int64(bytes.count))
        XCTAssertEqual(first.sha256, digest(bytes)); XCTAssertEqual(try Data(contentsOf: url), bytes)
        XCTAssertTrue(first.receipt.matches(first.proof)); try files.requireProviderSource(first.receipt)
        try await recorder.cancel(selected, reason: .backgrounded)
        XCTAssertEqual(try Data(contentsOf: url), bytes)
        let removed = try await recorder.retire(first), absent = try await recorder.retire(first)
        XCTAssertEqual(removed, .removed); XCTAssertEqual(absent, .absent); XCTAssertTrue(try entries().isEmpty)
    }
    func testSelectedOwnerRejectsOtherRecorderAndCannotCreateSecondLiveSession() async throws {
        let backend = Backend(), recorder = NativeVoiceRecorder(files: files, backend: backend)
        let other = NativeVoiceRecorder(files: files, backend: Backend()), selected = try await session(recorder)
        do { try await other.start(selected); XCTFail("Foreign recording handle") }
        catch { XCTAssertEqual(error as? NativeVoiceRecordingError, .stale) }
        do { _ = try await session(recorder); XCTFail("One session only") }
        catch { XCTAssertEqual(error as? NativeVoiceRecordingError, .stale) }
        XCTAssertTrue(try entries().isEmpty); XCTAssertEqual(backend.made, 0)
    }
    func testCancelClosesBeforeExactCleanupAndKeepsUnrelatedCacheEntry() async throws {
        let sentinel = cache.appendingPathComponent("foreign-sentinel"), bytes = Data("keep".utf8)
        try bytes.write(to: sentinel)
        let backend = Backend(), recorder = NativeVoiceRecorder(files: files, backend: backend), selected = try await session(recorder)
        try await recorder.start(selected); try await recorder.cancel(selected); try await recorder.cancel(selected)
        XCTAssertEqual(backend.adapter?.closeCount, 1); XCTAssertEqual(try entries(), [sentinel])
        XCTAssertEqual(try Data(contentsOf: sentinel), bytes)
        await assertStopFailure(recorder, selected, .cancelled)
    }
    func testFactoryAndCloseFailuresDrainAndRetireOnlyCreatedSource() async throws {
        var factoryReached = 0, unlinkReached = 0
        files.beforeRetirementUnlink = { unlinkReached += 1 }
        defer { files.beforeRetirementUnlink = nil }
        let failedFactory = Backend(); failedFactory.beforeCreate = { _ in factoryReached += 1; throw FixtureError.failed }
        let failedOwner = NativeVoiceRecorder(files: files, backend: failedFactory), failedSession = try await session(failedOwner)
        do { try await failedOwner.start(failedSession); XCTFail("Factory fixture failure") }
        catch { XCTAssertEqual(error as? NativeVoiceRecordingError, .unavailable) }
        let firstSummary = try entrySummary()
        XCTAssertEqual(factoryReached, 1, "Factory hook admission; remaining fixture metadata: \(firstSummary)")
        XCTAssertEqual(unlinkReached, 1, "Creation cleanup hook; remaining fixture metadata: \(firstSummary)")
        XCTAssertEqual(failedFactory.made, 0); XCTAssertTrue(try entries().isEmpty, firstSummary)
        for closeFailure in [false, true] {
            let previousEntries = try entries().count, previousUnlinks = unlinkReached
            let backend = Backend(); backend.failStart = !closeFailure; backend.failClose = closeFailure
            let recorder = NativeVoiceRecorder(files: files, backend: backend), selected = try await session(recorder)
            if closeFailure {
                try await recorder.start(selected); await assertStopFailure(recorder, selected, .unavailable)
            } else {
                do { try await recorder.start(selected); XCTFail("Start fixture failure") }
                catch { XCTAssertEqual(error as? NativeVoiceRecordingError, .unavailable) }
            }
            let summary = try entrySummary()
            XCTAssertEqual(unlinkReached - previousUnlinks, 1, "Subcase cleanup hook; remaining fixture metadata: \(summary)")
            XCTAssertEqual(try entries().count, previousEntries, "Subcase must remove its new entry: \(summary)")
            XCTAssertEqual(backend.adapter?.closeCount, 1); XCTAssertTrue(try entries().isEmpty, summary)
        }
    }
    func testExactRawLimitIsAcceptedAndOversizeOrEmptyStopsRefuseWithoutReceipt() async throws {
        for size in [NativeVoiceRecorder.maximumAudioBytes, NativeVoiceRecorder.maximumAudioBytes + 1, 0] {
            let backend = Backend(); backend.startBytes = Data(repeating: 0x2a, count: size); backend.closeBytes = Data()
            let recorder = NativeVoiceRecorder(files: files, backend: backend), selected = try await session(recorder)
            try await recorder.start(selected)
            if size == NativeVoiceRecorder.maximumAudioBytes {
                let source = try await recorder.stop(selected)
                XCTAssertEqual(source.size, Int64(size)); _ = try await recorder.retire(source)
            } else { await assertStopFailure(recorder, selected, size == 0 ? .emptyRecording : .tooLarge) }
            XCTAssertEqual(backend.adapter?.closeCount, 1); XCTAssertTrue(try entries().isEmpty)
        }
    }
    func testLiveOversizeMonitorClosesAndCancelsWithoutAcceptingSource() async throws {
        let backend = Backend(); backend.startBytes = Data(repeating: 0x2a, count: NativeVoiceRecorder.maximumAudioBytes + 1)
        backend.closeBytes = Data()
        let recorder = NativeVoiceRecorder(files: files, backend: backend), selected = try await session(recorder)
        try await recorder.start(selected)
        for _ in 0..<200 {
            if backend.adapter?.closeCount == 1 { break }
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        XCTAssertEqual(backend.adapter?.closeCount, 1)
        await assertStopFailure(recorder, selected, .tooLarge)
        XCTAssertTrue(try entries().isEmpty)
    }
    func testInterruptionBackgroundAndRouteLossCancelUnsavedRecording() async throws {
        let events: [(NativeVoiceRecorderEvent, NativeVoiceRecordingError)] = [(.interrupted, .interrupted),
            (.backgrounded, .backgrounded), (.routeLost, .routeLost), (.failed, .unavailable)]
        for (event, expected) in events {
            let backend = Backend(), recorder = NativeVoiceRecorder(files: files, backend: backend), selected = try await session(recorder)
            try await recorder.start(selected); try XCTUnwrap(backend.adapter).event(event)
            for _ in 0..<100 {
                if backend.adapter?.closeCount == 1 { break }
                try await Task.sleep(nanoseconds: 1_000_000)
            }
            XCTAssertEqual(backend.adapter?.closeCount, 1)
            await assertStopFailure(recorder, selected, expected); XCTAssertTrue(try entries().isEmpty)
        }
    }
    func testReplacedFactoryOutputIsClosedAndRetainedRatherThanAdopted() async throws {
        let backend = Backend(), displaced = root.appendingPathComponent("displaced-reservation")
        backend.beforeCreate = { url in
            try FileManager.default.moveItem(at: url, to: displaced)
            try Data("foreign generation".utf8).write(to: url)
        }
        let recorder = NativeVoiceRecorder(files: files, backend: backend), selected = try await session(recorder)
        do { try await recorder.start(selected); XCTFail("Factory replaced reserved inode") }
        catch { XCTAssertEqual(error as? NativeVoiceRecordingError, .unavailable) }
        XCTAssertEqual(backend.adapter?.closeCount, 1); XCTAssertTrue(FileManager.default.fileExists(atPath: displaced.path))
        XCTAssertEqual(try entries().count, 1); XCTAssertFalse(FileManager.default.fileExists(atPath: files.managedRoot.path))
    }
    func testStoppedSourceReplacementCannotBeRetiredOrConfusedWithOriginal() async throws {
        let backend = Backend(), recorder = NativeVoiceRecorder(files: files, backend: backend), selected = try await session(recorder)
        try await recorder.start(selected); let source = try await recorder.stop(selected)
        let url = try XCTUnwrap(URL(string: source.proof.sourceURI)), original = root.appendingPathComponent("original-source")
        let bytes = try Data(contentsOf: url)
        try FileManager.default.moveItem(at: url, to: original); try bytes.write(to: url)
        let outcome = try await recorder.retire(source)
        XCTAssertEqual(outcome, .generationChanged); XCTAssertEqual(try Data(contentsOf: url), bytes)
        XCTAssertEqual(try Data(contentsOf: original), bytes)
    }

    #if os(iOS)
    @MainActor private final class PermissionApplication {
        var state: UIApplication.State = .inactive
        var reads = 0
        let notifications = NotificationCenter()
        func read() -> UIApplication.State { reads += 1; return state }
    }

    @MainActor func testGrantedMicrophonePermissionWaitsForInactivePromptToBecomeActive() async throws {
        let application = PermissionApplication()
        let backend = NativeAVAudioRecorderBackend(permissionRequest: { true },
            applicationState: { application.read() }, notifications: application.notifications, foregroundTimeout: 1)
        let request = Task { try await backend.requestPermission() }
        for _ in 0..<1000 {
            if application.reads > 0 { break }
            await Task.yield()
        }
        XCTAssertGreaterThan(application.reads, 0)
        application.state = .active
        application.notifications.post(name: UIApplication.didBecomeActiveNotification, object: nil)
        let granted = try await request.value
        XCTAssertTrue(granted)
        XCTAssertTrue(try entries().isEmpty)
    }

    @MainActor func testMicrophonePermissionRejectsObservedBackgroundEvenAfterReturningActive() async throws {
        let application = PermissionApplication(), permission = PermissionGate()
        let backend = NativeAVAudioRecorderBackend(permissionRequest: { await permission.request() },
            applicationState: { application.read() }, notifications: application.notifications, foregroundTimeout: 1)
        let request = Task { try await backend.requestPermission() }
        await permission.requested()
        application.state = .background
        application.notifications.post(name: UIApplication.didEnterBackgroundNotification, object: nil)
        application.state = .active
        await permission.resolve(true)
        do { _ = try await request.value; XCTFail("A backgrounded permission request must remain rejected") }
        catch { XCTAssertEqual(error as? NativeVoiceRecordingError, .backgrounded) }
        XCTAssertTrue(try entries().isEmpty)
    }

    @MainActor func testMicrophonePermissionRejectsActiveStateReadAfterForegroundDeadline() async throws {
        let application = PermissionApplication()
        let backend = NativeAVAudioRecorderBackend(permissionRequest: { true }, applicationState: {
            if application.reads > 0 {
                Thread.sleep(forTimeInterval: 0.1)
                application.state = .active
            }
            return application.read()
        }, notifications: application.notifications, foregroundTimeout: 0.05)
        do { _ = try await backend.requestPermission(); XCTFail("Late activation cannot bypass the foreground deadline") }
        catch { XCTAssertEqual(error as? NativeVoiceRecordingError, .unavailable) }
        XCTAssertEqual(application.reads, 2)
        XCTAssertEqual(application.state, .active)
        XCTAssertTrue(try entries().isEmpty)
    }

    @MainActor func testMicrophonePermissionRejectsBackgroundDuringInactiveReadmission() async throws {
        let application = PermissionApplication()
        let backend = NativeAVAudioRecorderBackend(permissionRequest: { true },
            applicationState: { application.read() }, notifications: application.notifications, foregroundTimeout: 1)
        let request = Task { try await backend.requestPermission() }
        for _ in 0..<1000 {
            if application.reads > 0 { break }
            await Task.yield()
        }
        XCTAssertGreaterThan(application.reads, 0)
        application.notifications.post(name: UIApplication.didEnterBackgroundNotification, object: nil)
        application.state = .active
        do { _ = try await request.value; XCTFail("Foreground return cannot erase a background transition") }
        catch { XCTAssertEqual(error as? NativeVoiceRecordingError, .backgrounded) }
        XCTAssertTrue(try entries().isEmpty)
    }

    @MainActor func testMicrophonePermissionBackgroundStateTimeoutAndDenialDoNotStartRecording() async throws {
        for state in [UIApplication.State.background, .inactive] {
            let application = PermissionApplication(); application.state = state
            let backend = NativeAVAudioRecorderBackend(permissionRequest: { true },
                applicationState: { application.read() }, notifications: application.notifications, foregroundTimeout: 0)
            do { _ = try await backend.requestPermission(); XCTFail("A nonactive permission request cannot start recording") }
            catch { XCTAssertEqual(error as? NativeVoiceRecordingError, state == .background ? .backgrounded : .unavailable) }
        }
        let application = PermissionApplication()
        let denied = NativeAVAudioRecorderBackend(permissionRequest: { false },
            applicationState: { application.read() }, notifications: application.notifications, foregroundTimeout: 0)
        let granted = try await denied.requestPermission()
        XCTAssertFalse(granted); XCTAssertEqual(application.reads, 0)
        XCTAssertTrue(try entries().isEmpty)
    }

    @MainActor func testMicrophonePermissionInactiveWaitHonorsTaskAndSessionCancellation() async throws {
        let application = PermissionApplication()
        let backend = NativeAVAudioRecorderBackend(permissionRequest: { true },
            applicationState: { application.read() }, notifications: application.notifications, foregroundTimeout: 1)
        let request = Task { try await backend.requestPermission() }
        for _ in 0..<1000 {
            if application.reads > 0 { break }
            await Task.yield()
        }
        XCTAssertGreaterThan(application.reads, 0)
        request.cancel()
        do { _ = try await request.value; XCTFail("A cancelled permission waiter cannot be admitted") }
        catch { XCTAssertEqual(error as? NativeVoiceRecordingError, .cancelled) }
        let permission = PermissionGate()
        let pending = NativeAVAudioRecorderBackend(permissionRequest: { await permission.request() },
            applicationState: { application.read() }, notifications: application.notifications, foregroundTimeout: 1)
        let recorder = NativeVoiceRecorder(files: files, backend: pending), selected = try await session(recorder)
        let start = Task { try await recorder.start(selected) }
        await permission.requested()
        try await recorder.cancel(selected)
        application.state = .active
        await permission.resolve(true)
        do { try await start.value; XCTFail("Session cancellation fences a late foreground grant") }
        catch { XCTAssertEqual(error as? NativeVoiceRecordingError, .cancelled) }
        XCTAssertTrue(try entries().isEmpty)
    }
    #endif

    #if os(iOS) && NATIVE_DEVICE_TEST && !targetEnvironment(simulator)
    func testPhysicalMicrophoneTwoSecondsThenCancelWithoutAI() async throws {
        guard !(Bundle.main.object(forInfoDictionaryKey: "NSMicrophoneUsageDescription") as? String ?? "").isEmpty else {
            XCTFail("The recording process needs its own microphone purpose string"); return
        }
        let recordingBundle = try XCTUnwrap(Bundle.main.bundleIdentifier)
        guard recordingBundle == "tech.dongdongbh.mindwtr.uitests.xctrunner" else {
            XCTFail("Unexpected physical recording process"); return
        }
        await MainActor.run {
            XCUIApplication(bundleIdentifier: recordingBundle).activate()
        }
        guard await MainActor.run(body: { UIApplication.shared.applicationState == .active }) else {
            XCTFail("The recording process must be foreground and active"); return
        }
        let recorder = NativeVoiceRecorder(files: files, backend: NativeAVAudioRecorderBackend())
        let selected = try await session(recorder)
        addTeardownBlock { try? await recorder.cancel(selected) }
        let stream = try await recorder.events(selected)
        var events = stream.makeAsyncIterator()
        let permissionBefore = AVAudioSession.sharedInstance().recordPermission
        print("PHYSICAL_MICROPHONE permissionBefore=\(permissionBefore.rawValue)")
        try await recorder.start(selected)
        let recording = await events.next()
        guard recording == .recording else { XCTFail("Real recorder did not enter recording"); return }
        XCTAssertEqual(AVAudioSession.sharedInstance().recordPermission, .granted)
        let started = ProcessInfo.processInfo.systemUptime
        try await Task.sleep(nanoseconds: 2_000_000_000)
        let elapsed = ProcessInfo.processInfo.systemUptime - started
        XCTAssertGreaterThanOrEqual(elapsed, 1.9)
        let owned = try entries()
        XCTAssertEqual(owned.count, 1)
        if let url = owned.first {
            let metadata = try FileManager.default.attributesOfItem(atPath: url.path)
            XCTAssertGreaterThan((metadata[.size] as? NSNumber)?.int64Value ?? 0, 0)
        }
        try await recorder.cancel(selected)
        let cancelled = await events.next()
        XCTAssertEqual(cancelled, .cancelled)
        XCTAssertTrue(try entries().isEmpty)
        await assertStopFailure(recorder, selected, .cancelled)
        print("PHYSICAL_MICROPHONE outcome=cancelled elapsedMs=\(Int(elapsed * 1000)) providerPath=absent")
    }
    #endif
}
