import SwiftUI
import CoreSpotlight
import LocalAuthentication
import UIKit
import MindwtrNativeCore
import MindwtrWatchPayloadValidation
import UserNotifications


enum NativeAppLaunch {
    static let arguments = ProcessInfo.processInfo.arguments
    static let reminderRoute = Result { try NativePersonalIntakeRoute.current() }
    static let selection: Result<NativeLaunchSelection, Error> = {
        let identifier = Bundle.main.bundleIdentifier
        #if targetEnvironment(simulator)
        #if DEBUG
        let mode = NativeLaunchSelection.BuildMode.simulatorDebug
        #else
        let mode = NativeLaunchSelection.BuildMode.simulatorRelease
        #endif
        #elseif DEBUG && NATIVE_DEVICE_TEST
        guard identifier == "tech.dongdongbh.mindwtr.native.dev" else {
            return .failure(LaunchFailure.developmentBundleRequired)
        }
        let mode = NativeLaunchSelection.BuildMode.deviceTest
        #else
        let mode = NativeLaunchSelection.BuildMode.production
        #endif
        return Result {
            let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                appropriateFor: nil, create: false)
            return try NativeLaunchSelection.resolve(arguments: arguments, bundleIdentifier: identifier,
                supportURL: support, homeURL: URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true), mode: mode)
        }
    }()

    private enum LaunchFailure: LocalizedError {
        case developmentBundleRequired
        var errorDescription: String? {
            switch self {
            case .developmentBundleRequired: return "Physical testing requires the isolated native development app."
            }
        }
    }
}

/// One pre-host owner; a failed open is retried only by a later explicit capture or startup.
/// One synchronous native marker, bound before settlement and transferred before it is removed.
private final class NativeNavigationFinishRelay: @unchecked Sendable {
    struct Identity: Sendable {
        let owner: UUID
        let writer: NativePersonalIntake
        let reservation: String?
        let item: NativePersonalIntake.Item
        let outcome: NativePersonalIntake.Outcome
        func matches(_ other: Identity) -> Bool {
            owner == other.owner && writer === other.writer && reservation == other.reservation
                && item.id == other.item.id && item.kind == other.item.kind
                && item.sequence == other.item.sequence && item.receivedAtMs == other.item.receivedAtMs
                && outcome == other.outcome
        }
    }
    private let lock = NSLock()
    private var identity: Identity?
    private var marker: NativePersonalIntake.Diagnostic?
    private var sameTreeReopenMarker: NativePersonalIntake.Diagnostic?
    private var shareImportMarker: NativePersonalIntake.Diagnostic?
    func arm(_ value: Identity) throws {
        lock.lock(); defer { lock.unlock() }
        guard identity == nil || identity?.matches(value) == true else { throw NativePersonalIntakeError.pendingPublication }
        identity = value
    }
    func retainedSameTreeReopen() -> NativePersonalIntake.Diagnostic? {
        lock.lock(); defer { lock.unlock() }; return sameTreeReopenMarker
    }
    func retainedShareImport() -> NativePersonalIntake.Diagnostic? {
        lock.lock(); defer { lock.unlock() }; return shareImportMarker
    }
    func deliveredShareImport(_ value: NativePersonalIntake.Diagnostic) {
        lock.lock(); defer { lock.unlock() }
        if shareImportMarker?.releaseCheck == value.releaseCheck && shareImportMarker?.operation == value.operation
            && shareImportMarker?.message == value.message && shareImportMarker?.outcome == value.outcome { shareImportMarker = nil }
    }
    func receive(_ value: NativePersonalIntake.Diagnostic) {
        if value.operation == "share-import" {
            guard value.message == "Native iOS share intake confirmed", value.releaseCheck == "v1.3.8/ios-share-text-url",
                  value.outcome == "confirmed" else { return }
            lock.lock(); defer { lock.unlock() }
            if shareImportMarker == nil { shareImportMarker = value }
            return
        }
        if value.operation == "same-tree-reopen" {
            guard value.message == "Native iOS personal intake reopened after container relocation",
                  value.releaseCheck == "v1.3.8/ios-intake-same-tree-reopen", value.outcome == "confirmed" else { return }
            lock.lock(); defer { lock.unlock() }
            if sameTreeReopenMarker == nil { sameTreeReopenMarker = value }
            return
        }
        guard value.operation == "finish-settlement" else { return }
        lock.lock(); defer { lock.unlock() }
        guard let identity, value.outcome == identity.outcome.rawValue,
              value.releaseCheck == "v1.3.8/ios-navigation-finish-settlement",
              value.message == "Native iOS navigation finish settlement confirmed" else { return }
        if marker == nil { marker = value }
    }
    func retained(_ value: Identity) throws -> NativePersonalIntake.Diagnostic? {
        lock.lock(); defer { lock.unlock() }
        guard identity?.matches(value) == true else { throw NativePersonalIntakeError.unavailable }
        return marker
    }
    func transferred(_ value: Identity) throws {
        lock.lock(); defer { lock.unlock() }
        guard identity?.matches(value) == true, marker != nil else { throw NativePersonalIntakeError.unavailable }
        marker = nil; identity = nil
    }
}

actor NativeNotificationResponses {
    struct Diagnostic: Sendable { let action: String; let outcome: String }
    typealias Wake = @MainActor @Sendable () -> Void
    enum HandoverFailure: Error { case refused, held }
    private enum Mode: String { case unchecked, checking, legacy, preparing, held, blocked }
    private final class PendingCapture {
        let response: NativeReminderResponse
        var wake: Wake?
        var callbackManaged: Bool
        var enteredLegacy = false
        var completions: [NativeReminderCallbackCompletion] = []
        init(_ response: NativeReminderResponse, wake: Wake?, callbackManaged: Bool) {
            self.response = response; self.wake = wake; self.callbackManaged = callbackManaged
        }
    }
    private final class Preparation {
        let id = UUID()
        let source: NativeReminderInbox?
        let publisher: Task<Void, Never>?
        let cold: Bool
        var nativeStarted: Bool
        init(source: NativeReminderInbox?, publisher: Task<Void, Never>?, cold: Bool, nativeStarted: Bool = false) {
            self.source = source; self.publisher = publisher; self.cold = cold; self.nativeStarted = nativeStarted
        }
    }
    static let shared = NativeNotificationResponses()
    static let changed = Notification.Name("MindwtrNativeNotificationResponsesChanged")
    private var mode = Mode.unchecked
    private var storage: NativeReminderInbox?
    private var intake: NativePersonalIntake?
    private let navigationFinishRelay = NativeNavigationFinishRelay()
    private var preparation: Preparation?
    private var coldTask: Task<Void, Error>?
    private var coldUncertain = false
    private var publisher: Task<Void, Never>?
    private var publisherID: UUID?
    private var publisherFailed = false
    private var legacyOperations = 0
    private var legacyWaiters: [CheckedContinuation<Void, Never>] = []
    // shortcut: no eviction; RAM is O(unconfirmed distinct deliveries). OS completion is not durable ACK;
    // process death before the first durable write can lose those envelopes. A second spool is out of scope.
    private var pendingCaptures: [String: PendingCapture] = [:]
    private var captureOrder: [String] = []
    private var diagnostics: [Diagnostic] = []
    private(set) var handoverDiagnostic: [String: String]?
    private var heldPersonalReplay = false
    private struct HeldReminderDispatch {
        let admitted: NativePersonalIntake.Item
        let dispatch: NativeReminderInbox.Item
        var outcome: NativePersonalIntake.Outcome?
    }
    private var heldReminderDispatches: [String: HeldReminderDispatch] = [:]

    #if DEBUG && targetEnvironment(simulator)
    private var moreTestCaptured = false
    func captureMoreTestResponse() async throws {
        let fixtureMode = ProcessInfo.processInfo.environment["MINDWTR_RESPONSE_TEST_MORE"] ?? ""
        guard !moreTestCaptured, ["1", "context"].contains(fixtureMode),
              case let .isolated(_, _, namespace, _) = try NativeAppLaunch.selection.get() else { return }
        guard mode == .legacy else { return }
        moreTestCaptured = true
        let content = UNMutableNotificationContent()
        let data = fixtureMode == "context"
            ? ["alarmKey": "task:task452-preview", "kind": "context-automation", "context": " @office "]
            : ["alarmKey": "task:task452-preview", "taskId": "task452-preview"]
        content.userInfo = ["mindwtrNativeReminder": ["version": 1, "namespace": namespace, "id": 452], "data": data]
        let request = UNNotificationRequest(identifier: "mindwtr-native:\(namespace):452", content: content, trigger: nil)
        let now = Date()
        guard let response = NativeReminderResponse.capture(request, deliveredAt: now, receivedAt: now,
            actionIdentifier: UNNotificationDefaultActionIdentifier, namespace: namespace) else { throw CocoaError(.coderInvalidValue) }
        _ = try retain(response, wake: {
            // The fixture uses the same publisher and original callback tail as the real delegate.
            NativeAppModel.shared.requestNotificationResponses()
        }, callbackManaged: true)
        if publisher == nil { publisherFailed = false; startPublisher() }
    }
    #endif


    func record(_ action: NativeReminderResponse.Action, outcome: String) {
        if diagnostics.count == 128 { diagnostics.removeFirst() }
        diagnostics.append(.init(action: action.rawValue, outcome: outcome))
    }
    func takeDiagnostics() -> [Diagnostic] { defer { diagnostics.removeAll() }; return diagnostics }
    private func trustedNamespace() throws -> String {
        switch try NativeAppLaunch.selection.get() {
        case .production: return NativeLaunchSelection.productionNamespace
        case let .standard(_, _, name), let .isolated(_, _, name, _): return name
        case .rehearsal: throw HandoverFailure.held
        }
    }
    private func retain(_ response: NativeReminderResponse, wake: Wake?, callbackManaged: Bool, completion: NativeReminderCallbackCompletion? = nil) throws -> PendingCapture {
        try NativeReminderInbox.validateForPersonalIntake(response, namespace: trustedNamespace())
        if let original = pendingCaptures[response.requestID] {
            guard original.response.notificationIdentifier == response.notificationIdentifier,
                  original.response.action == response.action, original.response.deliveredAtBits == response.deliveredAtBits else {
                throw HandoverFailure.held
            }
            if original.wake == nil { original.wake = wake }
            original.callbackManaged = original.callbackManaged || callbackManaged
            original.completions.removeAll { $0.isFinished }
            if let completion { original.completions.append(completion) }
            return original
        }
        let entry = PendingCapture(response, wake: wake, callbackManaged: callbackManaged)
        if let completion { entry.completions.append(completion) }
        pendingCaptures[response.requestID] = entry; captureOrder.append(response.requestID)
        return entry
    }
    /// The delegate owns OS completion separately; after this call the original validated envelope stays here.
    fileprivate func receive(_ response: NativeReminderResponse, wake: Wake?, completion: NativeReminderCallbackCompletion) {
        do {
            _ = try retain(response, wake: wake, callbackManaged: true, completion: completion)
            if publisher == nil { publisherFailed = false; startPublisher() }
        }
        catch { record(response.action, outcome: "capture-refused") }
    }
    private func ensureCold() async throws {
        if let coldTask { try await coldTask.value; return }
        if mode == .legacy || mode == .held || (mode == .preparing && preparation?.cold == false) { return }
        let task = Task { try await inspectCold() }; coldTask = task
        do { try await task.value; coldTask = nil }
        catch { coldTask = nil; throw error }
    }
    private func inspectCold() async throws {
        mode = .checking
        do {
            let route = try NativeAppLaunch.reminderRoute.get()
            if intake == nil { intake = try NativePersonalIntake.openExisting(route: route, diagnostic: { [relay = navigationFinishRelay] in relay.receive($0) }) }
            if let intake {
                let progress = try await intake.requiresReminderPreparation()
                if progress {
                    coldUncertain = true
                    if storage == nil { storage = try NativeReminderInbox.openExistingForHandover(selection: route.selection) }
                    let owner = preparation ?? Preparation(source: storage, publisher: nil, cold: true, nativeStarted: true)
                    preparation = owner; mode = .preparing
                    guard let original = owner.source else { throw HandoverFailure.held }
                    try await original.handoverCaptures(into: intake, route: route)
                    guard preparation === owner, storage === original else { throw HandoverFailure.held }
                    mode = .held; bufferHandover(); return
                }
                guard !coldUncertain else { throw HandoverFailure.held }
                // No reminder preparation says nothing about the same writer's navigation claim.
            } else { guard !coldUncertain else { throw HandoverFailure.held } }
            // A definitive no-progress observation permits the ordinary original owner only.
            do { storage = try NativeReminderInbox(selection: route.selection) }
            catch { mode = .unchecked; throw HandoverFailure.refused }
            preparation = nil; mode = .legacy
        } catch HandoverFailure.refused { throw HandoverFailure.refused }
        catch { coldUncertain = true; mode = .blocked; throw HandoverFailure.held }
    }
    /// No model/Host await: startup can safely call this before creating its first CoreHost.
    func startupHeld() async -> Bool {
        do {
            try await ensureCold()
            if publisher == nil { publisherFailed = false; startPublisher() }
            return mode != .legacy
        }
        catch HandoverFailure.refused { return false } // No intake progress; ordinary startup may create its selected library first.
        catch { return true }
    }

    var sameTreeReopenDiagnostic: NativePersonalIntake.Diagnostic? { navigationFinishRelay.retainedSameTreeReopen() }

    /// Existing-only and independent of Host/reminder startup; unknown state never means ordinary navigation.
    func navigationReservationID() async throws -> String? {
        let route = try NativeAppLaunch.reminderRoute.get()
        if intake == nil { intake = try NativePersonalIntake.openExisting(route: route, diagnostic: { [relay = navigationFinishRelay] in relay.receive($0) }) }
        return try await intake?.navigationReservationID()
    }
    func reserveNavigationCapture(id: String) async throws -> String {
        let route = try NativeAppLaunch.reminderRoute.get()
        if intake == nil { intake = try NativePersonalIntake(route: route, diagnostic: { [relay = navigationFinishRelay] in relay.receive($0) }) }
        guard let intake else { throw HandoverFailure.held }
        let claim = try await intake.reserveNavigationCapture(id: id)
        #if DEBUG && (targetEnvironment(simulator) || NATIVE_DEVICE_TEST)
        if navigationFixtureFault {
            await intake.setIOFaults(afterPublication: { if $0 != "state.json" { throw CocoaError(.fileWriteUnknown) } })
        }
        #endif
        return claim
    }
    func captureNavigation(_ event: NativePersonalIntakeEvent, reservation: String) async throws -> NativePersonalIntake.Item {
        guard event.kind != .reminder, let intake else { throw HandoverFailure.held }
        try await intake.retry()
        guard try await intake.navigationReservationID() == reservation else { throw HandoverFailure.held }
        return try await intake.capture(event)
    }
    struct NavigationReplayStorage: Sendable {
        let writer: NativePersonalIntake
        let reservation: String
    }
    struct NavigationFinishProof: Sendable {
        let receipt: NativePersonalIntake.FinishSettlement
        let diagnostic: NativePersonalIntake.Diagnostic?
    }
    func navigationReplayStorage(reservation: String) async throws -> NavigationReplayStorage {
        guard let original = intake else { throw HandoverFailure.held }
        try await original.retry()
        guard intake === original, try await original.navigationReservationID() == reservation else { throw HandoverFailure.held }
        return .init(writer: original, reservation: reservation)
    }
    func settleNavigationFinish(_ item: NativePersonalIntake.Item, outcome: NativePersonalIntake.Outcome,
                                storage: NavigationReplayStorage, owner: UUID) async throws -> NavigationFinishProof {
        guard intake === storage.writer else { throw HandoverFailure.held }
        let identity = NativeNavigationFinishRelay.Identity(owner: owner, writer: storage.writer,
            reservation: storage.reservation, item: item, outcome: outcome)
        try navigationFinishRelay.arm(identity)
        let receipt = try await storage.writer.settleFinish(item, outcome: outcome)
        guard intake === storage.writer, receipt.id == item.id, receipt.kind == item.kind,
              receipt.sequence == item.sequence, receipt.receivedAtMs == item.receivedAtMs,
              receipt.outcome == outcome else { throw HandoverFailure.held }
        return .init(receipt: receipt, diagnostic: try navigationFinishRelay.retained(identity))
    }
    /// The App owner must retain both receipt and marker debt before releasing this native relay.
    func transferredNavigationFinish(_ item: NativePersonalIntake.Item, outcome: NativePersonalIntake.Outcome,
                                     storage: NavigationReplayStorage, owner: UUID) throws {
        guard intake === storage.writer else { throw HandoverFailure.held }
        try navigationFinishRelay.transferred(.init(owner: owner, writer: storage.writer,
            reservation: storage.reservation, item: item, outcome: outcome))
    }
    struct ShareCaptureStorage: Sendable { let writer: NativePersonalIntake }
    func shareCaptureStorage(reservation: String? = nil) async throws -> ShareCaptureStorage? {
        let intakeRoute = try NativeAppLaunch.reminderRoute.get()
        guard let route = NativeShareMailbox.Route.app(selection: try NativeAppLaunch.selection.get(),
                  bundleIdentifier: Bundle.main.bundleIdentifier), route.appIdentifier == intakeRoute.namespace else { return nil }
        try await ensureCold()
        let reminder: NativeReminderInbox?
        let heldWriter: NativePersonalIntake?
        if let reservation {
            guard !reservation.isEmpty, mode == .held, heldPersonalReplay, !publisherFailed,
                  let original = intake, let source = storage else { throw HandoverFailure.held }
            reminder = source; heldWriter = original
            try await validateShareCaptureStorage(original, reminder: source, reservation: reservation)
        } else {
            guard mode == .legacy, preparation == nil, !publisherFailed else { return nil }
            reminder = nil; heldWriter = nil
            if let intake {
                guard !(try await intake.requiresReminderPreparation()), try await intake.navigationReservationID() == nil else { return nil }
            }
        }
        let mailbox = try NativeShareMailbox.current(), page = try await mailbox.pendingPage()
        guard heldWriter == nil || intake === heldWriter else { throw HandoverFailure.held }
        if intake == nil, page.items.isEmpty { return nil }
        // Only the unchanged ordinary path may create its intake. Held return requires its original writer.
        if intake == nil, reservation == nil { intake = try NativePersonalIntake(route: try NativeAppLaunch.reminderRoute.get(), diagnostic: { [relay = navigationFinishRelay] in relay.receive($0) }) }
        guard let original = intake else { throw HandoverFailure.held }
        try await validateShareCaptureStorage(original, reminder: reminder, reservation: reservation)
        try await original.retry()
        try await validateShareCaptureStorage(original, reminder: reminder, reservation: reservation)
        for source in page.items {
            try await validateShareCaptureStorage(original, reminder: reminder, reservation: reservation)
            do { _ = try await original.importShare(source, from: mailbox) }
            catch {
                // The original producer bytes remain in the mailbox. A durable private capture may still be offered safely.
                try await validateShareCaptureStorage(original, reminder: reminder, reservation: reservation)
                try await original.retry()
                try await validateShareCaptureStorage(original, reminder: reminder, reservation: reservation)
                break
            }
            try await validateShareCaptureStorage(original, reminder: reminder, reservation: reservation)
        }
        try await validateShareCaptureStorage(original, reminder: reminder, reservation: reservation)
        return .init(writer: original)
    }
    private func shareCaptureStorageCurrent(_ original: NativePersonalIntake, reminder: NativeReminderInbox?, reservation: String?) -> Bool {
        guard intake === original, !publisherFailed else { return false }
        if reservation != nil {
            return mode == .held && heldPersonalReplay && reminder != nil && storage === reminder
        }
        return mode == .legacy && preparation == nil && reminder == nil
    }
    private func validateShareCaptureStorage(_ original: NativePersonalIntake, reminder: NativeReminderInbox?, reservation: String?) async throws {
        guard shareCaptureStorageCurrent(original, reminder: reminder, reservation: reservation) else { throw HandoverFailure.held }
        if let reminder {
            try await reminder.handoverCaptures(into: original, route: try NativeAppLaunch.reminderRoute.get())
            guard shareCaptureStorageCurrent(original, reminder: reminder, reservation: reservation) else { throw HandoverFailure.held }
        }
        let claim = try await original.navigationReservationID()
        guard shareCaptureStorageCurrent(original, reminder: reminder, reservation: reservation), claim == reservation else { throw HandoverFailure.held }
    }
    func shareImportDiagnostic() -> NativePersonalIntake.Diagnostic? { navigationFinishRelay.retainedShareImport() }
    func deliveredShareImportDiagnostic(_ marker: NativePersonalIntake.Diagnostic) { navigationFinishRelay.deliveredShareImport(marker) }
    func settleShareCaptureFinish(_ item: NativePersonalIntake.Item, outcome: NativePersonalIntake.Outcome,
                                  storage: ShareCaptureStorage, owner: UUID) async throws -> NavigationFinishProof {
        guard intake === storage.writer, item.kind == .share else { throw HandoverFailure.held }
        let identity = NativeNavigationFinishRelay.Identity(owner: owner, writer: storage.writer, reservation: nil, item: item, outcome: outcome)
        try navigationFinishRelay.arm(identity)
        guard case .submitted = await storage.writer.submitFinish(item, outcome: outcome) else { throw HandoverFailure.held }
        let receipt = try await storage.writer.settleFinish(item, outcome: outcome)
        guard intake === storage.writer, receipt.id == item.id, receipt.kind == .share, receipt.sequence == item.sequence,
              receipt.receivedAtMs == item.receivedAtMs, receipt.outcome == outcome else { throw HandoverFailure.held }
        return .init(receipt: receipt, diagnostic: try navigationFinishRelay.retained(identity))
    }
    func transferredShareCaptureFinish(_ item: NativePersonalIntake.Item, outcome: NativePersonalIntake.Outcome,
                                       storage: ShareCaptureStorage, owner: UUID) throws {
        guard intake === storage.writer, item.kind == .share else { throw HandoverFailure.held }
        try navigationFinishRelay.transferred(.init(owner: owner, writer: storage.writer, reservation: nil, item: item, outcome: outcome))
    }
    #if DEBUG && (targetEnvironment(simulator) || NATIVE_DEVICE_TEST)
    private var navigationFixtureFault = false
    func navigationReplayFixturePendingStage() async throws -> String {
        guard let intake else { throw HandoverFailure.held }
        var page = try await intake.pendingPage()
        while true {
            if let item = page.items.first(where: { $0.kind != .reminder }) { return item.stage.rawValue }
            guard let next = page.next else { return "no-pending" }
            page = try await intake.pendingPage(after: next)
        }
    }
    func clearNavigationReplayFixtureFault() async { await intake?.setIOFaults() }
    func armNavigationFixtureFault() { navigationFixtureFault = true }
    func releaseNavigationFixtureFault() async { navigationFixtureFault = false; await intake?.setIOFaults() }
    func navigationFixtureEvents() async throws -> [NativePersonalIntakeEvent] {
        guard let intake else { return [] }
        var page = try await intake.pendingPage(), events: [NativePersonalIntakeEvent] = []
        while true {
            events += page.items.compactMap(\.event)
            guard let next = page.next else { return events }
            page = try await intake.pendingPage(after: next)
        }
    }
    #endif
    private func legacyOwner() throws -> NativeReminderInbox {
        guard mode == .legacy || (mode == .preparing && preparation?.cold == false && preparation?.nativeStarted == false),
              let storage else { throw HandoverFailure.held }
        legacyOperations += 1; return storage
    }
    private func finishLegacyOperation() {
        precondition(legacyOperations > 0); legacyOperations -= 1
        if legacyOperations == 0 { let waiters = legacyWaiters; legacyWaiters.removeAll(); waiters.forEach { $0.resume() } }
    }
    /// Explicit ordinary Retry owns one serialized publisher attempt and its whole callback tail.
    func retryCaptures() async throws {
        guard !Task.isCancelled else { throw CancellationError() }
        try await ensureCold()
        if mode == .held {
            guard heldPersonalReplay, let target = intake else { throw HandoverFailure.held }
            await publisher?.value
            guard !Task.isCancelled, mode == .held, heldPersonalReplay, intake === target else { throw HandoverFailure.held }
            try await target.retry()
            publisherFailed = false; startPublisher()
            await publisher?.value
            guard !Task.isCancelled, mode == .held, heldPersonalReplay, intake === target,
                  !publisherFailed, captureOrder.isEmpty else { throw HandoverFailure.held }
            return
        }
        guard mode == .legacy, preparation == nil else { throw HandoverFailure.held }
        let original = publisher
        await original?.value
        guard !Task.isCancelled else { throw CancellationError() }
        guard mode == .legacy, preparation == nil else { throw HandoverFailure.held }
        if !captureOrder.isEmpty {
            publisherFailed = false; startPublisher()
            let attempt = publisher
            await attempt?.value
        }
        guard !Task.isCancelled else { throw CancellationError() }
        guard mode == .legacy, preparation == nil, !publisherFailed, captureOrder.isEmpty else { throw HandoverFailure.held }
    }
    func pauseHeldPersonalReplay() { heldPersonalReplay = false }
    func enableHeldPersonalReplay() async throws {
        try await ensureCold()
        if mode == .legacy { return }
        guard mode == .held, let target = intake else { throw HandoverFailure.held }
        let route = try NativeAppLaunch.reminderRoute.get()
        if storage == nil { storage = try NativeReminderInbox.openExistingForHandover(selection: route.selection) }
        guard let original = storage else { throw HandoverFailure.held }
        try await original.handoverCaptures(into: target, route: route)
        guard storage === original, intake === target, mode == .held else { throw HandoverFailure.held }
        heldPersonalReplay = true
    }
    func pending() async throws -> [NativeReminderInbox.Item] {
        try await ensureCold()
        if mode == .held {
            guard heldPersonalReplay, let original = storage, let target = intake else { throw HandoverFailure.held }
            let route = try NativeAppLaunch.reminderRoute.get()
            try await target.retry()
            var result: [NativeReminderInbox.Item] = []
            var page = try await target.pendingPage()
            while true {
                for item in page.items where item.kind == .reminder {
                    let admitted: NativePersonalIntake.Item
                    do { admitted = try await original.admitHeldReminder(item, in: target, route: route) }
                    catch NativePersonalIntakeError.ambiguousReminderFloor {
                        guard heldPersonalReplay, storage === original, intake === target else { throw HandoverFailure.held }
                        continue
                    }
                    let dispatch = try await original.heldReminderDispatchItem(admitted, in: target, route: route)
                    guard heldPersonalReplay, storage === original, intake === target else { throw HandoverFailure.held }
                    if heldReminderDispatches[dispatch.response.requestID]?.outcome == nil {
                        heldReminderDispatches[dispatch.response.requestID] = .init(admitted: admitted, dispatch: dispatch)
                    }
                    result.append(dispatch)
                }
                guard let next = page.next else { break }
                page = try await target.pendingPage(after: next)
            }
            return result
        }
        let current = try legacyOwner(); defer { finishLegacyOperation() }
        try await current.retry()
        // Native settlement alone cannot hide retained callback envelopes from the ordinary Retry affordance.
        guard captureOrder.isEmpty || (!publisherFailed && publisher != nil) else { throw HandoverFailure.held }
        return try await current.pending()
    }
    func markAdmitting(_ id: String) async throws -> NativeReminderInbox.Item {
        if mode == .held {
            guard heldPersonalReplay, let retained = heldReminderDispatches[id], let original = storage, let target = intake else { throw HandoverFailure.held }
            return try await original.heldReminderDispatchItem(retained.admitted, in: target, route: NativeAppLaunch.reminderRoute.get())
        }
        let current = try legacyOwner(); defer { finishLegacyOperation() }
        do { return try await current.markAdmitting(id) }
        catch { try await current.retry(); return try await current.markAdmitting(id) }
    }
    func finish(_ item: NativeReminderInbox.Item, outcome: String = "confirmed") async throws -> Bool {
        if mode == .held {
            let id = item.response.requestID
            guard var retained = heldReminderDispatches[id], retained.dispatch == item,
                  let original = storage, let target = intake else { throw HandoverFailure.held }
            let terminal: NativePersonalIntake.Outcome = outcome == "refused" ? .ignored : .completed
            guard retained.outcome == nil || retained.outcome == terminal else { throw HandoverFailure.held }
            retained.outcome = terminal; heldReminderDispatches[id] = retained
            _ = try await original.finishHeldReminder(retained.admitted, outcome: terminal, in: target,
                                                     route: NativeAppLaunch.reminderRoute.get())
            return true
        }
        let current = try legacyOwner(); defer { finishLegacyOperation() }
        do { try await current.finish(item) }
        catch { try await current.retry(); try await current.finish(item) }
        return false
    }
    func acknowledgedHeldReminder(_ item: NativeReminderInbox.Item) {
        if heldReminderDispatches[item.response.requestID]?.dispatch == item {
            heldReminderDispatches.removeValue(forKey: item.response.requestID)
        }
    }
    private func startPublisher() {
        guard publisher == nil, !publisherFailed, !captureOrder.isEmpty,
              mode == .unchecked || mode == .legacy || mode == .held else { return }
        let id = UUID(); publisherID = id
        publisher = Task { await publishPending(id) }
    }
    private func publishPending(_ id: UUID) async {
        defer { if publisherID == id { publisherID = nil; publisher = nil } }
        do { try await ensureCold() }
        catch {
            publisherFailed = true
            if let first = captureOrder.first, let entry = pendingCaptures[first], entry.callbackManaged {
                record(entry.response.action, outcome: "capture-refused"); await entry.wake?()
            }
            return
        }
        while publisherID == id, let next = captureOrder.first, let entry = pendingCaptures[next], mode == .legacy || mode == .held {
            var legacyItem: NativeReminderInbox.Item?
            var confirmedResponse: NativeReminderResponse?
            let outcome: String
            do {
                if mode == .legacy {
                    let current = try legacyOwner(); entry.enteredLegacy = true
                    do {
                        do { legacyItem = try await current.capture(entry.response) }
                        catch {
                            #if DEBUG && (targetEnvironment(simulator) || NATIVE_DEVICE_TEST)
                            await holdRetryFixtureIfArmed(current)
                            #endif
                            try await current.retry(); legacyItem = try await current.capture(entry.response)
                        }
                        finishLegacyOperation()
                    } catch { finishLegacyOperation(); throw error }
                    confirmedResponse = legacyItem?.response
                    outcome = legacyItem == nil ? "retired" : "captured"
                } else {
                    guard let intake else { throw HandoverFailure.held }
                    let result: NativePersonalIntake.ReminderCaptureDisposition
                    do { result = try await intake.captureReminder(entry.response) }
                    catch { try await intake.retry(); result = try await intake.captureReminder(entry.response) }
                    switch result {
                    case .captured(let item): outcome = "held-captured"; confirmedResponse = item.event?.response
                    case .knownTerminal: outcome = "known-terminal"
                    case .ambiguousFloor(let item): outcome = "ambiguous-floor"; confirmedResponse = item.event?.response
                    }
                }
                #if DEBUG && (targetEnvironment(simulator) || NATIVE_DEVICE_TEST)
                fixtureOutcome = outcome
                confirmFixture(entry.response, actual: confirmedResponse)
                #endif
                if entry.callbackManaged { record(entry.response.action, outcome: outcome); await entry.wake?() }
                await finishCallbackTails(entry)
                pendingCaptures.removeValue(forKey: next); captureOrder.removeFirst()
            } catch {
                publisherFailed = true
                #if DEBUG && (targetEnvironment(simulator) || NATIVE_DEVICE_TEST)
                await holdFailureTailFixtureIfArmed()
                #endif
                if entry.callbackManaged { record(entry.response.action, outcome: "capture-refused"); await entry.wake?() }
                await finishCallbackTails(entry)
                return
            }
        }
    }
    private func finishCallbackTails(_ entry: PendingCapture) async {
        while let completion = entry.completions.first {
            await completion.waitUntilFinished()
            entry.completions.removeAll { $0.isFinished }
        }
    }
    /// Synchronous actor reservation; later captures park without becoming legacy wrappers.
    func reserveHandover() throws -> UUID {
        if let preparation { return preparation.id }
        guard mode == .legacy, let storage else { throw HandoverFailure.held }
        let owner = Preparation(source: storage, publisher: publisher, cold: false)
        preparation = owner; mode = .preparing; return owner.id
    }
    func releaseBeforeSeal(_ id: UUID) -> Bool {
        guard let owner = preparation, owner.id == id, !owner.cold, !owner.nativeStarted,
              storage === owner.source else { return false }
        preparation = nil; mode = .legacy
        startPublisher(); return true
    }
    func drainHandover(_ id: UUID) async throws {
        guard let owner = preparation, owner.id == id, !owner.cold else { throw HandoverFailure.held }
        if let task = owner.publisher { await task.value }
        while legacyOperations > 0 { await withCheckedContinuation { legacyWaiters.append($0) } }
        guard preparation === owner, storage === owner.source, publisher == nil,
              !pendingCaptures.values.contains(where: { $0.enteredLegacy }) else { throw HandoverFailure.refused }
    }
    func completeHandover(_ id: UUID) async throws {
        guard let owner = preparation, owner.id == id, !owner.cold else { throw HandoverFailure.held }
        if mode == .held { return }
        guard storage === owner.source, publisher == nil, legacyOperations == 0,
              !pendingCaptures.values.contains(where: { $0.enteredLegacy }) else { throw HandoverFailure.refused }
        guard let original = owner.source else { throw HandoverFailure.held }
        do {
            let route = try NativeAppLaunch.reminderRoute.get()
            owner.nativeStarted = true
            try await original.prepareEmptySourceForPersonalIntake(route: route)
            guard preparation === owner, storage === original, mode == .preparing, publisher == nil,
                  legacyOperations == 0, !pendingCaptures.values.contains(where: { $0.enteredLegacy }) else { throw HandoverFailure.held }
            if intake == nil { intake = try NativePersonalIntake(route: route, diagnostic: { [relay = navigationFinishRelay] in relay.receive($0) }) }
            guard let intake else { throw HandoverFailure.held }
            #if DEBUG && (targetEnvironment(simulator) || NATIVE_DEVICE_TEST)
            await faultTargetFixtureIfArmed(intake)
            if fixtureACKHold { await original.setImportAcknowledgementBarrier { await NativeNotificationResponses.shared.holdImportACKFixtureIfArmed() } }
            #endif
            try await original.handoverCaptures(into: intake, route: route)
            guard preparation === owner, storage === original else { throw HandoverFailure.held }
            mode = .held; bufferHandover(); publisherFailed = false; startPublisher()
        } catch NativeReminderInbox.CaptureHandoverFailure.refused {
            owner.nativeStarted = false; throw HandoverFailure.refused
        } catch { mode = .blocked; throw HandoverFailure.held }
    }
    #if DEBUG && (targetEnvironment(simulator) || NATIVE_DEVICE_TEST)
    private var fixtureEnabled: Bool {
        #if targetEnvironment(simulator)
        guard ["tech.dongdongbh.mindwtr", "tech.dongdongbh.mindwtr.native.dev"].contains(Bundle.main.bundleIdentifier ?? "") else { return false }
        #else
        guard Bundle.main.bundleIdentifier == "tech.dongdongbh.mindwtr.native.dev" else { return false }
        #endif
        guard NativeAppLaunch.arguments.filter({ $0 == "--native-reminder-handover-fixture" }).count == 1,
              let selection = try? NativeAppLaunch.selection.get(), case .isolated = selection else { return false }
        return true
    }
    private var fixtureState = "idle"
    private var fixtureFailureTailHold = false
    private var fixtureFailureTailWaiter: CheckedContinuation<Void, Never>?
    private var fixtureRetryHold = false
    private var fixtureRetryWaiter: CheckedContinuation<Void, Never>?
    private var fixtureEntryHold = false
    private var fixtureEntryWaiter: CheckedContinuation<Void, Never>?
    private var fixtureTargetFailure = false
    private var fixtureACKHold = false
    private var fixtureACKWaiter: CheckedContinuation<Void, Never>?
    private var fixtureOutcome = "none"
    private var fixtureExpected: NativeReminderResponse?
    private var fixtureFirstExact = false
    private var fixtureConfirmations = 0
    private var fixturePageRevision = -1
    private var fixtureStored = 0
    private var fixtureStoredFirst = false
    private var fixtureCallbacks: [NativeReminderCallbackCompletion] = []
    func armPersistentCaptureFailureFixture() async throws {
        guard fixtureEnabled else { return }; try await ensureCold()
        guard let storage, mode == .legacy else { throw HandoverFailure.held }
        await storage.setIOFaults(beforePublication: { throw CocoaError(.fileWriteUnknown) })
        fixtureFailureTailHold = true; fixtureState = "persistent-capture-failure"
    }
    private func holdFailureTailFixtureIfArmed() async {
        guard fixtureEnabled, fixtureFailureTailHold else { return }; fixtureFailureTailHold = false
        fixtureState = "publisher-failure-held"
        await withCheckedContinuation { fixtureFailureTailWaiter = $0 }
        fixtureState = "publisher-failure-released"
    }
    func releaseFailureTailFixture() { let waiter = fixtureFailureTailWaiter; fixtureFailureTailWaiter = nil; waiter?.resume() }
    func releasePersistentCaptureFailureFixture() async {
        guard fixtureEnabled else { return }
        await storage?.setIOFaults()
        fixtureState = "storage-usable" // Only the ordinary Retry action may restart the retained publisher.
    }
    func armCaptureRetryFixture() async throws {
        guard fixtureEnabled else { return }; try await ensureCold()
        guard let storage, mode == .legacy else { throw HandoverFailure.held }
        fixtureRetryHold = true; fixtureState = "retry-armed"
        await storage.setIOFaults(afterPublication: { throw CocoaError(.fileWriteUnknown) })
    }
    private func holdRetryFixtureIfArmed(_ original: NativeReminderInbox) async {
        guard fixtureEnabled, fixtureRetryHold else { return }
        fixtureRetryHold = false
        await original.setIOFaults()
        fixtureState = "wrapper-retry-held"
        await withCheckedContinuation { fixtureRetryWaiter = $0 }
        fixtureState = "wrapper-retry-released"
    }
    func releaseRetryFixture() { let waiter = fixtureRetryWaiter; fixtureRetryWaiter = nil; waiter?.resume() }
    func armEntryFixture() { guard fixtureEnabled else { return }; fixtureEntryHold = true; fixtureState = "entry-armed" }
    func holdCallbackEntryFixtureIfArmed() async {
        guard fixtureEnabled, fixtureEntryHold else { return }; fixtureEntryHold = false
        fixtureState = "callback-entry-held"
        await withCheckedContinuation { fixtureEntryWaiter = $0 }
        fixtureState = "callback-entry-released"
    }
    func releaseEntryFixture() { let waiter = fixtureEntryWaiter; fixtureEntryWaiter = nil; waiter?.resume() }
    func armImportACKFixture() { guard fixtureEnabled else { return }; fixtureACKHold = true }
    private func holdImportACKFixtureIfArmed() async {
        guard fixtureEnabled, fixtureACKHold else { return }; fixtureACKHold = false
        fixtureState = "import-before-final-ack"
        await withCheckedContinuation { fixtureACKWaiter = $0 }
    }
    func releaseImportACKFixture() { let waiter = fixtureACKWaiter; fixtureACKWaiter = nil; waiter?.resume() }
    func armTargetFailureFixture() { guard fixtureEnabled else { return }; fixtureTargetFailure = true }
    private func faultTargetFixtureIfArmed(_ destination: NativePersonalIntake) async {
        guard fixtureEnabled, fixtureTargetFailure else { return }; fixtureTargetFailure = false
        await destination.setIOFaults(beforePublication: { if $0 == "legacy-reminder-terminals.json" { throw CocoaError(.fileWriteUnknown) } })
    }
    func releaseTargetFailureFixture() async { await intake?.setIOFaults(); fixtureState = "target-failure-released" }
    fileprivate func rememberCallbackFixture(_ completion: NativeReminderCallbackCompletion, response: NativeReminderResponse) {
        guard fixtureEnabled else { return }
        fixtureCallbacks.append(completion)
        if fixtureExpected == nil { fixtureExpected = response }
    }
    private func confirmFixture(_ response: NativeReminderResponse, actual: NativeReminderResponse?) {
        guard fixtureEnabled else { return }; fixtureConfirmations += 1
        if let expected = fixtureExpected, expected.requestID == response.requestID, let actual {
            fixtureFirstExact = actual.requestedAtMs == expected.requestedAtMs && Data(actual.payloadJSON.utf8) == Data(expected.payloadJSON.utf8)
        }
    }
    func fixtureResponse(index: Int = 1, action: NativeReminderResponse.Action = .open, taskID: String = "synthetic-first", clock: Double = 100) throws -> NativeReminderResponse {
        guard fixtureEnabled else { throw HandoverFailure.held }
        let namespace = try trustedNamespace(), content = UNMutableNotificationContent()
        content.title = "Synthetic reminder"; content.body = "Synthetic body"; content.threadIdentifier = "synthetic"
        let data = ["alarmKey": "task:\(taskID)", "taskId": taskID]
        let details: [String: Any] = ["title": content.title, "message": content.body, "tag": content.threadIdentifier,
            "play_sound": false, "has_complete_action": true, "snooze_interval": 5, "data": data]
        let encoded = try JSONSerialization.data(withJSONObject: details, options: [.sortedKeys])
        content.userInfo = ["mindwtrNativeReminder": ["version": 1, "namespace": namespace, "id": index], "data": data,
            "mindwtrNativeResponse": ["version": 1, "publication": "00000000-0000-4000-8000-000000000025", "details": String(decoding: encoded, as: UTF8.self)]]
        let request = UNNotificationRequest(identifier: "mindwtr-native:\(namespace):\(index)", content: content, trigger: nil)
        let identifier: String
        switch action {
        case .open: identifier = UNNotificationDefaultActionIdentifier
        case .complete: identifier = NativeReminderResponse.completeActionIdentifier
        case .snooze: identifier = NativeReminderResponse.snoozeActionIdentifier
        case .dismiss: identifier = NativeReminderResponse.dismissActionIdentifier
        }
        guard let result = NativeReminderResponse.capture(request, deliveredAt: Date(timeIntervalSinceReferenceDate: Double(index)),
            receivedAt: Date(timeIntervalSince1970: clock), actionIdentifier: identifier, namespace: namespace) else { throw HandoverFailure.held }
        return result
    }
    func fixtureSnapshot() async -> String {
        var nativePending = -1
        if mode == .legacy, let storage { nativePending = (try? await storage.pending().count) ?? -1 }
        if mode == .held, fixturePageRevision != fixtureConfirmations, let intake {
            var count = 0, retainedFirst = false
            do {
                var page = try await intake.pendingPage()
                while true {
                    count += page.items.count
                    if let expected = fixtureExpected {
                        retainedFirst = retainedFirst || page.items.contains { $0.event?.response == expected }
                    }
                    guard let next = page.next else { break }; page = try await intake.pendingPage(after: next)
                }
                fixtureStored = count; fixtureStoredFirst = retainedFirst; fixturePageRevision = fixtureConfirmations
            } catch { fixtureStored = -1 }
        }
        return "\(mode.rawValue)|\(fixtureState)|pending=\(captureOrder.count)|wrappers=\(legacyOperations)|publishing=\(publisher != nil)|first=\(fixtureFirstExact)|confirmed=\(fixtureConfirmations)|callbacks=\(fixtureCallbacks.reduce(0) { $0 + $1.invocations })|once=\(fixtureCallbacks.allSatisfy { $0.invocations == 1 })|outcome=\(fixtureOutcome)|handover=\(handoverDiagnostic != nil)|stored=\(fixtureStored)|storedFirst=\(fixtureStoredFirst)|nativePending=\(nativePending)"
    }
    #endif

    private func bufferHandover() {
        if handoverDiagnostic == nil {
            handoverDiagnostic = ["releaseCheck":"v1.3.8/ios-reminder-capture-handover", "operation":"handover", "outcome":"confirmed"]
        }
    }
}

fileprivate final class NativeReminderCallbackCompletion: @unchecked Sendable {
    private let lock = NSLock()
    private var completion: (() -> Void)?
    private var count = 0
    private var finished = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    init(_ completion: @escaping () -> Void) { self.completion = completion }
    func finish() {
        lock.lock(); let callback = completion; completion = nil
        if callback != nil { count += 1 }; lock.unlock()
        guard let callback else { return }
        callback()
        lock.lock(); finished = true; let pending = waiters; waiters.removeAll(); lock.unlock()
        pending.forEach { $0.resume() }
    }
    var isFinished: Bool { lock.lock(); defer { lock.unlock() }; return finished }
    func waitUntilFinished() async {
        await withCheckedContinuation { continuation in
            lock.lock()
            if finished { lock.unlock(); continuation.resume() }
            else { waiters.append(continuation); lock.unlock() }
        }
    }
    var invocations: Int { lock.lock(); defer { lock.unlock() }; return count }
}

final class NativeNotificationDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    private struct PersonalCallbacks: Sendable {
        let foreground: @MainActor @Sendable (Bool) async -> Void
        let wake: @MainActor @Sendable () -> Void
    }
    private let callbackLock = NSLock()
    private var callbacks: PersonalCallbacks?
    private func personalCallbacks() -> PersonalCallbacks? {
        callbackLock.lock(); defer { callbackLock.unlock() }; return callbacks
    }

    @MainActor
    func bindPersonalCallbacks(to original: CoreModel) {
        let bound = PersonalCallbacks(foreground: { [weak original] sound in
            await original?.recordForegroundReminderPresentation(sound: sound)
        }, wake: { [weak original] in
            guard let original else { return }
            original.requestNotificationResponses()
            NotificationCenter.default.post(name: NativeNotificationResponses.changed, object: nil)
        })
        callbackLock.lock(); defer { callbackLock.unlock() }
        if callbacks == nil { callbacks = bound }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        let options = NativeReminderResponse.foregroundPresentation(notification.request,
            selection: try? NativeAppLaunch.selection.get())
        completionHandler(options)
        guard !options.isEmpty else { return }
        guard let original = personalCallbacks() else { return }
        Task { await original.foreground(options.contains(.sound)) }
    }

    func application(_ application: UIApplication,
                     willFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        guard let selection = try? NativeAppLaunch.selection.get() else { return true }
        if case let .standard(_, _, namespace) = selection,
           namespace == NativeWidgetNextCache.namespace, Bundle.main.bundleIdentifier == namespace {
            MindwtrWatchConnectivityReceiver.shared.activateAtLaunch()
        }
        switch selection {
        case .production, .standard, .isolated:
            let center = UNUserNotificationCenter.current()
            center.delegate = self
            center.setNotificationCategories(NativeReminderResponse.categories())
        case .rehearsal: break
        }
        return true
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let namespace: String
        guard let selection = try? NativeAppLaunch.selection.get() else { completionHandler(); return }
        switch selection {
        case .production: namespace = NativeLaunchSelection.productionNamespace
        case let .standard(_, _, name), let .isolated(_, _, name, _): namespace = name
        case .rehearsal: completionHandler(); return
        }
        guard let captured = NativeReminderResponse.capture(response.notification.request,
            deliveredAt: response.notification.date, receivedAt: Date(),
            actionIdentifier: response.actionIdentifier, namespace: namespace) else { completionHandler(); return }
        Self.submit(captured, original: personalCallbacks(), completion: NativeReminderCallbackCompletion(completionHandler))
    }
    private static func submit(_ captured: NativeReminderResponse, original: PersonalCallbacks?, completion: NativeReminderCallbackCompletion) {
        Task {
            defer { completion.finish() } // OS completion is once, not a durable storage acknowledgement.
            #if DEBUG && (targetEnvironment(simulator) || NATIVE_DEVICE_TEST)
            await NativeNotificationResponses.shared.holdCallbackEntryFixtureIfArmed()
            #endif
            await NativeNotificationResponses.shared.receive(captured, wake: original?.wake, completion: completion)
        }
    }
    #if DEBUG && (targetEnvironment(simulator) || NATIVE_DEVICE_TEST)
    @MainActor
    static func deliverFixture(_ response: NativeReminderResponse, original: CoreModel) async {
        let completion = NativeReminderCallbackCompletion({})
        await NativeNotificationResponses.shared.rememberCallbackFixture(completion, response: response)
        let callbacks = PersonalCallbacks(foreground: { _ in }, wake: { [weak original] in
            original?.requestNotificationResponses()
            NotificationCenter.default.post(name: NativeNotificationResponses.changed, object: nil)
        })
        submit(response, original: callbacks, completion: completion)
    }
    #endif
}

@MainActor
enum NativeAppModel {
    static let shared = CoreModel()
    static let session = NativeSandboxSession(model: shared)
}

#if DEBUG && (targetEnvironment(simulator) || NATIVE_DEVICE_TEST)
private struct NativeNavigationCaptureFixtureView: View {
    @ObservedObject var model: CoreModel
    @ObservedObject var session: NativeSandboxSession
    var body: some View {
        VStack(spacing: 2) {
            Text("\(session.navigationCapturePhase)|\(model.navigationFixtureState)")
                .accessibilityIdentifier("navigation-capture-state")
            Button("Reserve navigation capture") { session.requestNavigationCapture() }
                .accessibilityIdentifier("navigation-capture-reserve")
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible()), GridItem(.flexible())]) {
                ForEach(["head", "tail", "fault", "release-fault", "second", "dirty", "clean", "logging", "export", "restore-logging", "refresh"], id: \.self) { command in
                    Button(command) { Task { await model.navigationCaptureFixtureCommand(command) } }
                        .accessibilityIdentifier("navigation-capture-" + command)
                }
            }
        }.font(.caption2).padding(4).background(.regularMaterial)
            .task {
                while !Task.isCancelled {
                    await model.refreshNavigationCaptureFixture()
                    try? await Task.sleep(nanoseconds: 250_000_000)
                }
            }
    }
}
struct NativeNavigationReplayFixtureView: View {
    @ObservedObject var model: CoreModel
    @ObservedObject var session: NativeSandboxSession
    var task = false
    private var prefix: String { task ? "navigation-replay-task-" : "navigation-replay-" }
    var body: some View {
        VStack(spacing: 2) {
            Text(model.navigationReplayFixtureState + "|retirement=" + session.phase.rawValue)
                .accessibilityIdentifier(prefix + "state")
            Button("Replay captured navigation") { session.requestNavigationReplay() }
                .disabled(!model.navigationReplayFixtureReady)
                .accessibilityIdentifier(prefix + "request")
            Button("Retire original Host") { session.requestRetirement() }
                .accessibilityIdentifier(prefix + "retire")
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible()), GridItem(.flexible())]) {
                ForEach(["task", "same-task", "second", "project", "missing", "none", "terminal-frontier", "search-task", "search-inbox", "search-invalid", "logging", "export", "restore-logging",
                         "hold-render", "release-render", "release-render-next", "wrong-ticket", "hold-submit", "release-submit", "hold-tail", "release-tail", "admission-after", "finish-before", "finish-after", "release-native", "dirty", "clean", "probe", "restart", "restart-required", "clear-restart", "consent-on", "consent-off", "consent-unknown", "consent-changing", "restore-consent"], id: \.self) { command in
                    Button(command) { Task { await model.navigationReplayFixtureCommand(command) } }
                        .disabled(!model.navigationReplayFixtureReady && !["release-submit", "release-tail", "release-native", "release-render"].contains(command))
                        .accessibilityIdentifier(prefix + command)
                }
            }
        }.font(.caption2).padding(4).background(.regularMaterial)
    }
}
private struct NativeReminderHandoverFixtureView: View {
    @ObservedObject var model: CoreModel
    @ObservedObject var session: NativeSandboxSession
    @State private var controlsVisible = true
    private let commands = ["logging", "restore-logging", "logging-on", "logging-off", "export", "wrapper", "persistent", "second", "held-dismiss", "release-persistent", "release-failure", "duplicate", "release-wrapper", "entry", "release-entry", "receipt", "release-receipt",
        "cancel", "wake", "retire", "before-ack", "release-ack", "duplicate-receipt", "target-failure", "release-target", "dirty", "clean", "burst", "probe-receipt"]
    var body: some View {
        VStack(spacing: 3) {
            Button(controlsVisible ? "Hide fixture controls" : "Show fixture controls") { controlsVisible.toggle() }
                .accessibilityIdentifier("reminder-handover-controls")
            if controlsVisible {
                Text("\(session.captureHandoverPhase)|\(model.reminderHandoverFixtureState)|\(model.reminderHandoverModelState)|\(model.reminderHandoverOwnerState)|retirement=\(session.phase.rawValue):\(session.outcome)")
                    .lineLimit(5).accessibilityIdentifier("reminder-handover-state")
                Button("Prepare original capture handover") { session.requestReminderCaptureHandover() }
                    .accessibilityIdentifier("reminder-handover-request").disabled(!model.ready)
                Button("Clean and prepare original capture handover") {
                    guard session.model === model, model.cleanReminderHandoverFixtureForRequest() else { return }
                    session.requestReminderCaptureHandover()
                }
                .accessibilityIdentifier("reminder-handover-clean-and-request").disabled(!model.ready)
                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible()), GridItem(.flexible())], spacing: 2) {
                    ForEach(commands, id: \.self) { command in
                        Button(command) { Task { await model.reminderHandoverFixtureCommand(command) } }
                            .accessibilityIdentifier("reminder-handover-" + command).disabled(!model.ready)
                    }
                }
            }
        }.font(.caption2).padding(5).frame(maxWidth: 390).background(.regularMaterial)
            .task {
                while !Task.isCancelled {
                    await model.refreshReminderHandoverFixture()
                    try? await Task.sleep(nanoseconds: 250_000_000)
                }
            }
    }
}
#endif

@main
enum NativeAppEntry {
    @MainActor
    static func main() {
        #if DEBUG || NATIVE_DEVICE_TEST
        if NativeShareMailboxExport.requested(arguments: ProcessInfo.processInfo.arguments) {
            NativeShareMailboxExportApp.main()
            return
        }
        #endif
        MindwtrNativeApp.main()
    }
}

#if DEBUG || NATIVE_DEVICE_TEST
private struct NativeShareMailboxExportApp: App {
    @State private var started = false
    @State private var status = "Mailbox export pending; ordinary startup blocked"

    var body: some Scene {
        WindowGroup {
            Text(status)
                .accessibilityIdentifier("native-share-mailbox-export-state")
                .task {
                    guard !started else { return }
                    started = true
                    do {
                        let receipt = try await NativeShareMailboxExport.perform()
                        status = "Mailbox export complete: \(receipt.envelopes) envelopes, \(receipt.bytes) bytes; ordinary startup blocked"
                    } catch {
                        status = "Mailbox export failed: \(NativeShareMailboxExport.failureCode(error)); ordinary startup blocked"
                    }
                }
        }
    }
}
#endif

struct MindwtrNativeApp: App {
    @UIApplicationDelegateAdaptor(NativeNotificationDelegate.self) private var notificationDelegate
    @StateObject private var model = NativeAppModel.shared
    @StateObject private var workspace = NativeAppModel.session

    var body: some Scene {
        WindowGroup {
            AppLockRoot(model: model, lock: model.appLock, workspace: workspace)
                .environment(\.nativeExternalLinkLabels, model.strings)
                .environment(\.nativeExternalLinkAdmission, { model.workspaceAdmissionsOpen })
                .environment(\.openURL, OpenURLAction { _ in
                    model.workspaceAdmissionsOpen ? .systemAction : .discarded
                })
                .environment(\.nativeExternalLinkDiagnostic, { outcome, surface, scheme in
                    await model.recordNoteAppHandoff(outcome, surface: surface, scheme: scheme)
                })
                .onDisappear { model.unregisterQuickCaptureIntentTarget() }
                .onOpenURL { url in
                    if !model.consumeDropboxAuthorizationCallback(url) { model.receiveEntityLink(url) }
                }
                .onContinueUserActivity(CSSearchableItemActionType) { activity in
                    guard let identifier = activity.userInfo?[CSSearchableItemActivityIdentifier] as? String else { return }
                    model.receiveSearchIdentifier(identifier)
                }
                .task {
                    #if DEBUG && targetEnvironment(simulator)
                    await model.prepareQuickCaptureIntentFixtureBeforeRegistration()
                    #endif
                    model.registerQuickCaptureIntentTarget()
                    notificationDelegate.bindPersonalCallbacks(to: model)
                    await model.start()
                }
        }
    }
}


@MainActor
final class AppLockController: ObservableObject {
    @Published private(set) var enabled: Bool?
    @Published private(set) var locked = true
    @Published private(set) var authenticating = false
    @Published private(set) var errorKey: String?
    @Published private(set) var nonce = 0
    var relockDelayMinutes = 0
    private var relockPolicy = NativeAppLockRelockPolicy()
    private var promptedNonce = -1
    private var phase: ScenePhase = .active
    private var context: LAContext?
    private var authenticationGeneration = 0
    private var successfulAuthenticationGeneration: Int?
    private var privacyCovers: [UIView] = []
#if DEBUG && targetEnvironment(simulator)

    var testOutcomes: [String] = []
#endif
    var concealed: Bool { enabled == nil || locked }

    func saved(_ value: Bool, justEnabled: Bool = false) {
        let firstRead = enabled == nil
        let changed = enabled != value
        enabled = value
        if firstRead || changed || justEnabled { relockPolicy.reset() }
        if !value { locked = false; errorKey = nil }
        else if justEnabled && phase != .background && successfulAuthenticationGeneration == authenticationGeneration { locked = false; errorKey = nil }
        else if firstRead || changed { lock() }
    }

    func readFailed() {
        relockPolicy.reset()
        enabled = nil
        locked = true
    }

    private func lock() {
        locked = true
        errorKey = nil
        nonce += 1
    }

    func concealSnapshot() {
        guard enabled != false, privacyCovers.isEmpty else { return }
        for scene in UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }) {
            for window in scene.windows where window.isKeyWindow {
                let cover = UIView(frame: window.bounds)
                cover.backgroundColor = .systemBackground
                cover.autoresizingMask = [.flexibleWidth, .flexibleHeight]
                cover.isAccessibilityElement = false
                cover.accessibilityViewIsModal = true
                window.addSubview(cover)
                privacyCovers.append(cover)
            }
        }
    }

    func sceneChanged(_ next: ScenePhase) {
        let previous = phase
        phase = next
        if previous == .active && next != .active && !authenticating {
            relockPolicy.leave(unlocked: enabled == true && !locked, now: Date().timeIntervalSince1970)
        }
        if next == .active {
            let warmReturn = relockPolicy.resume(delayMinutes: relockDelayMinutes, now: Date().timeIntervalSince1970)
            if enabled == true && locked && !authenticating && warmReturn {
                locked = false
                errorKey = nil
                NSLog("Native App lock warm return releaseCheck=v1.3.8/ios-app-lock-delay outcome=within-delay")
            }
            // Remove after SwiftUI has reconciled the locked tree, including any presented sheets.
            DispatchQueue.main.async { [weak self] in
                guard let self, self.phase == .active else { return }
                self.privacyCovers.forEach { $0.removeFromSuperview() }
                self.privacyCovers.removeAll()
            }
        }

        if next == .background {
            authenticationGeneration += 1
            context?.invalidate()
            if enabled == true { lock() }
        } else if previous == .active && next == .inactive && !authenticating {
            authenticationGeneration += 1
            if enabled == true { lock() }
        }
    }

    func autoUnlock(label: (String) -> String) async {
        guard enabled == true, locked, phase == .active, !authenticating, promptedNonce != nonce else { return }
        let candidate = nonce
        do { try await Task.sleep(nanoseconds: 250_000_000) } catch { return }
        guard candidate == nonce, enabled == true, locked, phase == .active, !authenticating,
              promptedNonce != candidate else { return }
        promptedNonce = candidate
        await unlock(label: label)
    }

    func unlock(label: (String) -> String) async {
        guard enabled == true, locked else { return }
        promptedNonce = nonce
        if await authenticate(reason: label("appLock.prompt"), label: label) { locked = false }
    }

    func authenticate(reason: String, label: (String) -> String) async -> Bool {
        guard !authenticating, phase == .active else { return false }
        authenticating = true
        errorKey = nil
        let generation = authenticationGeneration
        defer { authenticating = false; context = nil }
#if DEBUG && targetEnvironment(simulator)
        if !testOutcomes.isEmpty {
            let outcome = testOutcomes.removeFirst()

            sceneChanged(.inactive)
            await Task.yield()
            sceneChanged(.active)
            guard generation == authenticationGeneration, phase != .background else { return false }
            if outcome == "success" { successfulAuthenticationGeneration = generation; return true }
            errorKey = outcome == "cancel" ? "appLock.cancelled" : outcome == "unavailable" ? "appLock.unavailable" : "appLock.failed"
            return false
        }
#endif
        let attempt = LAContext()
        context = attempt
        attempt.localizedCancelTitle = label("common.cancel")
        attempt.localizedFallbackTitle = label("appLock.useDevicePasscode")
        var failure: NSError?
        guard attempt.canEvaluatePolicy(.deviceOwnerAuthentication, error: &failure) else {
            errorKey = "appLock.unavailable"
            return false
        }
        let result: (Bool, Error?) = await withCheckedContinuation { continuation in
            let prompt = reason.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Unlock Mindwtr" : reason
            attempt.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: prompt) { success, error in
                continuation.resume(returning: (success, error))
            }
        }
        guard generation == authenticationGeneration, phase != .background else { return false }
        if result.0 { successfulAuthenticationGeneration = generation; return true }
        switch (result.1 as? LAError)?.code {
        case .userCancel, .appCancel, .systemCancel: errorKey = "appLock.cancelled"
        case .passcodeNotSet, .biometryNotAvailable, .biometryNotEnrolled: errorKey = "appLock.unavailable"
        default: errorKey = "appLock.failed"
        }
        return false
    }
}

private struct AppLockRoot: View {
    private struct ForegroundState: Equatable {
        let token: UUID?
        let active: Bool
        let concealed: Bool
    }
    @ObservedObject var model: CoreModel
    @ObservedObject var lock: AppLockController
    @ObservedObject var workspace: NativeSandboxSession
    @State private var confirmingCorruptDraftDiscard = false
    @State private var observedApplicationActive: Bool?
    @Environment(\.scenePhase) private var phase
    @Environment(\.colorScheme) private var scheme
    private var palette: AppPalette { AppPalette(theme: model.theme, system: scheme) }

    private var applicationActive: Bool {
        observedApplicationActive ?? (UIApplication.shared.applicationState == .active)
    }

    private var workspaceReady: Bool { model.ready || workspace.isActive }

    var body: some View {
        let startupToken = model.completedStartupToken
        let foreground = ForegroundState(token: startupToken, active: applicationActive, concealed: lock.concealed)
        Group {
            if workspaceReady && !lock.concealed {
                if workspace.isActive {
                    NativeSandboxView(session: workspace, palette: palette)
                } else if model.settingsSyncRestartRequired {
                    VStack(spacing: 16) {
                        Image(systemName: "exclamationmark.arrow.triangle.2.circlepath")
                            .font(.system(size: 32)).accessibilityHidden(true)
                        Text("The operation could not be confirmed. Close and reopen Mindwtr before trying again.")
                            .rnFont(17, .semibold).multilineTextAlignment(.center)
                            .fixedSize(horizontal: false, vertical: true)
                    }.padding(32).frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(palette.bg).foregroundStyle(palette.text)
                        .accessibilityIdentifier("sync-restart-gate")
                } else if model.settingsSyncPresented {
                    SettingsScreen(model: model, palette: palette)
                } else if model.taskRecoveryGateVisible {
                    TaskRecoveryGate(model: model, palette: palette)
                } else {
                    InboxScreen(model: model)
                        .overlay(alignment: .bottomTrailing) {
                            if model.taskRecoveryAvailable {
                                Button(model.taskAttachmentState == .savedCleanup
                                    || (model.taskAttachmentState == .discardedCleanup && !model.taskAttachmentHasIndependentDraft)
                                    ? "File cleanup" : "Resume draft") { model.showTaskRecovery() }
                                    .buttonStyle(.borderedProminent)
                                    .padding(16)
                                    .accessibilityIdentifier("task-recovery-open")
                            }
                        }
                }
            } else {
                ZStack {
                    palette.bg.ignoresSafeArea()
                    GeometryReader { geometry in
                        ScrollView {
                        VStack(spacing: 0) {
                            Image(systemName: "lock").font(.system(size: 34)).accessibilityHidden(true)
                                .frame(width: 72, height: 72)
                                .background(palette.filter, in: RoundedRectangle(cornerRadius: 24))
                                .overlay(RoundedRectangle(cornerRadius: 24).stroke(palette.border, lineWidth: 1))
                                .padding(.bottom, 22)
                            Text(model.label("appLock.title").isEmpty ? "Mindwtr" : model.label("appLock.title")).rnFont(24, .bold).accessibilityAddTraits(.isHeader)
                                .multilineTextAlignment(.center).padding(.bottom, 10)
                            Text(model.label(lock.errorKey ?? "appLock.description"))
                                .rnFont(15).foregroundStyle(palette.secondary).multilineTextAlignment(.center)
                                .frame(maxWidth: 320).padding(.bottom, 26)
                            if model.busy || lock.authenticating {
                                ProgressView().accessibilityLabel(model.label("appLock.authenticating"))
                            } else if !model.ready && model.taskAttachmentState == .savedCleanup {
                                TaskAttachmentRecoveryStatus(model: model, palette: palette)
                            } else if model.taskRecoveryStartupCorrupt {
                                Text("An unreadable task draft prevents startup. Its contents cannot be shown.")
                                    .rnFont(15).multilineTextAlignment(.center).padding(.bottom, 12)
                                    .accessibilityIdentifier("task-recovery-startup-corrupt")
                                Button("Discard unreadable draft") { confirmingCorruptDraftDiscard = true }
                                    .accessibilityIdentifier("task-recovery-startup-discard")
                            } else if model.appLockRecoveryPending {
                                Text("The pending App lock change could not be confirmed. Cancel it to continue with the saved setting.")
                                    .rnFont(15).multilineTextAlignment(.center).padding(.bottom, 20)
                                Button("Cancel pending change") { Task { await model.cancelAppLockRecovery() } }
                                    .foregroundStyle(palette.onTint)
                                    .accessibilityIdentifier("app-lock-recovery-cancel")
                            } else if !model.ready && model.projectFileAvailabilityPending && lock.enabled != nil {
                                if lock.concealed {
                                    Button(model.label("appLock.unlock").isEmpty ? "Unlock" : model.label("appLock.unlock")) {
                                        Task { await lock.unlock(label: model.label) }
                                    }
                                    .foregroundStyle(palette.onTint).accessibilityIdentifier("app-lock-unlock")
                                } else {
                                    ProjectFileAvailabilityRecoveryPanel(model: model, palette: palette)
                                }
                            } else if !model.ready && !model.projectFileAddSummary.isEmpty && lock.enabled != nil {
                                if lock.concealed {
                                    Button(model.label("appLock.unlock").isEmpty ? "Unlock" : model.label("appLock.unlock")) {
                                        Task { await lock.unlock(label: model.label) }
                                    }
                                    .foregroundStyle(palette.onTint).accessibilityIdentifier("app-lock-unlock")
                                } else {
                                    ProjectFileAddRecoveryPanel(model: model, palette: palette)
                                }
                            } else if !workspaceReady || lock.enabled == nil {
                                if !model.ready && model.error != nil {
                                    Text(model.productionStartupRecoveryReason ?? (model.label("settings.feedback.actionFailed").isEmpty
                                        ? "Couldn't complete this action. Try again."
                                        : model.label("settings.feedback.actionFailed")))
                                        .rnFont(15).foregroundStyle(palette.danger).multilineTextAlignment(.center).padding(.bottom, 12)
                                        .accessibilityIdentifier("app-lock-read-error")
                                }
                                Button(model.label("common.retry").isEmpty ? "Retry" : model.label("common.retry")) {
                                    Task { await model.retryAppLockRead() }
                                }.foregroundStyle(palette.onTint).accessibilityIdentifier("app-lock-read-retry")
                            } else {
                                Button(model.label("appLock.unlock")) { Task { await lock.unlock(label: model.label) } }
                                    .foregroundStyle(palette.onTint)
                                    .accessibilityIdentifier("app-lock-unlock")
                            }
                        }
                        .padding(32).frame(maxWidth: 540)
                        .frame(maxWidth: .infinity, minHeight: geometry.size.height)
                        }
                    }
                }
                .foregroundStyle(palette.text).tint(palette.tint)
                .buttonStyle(.borderedProminent).controlSize(.large).rnFont(16, .bold)
                .accessibilityIdentifier("app-lock-gate")
            }
        }
        .allowsHitTesting(model.workspaceAdmissionsOpen || workspace.isActive)
        .background {
            NativeCalendarEventEditor(presentation: model.calendarEventOpenPresentation,
                isPresented: model.calendarEventOpenPresented,
                canPresent: { model.calendarEventOpenCanPresent($0) },
                requestDismiss: { model.requestCalendarEventOpenDismissal($0, outcome: $1) },
                didDismiss: { model.calendarEventOpenDidDismiss($0) })
        }
        .overlay(alignment: .bottom) {
            if let notice = model.voiceNotice, !lock.concealed {
                Text(notice).rnFont(15).foregroundStyle(palette.text).fixedSize(horizontal: false, vertical: true)
                    .padding(14).background(palette.card, in: RoundedRectangle(cornerRadius: 12)).padding(16)
                    .allowsHitTesting(false).accessibilityIdentifier("voice-capture-notice")
            } else if let notice = model.appleRemindersAutoNotice, !lock.concealed {
                Text(notice).rnFont(15).foregroundStyle(palette.text).fixedSize(horizontal: false, vertical: true)
                    .padding(14).background(palette.card, in: RoundedRectangle(cornerRadius: 12)).padding(16)
                    .allowsHitTesting(false).accessibilityIdentifier("apple-reminders-auto-notice")
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didEnterBackgroundNotification)) { _ in
            workspace.sample?.suspend()
            model.retireReviewAI()
            model.retireProcessInboxAI()
            model.retireTaskAI()
            model.retireVoiceForLifecycle()
        }
        .preferredColorScheme(model.theme.text("scheme").isEmpty ? nil : palette.dark ? .dark : .light)
        #if DEBUG && targetEnvironment(simulator)
        .safeAreaInset(edge: .bottom) {
            if model.quickCaptureIntentFixtureEnabled && !model.taskPresented { NativeQuickCaptureIntentFixtureView(model: model) }
        }
        #endif
        #if DEBUG && (targetEnvironment(simulator) || NATIVE_DEVICE_TEST)
        .overlay(alignment: .bottomLeading) {
            if model.reminderHandoverFixtureEnabled { NativeReminderHandoverFixtureView(model: model, session: workspace) }
            if model.navigationCaptureFixtureEnabled { NativeNavigationCaptureFixtureView(model: model, session: workspace) }
            if model.navigationReplayFixtureEnabled { NativeNavigationReplayFixtureView(model: model, session: workspace) }
        }
        .overlay(alignment: .topLeading) {
            if model.workspaceRetirementFixtureEnabled {
                VStack(spacing: 4) {
                    Text("\(workspace.phase.rawValue)|\(workspace.outcome)|\(model.workspaceRetirementFixtureState)|\(workspace.receipt?.scope ?? "none")|current=\(model.workspaceRetirementViewCurrent)|wakeRestored=\(model.workspaceRetirementWakeRestored)")
                        .accessibilityIdentifier("workspace-retirement-state")
                    Button("Hold original read") {
                        Task { await model.selectSurface(.focus); model.holdWorkspaceRetirementReadFixture() }
                    }.disabled(!model.ready || model.busy || !model.workspaceAdmissionsOpen)
                        .accessibilityIdentifier("workspace-retirement-hold")
                    Button("Retire original owner") { workspace.requestRetirement() }
                        .accessibilityIdentifier("workspace-retirement-request")
                    Button("Release original read") { model.releaseWorkspaceRetirementReadFixture() }
                        .accessibilityIdentifier("workspace-retirement-release")
                    Button("Check stale picker") { model.checkWorkspaceRetirementPickerFixture() }
                        .accessibilityIdentifier("workspace-retirement-picker")
                    Button("Check late model intent") { model.checkWorkspaceRetirementIntentFixture() }
                        .accessibilityIdentifier("workspace-retirement-intent")
                    Button("Prepare pending draft") { model.dirtyWorkspaceRetirementFixture() }
                        .accessibilityIdentifier("workspace-retirement-dirty")
                    Button("Arm ordinary close") { model.closeWorkspaceRetirementHostFixture() }
                        .accessibilityIdentifier("workspace-retirement-close")
                    Button("Arm real native draft") { model.armWorkspaceRetirementDraftFixture() }
                        .accessibilityIdentifier("workspace-retirement-native-draft")
                    Button("Discard exact fixture draft") { Task { await model.cleanWorkspaceRetirementDraftFixture() } }
                        .accessibilityIdentifier("workspace-retirement-native-cleanup")
                }.font(.caption2).padding(4).background(palette.card).frame(maxWidth: 320)
            }
        }
        .overlay(alignment: .topTrailing) {
            if model.pomodoroAlarmTestEnabled {
                VStack(spacing: 4) {
                    Text(model.pomodoroAlarmTestState).lineLimit(1)
                        .accessibilityLabel(model.pomodoroAlarmTestState)
                        .accessibilityIdentifier("pomodoro-alarm-fixture-state")
                    HStack {
                        Button("Read alarm fixture") { Task { await model.refreshPomodoroAlarmTestState() } }
                            .accessibilityIdentifier("pomodoro-alarm-fixture-refresh")
                        Button("Release alarm fixture") { Task { await model.releasePomodoroAlarmTestAdd() } }
                            .accessibilityIdentifier("pomodoro-alarm-fixture-release")
                        Button("Retire alarm fixture") { model.retirePomodoroAlarmTestHost() }
                            .accessibilityIdentifier("pomodoro-alarm-fixture-retire")
                    }
                }.font(.caption2).padding(4).background(palette.card).frame(maxWidth: 300)
            }
        }
        #endif
        .onAppear {
            model.widgetAppearanceChanged(scheme == .dark ? .dark : .light)
            lock.sceneChanged(phase)
            if applicationActive { model.appleRemindersDidBecomeActive(); model.notificationSettingsDidBecomeActive(); model.calendarSettingsDidBecomeActive(); model.calendarFeedDidBecomeActive() }
            model.requestForegroundSync(token: model.completedStartupToken, active: applicationActive)
            model.requestAppleRemindersAutoImport(token: model.completedStartupToken, active: applicationActive)
            model.requestGmailCapture(token: model.completedStartupToken, active: applicationActive)
            model.requestReminderLifecycle(token: model.completedStartupToken, active: applicationActive)
            model.requestCalendarPushLifecycle(token: model.completedStartupToken, active: applicationActive)
            model.requestSearchLifecycle(token: model.completedStartupToken, active: applicationActive)
            model.requestNotificationResponses()
            model.requestEntityLinks()
            model.requestQuickCaptureIntent()
        }
        .onReceive(NotificationCenter.default.publisher(for: MindwtrWatchConnectivityReceiver.pendingCaptureNotification)) { _ in
            model.watchCommandsChanged()
        }
        .onReceive(NotificationCenter.default.publisher(for: NativeNotificationResponses.changed)) { _ in
            model.requestNotificationResponses()
        }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didBecomeActiveNotification)) { _ in
            observedApplicationActive = true
            model.dropboxAuthorizationDidBecomeActive()
            model.appleRemindersDidBecomeActive()
            model.notificationSettingsDidBecomeActive()
            model.calendarSettingsDidBecomeActive()
            model.calendarFeedDidBecomeActive()
            model.textInputDidBecomeActive()
            model.requestNotificationResponses()
            model.requestEntityLinks()
            model.requestQuickCaptureIntent()
            model.requestSearchLifecycle(token: model.completedStartupToken, active: true, force: true)
            guard !lock.concealed else { return }
            model.requestForegroundSync(token: model.completedStartupToken, active: true)
            model.requestAppleRemindersAutoImport(token: model.completedStartupToken, active: true)
            model.requestGmailCapture(token: model.completedStartupToken, active: true)
            model.requestReminderLifecycle(token: model.completedStartupToken, active: true)
            model.requestCalendarPushLifecycle(token: model.completedStartupToken, active: true)
        }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.willResignActiveNotification)) { _ in
            let dropboxBrowser = model.dropboxAuthorizationWillResignActive()
            model.retireReviewAI()
            model.retireProcessInboxAI()
            model.retireTaskAI()
            observedApplicationActive = false
            model.retireTrashPresentation()
            model.retireCaptureEditNavigation()
            model.suspendEntityLinks()
            model.appleRemindersWillResignActive()
            model.notificationSettingsWillResignActive()
            model.calendarSettingsWillResignActive()
            model.calendarFeedWillResignActive()
            if !dropboxBrowser { model.cancelForegroundSync() }
            model.cancelAppleRemindersAutoImport()
            model.cancelGmailCapture()
            model.cancelReminderLifecycle()
            model.cancelCalendarPushLifecycle()
            model.cancelSearchLifecycle()
            model.cancelProjectAttachmentDownload()
            if !dropboxBrowser { model.clearSettingsSyncForPrivacy() }
            model.stopTaskAudioForBackground()
            model.cancelTaskFileImport()
            model.cancelProjectFileImport()
            model.flushTaskDraftCheckpointInBackground()
            if !dropboxBrowser {
                if model.appLockActive && !lock.authenticating { lock.readFailed() }
                lock.concealSnapshot()
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didEnterBackgroundNotification)) { _ in
            _ = model.dropboxAuthorizationSceneChanged(.background)
            model.cancelAppleRemindersIntent()
            model.cancelNotificationSettingsIntent()
            model.cancelCalendarSettingsIntent()
            model.retireCalendarFeed()
        }
        .onChange(of: phase) { next in
            let dropboxBrowser = model.dropboxAuthorizationSceneChanged(next)
            if next == .background { model.cancelAppleRemindersIntent(); model.cancelNotificationSettingsIntent(); model.cancelCalendarSettingsIntent(); model.retireCalendarFeed() }
            model.observeForegroundSyncScene(next, token: startupToken)
            if next != .active {
                model.retireTrashPresentation()
                model.retireCaptureEditNavigation()
                model.suspendEntityLinks()
                if !dropboxBrowser { model.cancelForegroundSync() }
                model.cancelAppleRemindersAutoImport()
                model.cancelGmailCapture()
                model.cancelReminderLifecycle()
                model.cancelCalendarPushLifecycle()
                model.cancelSearchLifecycle()
                model.cancelProjectAttachmentDownload()
                model.cancelProjectFileAvailabilityRecovery()
                if !dropboxBrowser { model.clearSettingsSyncForPrivacy() }
                model.stopTaskAudioForBackground()
                model.cancelTaskFileImport()
                model.cancelProjectFileImport()
                model.flushTaskDraftCheckpointInBackground()
            }
            if !dropboxBrowser {
                if next != .active && model.appLockActive && !lock.authenticating { lock.readFailed() }
                lock.sceneChanged(next)
            }
            if next == .active && !lock.concealed { Task { await model.refresh() } }
            model.requestForegroundSync(token: model.completedStartupToken, active: applicationActive)
            model.requestAppleRemindersAutoImport(token: model.completedStartupToken, active: applicationActive)
            model.requestGmailCapture(token: model.completedStartupToken, active: applicationActive)
            model.requestReminderLifecycle(token: model.completedStartupToken, active: applicationActive)
            model.requestCalendarPushLifecycle(token: model.completedStartupToken, active: applicationActive)
            model.requestSearchLifecycle(token: model.completedStartupToken, active: applicationActive)
        }
        .onChange(of: lock.concealed) { concealed in
            if concealed {
                model.retireTrashPresentation()
                model.retireCaptureEditNavigation()
                model.suspendEntityLinks()
                model.cancelAppleRemindersIntent()
                model.cancelNotificationSettingsIntent()
                model.cancelCalendarSettingsIntent()
                model.retireCalendarFeed()
                model.cancelForegroundSync()
                model.cancelAppleRemindersAutoImport()
                model.cancelGmailCapture()
                model.cancelReminderLifecycle()
                model.cancelCalendarPushLifecycle()
                model.cancelSearchLifecycle()
                model.cancelProjectAttachmentDownload()
                model.cancelProjectFileAvailabilityRecovery()
                model.clearSettingsSyncForPrivacy()
                model.cancelTaskFileImport()
                model.cancelProjectFileImport()
                model.dismissTaskShare()
            }
            if !concealed && phase == .active { Task { await model.refresh() } }
        }
        .onChange(of: scheme) { next in model.widgetAppearanceChanged(next == .dark ? .dark : .light) }
        .onChange(of: lock.enabled) { _ in model.searchPolicyChanged() }
        .onChange(of: lock.authenticating) { _ in model.searchPolicyChanged() }
        .onChange(of: model.appLockActive) { _ in model.searchPolicyChanged() }
        .onChange(of: foreground) { next in
            model.requestForegroundSync(token: next.token, active: next.active)
            model.requestAppleRemindersAutoImport(token: next.token, active: next.active)
            model.requestGmailCapture(token: next.token, active: next.active)
            model.requestReminderLifecycle(token: next.token, active: next.active)
            model.requestCalendarPushLifecycle(token: next.token, active: next.active)
            model.requestSearchLifecycle(token: next.token, active: next.active)
            if next.active && !next.concealed { model.requestNotificationResponses() }
            if next.active && !next.concealed { model.requestEntityLinks(); model.requestShareCapture(); model.requestQuickCaptureIntent() }
        }
        .onChange(of: model.notificationResponseContextClean) { clean in
            if clean { model.externalContextBecameClean() }
        }
        #if DEBUG && targetEnvironment(simulator)
        .overlay(alignment: .bottom) {
            if model.captureSaveEditPostAckTestHeld {
                VStack {
                    Text(model.captureSaveEditTestState).rnFont(10)
                        .accessibilityIdentifier("capture-save-edit-fixture-state")
                    Button("Release capture read") { model.releaseCaptureSaveEditFixtureAcknowledgement() }
                        .buttonStyle(.bordered).frame(minHeight: 44)
                        .accessibilityIdentifier("capture-save-edit-fixture-release")
                }
                .padding(16).background(palette.card)
            }
        }
        .onChange(of: model.morePresented) { presented in
            if presented {
                model.deliverEntityLinkTestInput("more")
                Task { try? await NativeNotificationResponses.shared.captureMoreTestResponse() }
            }
        }
        .onChange(of: model.taskTitleDraft) { _ in model.deliverEntityLinkTestInput("dirty") }
        .onChange(of: model.morePresented) { presented in
            if presented { model.deliverSearchTestInput("more") }
        }
        .onChange(of: model.taskTitleDraft) { _ in model.deliverSearchTestInput("dirty") }
        #endif
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.significantTimeChangeNotification)) { _ in
            model.reminderClockChanged()
            model.searchClockChanged()
        }
        .onReceive(NotificationCenter.default.publisher(for: .NSCalendarDayChanged)) { _ in
            model.reminderClockChanged(); model.searchClockChanged()
        }
        .onReceive(NotificationCenter.default.publisher(for: .NSSystemTimeZoneDidChange)) { _ in
            model.reminderClockChanged(); model.searchClockChanged()
        }
        .task(id: "\(workspaceReady)-\(lock.nonce)-\(phase == .active)-\(lock.authenticating)") {
            guard workspaceReady, phase == .active else { return }
            await lock.autoUnlock(label: model.label)
        }
        .alert("Discard unreadable draft?", isPresented: $confirmingCorruptDraftDiscard) {
            Button("Discard draft", role: .destructive) {
                Task { await model.discardCorruptStartupDraft() }
            }
            .accessibilityIdentifier("task-recovery-startup-discard-confirm")
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This removes the unsaved editor draft from this device. A pending save will prevent removal until it is settled.")
        }
    }
}

private struct TaskRecoveryGate: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    @State private var confirmingDiscard = false
    private var retainedCleanup: Bool {
        model.taskAttachmentState == .savedCleanup
            || (model.taskAttachmentState == .discardedCleanup && !model.taskAttachmentHasIndependentDraft)
    }
    private var canResume: Bool {
        model.taskAttachmentState == .none || model.taskAttachmentState == .active
            || model.taskAttachmentHasIndependentDraft
    }

    var body: some View {
        GeometryReader { geometry in
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Text(model.taskAttachmentState == .savedCleanup ? "Task saved"
                        : retainedCleanup ? "Draft discarded" : "Saved task draft")
                        .rnFont(24, .bold)
                        .accessibilityAddTraits(.isHeader)
                    if !retainedCleanup {
                        Text(model.taskRecoveryReviewTitle.isEmpty ? "Untitled task" : model.taskRecoveryReviewTitle)
                            .rnFont(17, .semibold)
                            .accessibilityIdentifier("task-recovery-title")
                        if !model.taskRecoveryReviewNote.isEmpty {
                            Text(model.taskRecoveryReviewNote).rnFont(15)
                                .foregroundStyle(palette.secondary)
                                .accessibilityIdentifier("task-recovery-note")
                        }
                        ForEach(Array(model.taskRecoveryReviewLines.enumerated()), id: \.offset) { entry in
                            Text(entry.element).rnFont(15).foregroundStyle(palette.secondary)
                        }
                    }
                    TaskAttachmentRecoveryStatus(model: model, palette: palette)
                    if let conflict = model.taskRecoveryConflict {
                        Text(conflict).rnFont(15).foregroundStyle(palette.danger)
                            .accessibilityIdentifier("task-recovery-conflict")
                    }
                    if !retainedCleanup, let protectionError = model.taskRecoveryCheckpointError {
                        Text(protectionError).rnFont(15).foregroundStyle(palette.danger)
                            .accessibilityIdentifier("task-recovery-error")
                        Button(model.label("common.retry")) {
                            Task { await model.retryTaskDraftCheckpoint() }
                        }
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .accessibilityIdentifier("task-recovery-retry-checkpoint")
                    }
                    if model.busy && model.taskAttachmentState == .none {
                        ProgressView().frame(minHeight: 44)
                            .accessibilityIdentifier("task-recovery-loading")
                    }
                    if canResume {
                        Button("Resume editing") { Task { await model.restoreTaskRecovery() } }
                            .buttonStyle(.borderedProminent)
                            .frame(maxWidth: .infinity, minHeight: 44)
                            .disabled(model.busy)
                            .accessibilityIdentifier("task-recovery-resume")
                    }
                    if !retainedCleanup {
                        Button("Keep for later") { Task { await model.keepTaskRecoveryForLater() } }
                            .frame(maxWidth: .infinity, minHeight: 44)
                            .disabled(model.busy || model.taskRecoveryCheckpointError != nil)
                            .accessibilityIdentifier("task-recovery-keep")
                        Button("Discard draft", role: .destructive) { confirmingDiscard = true }
                            .frame(maxWidth: .infinity, minHeight: 44)
                            .disabled(model.busy)
                            .accessibilityIdentifier("task-recovery-discard")
                    }
                }
                .padding(24)
                .frame(maxWidth: 540, minHeight: geometry.size.height, alignment: .center)
                .frame(maxWidth: .infinity)
            }
        }
        .foregroundStyle(palette.text)
        .background(palette.bg)
        .tint(palette.tint)
        .accessibilityIdentifier("task-recovery-gate")
        .alert("Discard saved draft?", isPresented: $confirmingDiscard) {
            Button("Discard draft", role: .destructive) {
                Task { await model.discardTaskRecoveryDraft(close: true) }
            }
            .accessibilityIdentifier("task-recovery-discard-confirm")
            Button(model.label("common.cancel"), role: .cancel) {}
        } message: {
            Text("This removes the unsaved task changes from this device.")
        }
        .task {
            if canResume && model.taskRecoveryConflict == nil { await model.restoreTaskRecovery() }
        }
    }
}

struct TaskAttachmentRecoveryStatus: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette

    private var message: String? {
        switch model.taskAttachmentState {
        case .none: return nil
        case .active: return "File editing is active. Save or discard this draft to finish."
        case .interrupted: return "File editing was interrupted. Retry to confirm the result before continuing."
        case .savedCleanup: return "Task saved. File cleanup still needs to finish. Retry will finish cleanup."
        case .discardedCleanup:
            return model.taskAttachmentHasIndependentDraft
                ? "An earlier draft was discarded. Its file cleanup still needs to finish."
                : "Draft changes were discarded. File cleanup still needs to finish."
        case .blocked: return "This draft needs a recovery decision before file editing can continue."
        }
    }

    var body: some View {
        if message != nil || model.taskAttachmentError != nil {
            VStack(alignment: .leading, spacing: 8) {
                if let message {
                    Text(message).rnFont(14).foregroundStyle(palette.secondary)
                        .accessibilityIdentifier("task-attachment-status")
                }
                if model.taskAttachmentError != nil {
                    Text(model.label("settings.feedback.actionFailed").isEmpty
                        ? "Couldn't complete this action. Try again."
                        : model.label("settings.feedback.actionFailed")).rnFont(14).foregroundStyle(palette.danger)
                        .textSelection(.enabled)
                        .accessibilityIdentifier("task-attachment-error")
                }
                if model.taskAttachmentWorking {
                    ProgressView().frame(minHeight: 44)
                }
                if model.taskAttachmentState == .interrupted || model.taskAttachmentState == .savedCleanup
                    || model.taskAttachmentState == .discardedCleanup || model.taskAttachmentState == .blocked {
                    if model.taskAttachmentState == .discardedCleanup
                        && (model.taskPresented || model.taskAttachmentHasIndependentDraft) {
                        Text("Save or discard the current draft before retrying file cleanup.")
                            .rnFont(14).foregroundStyle(palette.secondary)
                    }
                    Button(model.label("common.retry").isEmpty ? "Retry" : model.label("common.retry")) {
                        Task { await model.retryTaskAttachmentRecovery() }
                    }
                    .frame(minWidth: 44, minHeight: 44)
                    .disabled(model.busy || model.taskAttachmentWorking
                        || (model.taskAttachmentState == .discardedCleanup
                            && (model.taskPresented || model.taskAttachmentHasIndependentDraft)))
                    .accessibilityIdentifier("task-attachment-retry")
                }
                if model.taskAttachmentState == .discardedCleanup && !model.taskPresented
                    && !model.taskAttachmentHasIndependentDraft {
                    Button("Continue") { Task { await model.continueAfterTaskAttachmentDiscard() } }
                        .frame(minWidth: 44, minHeight: 44)
                        .disabled(model.busy || model.taskAttachmentWorking)
                        .accessibilityIdentifier("task-attachment-continue")
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
