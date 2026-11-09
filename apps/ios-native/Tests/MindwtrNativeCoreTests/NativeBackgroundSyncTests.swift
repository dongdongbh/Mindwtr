import XCTest
@testable import MindwtrNativeCore

private final class FakeBackgroundScheduler: NativeBackgroundSyncScheduling {
    var submitted: [(String, Date)] = []
    var cancelled: [String] = []
    func submit(identifier: String, earliestBeginDate: Date) throws { submitted.append((identifier, earliestBeginDate)) }
    func cancel(identifier: String) { cancelled.append(identifier) }
}

final class NativeBackgroundSyncTests: XCTestCase {
    private var defaults: UserDefaults!
    private var scheduler: FakeBackgroundScheduler!
    private var clock = Date(timeIntervalSince1970: 1_000_000)

    override func setUp() {
        super.setUp()
        defaults = UserDefaults(suiteName: "NativeBackgroundSyncTests-\(UUID().uuidString)")
        scheduler = FakeBackgroundScheduler()
    }

    private func makeSync() -> NativeBackgroundSync {
        NativeBackgroundSync(scheduler: scheduler, defaults: defaults, now: { [unowned self] in self.clock })
    }

    func testScheduleUsesRNIdentifierAndFifteenMinuteIntervalAndCancelsWhenUnwanted() {
        let sync = makeSync()
        sync.schedule(true)
        XCTAssertEqual(scheduler.submitted.map { $0.0 }, ["com.expo.modules.backgroundtask.processing"])
        XCTAssertEqual(scheduler.submitted.first?.1, clock.addingTimeInterval(15 * 60))
        sync.schedule(false)
        XCTAssertEqual(scheduler.cancelled, ["com.expo.modules.backgroundtask.processing"])
    }

    func testWantedMatchesNativeAutomaticSyncBackends() {
        XCTAssertTrue(NativeBackgroundSync.wanted(backend: " webdav ", cloudProvider: nil))
        XCTAssertTrue(NativeBackgroundSync.wanted(backend: "cloud", cloudProvider: nil))
        XCTAssertTrue(NativeBackgroundSync.wanted(backend: "cloud", cloudProvider: "selfhosted"))
        XCTAssertFalse(NativeBackgroundSync.wanted(backend: "cloud", cloudProvider: "dropbox"))
        for backend in [nil, "off", "file", "cloudkit"] {
            XCTAssertFalse(NativeBackgroundSync.wanted(backend: backend, cloudProvider: nil))
        }
    }

    func testRunCompletesExactlyOnceAndReschedules() {
        let sync = makeSync()
        var completions: [Bool] = []
        let run = sync.begin { completions.append($0) }
        XCTAssertTrue(run.end(.finished))
        XCTAssertFalse(run.end(.expired))
        XCTAssertFalse(run.end(.failed))
        XCTAssertEqual(completions, [true])
        XCTAssertEqual(run.outcome, .finished)
        XCTAssertEqual(scheduler.submitted.count, 1)
    }

    func testExpiryCancelsWorkCompletesUnsuccessfullyAndIgnoresLateFinish() {
        let sync = makeSync()
        var completions: [Bool] = []
        var cancels = 0
        let run = sync.begin { completions.append($0) }
        XCTAssertTrue(run.onCancel { cancels += 1 })
        XCTAssertTrue(run.end(.expired))
        XCTAssertFalse(run.end(.finished))
        XCTAssertEqual(completions, [false])
        XCTAssertEqual(cancels, 1)
        XCTAssertEqual(scheduler.submitted.count, 1)
    }

    func testWorkAttachedAfterExpiryIsCancelledAtOnce() {
        let run = makeSync().begin { _ in }
        run.end(.expired)
        var cancels = 0
        XCTAssertFalse(run.onCancel { cancels += 1 })
        XCTAssertEqual(cancels, 1)
    }

    func testFinishedRunDoesNotCancelWork() {
        let run = makeSync().begin { _ in }
        var cancels = 0
        run.onCancel { cancels += 1 }
        run.end(.finished)
        XCTAssertEqual(cancels, 0)
    }

    func testDeadlineExpiresRunAndCountsAsFailure() {
        let sync = makeSync()
        let completed = expectation(description: "completed")
        let reported = expectation(description: "reported")
        var cancels = 0
        let run = sync.begin { success in XCTAssertFalse(success); completed.fulfill() }
        run.onCancel { cancels += 1 }
        run.armDeadline(after: 0.01) { reported.fulfill() }
        wait(for: [completed, reported], timeout: 2)
        XCTAssertEqual(run.outcome, .expired)
        XCTAssertEqual(cancels, 1)
        XCTAssertTrue(sync.coolingDown)
    }

    func testDeadlineAfterFinishDoesNothing() {
        let sync = makeSync()
        let run = sync.begin { _ in }
        run.end(.finished)
        let reported = expectation(description: "not reported")
        reported.isInverted = true
        run.armDeadline(after: 0.01) { reported.fulfill() }
        wait(for: [reported], timeout: 0.2)
        XCTAssertEqual(run.outcome, .finished)
    }

    func testFailureCooldownDoublesUpToTwoHoursAndSuccessClearsIt() {
        let sync = makeSync()
        XCTAssertFalse(sync.coolingDown)
        for (failures, minutes) in [(1, 15.0), (2, 30.0), (3, 60.0), (4, 120.0), (5, 120.0)] {
            sync.begin { _ in }.end(.failed)
            clock = clock.addingTimeInterval(minutes * 60 - 1)
            XCTAssertTrue(sync.coolingDown, "failures=\(failures)")
            clock = clock.addingTimeInterval(1)
            XCTAssertFalse(sync.coolingDown, "failures=\(failures)")
        }
        sync.begin { _ in }.end(.finished)
        sync.begin { _ in }.end(.failed)
        clock = clock.addingTimeInterval(15 * 60)
        XCTAssertFalse(sync.coolingDown)
    }

    func testSkippedRunKeepsFailureRecord() {
        let sync = makeSync()
        sync.begin { _ in }.end(.failed)
        sync.begin { _ in }.end(.skipped)
        XCTAssertTrue(sync.coolingDown)
    }

    func testUnwantedRunCancelsScheduleWhenItEnds() {
        let sync = makeSync()
        let run = sync.begin { _ in }
        run.unwanted()
        run.end(.skipped)
        XCTAssertTrue(scheduler.submitted.isEmpty)
        XCTAssertEqual(scheduler.cancelled, [NativeBackgroundSync.identifier])
    }
}
