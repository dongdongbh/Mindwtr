import Darwin
import Foundation
import XCTest
@testable import MindwtrWatchPayloadValidation

final class MindwtrWatchRetainedAudioTests: XCTestCase {
    private var root: URL!, documents: URL!, queue: URL!, audio: URL!
    private let id = "00000000-0000-4000-8000-000000000001"
    private var wave: URL { audio.appendingPathComponent(id + ".wav") }
    private var source: URL { queue.appendingPathComponent(id + ".json") }

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("watch-audio-proof-" + UUID().uuidString)
        documents = root.appendingPathComponent("Documents")
        queue = documents.appendingPathComponent("pending-captures")
        audio = documents.appendingPathComponent("watch-audio")
        try FileManager.default.createDirectory(at: queue, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: audio, withIntermediateDirectories: true)
        try Data("{\"synthetic\":true}".utf8).write(to: source)
        try waveBytes().write(to: wave)
    }
    override func tearDownWithError() throws { if let root { try FileManager.default.removeItem(at: root) } }

    private func waveBytes(pcmBytes: Int = 32) throws -> Data {
        try MindwtrCanonicalWave.header(dataByteCount: pcmBytes) + Data(repeating: 0, count: pcmBytes)
    }
    private func marker() throws -> MindwtrWatchAudioCleanup {
        let command = try MindwtrWatchPendingCommand.read(directory: queue, name: id + ".json")
        let retained = try XCTUnwrap(MindwtrWatchRetainedAudio.read(at: wave))
        return MindwtrWatchAudioCleanup(id: id, source: command.proof, receipt: command.proof, wave: retained.proof)
    }

    func testOfficialRecordingAndFourMiBBoundaryFreezeExactBytes() throws {
        for pcmBytes in [120 * 16000 * 2, MindwtrWatchRetainedAudio.maximumBytes - 44] {
            let bytes = try waveBytes(pcmBytes: pcmBytes)
            try bytes.write(to: wave)
            let retained = try XCTUnwrap(MindwtrWatchRetainedAudio.read(at: wave))
            XCTAssertEqual(retained.bytes, bytes)
            try retained.proof.validate(directory: audio, name: id + ".wav", maximumBytes: MindwtrWatchRetainedAudio.maximumBytes)
        }
    }

    func testOversizeTruncationAndCorruptHeaderStayOnDisk() throws {
        var corrupt = try waveBytes(); corrupt[0] = 0
        for bytes in [try waveBytes(pcmBytes: MindwtrWatchRetainedAudio.maximumBytes - 42),
                      Data(try waveBytes().dropLast()), corrupt, Data([1, 2])] {
            try bytes.write(to: wave)
            XCTAssertThrowsError(try MindwtrWatchRetainedAudio.read(at: wave))
            XCTAssertEqual(try Data(contentsOf: wave), bytes)
        }
    }

    func testMovedContainerRebasesOnlyExactLowercaseUUIDLeaf() throws {
        let old = "file:///old-container/Documents/watch-audio/" + id + ".wav"
        XCTAssertEqual(MindwtrWatchAudioPathResolver.rebase(absoluteString: old, id: id, kind: .wave,
                                                          currentDocumentsURL: documents), wave)
        for path in ["file:///old/Documents/watch-audio/../watch-audio/" + id + ".wav",
                     "file:///old/Documents/watch-audio/other.wav", old + "?query=1", "file:///elsewhere/" + id + ".wav"] {
            XCTAssertNil(MindwtrWatchAudioPathResolver.rebase(absoluteString: path, id: id, kind: .wave,
                                                            currentDocumentsURL: documents))
        }
    }

    func testSymlinkHardlinkAndSymlinkParentRefuse() throws {
        let external = root.appendingPathComponent("external.wav")
        try FileManager.default.moveItem(at: wave, to: external)
        try FileManager.default.createSymbolicLink(at: wave, withDestinationURL: external)
        XCTAssertThrowsError(try MindwtrWatchRetainedAudio.read(at: wave))
        try FileManager.default.removeItem(at: wave)
        XCTAssertEqual(link(external.path, wave.path), 0)
        XCTAssertThrowsError(try MindwtrWatchRetainedAudio.read(at: wave))
        try FileManager.default.removeItem(at: wave)
        try FileManager.default.removeItem(at: audio)
        try FileManager.default.createSymbolicLink(at: audio, withDestinationURL: root)
        XCTAssertThrowsError(try MindwtrWatchRetainedAudio.read(at: wave))
        XCTAssertEqual(try Data(contentsOf: external), try waveBytes())
    }

    func testFileMutationAndParentReplacementDuringReadRefuse() throws {
        XCTAssertThrowsError(try MindwtrWatchRetainedAudio.read(at: wave) {
            let handle = try FileHandle(forWritingTo: self.wave)
            try handle.seek(toOffset: 44); try handle.write(contentsOf: Data([1, 2])); try handle.close()
        })
        try waveBytes().write(to: wave)
        XCTAssertThrowsError(try MindwtrWatchRetainedAudio.read(at: wave) {
            try FileManager.default.moveItem(at: self.audio, to: self.root.appendingPathComponent("old-audio"))
            try FileManager.default.createDirectory(at: self.audio, withIntermediateDirectories: false)
            try self.waveBytes().write(to: self.wave)
        })
    }

    func testQueueFailureKeepsWAVAndExactRetirementIsIdempotent() throws {
        let cleanup = try marker()
        XCTAssertThrowsError(try cleanup.retire(pendingDirectory: queue, audioDirectory: audio) {
            throw CocoaError(.fileWriteUnknown)
        })
        XCTAssertTrue(FileManager.default.fileExists(atPath: source.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: wave.path))
        try cleanup.retire(pendingDirectory: queue, audioDirectory: audio)
        XCTAssertFalse(FileManager.default.fileExists(atPath: source.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: wave.path))
        try cleanup.retire(pendingDirectory: queue, audioDirectory: audio)
    }

    func testDurableCleanupRetryAfterQueueRemovalRefusesReplacement() throws {
        let cleanup = try marker()
        let markerURL = root.appendingPathComponent("cleanup.json")
        try JSONEncoder().encode(cleanup).write(to: markerURL, options: .atomic)
        let originalAudio = root.appendingPathComponent("original-audio")
        try cleanup.source.retire(directory: queue, name: id + ".json", maximumBytes: 32 * 1024)
        XCTAssertFalse(FileManager.default.fileExists(atPath: source.path))
        try FileManager.default.moveItem(at: audio, to: originalAudio)
        try FileManager.default.createDirectory(at: audio, withIntermediateDirectories: false)
        try waveBytes().write(to: wave)
        let recovered = try JSONDecoder().decode(MindwtrWatchAudioCleanup.self, from: Data(contentsOf: markerURL))
        XCTAssertThrowsError(try recovered.retire(pendingDirectory: queue, audioDirectory: audio))
        XCTAssertTrue(FileManager.default.fileExists(atPath: wave.path))
        try FileManager.default.removeItem(at: audio)
        try FileManager.default.moveItem(at: originalAudio, to: audio)
        try recovered.retire(pendingDirectory: queue, audioDirectory: audio)
        XCTAssertFalse(FileManager.default.fileExists(atPath: wave.path))
    }

    func testQueueAndWaveSameByteReplacementsAreNeverRetired() throws {
        let cleanup = try marker()
        try FileManager.default.moveItem(at: source, to: root.appendingPathComponent("old-source"))
        try Data("{\"synthetic\":true}".utf8).write(to: source)
        XCTAssertThrowsError(try cleanup.retire(pendingDirectory: queue, audioDirectory: audio))
        XCTAssertTrue(FileManager.default.fileExists(atPath: wave.path))
        try FileManager.default.removeItem(at: source)
        try FileManager.default.moveItem(at: root.appendingPathComponent("old-source"), to: source)
        let freshCleanup = try marker()
        try FileManager.default.moveItem(at: wave, to: root.appendingPathComponent("old-wave"))
        try waveBytes().write(to: wave)
        XCTAssertThrowsError(try freshCleanup.retire(pendingDirectory: queue, audioDirectory: audio))
        XCTAssertTrue(FileManager.default.fileExists(atPath: source.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: wave.path))
    }

    func testCommittedReceiptCanRetireAbsentWAVButNeverInvalidPresentWAV() throws {
        try FileManager.default.removeItem(at: wave)
        XCTAssertNil(try MindwtrWatchRetainedAudio.proofForRetirement(at: wave))
        try FileManager.default.removeItem(at: audio)
        XCTAssertNil(try MindwtrWatchRetainedAudio.proofForRetirement(at: wave))
        let command = try MindwtrWatchPendingCommand.read(directory: queue, name: id + ".json")
        let cleanup = MindwtrWatchAudioCleanup(id: id, source: command.proof, receipt: command.proof, wave: nil)
        try cleanup.retire(pendingDirectory: queue, audioDirectory: audio)
        XCTAssertFalse(FileManager.default.fileExists(atPath: source.path))
        try FileManager.default.createDirectory(at: audio, withIntermediateDirectories: false)
        try Data([0, 1]).write(to: wave)
        XCTAssertThrowsError(try MindwtrWatchRetainedAudio.proofForRetirement(at: wave))
        XCTAssertEqual(try Data(contentsOf: wave), Data([0, 1]))
    }

    func testColdAdmissionRoundtripRetainsOriginalWAVAndRefusesReplacement() throws {
        let original = try marker()
        let admission = MindwtrWatchAudioAdmission(id: id, source: original.source, receipt: original.receipt,
                                                  wave: try XCTUnwrap(original.wave))
        let admissionURL = root.appendingPathComponent("admission.json")
        try JSONEncoder().encode(admission).write(to: admissionURL, options: .atomic)
        let cold = try JSONDecoder().decode(MindwtrWatchAudioAdmission.self, from: Data(contentsOf: admissionURL))
        XCTAssertEqual(cold, admission)
        XCTAssertTrue(FileManager.default.fileExists(atPath: source.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: wave.path))
        try FileManager.default.moveItem(at: wave, to: root.appendingPathComponent("admitted-wave"))
        try waveBytes().write(to: wave)
        XCTAssertThrowsError(try cold.confirmedCleanup(source: original.source, receipt: original.receipt, audioDirectory: audio))
        XCTAssertTrue(FileManager.default.fileExists(atPath: source.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: wave.path))
        XCTAssertEqual(try JSONDecoder().decode(MindwtrWatchAudioAdmission.self, from: Data(contentsOf: admissionURL)), admission)
    }

    func testColdAdmissionConfirmationAllowsMissingOriginalWAVAndIsIdempotent() throws {
        let original = try marker()
        let admission = MindwtrWatchAudioAdmission(id: id, source: original.source, receipt: original.receipt,
                                                  wave: try XCTUnwrap(original.wave))
        let cold = try JSONDecoder().decode(MindwtrWatchAudioAdmission.self, from: JSONEncoder().encode(admission))
        try FileManager.default.removeItem(at: wave)
        let confirmed = try cold.confirmedCleanup(source: original.source, receipt: original.receipt, audioDirectory: audio)
        XCTAssertEqual(confirmed.wave, original.wave)
        XCTAssertTrue(FileManager.default.fileExists(atPath: source.path))
        try confirmed.retire(pendingDirectory: queue, audioDirectory: audio)
        XCTAssertFalse(FileManager.default.fileExists(atPath: source.path))
        try confirmed.retire(pendingDirectory: queue, audioDirectory: audio)
    }
}
