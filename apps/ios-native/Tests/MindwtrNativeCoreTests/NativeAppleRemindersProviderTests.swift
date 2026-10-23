import Foundation
import XCTest
@testable import MindwtrNativeCore

final class AppleRemindersTestSDK: NativeAppleRemindersSDK, @unchecked Sendable {
    let lock = NSLock()
    var listValues = [NativeAppleReminderListDTO(identity: .init(id: "list", sourceID: "account"), title: "List", color: nil)]
    var permissionCompletion: ((Result<Void, NativeAppleRemindersError>) -> Void)?
    var receive: ((() throws -> [NativeAppleReminderSDKRow]?) -> Void)?
    var beforeFetchReturn: (() -> Void)?
    var immediate: [NativeAppleReminderSDKRow]?
    var beforeRemove: (() throws -> Void)?
    var afterRemove: (() throws -> Void)?
    private(set) var removals: [String] = []
    private(set) var requests = 0
    private(set) var listReads = 0
    private(set) var fetches = 0
    private(set) var cancellations: [UUID] = []
    func requestPermission(_ completion: @escaping (Result<Void, NativeAppleRemindersError>) -> Void) {
        lock.lock(); requests += 1; permissionCompletion = completion; lock.unlock()
    }
    func lists() throws -> [NativeAppleReminderListDTO] { lock.lock(); defer { lock.unlock() }; listReads += 1; return listValues }
    func fetch(list: NativeAppleReminderListIdentity,
               receive: @escaping (() throws -> [NativeAppleReminderSDKRow]?) -> Void) throws -> Any {
        lock.lock(); fetches += 1; self.receive = receive; let rows = immediate; lock.unlock()
        if let rows { receive { rows } }
        beforeFetchReturn?()
        return UUID()
    }
    func cancelFetch(_ token: Any) {
        lock.lock(); cancellations.append(token as! UUID); lock.unlock()
        // Real EventKit suppresses the completion; deliberately do not call receive.
    }
    func remove(list: NativeAppleReminderListIdentity, source: NativeAppleReminderSourceDTO, cancellation: NativeAttachmentCancellation) throws {
        try beforeRemove?()
        guard !cancellation.isCancelled else { throw NativeAppleRemindersError.cancelled }
        guard let actual = immediate?.first(where: { $0.source.id == source.id }), actual.list.matches(list) else {
            throw NativeAppleRemindersError.listChanged
        }
        try NativeAppleRemindersValidation.unchanged(actual.source, expected: source)
        lock.lock(); removals.append(source.id!); lock.unlock()
        try afterRemove?()
    }
    func deliver(_ rows: [NativeAppleReminderSDKRow]?) { receive? { rows } }
    static func row(_ id: String = "item", completed: Bool = false,
                    list: String = "list", account: String = "account", notes: String? = nil) -> NativeAppleReminderSDKRow {
        .init(list: .init(id: list, sourceID: account), source: .init(id: id, title: " Title ", notes: notes,
            completed: completed, creationDate: nil, startDate: nil, dueDate: nil, revision: "revision-1"))
    }
}

final class NativeAppleRemindersProviderTests: XCTestCase {
    private let list = NativeAppleReminderListIdentity(id: "list", sourceID: "account")

    func testRemovalRequiresFreshPermissionListAndUnchangedSource() throws {
        let sdk = AppleRemindersTestSDK(); let source = AppleRemindersTestSDK.row().source
        sdk.immediate = [.init(list: list, source: source)]
        var permission = NativeAppleRemindersPermission.denied
        let provider = NativeAppleRemindersProvider(status: { permission }, sdkFactory: { sdk })
        XCTAssertThrowsError(try provider.remove(list: list, source: source, cancellation: .init()))
        permission = .granted
        XCTAssertThrowsError(try provider.remove(list: .init(id: "list", sourceID: "other"), source: source, cancellation: .init()))
        var changed = source; changed.revision = "revision-2"
        sdk.immediate = [.init(list: list, source: changed)]
        XCTAssertThrowsError(try provider.remove(list: list, source: source, cancellation: .init()))
        sdk.immediate = [.init(list: list, source: source)]
        let cancelled = NativeAttachmentCancellation(); cancelled.cancel()
        XCTAssertThrowsError(try provider.remove(list: list, source: source, cancellation: cancelled))
        XCTAssertEqual(sdk.removals, [])
        try provider.remove(list: list, source: source, cancellation: .init())
        XCTAssertEqual(sdk.removals, ["item"])
    }

    func testRemovalWitnessIsPrivateAndExactAndMissingWitnessRefuses() throws {
        let source = AppleRemindersTestSDK.row(notes: "caf\u{e9}").source
        XCTAssertNil(source.value["revision"]); XCTAssertEqual(source.providerValue["revision"] as? String, "revision-1")
        let changed = AppleRemindersTestSDK.row(notes: "cafe\u{301}").source
        XCTAssertThrowsError(try NativeAppleRemindersValidation.unchanged(changed, expected: source))
        var missing = source; missing.revision = nil
        XCTAssertThrowsError(try NativeAppleRemindersValidation.removal(missing))
        XCTAssertThrowsError(try NativeAppleRemindersValidation.source(["completed": 1]))
        XCTAssertThrowsError(try NativeAppleRemindersValidation.source(["completed": false, "other": "value"]))
    }

    func testPassivePermissionNeverCreatesSDKAndDeniedReadsNeverFetch() throws {
        var factories = 0
        let provider = NativeAppleRemindersProvider(status: { .denied }, sdkFactory: { factories += 1; return AppleRemindersTestSDK() })
        XCTAssertEqual(provider.permission(), .denied)
        XCTAssertThrowsError(try provider.lists())
        XCTAssertThrowsError(try provider.beginRead(list: list, cancellation: .init()) { _ in XCTFail() })
        XCTAssertEqual(factories, 0)
    }

    func testExplicitPermissionRetainsRealCallbackAndReadsFreshStatus() {
        let sdk = AppleRemindersTestSDK(); var status = NativeAppleRemindersPermission.undetermined
        let provider = NativeAppleRemindersProvider(status: { status }, sdkFactory: { sdk })
        var answers: [NativeAppleRemindersPermission] = []
        provider.requestPermission { if case .success(let value) = $0 { answers.append(value) } }
        XCTAssertEqual(sdk.requests, 1); XCTAssertTrue(answers.isEmpty)
        status = .denied; sdk.permissionCompletion?(.success(()))
        XCTAssertEqual(answers, [.denied])
        provider.requestPermission { if case .success(let value) = $0 { answers.append(value) } else { XCTFail() } }
        status = .granted; sdk.permissionCompletion?(.success(())); sdk.permissionCompletion?(.success(()))
        XCTAssertEqual(answers, [.denied, .granted])
        provider.requestPermission { if case .failure(let value) = $0 { XCTAssertEqual(value, .failed) } else { XCTFail() } }
        sdk.permissionCompletion?(.failure(.failed))
    }

    func testExactListAndSourceUTF8CannotSubstituteEquivalentOrMissingIdentity() throws {
        let sdk = AppleRemindersTestSDK()
        sdk.listValues = [.init(identity: .init(id: "caf\u{e9}", sourceID: "account"), title: "Same", color: nil)]
        let provider = NativeAppleRemindersProvider(status: { .granted }, sdkFactory: { sdk })
        for identity in [NativeAppleReminderListIdentity(id: "cafe\u{301}", sourceID: "account"),
                         .init(id: "caf\u{e9}", sourceID: "other"), .init(id: "missing", sourceID: "account")] {
            XCTAssertThrowsError(try provider.beginRead(list: identity, cancellation: .init()) { _ in XCTFail() })
        }
        XCTAssertEqual(sdk.fetches, 0)
    }

    func testValidEmptyIsSuccessButNilFailsAndCompletedOrderIsPreserved() throws {
        let sdk = AppleRemindersTestSDK(), provider = NativeAppleRemindersProvider(status: { .granted }, sdkFactory: { sdk })
        var results: [Result<NativeAppleReminderReadDTO, NativeAppleRemindersError>] = []
        _ = try provider.beginRead(list: list, cancellation: .init()) { results.append($0) }; sdk.deliver([])
        XCTAssertEqual(try results[0].get().sources.count, 0)
        _ = try provider.beginRead(list: list, cancellation: .init()) { results.append($0) }; sdk.deliver(nil)
        if case .failure(.failed) = results[1] {} else { XCTFail() }
        _ = try provider.beginRead(list: list, cancellation: .init()) { results.append($0) }
        sdk.deliver([AppleRemindersTestSDK.row("done", completed: true), AppleRemindersTestSDK.row("next", notes: " Notes "),
                     AppleRemindersTestSDK.row("empty", notes: "")])
        let rows = try results[2].get().sources
        XCTAssertEqual(rows.map(\.id), ["done", "next", "empty"]); XCTAssertTrue(rows[0].completed)
        XCTAssertEqual(rows[1].title, " Title "); XCTAssertEqual(rows[1].notes, " Notes ")
        XCTAssertNil(rows[0].value["notes"]); XCTAssertEqual(rows[2].value["notes"] as? String, "")
    }

    func testImmediateAndDuplicateCallbacksConvertAndSettleOnlyOnce() throws {
        let sdk = AppleRemindersTestSDK(); sdk.immediate = [AppleRemindersTestSDK.row()]
        let provider = NativeAppleRemindersProvider(status: { .granted }, sdkFactory: { sdk })
        var answers = 0, extraConversions = 0
        _ = try provider.beginRead(list: list, cancellation: .init()) { _ in answers += 1 }
        sdk.receive? { extraConversions += 1; return [] }
        XCTAssertEqual(answers, 1); XCTAssertEqual(extraConversions, 0)
    }

    func testClosedGateNeverReadsSDKFieldsAndCancelDrainsWithoutCallback() throws {
        let sdk = AppleRemindersTestSDK(), provider = NativeAppleRemindersProvider(status: { .granted }, sdkFactory: { sdk })
        let token = NativeAttachmentCancellation()
        let id = try provider.beginRead(list: list, cancellation: token) { _ in XCTFail("cancelled adoption") }
        token.cancel(); var drained = 0, conversions = 0
        provider.cancelRead(id) { drained += 1 }
        sdk.receive? { conversions += 1; return [] }
        provider.cancelRead(id) { drained += 1 }
        XCTAssertEqual(conversions, 0); XCTAssertEqual(drained, 2); XCTAssertEqual(sdk.cancellations.count, 1)
    }

    func testCancellationDuringConversionWaitsForItsDeparture() throws {
        let sdk = AppleRemindersTestSDK(), provider = NativeAppleRemindersProvider(status: { .granted }, sdkFactory: { sdk })
        let token = NativeAttachmentCancellation(), entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
        let converted = expectation(description: "conversion exited"), drained = expectation(description: "drained")
        let drainSignal = DispatchSemaphore(value: 0)
        let id = try provider.beginRead(list: list, cancellation: token) { _ in XCTFail("retired result") }
        DispatchQueue.global().async {
            sdk.receive? { entered.signal(); _ = release.wait(timeout: .now() + 5); return [] }
            converted.fulfill()
        }
        XCTAssertEqual(entered.wait(timeout: .now() + 2), .success)
        token.cancel(); provider.cancelRead(id) { drainSignal.signal(); drained.fulfill() }
        XCTAssertEqual(drainSignal.wait(timeout: .now()), .timedOut)
        release.signal(); wait(for: [converted, drained], timeout: 3)
        XCTAssertEqual(sdk.cancellations.count, 1)
    }

    func testCancellationWaitsForAdmittedCompletionPublication() throws {
        let sdk = AppleRemindersTestSDK(), provider = NativeAppleRemindersProvider(status: { .granted }, sdkFactory: { sdk })
        let token = NativeAttachmentCancellation(), entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
        let drainSignal = DispatchSemaphore(value: 0), departed = expectation(description: "publication departed")
        let id = try provider.beginRead(list: list, cancellation: token) { _ in
            entered.signal(); _ = release.wait(timeout: .now() + 5)
        }
        DispatchQueue.global().async { sdk.deliver([]); departed.fulfill() }
        XCTAssertEqual(entered.wait(timeout: .now() + 2), .success)
        token.cancel(); provider.cancelRead(id) { drainSignal.signal() }
        XCTAssertEqual(drainSignal.wait(timeout: .now()), .timedOut)
        release.signal(); wait(for: [departed], timeout: 3)
        XCTAssertEqual(drainSignal.wait(timeout: .now() + 1), .success)
    }

    func testWholeReadRefusesWrongListDuplicateIDsAndRowLimit() throws {
        let sdk = AppleRemindersTestSDK(), provider = NativeAppleRemindersProvider(status: { .granted }, sdkFactory: { sdk })
        for rows in [[AppleRemindersTestSDK.row(list: "other")],
                     [AppleRemindersTestSDK.row(), AppleRemindersTestSDK.row()],
                     (0...10_000).map { AppleRemindersTestSDK.row(String($0)) }] {
            var failed = false
            _ = try provider.beginRead(list: list, cancellation: .init()) { if case .failure = $0 { failed = true } }
            sdk.deliver(rows); XCTAssertTrue(failed)
        }
        var accepted = 0
        _ = try provider.beginRead(list: list, cancellation: .init()) { if case .success(let value) = $0 { accepted = value.sources.count } }
        sdk.deliver((0..<10_000).map { AppleRemindersTestSDK.row(String($0)) })
        XCTAssertEqual(accepted, 10_000)
    }

    func testUTF8IDAndFieldBoundsRejectWholeListsAndReads() throws {
        let sdk = AppleRemindersTestSDK(), provider = NativeAppleRemindersProvider(status: { .granted }, sdkFactory: { sdk })
        let bounded = NativeAppleReminderListDTO(identity: .init(id: String(repeating: "é", count: 512), sourceID: "account"), title: "List", color: nil)
        sdk.listValues = [bounded]; XCTAssertEqual(try provider.lists().count, 1)
        sdk.listValues = [bounded, bounded]; XCTAssertThrowsError(try provider.lists())
        sdk.listValues = [.init(identity: .init(id: String(repeating: "é", count: 513), sourceID: "account"), title: "List", color: nil)]
        XCTAssertThrowsError(try provider.lists())
        sdk.listValues = [.init(identity: list, title: "List", color: nil)]
        for row in [AppleRemindersTestSDK.row(String(repeating: "é", count: 513)),
                    AppleRemindersTestSDK.row(notes: String(repeating: "é", count: 524_289))] {
            var failed = false
            _ = try provider.beginRead(list: list, cancellation: .init()) { if case .failure = $0 { failed = true } }
            sdk.deliver([row]); XCTAssertTrue(failed)
        }
    }

    func testPrimitiveDatesMatchExpoCurrentCalendarUTCAndMillisecondStrings() throws {
        var calendar = Calendar(identifier: .gregorian); calendar.timeZone = try XCTUnwrap(TimeZone(identifier: "America/New_York"))
        XCTAssertNil(NativeAppleRemindersDates.components(nil, calendar: calendar))
        XCTAssertEqual(NativeAppleRemindersDates.date(Date(timeIntervalSince1970: 0.123)), "1970-01-01T00:00:00.123Z")
        let allDay = DateComponents(year: 2026, month: 3, day: 8)
        XCTAssertEqual(NativeAppleRemindersDates.components(allDay, calendar: calendar), "2026-03-08T05:00:00.000Z")
        let afterDST = DateComponents(year: 2026, month: 3, day: 9, hour: 9, minute: 30)
        XCTAssertEqual(NativeAppleRemindersDates.components(afterDST, calendar: calendar), "2026-03-09T13:30:00.000Z")
        var utc = afterDST; utc.timeZone = TimeZone(secondsFromGMT: 0)
        XCTAssertEqual(NativeAppleRemindersDates.components(utc, calendar: calendar), "2026-03-09T09:30:00.000Z")
        let expo = DateFormatter(); expo.locale = Locale(identifier: "en_US_POSIX"); expo.timeZone = TimeZone(identifier: "UTC")
        expo.dateFormat = "yyyy-MM-dd'T'HH:mm:ss.SSSZZZZZ"
        let fractional = Date(timeIntervalSince1970: 1_000.9996)
        XCTAssertEqual(NativeAppleRemindersDates.date(fractional), expo.string(from: fractional))
    }

    #if !os(iOS) || !canImport(EventKit)
    func testSystemAdapterIsUnavailableOutsideIOS() {
        let provider = NativeAppleRemindersProvider()
        XCTAssertEqual(provider.permission(), .unavailable)
        XCTAssertThrowsError(try provider.lists())
    }
    #endif
}
