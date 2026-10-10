import Foundation

/// Compile with the actual App source; the UIKit adapter is excluded on macOS.
@main
enum NativeCalendarEditorLifetimeChecks {
    private struct Failure: Error, CustomStringConvertible {
        let description: String
    }
    private static func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
        if !condition() { throw Failure(description: message) }
    }

    static func main() throws {
        try cancelBeforeMount()
        try cancelAfterStart()
        try delegateThenBackground(.saved)
        try delegateThenBackground(.deleted)
        try delegateThenBackground(.cancelled)
        try duplicateAndLateCallbacks()
        try refusedIdentity()
        try refusedTransitionObservation()
        print("Calendar editor production lifetime: 8 checks passed")
    }

    private static func cancelBeforeMount() throws {
        let id = UUID()
        var lifetime = NativeCalendarEventEditorLifetime(id: id)
        lifetime.cancel()
        try require(!lifetime.hasStarted && !lifetime.wasPresented, "pre-mount cancellation manufactured presentation")
        try require(lifetime.phase == .unstarted && lifetime.outcome == .cancelled, "pre-mount cancellation lost terminal outcome")
        try require(!lifetime.start(id), "late mount admitted a cancelled request")
        try require(lifetime.finish(id), "never-started cancellation stranded its slot")
        try require(!lifetime.hasStarted && lifetime.phase == .closed, "never-started cleanup changed the start witness")
        try require(!lifetime.didAppear(id) && !lifetime.start(id), "closed request revived")
    }

    private static func cancelAfterStart() throws {
        let id = UUID()
        var lifetime = NativeCalendarEventEditorLifetime(id: id)
        try require(lifetime.start(id), "valid presentation refused")
        try require(!lifetime.start(id), "duplicate activation started two editors")
        lifetime.cancel()
        try require(lifetime.phase == .started && lifetime.hasStarted, "started cancellation released before dismissal")
        try require(lifetime.requiresDraftCancellation && lifetime.outcome == .cancelled, "unresolved draft was not cancelled")
        try require(!lifetime.didAppear(id) && !lifetime.wasPresented, "cancelled presentation recorded a successful appearance")
        try require(!lifetime.finish(UUID()), "another UUID finalized this editor")
        try require(lifetime.phase == .started, "wrong completion released resources")
        try require(lifetime.finish(id), "matching actual dismissal did not release")
        try require(!lifetime.requiresDraftCancellation, "closed editor requested another draft cancellation")
    }

    private static func delegateThenBackground(_ outcome: NativeCalendarEventEditorOutcome) throws {
        let id = UUID()
        var lifetime = NativeCalendarEventEditorLifetime(id: id)
        try require(lifetime.start(id) && lifetime.didAppear(id), "actual appearance did not record its witness")
        try require(lifetime.completeDelegate(id, outcome: outcome), "first delegate completion refused")
        lifetime.cancel()
        lifetime.cancel()
        try require(lifetime.outcome == outcome && lifetime.wasPresented, "background changed first delegate outcome")
        try require(!lifetime.requiresDraftCancellation, "background called cancelEditing after delegate completion")
        try require(lifetime.phase == .started, "delegate or background released before actual dismissal")
        try require(!lifetime.completeDelegate(id, outcome: .cancelled), "duplicate delegate replaced first outcome")
        try require(lifetime.finish(id), "completed editor could not finalize")
        try require(lifetime.outcome == outcome && lifetime.wasPresented, "final cleanup erased diagnostic witnesses")
    }

    private static func duplicateAndLateCallbacks() throws {
        let oldID = UUID(), newID = UUID()
        var old = NativeCalendarEventEditorLifetime(id: oldID)
        try require(old.start(oldID) && old.didAppear(oldID), "old fixture did not appear")
        old.cancel()
        try require(old.finish(oldID) && !old.finish(oldID), "duplicate old completion was accepted")

        var next = NativeCalendarEventEditorLifetime(id: newID)
        try require(next.start(newID), "next editor could not start after terminal close")
        try require(!next.finish(oldID), "late old completion finalized the new UUID")
        try require(!next.completeDelegate(oldID, outcome: .deleted), "late old delegate changed the new UUID")
        try require(!next.didAppear(oldID) && next.outcome == nil, "late old appearance polluted current editor")
        try require(next.phase == .started && next.didAppear(newID), "late callback stranded current editor")
        try require(next.completeDelegate(newID, outcome: .saved), "current delegate did not complete")
        try require(next.finish(newID) && !next.finish(newID), "current completion was not exactly once")
        try require(next.wasPresented && next.outcome == .saved, "current terminal witnesses changed")
    }

    private static func refusedIdentity() throws {
        let id = UUID()
        var lifetime = NativeCalendarEventEditorLifetime(id: id)
        try require(!lifetime.start(UUID()) && lifetime.canStart, "wrong owner either started or consumed a valid claim")
        lifetime.cancel()
        try require(!lifetime.completeDelegate(id, outcome: .saved), "unstarted request received an editor result")
        try require(lifetime.finish(id), "refused request could not close")
        try require(!lifetime.wasPresented && lifetime.outcome == .cancelled, "refusal looked like an opened editor")
    }

    private static func refusedTransitionObservation() throws {
        let id = UUID()
        var lifetime = NativeCalendarEventEditorLifetime(id: id)
        try require(lifetime.observeTransitionCompletion(registered: true) && lifetime.canStart,
                    "real transition observation prematurely consumed presentation")
        try require(!lifetime.observeTransitionCompletion(registered: false), "missing transition callback was admitted")
        try require(lifetime.cancelled && !lifetime.hasStarted && !lifetime.start(id),
                    "missing callback stranded or revived an unstarted editor")
        try require(lifetime.finish(id), "registration refusal could not release its slot")

        var started = NativeCalendarEventEditorLifetime(id: UUID())
        try require(started.start(started.id), "started transition fixture refused")
        try require(!started.observeTransitionCompletion(registered: false)
                    && started.phase == .started && !started.cancelled,
                    "registration failure retired an already started owner")
        try require(started.finish(started.id), "started owner could not complete actual dismissal")
    }
}
