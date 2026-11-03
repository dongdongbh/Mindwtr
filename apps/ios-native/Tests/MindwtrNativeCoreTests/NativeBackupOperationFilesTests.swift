import Foundation
import XCTest
import Darwin
import CryptoKit
@testable import MindwtrNativeCore

final class NativeBackupOperationFilesTests: XCTestCase {
    private func withRoot(_ body: (URL) throws -> Void) throws {
        let root = URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
            .appendingPathComponent(".mindwtr-operation-test-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: false)
        defer { try? FileManager.default.removeItem(at: root) }
        try body(root)
    }

    private func id() -> String { UUID().uuidString.lowercased() }
    private var date: Date { Date(timeIntervalSince1970: 1_728_000_000.123) }
    private func operationURL(_ root: URL, _ reference: NativeBackupOperationReference) -> URL {
        root.appendingPathComponent("backup-operations").appendingPathComponent(reference.id)
    }
    private func snapshotURL(_ root: URL, _ reference: NativeBackupSnapshotReference) -> URL {
        root.appendingPathComponent("backup-snapshots").appendingPathComponent(reference.id)
    }
    private func hash(_ bytes: Data) -> String { SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined() }
    private func prepare(_ owner: NativeBackupOperationFiles, at date: Date? = nil,
                         plan: String = "{\"data\":\"merged\"}", content: String = "{\"data\":\"before\"}") throws -> NativeBackupOperationReference {
        let name = try owner.nextSnapshotName(at: date ?? self.date)
        return try owner.prepare(id: id(), planJSON: plan, newSnapshot: (name, content), existingSnapshot: nil)
    }
    private func completeAndDiscard(_ owner: NativeBackupOperationFiles, _ reference: NativeBackupOperationReference) throws -> NativeBackupSnapshotReference {
        let snapshot = try owner.read(reference).snapshot
        try owner.complete(reference)
        try owner.discard(reference, provenRejected: false)
        return snapshot
    }

    func testImmutableUnicodeBytesAndPendingSnapshotSurviveRestart() throws {
        try withRoot { root in
            let owner = NativeBackupOperationFiles(libraryRoot: root)
            let plan = "{\"notes\":\"日本語 🦉 مرحبا\",\"expectedCurrent\":{}}"
            let before = "{\"notes\":\"恢复 résumé\"}"
            let reference = try prepare(owner, plan: plan, content: before)
            let snapshot = try owner.read(reference).snapshot
            XCTAssertEqual(snapshot.byteCount, before.utf8.count)
            XCTAssertEqual(try owner.listSnapshots(), [])
            let planBytes = try Data(contentsOf: operationURL(root, reference).appendingPathComponent("plan.json"))
            let manifestBytes = try Data(contentsOf: operationURL(root, reference).appendingPathComponent("manifest.json"))
            XCTAssertEqual(reference.byteCount, manifestBytes.count)
            XCTAssertEqual(reference.sha256, hash(manifestBytes))
            let recreated = NativeBackupOperationFiles(libraryRoot: root)
            XCTAssertEqual(try recreated.read(reference).planJSON, plan)
            XCTAssertEqual(try recreated.readSnapshot(snapshot), before)
            try recreated.complete(reference)
            XCTAssertEqual(try recreated.listSnapshots(), [snapshot])
            try recreated.complete(reference)
            XCTAssertEqual(try Data(contentsOf: operationURL(root, reference).appendingPathComponent("plan.json")), planBytes)
            XCTAssertEqual(try Data(contentsOf: operationURL(root, reference).appendingPathComponent("manifest.json")), manifestBytes)
            try recreated.discard(reference, provenRejected: false)
            XCTAssertThrowsError(try recreated.read(reference))
            XCTAssertEqual(try recreated.readSnapshot(snapshot), before)
        }
    }

    func testSameInstantUniqueNamesAndExclusiveStaleNameRefusal() throws {
        try withRoot { root in
            let owner = NativeBackupOperationFiles(libraryRoot: root)
            let name = try owner.nextSnapshotName(at: date)
            XCTAssertTrue(name.hasPrefix("data."))
            XCTAssertTrue(name.hasSuffix(".snapshot.json"))

            XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.path), [])
            let first = try owner.prepare(id: id(), planJSON: "{}", newSnapshot: (name, "first"), existingSnapshot: nil)
            XCTAssertThrowsError(try owner.prepare(id: id(), planJSON: "{}", newSnapshot: (name, "replacement"), existingSnapshot: nil))
            let next = try owner.nextSnapshotName(at: date)
            XCTAssertEqual(next, String(name.dropLast(".snapshot.json".count)) + ".1.snapshot.json")
            let second = try owner.prepare(id: id(), planJSON: "{}", newSnapshot: (next, "second"), existingSnapshot: nil)
            XCTAssertEqual(try owner.readSnapshot(owner.read(first).snapshot), "first")
            XCTAssertEqual(try owner.readSnapshot(owner.read(second).snapshot), "second")
            try owner.complete(first)
            try owner.complete(second)
            XCTAssertEqual(try owner.listSnapshots().map { $0.name }, [next, name])
        }
    }

    func testExistingUndoSourceCreatesNoSnapshotAndRemainsStable() throws {
        try withRoot { root in
            let owner = NativeBackupOperationFiles(libraryRoot: root)
            let merge = try prepare(owner)
            let source = try completeAndDiscard(owner, merge)
            let bytes = try Data(contentsOf: snapshotURL(root, source).appendingPathComponent(source.name))
            let metadata = try Data(contentsOf: snapshotURL(root, source).appendingPathComponent("metadata.json"))
            let restore = try owner.prepare(id: id(), planJSON: "{\"mode\":\"restore\"}", newSnapshot: nil, existingSnapshot: source)
            XCTAssertEqual(try owner.read(restore).snapshot, source)
            XCTAssertEqual(try owner.listSnapshots(), [source])
            try owner.complete(restore)
            try owner.discard(restore, provenRejected: true)
            XCTAssertEqual(try owner.listSnapshots(), [source])
            XCTAssertEqual(try Data(contentsOf: snapshotURL(root, source).appendingPathComponent(source.name)), bytes)
            XCTAssertEqual(try Data(contentsOf: snapshotURL(root, source).appendingPathComponent("metadata.json")), metadata)
            let pending = try prepare(owner)
            XCTAssertThrowsError(try owner.prepare(id: id(), planJSON: "{}", newSnapshot: nil, existingSnapshot: owner.read(pending).snapshot))
        }
    }

    func testPreparationRequiresExactlyOneSnapshotAndCanonicalIdentity() throws {
        try withRoot { root in
            let owner = NativeBackupOperationFiles(libraryRoot: root)
            XCTAssertThrowsError(try owner.prepare(id: id(), planJSON: "{}", newSnapshot: nil, existingSnapshot: nil))
            let name = try owner.nextSnapshotName(at: date)
            XCTAssertThrowsError(try owner.prepare(id: "../escape", planJSON: "{}", newSnapshot: (name, "{}"), existingSnapshot: nil))
            XCTAssertThrowsError(try owner.prepare(id: id().uppercased(), planJSON: "{}", newSnapshot: (name, "{}"), existingSnapshot: nil))
            XCTAssertThrowsError(try owner.prepare(id: id(), planJSON: "{}", newSnapshot: ("../escape.snapshot.json", "{}"), existingSnapshot: nil))
            let reference = try prepare(owner)
            let snapshot = try owner.read(reference).snapshot
            XCTAssertThrowsError(try owner.prepare(id: id(), planJSON: "{}", newSnapshot: (name, "{}"), existingSnapshot: snapshot))
            XCTAssertThrowsError(try owner.prepare(id: reference.id, planJSON: "changed", newSnapshot: nil, existingSnapshot: snapshot))
            XCTAssertEqual(try owner.read(reference).planJSON, "{\"data\":\"merged\"}")
        }
    }

    func testTamperedMissingAndForgedPlanManifestAndSnapshotRefuse() throws {
        try withRoot { root in
            let owner = NativeBackupOperationFiles(libraryRoot: root)
            let reference = try prepare(owner)
            let snapshot = try owner.read(reference).snapshot
            let op = operationURL(root, reference)
            let plan = op.appendingPathComponent("plan.json")
            let manifest = op.appendingPathComponent("manifest.json")
            let initialPlan = try Data(contentsOf: plan)
            let initialManifest = try Data(contentsOf: manifest)
            for forged in [
                NativeBackupOperationReference(id: "../escape", sha256: reference.sha256, byteCount: reference.byteCount),
                NativeBackupOperationReference(id: reference.id.uppercased(), sha256: reference.sha256, byteCount: reference.byteCount),
                NativeBackupOperationReference(id: reference.id, sha256: String(repeating: "0", count: 64), byteCount: reference.byteCount),
                NativeBackupOperationReference(id: reference.id, sha256: reference.sha256, byteCount: reference.byteCount + 1)
            ] { XCTAssertThrowsError(try owner.read(forged)) }
            try Data("tampered".utf8).write(to: plan)
            XCTAssertThrowsError(try owner.read(reference))
            XCTAssertThrowsError(try owner.complete(reference))
            XCTAssertThrowsError(try owner.discard(reference, provenRejected: true))
            try initialPlan.write(to: plan)
            try FileManager.default.removeItem(at: plan)
            XCTAssertThrowsError(try owner.read(reference))
            try initialPlan.write(to: plan)
            try Data("{}".utf8).write(to: manifest)
            XCTAssertThrowsError(try owner.read(reference))

            var object = try XCTUnwrap(JSONSerialization.jsonObject(with: initialManifest) as? [String: Any])
            object["path"] = "../../escape"
            let forgedManifest = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes])
            try forgedManifest.write(to: manifest)
            let forgedRef = NativeBackupOperationReference(id: reference.id, sha256: hash(forgedManifest), byteCount: forgedManifest.count)
            XCTAssertThrowsError(try owner.read(forgedRef))
            try initialManifest.write(to: manifest)
            let snapshotFile = snapshotURL(root, snapshot).appendingPathComponent(snapshot.name)
            let initialSnapshot = try Data(contentsOf: snapshotFile)
            try Data("tampered".utf8).write(to: snapshotFile)
            XCTAssertThrowsError(try owner.readSnapshot(snapshot))
            XCTAssertThrowsError(try owner.read(reference))
            try initialSnapshot.write(to: snapshotFile)
            let forgedSnapshot = NativeBackupSnapshotReference(id: snapshot.id, name: "../escape", sha256: snapshot.sha256, byteCount: snapshot.byteCount)
            XCTAssertThrowsError(try owner.readSnapshot(forgedSnapshot))
            let reservation = root.appendingPathComponent("backup-snapshots").appendingPathComponent(".name-" + snapshot.name)
            try Data(id().utf8).write(to: reservation)
            XCTAssertThrowsError(try owner.readSnapshot(snapshot))
            XCTAssertThrowsError(try owner.complete(reference))
        }
    }

    func testSymlinkAndHardlinkFilesAndDirectoriesAreRefusedAndPreserved() throws {
        try withRoot { root in
            let owner = NativeBackupOperationFiles(libraryRoot: root)
            let reference = try prepare(owner)
            let snapshot = try owner.read(reference).snapshot
            let target = root.appendingPathComponent("outside.json")
            try Data("private-target".utf8).write(to: target)
            let plan = operationURL(root, reference).appendingPathComponent("plan.json")
            try FileManager.default.removeItem(at: plan)
            try FileManager.default.createSymbolicLink(at: plan, withDestinationURL: target)
            XCTAssertThrowsError(try owner.read(reference))
            XCTAssertThrowsError(try owner.discardUnreferencedOperations(retaining: []))
            XCTAssertEqual(try FileManager.default.destinationOfSymbolicLink(atPath: plan.path), target.path)
            XCTAssertEqual(try String(contentsOf: target), "private-target")

            XCTAssertEqual(try owner.readSnapshot(snapshot), "{\"data\":\"before\"}")
            try FileManager.default.removeItem(at: plan)
            XCTAssertEqual(Darwin.link(target.path, plan.path), 0)
            XCTAssertThrowsError(try owner.read(reference))
            XCTAssertThrowsError(try owner.discardUnreferencedOperations(retaining: []))
            XCTAssertTrue(FileManager.default.fileExists(atPath: plan.path))
            XCTAssertEqual(try String(contentsOf: target), "private-target")
            let linkedRoot = root.appendingPathComponent("library-link")
            try FileManager.default.createSymbolicLink(at: linkedRoot, withDestinationURL: root)
            XCTAssertThrowsError(try NativeBackupOperationFiles(libraryRoot: linkedRoot).listSnapshots())
        }
    }

    func testPreparationFaultCleansOnlyNewPendingFilesAndReleasesName() throws {
        try withRoot { root in
            let owner = NativeBackupOperationFiles(libraryRoot: root)
            let old = try completeAndDiscard(owner, prepare(owner, at: date.addingTimeInterval(-1)))
            let name = try owner.nextSnapshotName(at: date)
            owner.beforeSnapshotWrite = { throw CocoaError(.fileWriteOutOfSpace) }
            XCTAssertThrowsError(try owner.prepare(id: id(), planJSON: "{}", newSnapshot: (name, "new"), existingSnapshot: nil)) { error in
                XCTAssertEqual(error as? NativeBackupOperationFilesError, .unavailable)
                XCTAssertFalse(error.localizedDescription.contains(root.path))
            }
            owner.beforeSnapshotWrite = nil
            XCTAssertEqual(try owner.nextSnapshotName(at: date), name)
            XCTAssertEqual(try owner.listSnapshots(), [old])
            owner.beforePlanWrite = { throw CocoaError(.fileWriteOutOfSpace) }
            XCTAssertThrowsError(try owner.prepare(id: id(), planJSON: "{}", newSnapshot: (name, "new"), existingSnapshot: nil))
            owner.beforePlanWrite = nil
            XCTAssertEqual(try owner.nextSnapshotName(at: date), name)
            XCTAssertEqual(try owner.listSnapshots(), [old])
            XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent("backup-operations").path), [])
            XCTAssertEqual(try owner.readSnapshot(old), "{\"data\":\"before\"}")
        }
    }

    func testMetadataPromotionFaultsKeepOldRosterAndRetryIsIdempotent() throws {
        try withRoot { root in
            let owner = NativeBackupOperationFiles(libraryRoot: root)
            var old: [NativeBackupSnapshotReference] = []
            for i in 0..<5 { old.append(try completeAndDiscard(owner, prepare(owner, at: date.addingTimeInterval(Double(i))))) }
            let reference = try prepare(owner, at: date.addingTimeInterval(10))
            let pending = try owner.read(reference).snapshot
            let plan = try Data(contentsOf: operationURL(root, reference).appendingPathComponent("plan.json"))
            owner.beforeMetadataPromote = { throw CocoaError(.fileWriteOutOfSpace) }
            XCTAssertThrowsError(try owner.complete(reference))
            XCTAssertEqual(Set(try owner.listSnapshots().map { $0.id }), Set(old.map { $0.id }))
            owner.beforeMetadataPromote = nil
            owner.afterMetadataPromote = { throw CocoaError(.fileWriteUnknown) }
            XCTAssertThrowsError(try owner.complete(reference))
            let afterRename = Set(try owner.listSnapshots().map { $0.id })
            XCTAssertTrue(Set(old.map { $0.id }).isSubset(of: afterRename))
            XCTAssertTrue(afterRename.contains(pending.id))


            let recreated = NativeBackupOperationFiles(libraryRoot: root)
            try recreated.complete(reference)
            try recreated.complete(reference)
            XCTAssertEqual(try recreated.listSnapshots().count, 5)
            XCTAssertEqual(try Data(contentsOf: operationURL(root, reference).appendingPathComponent("plan.json")), plan)
            XCTAssertEqual(try recreated.read(reference).snapshot, pending)
            for snapshot in old.dropFirst() { XCTAssertEqual(try recreated.readSnapshot(snapshot), "{\"data\":\"before\"}") }
        }
    }

    func testRetentionKeepsNewestFivePlusActiveExistingReference() throws {
        try withRoot { root in
            let owner = NativeBackupOperationFiles(libraryRoot: root)
            let oldest = try completeAndDiscard(owner, prepare(owner))
            let restore = try owner.prepare(id: id(), planJSON: "restore", newSnapshot: nil, existingSnapshot: oldest)
            var latest: [NativeBackupSnapshotReference] = []
            for i in 1...7 { latest.append(try completeAndDiscard(owner, prepare(owner, at: date.addingTimeInterval(Double(i))))) }
            XCTAssertEqual(Set(try owner.listSnapshots().map { $0.id }), Set(latest.suffix(5).map { $0.id }).union([oldest.id]))
            let recreated = NativeBackupOperationFiles(libraryRoot: root)
            try recreated.discardUnreferencedOperations(retaining: [restore.id])
            XCTAssertEqual(try recreated.readSnapshot(oldest), "{\"data\":\"before\"}")
            try recreated.discard(restore, provenRejected: true)

            XCTAssertEqual(try recreated.readSnapshot(oldest), "{\"data\":\"before\"}")
            try recreated.discardUnreferencedOperations(retaining: [])
            XCTAssertEqual(try recreated.listSnapshots().count, 5)
            XCTAssertThrowsError(try recreated.readSnapshot(oldest))
        }
    }

    func testRejectedOperationDiscardsOnlyOwnPendingSnapshot() throws {
        try withRoot { root in
            let owner = NativeBackupOperationFiles(libraryRoot: root)
            let live = try completeAndDiscard(owner, prepare(owner))
            let rejected = try prepare(owner)
            let pending = try owner.read(rejected).snapshot
            XCTAssertThrowsError(try owner.discard(rejected, provenRejected: false))
            XCTAssertEqual(try owner.readSnapshot(pending), "{\"data\":\"before\"}")
            try owner.discard(rejected, provenRejected: true)
            XCTAssertThrowsError(try owner.readSnapshot(pending))
            XCTAssertEqual(try owner.listSnapshots(), [live])
            let complete = try prepare(owner)
            let completedSnapshot = try owner.read(complete).snapshot
            try owner.complete(complete)
            try owner.discard(complete, provenRejected: true)
            XCTAssertEqual(try owner.readSnapshot(completedSnapshot), "{\"data\":\"before\"}")
        }
    }

    func testCleanupRetainsJournalPendingAndUnknownContentAndRemovesKnownOrphans() throws {
        try withRoot { root in
            let owner = NativeBackupOperationFiles(libraryRoot: root)
            let retained = try prepare(owner)
            let retainedSnapshot = try owner.read(retained).snapshot
            let orphan = try prepare(owner)
            let orphanSnapshot = try owner.read(orphan).snapshot
            let operations = root.appendingPathComponent("backup-operations")
            let snapshots = root.appendingPathComponent("backup-snapshots")
            let partialID = id()
            let partial = operations.appendingPathComponent(partialID)
            try FileManager.default.createDirectory(at: partial, withIntermediateDirectories: false)
            try Data("partial".utf8).write(to: partial.appendingPathComponent("plan.json"))
            let unrelated = snapshots.appendingPathComponent("unrelated.json")
            try Data("untouched".utf8).write(to: unrelated)
            let linked = snapshots.appendingPathComponent(id())
            try FileManager.default.createSymbolicLink(at: linked, withDestinationURL: root)
            XCTAssertThrowsError(try owner.discardUnreferencedOperations(retaining: ["invalid"]))
            XCTAssertEqual(try owner.read(orphan).snapshot, orphanSnapshot)
            let recreated = NativeBackupOperationFiles(libraryRoot: root)
            try recreated.discardUnreferencedOperations(retaining: [retained.id])
            XCTAssertEqual(try recreated.read(retained).snapshot, retainedSnapshot)
            XCTAssertThrowsError(try recreated.read(orphan))
            XCTAssertThrowsError(try recreated.readSnapshot(orphanSnapshot))
            XCTAssertFalse(FileManager.default.fileExists(atPath: partial.path))
            XCTAssertEqual(try String(contentsOf: unrelated), "untouched")
            XCTAssertEqual(try FileManager.default.destinationOfSymbolicLink(atPath: linked.path), root.path)
            XCTAssertEqual(try recreated.listSnapshots(), [])
        }
    }

    func testCleanupReleasesKnownPartialCreationButPreservesReservationOnlyAndUnknownOnes() throws {
        try withRoot { root in
            let owner = NativeBackupOperationFiles(libraryRoot: root)
            let kept = try prepare(owner)
            let snapshots = root.appendingPathComponent("backup-snapshots")
            let abandonedName = try owner.nextSnapshotName(at: date.addingTimeInterval(1))
            let abandoned = snapshots.appendingPathComponent(".name-" + abandonedName)
            let reservationOnlyID = id()
            try Data(reservationOnlyID.utf8).write(to: abandoned)
            let partialName = try owner.nextSnapshotName(at: date.addingTimeInterval(2))
            let partialID = id()
            let partialReservation = snapshots.appendingPathComponent(".name-" + partialName)
            try Data(partialID.utf8).write(to: partialReservation)
            let partial = snapshots.appendingPathComponent(partialID)
            try FileManager.default.createDirectory(at: partial, withIntermediateDirectories: false)
            try Data("partial".utf8).write(to: partial.appendingPathComponent(partialName))
            let malformedName = try owner.nextSnapshotName(at: date.addingTimeInterval(3))
            let malformed = snapshots.appendingPathComponent(".name-" + malformedName)
            try Data("not-a-uuid".utf8).write(to: malformed)
            let unknownName = try owner.nextSnapshotName(at: date.addingTimeInterval(4))
            let unknownID = id()
            let unknownReservation = snapshots.appendingPathComponent(".name-" + unknownName)
            try Data(unknownID.utf8).write(to: unknownReservation)
            let unknown = snapshots.appendingPathComponent(unknownID)
            try FileManager.default.createDirectory(at: unknown, withIntermediateDirectories: false)
            try Data("untouched".utf8).write(to: unknown.appendingPathComponent("not-owned"))
            try owner.discardUnreferencedOperations(retaining: [kept.id])
            XCTAssertEqual(try String(contentsOf: abandoned), reservationOnlyID)
            XCTAssertFalse(FileManager.default.fileExists(atPath: partial.path))
            XCTAssertFalse(FileManager.default.fileExists(atPath: partialReservation.path))
            XCTAssertEqual(try String(contentsOf: malformed), "not-a-uuid")
            XCTAssertEqual(try String(contentsOf: unknown.appendingPathComponent("not-owned")), "untouched")
            XCTAssertTrue(FileManager.default.fileExists(atPath: unknownReservation.path))
        }
    }

    func testMissingRetainedOperationStopsCleanupBeforeRemovingOrphans() throws {
        try withRoot { root in
            let owner = NativeBackupOperationFiles(libraryRoot: root)
            let orphan = try prepare(owner)
            XCTAssertThrowsError(try owner.discardUnreferencedOperations(retaining: [id()]))
            XCTAssertEqual(try owner.read(orphan).planJSON, "{\"data\":\"merged\"}")
        }
    }

    func testInvalidCompletedMetadataAndSnapshotDirectoryLinkStayUnlistedAndUntouched() throws {
        try withRoot { root in
            let owner = NativeBackupOperationFiles(libraryRoot: root)
            let source = try completeAndDiscard(owner, prepare(owner))
            let directory = snapshotURL(root, source)
            let metadata = directory.appendingPathComponent("metadata.json")
            let original = try Data(contentsOf: metadata)
            var object = try XCTUnwrap(JSONSerialization.jsonObject(with: original) as? [String: Any])
            object["unowned"] = true
            let invalid = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes])
            try invalid.write(to: metadata)
            XCTAssertEqual(try owner.listSnapshots(), [])
            XCTAssertThrowsError(try owner.readSnapshot(source))
            XCTAssertThrowsError(try owner.prepare(id: id(), planJSON: "restore", newSnapshot: nil, existingSnapshot: source))
            try owner.discardUnreferencedOperations(retaining: [])
            XCTAssertEqual(try Data(contentsOf: metadata), invalid)
            try original.write(to: metadata)
            try FileManager.default.removeItem(at: metadata)
            XCTAssertThrowsError(try owner.readSnapshot(source))
            try original.write(to: metadata)
            let held = root.appendingPathComponent("held-snapshot")
            try FileManager.default.moveItem(at: directory, to: held)
            try FileManager.default.createSymbolicLink(at: directory, withDestinationURL: held)
            XCTAssertThrowsError(try owner.readSnapshot(source))
            XCTAssertEqual(try owner.listSnapshots(), [])
            try owner.discardUnreferencedOperations(retaining: [])
            XCTAssertEqual(try FileManager.default.destinationOfSymbolicLink(atPath: directory.path), held.path)
            XCTAssertEqual(try Data(contentsOf: held.appendingPathComponent(source.name)), Data("{\"data\":\"before\"}".utf8))
        }
    }

    func testPreparationFailureNeverRemovesTamperedReservation() throws {
        try withRoot { root in
            let owner = NativeBackupOperationFiles(libraryRoot: root)
            let name = try owner.nextSnapshotName(at: date)
            let reservation = root.appendingPathComponent("backup-snapshots").appendingPathComponent(".name-" + name)
            let foreign = id()
            owner.beforeSnapshotWrite = {
                try Data(foreign.utf8).write(to: reservation)
                throw CocoaError(.fileWriteOutOfSpace)
            }
            XCTAssertThrowsError(try owner.prepare(id: id(), planJSON: "{}", newSnapshot: (name, "{}"), existingSnapshot: nil))
            XCTAssertEqual(try String(contentsOf: reservation), foreign)
            XCTAssertEqual(try owner.listSnapshots(), [])
            try owner.discardUnreferencedOperations(retaining: [])
            XCTAssertEqual(try String(contentsOf: reservation), foreign)
        }
    }

    func testCollisionAttemptBoundAndMalformedReservationNeverOverwrite() throws {
        try withRoot { root in
            let owner = NativeBackupOperationFiles(libraryRoot: root)
            let reference = try prepare(owner)
            let snapshots = root.appendingPathComponent("backup-snapshots")
            let name = try owner.read(reference).snapshot.name
            let base = String(name.dropLast(".snapshot.json".count))
            for collision in 1..<100 {
                try Data("unknown".utf8).write(to: snapshots.appendingPathComponent(".name-" + base + ".\(collision).snapshot.json"))
            }
            XCTAssertThrowsError(try owner.nextSnapshotName(at: date))
            XCTAssertThrowsError(try owner.prepare(id: id(), planJSON: "{}", newSnapshot: (base + ".1.snapshot.json", "{}"), existingSnapshot: nil))
            XCTAssertEqual(try String(contentsOf: snapshots.appendingPathComponent(".name-" + base + ".1.snapshot.json")), "unknown")
        }
    }


    func testExactProductByteBoundsAndUnicodeOverflow() throws {
        XCTAssertEqual(NativeBackupOperationFiles.maximumPlanBytes, 536870912)
        XCTAssertEqual(NativeBackupOperationFiles.maximumSnapshotBytes, 134217728)
        try withRoot { root in
            let owner = NativeBackupOperationFiles(libraryRoot: root)
            let plan = String(repeating: "é", count: NativeBackupOperationFiles.maximumPlanBytes / 2)
            let reference = try prepare(owner, plan: plan)
            XCTAssertEqual(try owner.read(reference).planJSON.utf8.count, NativeBackupOperationFiles.maximumPlanBytes)
            try owner.discard(reference, provenRejected: true)
            XCTAssertThrowsError(try prepare(owner, plan: plan + "é")) { error in
                XCTAssertEqual(error as? NativeBackupOperationFilesError, .planTooLarge)
            }
        }
        try withRoot { root in
            let owner = NativeBackupOperationFiles(libraryRoot: root)
            let content = String(repeating: "é", count: NativeBackupOperationFiles.maximumSnapshotBytes / 2)
            let reference = try prepare(owner, content: content)
            let snapshot = try owner.read(reference).snapshot
            XCTAssertEqual(snapshot.byteCount, NativeBackupOperationFiles.maximumSnapshotBytes)
            XCTAssertEqual(try owner.readSnapshot(snapshot).utf8.count, NativeBackupOperationFiles.maximumSnapshotBytes)
            try owner.discard(reference, provenRejected: true)
            XCTAssertThrowsError(try prepare(owner, content: content + "é")) { error in
                XCTAssertEqual(error as? NativeBackupOperationFilesError, .snapshotTooLarge)
            }
            XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent("backup-operations").path), [])
            XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent("backup-snapshots").path), [])
        }
    }
}
