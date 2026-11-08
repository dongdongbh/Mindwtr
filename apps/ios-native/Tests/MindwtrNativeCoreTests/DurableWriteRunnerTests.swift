import Foundation
import XCTest
@testable import MindwtrNativeCore

@MainActor
final class DurableWriteRunnerTests: XCTestCase {
    private final class FakeTransport: DurableWriteTransport {
        var pendingReplies: [String?] = []
        var retryPendingCalls = 0
        func retryPending() async throws -> String? {
            retryPendingCalls += 1
            return pendingReplies.isEmpty ? nil : pendingReplies.removeFirst()
        }
    }

    private final class Recorder {
        var busy = false
        var begins = 0
        var finishes = 0
        var retryNeeded = false
        var error: String?
        var events: [String] = []
        var model: DurableWriteModel {
            DurableWriteModel(isBusy: { self.busy }, begin: {
                self.busy = true
                self.begins += 1
            }, finish: {
                self.busy = false
                self.finishes += 1
            }, setRetryNeeded: { needed, error in
                self.retryNeeded = needed
                self.error = error
            }, isDefiniteRejection: { $0 is CoreHostRejection })
        }
    }

    private struct Script {
        var dispatch: () throws -> String = { "dispatched" }
        var retryOutcome: () throws -> String = { "probed" }
        var acknowledge: (String) throws -> Void = { _ in }
    }

    private func write(_ recorder: Recorder, _ script: Script = Script(), admit: Bool = true) -> DurableWriteRunner<FakeTransport>.Write {
        .init(admit: { _ in admit }, dispatch: { _, request, _ in
            recorder.events.append("dispatch:" + request)
            return try script.dispatch()
        }, retryOutcome: { _, request in
            recorder.events.append("outcome:" + request)
            return try script.retryOutcome()
        }, acknowledge: { reply in
            recorder.events.append("ack:" + reply)
            try script.acknowledge(reply)
        }, fail: { _, definite in
            recorder.events.append(definite ? "rejected" : "uncertain")
            return "failed"
        }, refresh: { acknowledged in
            recorder.events.append(acknowledged ? "refresh" : "refresh:rejected")
        }, ended: { _ in
            recorder.events.append("ended")
        })
    }

    private func run(_ runner: DurableWriteRunner<FakeTransport>, retry: Bool,
                     _ write: DurableWriteRunner<FakeTransport>.Write) async -> Bool {
        let started = runner.run(retry: retry, write)
        await runner.task?.value
        return started
    }

    func testSuccessAcknowledgesClearsPendingAndRefreshes() async {
        let recorder = Recorder(), transport = FakeTransport()
        let runner = DurableWriteRunner<FakeTransport>(model: recorder.model)
        runner.stage("request-1", on: transport)
        let started = await run(runner, retry: false, write(recorder))
        XCTAssertTrue(started)
        XCTAssertEqual(recorder.events, ["dispatch:request-1", "ack:dispatched", "refresh", "ended"])
        XCTAssertNil(runner.pending)
        XCTAssertNil(runner.operation)
        XCTAssertNil(runner.task)
        XCTAssertFalse(recorder.retryNeeded)
        XCTAssertNil(recorder.error)
        XCTAssertEqual(transport.retryPendingCalls, 0)
    }

    func testDefiniteRejectionClearsPendingWithoutRetry() async {
        let recorder = Recorder(), transport = FakeTransport()
        let runner = DurableWriteRunner<FakeTransport>(model: recorder.model)
        runner.stage("request-1", on: transport)
        var script = Script()
        script.dispatch = { throw CoreHostRejection(message: "refused") }
        _ = await run(runner, retry: false, write(recorder, script))
        XCTAssertEqual(recorder.events, ["dispatch:request-1", "rejected", "refresh:rejected", "ended"])
        XCTAssertNil(runner.pending)
        XCTAssertFalse(recorder.retryNeeded)
        XCTAssertNil(recorder.error)
    }

    func testUnknownOutcomeKeepsPendingThenRetryAcknowledgesThroughRetryPending() async {
        let recorder = Recorder(), transport = FakeTransport()
        let runner = DurableWriteRunner<FakeTransport>(model: recorder.model)
        runner.stage("request-1", on: transport)
        var script = Script()
        script.dispatch = { throw CocoaError(.fileWriteUnknown) }
        _ = await run(runner, retry: false, write(recorder, script))
        XCTAssertEqual(recorder.events, ["dispatch:request-1", "uncertain", "ended"])
        XCTAssertEqual(runner.pending?.request, "request-1")
        XCTAssertTrue(runner.pending?.transport === transport)
        XCTAssertTrue(recorder.retryNeeded)
        XCTAssertEqual(recorder.error, "failed")

        recorder.events = []
        transport.pendingReplies = ["acknowledged"]
        let started = await run(runner, retry: true, write(recorder, script))
        XCTAssertTrue(started)
        XCTAssertEqual(transport.retryPendingCalls, 1)
        XCTAssertEqual(recorder.events, ["ack:acknowledged", "refresh", "ended"])
        XCTAssertNil(runner.pending)
        XCTAssertFalse(recorder.retryNeeded)
        XCTAssertNil(recorder.error)
    }

    func testRetryRejectionRefreshesAsRejected() async {
        let recorder = Recorder(), transport = FakeTransport()
        let runner = DurableWriteRunner<FakeTransport>(model: recorder.model)
        runner.stage("request-1", on: transport)
        var script = Script()
        script.retryOutcome = { throw CoreHostRejection(message: "refused") }
        _ = await run(runner, retry: true, write(recorder, script))
        XCTAssertEqual(transport.retryPendingCalls, 1)
        XCTAssertEqual(recorder.events, ["outcome:request-1", "rejected", "refresh:rejected", "ended"])
        XCTAssertNil(runner.pending)
        XCTAssertFalse(recorder.retryNeeded)
    }

    func testRetryWithoutPendingReplyProbesRetryOutcome() async {
        let recorder = Recorder(), transport = FakeTransport()
        let runner = DurableWriteRunner<FakeTransport>(model: recorder.model)
        runner.stage("request-1", on: transport)
        _ = await run(runner, retry: true, write(recorder))
        XCTAssertEqual(transport.retryPendingCalls, 1)
        XCTAssertEqual(recorder.events, ["outcome:request-1", "ack:probed", "refresh", "ended"])
        XCTAssertNil(runner.pending)
    }

    func testMalformedAcknowledgmentKeepsPendingForRetry() async {
        let recorder = Recorder(), transport = FakeTransport()
        let runner = DurableWriteRunner<FakeTransport>(model: recorder.model)
        runner.stage("request-1", on: transport)
        var script = Script()
        script.acknowledge = { _ in throw CocoaError(.coderReadCorrupt) }
        _ = await run(runner, retry: false, write(recorder, script))
        XCTAssertEqual(recorder.events, ["dispatch:request-1", "ack:dispatched", "uncertain", "ended"])
        XCTAssertEqual(runner.pending?.request, "request-1")
        XCTAssertTrue(recorder.retryNeeded)
    }

    func testReplyForReplacedRequestIsIgnored() async {
        let recorder = Recorder(), transport = FakeTransport()
        let runner = DurableWriteRunner<FakeTransport>(model: recorder.model)
        runner.stage("request-1", on: transport)
        var script = Script()
        script.dispatch = {
            runner.stage("request-2", on: transport)
            throw CocoaError(.fileWriteUnknown)
        }
        _ = await run(runner, retry: false, write(recorder, script))
        XCTAssertEqual(recorder.events, ["dispatch:request-1", "ended"])
        XCTAssertEqual(runner.pending?.request, "request-2")
        XCTAssertFalse(recorder.retryNeeded)
    }

    func testBusyIsSetAndClearedExactlyOncePerRun() async {
        let recorder = Recorder(), transport = FakeTransport()
        let runner = DurableWriteRunner<FakeTransport>(model: recorder.model)
        XCTAssertFalse(runner.run(retry: false, write(recorder)))
        runner.stage("request-1", on: transport)
        XCTAssertTrue(runner.run(retry: false, write(recorder)))
        XCTAssertTrue(recorder.busy)
        XCTAssertNotNil(runner.operation)
        XCTAssertFalse(runner.run(retry: false, write(recorder)))
        await runner.task?.value
        XCTAssertFalse(recorder.busy)
        XCTAssertEqual(recorder.begins, 1)
        XCTAssertEqual(recorder.finishes, 1)

        recorder.busy = true
        runner.stage("request-2", on: transport)
        XCTAssertFalse(runner.run(retry: false, write(recorder)))
        XCTAssertEqual(recorder.begins, 1)
        recorder.busy = false
        XCTAssertFalse(runner.run(retry: false, write(recorder, admit: false)))
        XCTAssertEqual(recorder.begins, 1)
        XCTAssertEqual(recorder.finishes, 1)
    }
}
