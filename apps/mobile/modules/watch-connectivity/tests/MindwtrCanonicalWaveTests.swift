#if canImport(AudioToolbox)
import AudioToolbox
#endif
import Foundation
import XCTest
@testable import MindwtrWatchPayloadValidation

final class MindwtrCanonicalWaveTests: XCTestCase {
    #if canImport(AudioToolbox)
    func testConversionClientFormatAlwaysTargetsWhisperPCM() {
        let format = MindwtrCanonicalWave.clientFormat()

        XCTAssertEqual(format.mSampleRate, 16_000)
        XCTAssertEqual(format.mFormatID, kAudioFormatLinearPCM)
        XCTAssertEqual(format.mChannelsPerFrame, 1)
        XCTAssertEqual(format.mBitsPerChannel, 16)
        XCTAssertEqual(format.mBytesPerFrame, 2)
        XCTAssertEqual(format.mBytesPerPacket, 2)
        XCTAssertEqual(format.mFramesPerPacket, 1)
        XCTAssertNotEqual(format.mFormatFlags & kAudioFormatFlagIsSignedInteger, 0)
        XCTAssertNotEqual(format.mFormatFlags & kAudioFormatFlagIsPacked, 0)
        XCTAssertEqual(format.mFormatFlags & kAudioFormatFlagIsBigEndian, 0)
    }
    #endif

    func testValidatesCanonicalWaveBytesFromPrivateTemporaryFile() throws {
        let directory = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }

        let url = directory.appendingPathComponent(".capture.wav.tmp")
        var bytes = try MindwtrCanonicalWave.header(dataByteCount: 2)
        bytes.append(contentsOf: [0, 0])
        try bytes.write(to: url)

        XCTAssertTrue(MindwtrCanonicalWave.validateFile(at: url, maximumFileSize: 1_000_000))
    }

    func testFileValidationRejectsMalformedPrivateTemporaryFile() throws {
        let directory = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }

        let url = directory.appendingPathComponent(".malformed.wav.tmp")
        try Data(repeating: 0x7f, count: MindwtrCanonicalWave.headerSize + 2).write(to: url)

        XCTAssertFalse(MindwtrCanonicalWave.validateFile(at: url, maximumFileSize: 1_000_000))
    }

    func testFileValidationRejectsEmptyPrivateTemporaryFile() throws {
        let directory = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }

        let url = directory.appendingPathComponent(".empty.wav.tmp")
        try Data().write(to: url)

        XCTAssertFalse(MindwtrCanonicalWave.validateFile(at: url, maximumFileSize: 1_000_000))
    }

    func testFileValidationRejectsOversizedPrivateTemporaryFile() throws {
        let directory = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }

        let url = directory.appendingPathComponent(".oversized.wav.tmp")
        var bytes = try MindwtrCanonicalWave.header(dataByteCount: 22)
        bytes.append(Data(repeating: 0, count: 22))
        try bytes.write(to: url)

        XCTAssertFalse(MindwtrCanonicalWave.validateFile(at: url, maximumFileSize: 64))
    }

    func testFileValidationRejectsNonregularPrivateTemporaryNode() throws {
        let directory = try makeTemporaryDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }

        let url = directory.appendingPathComponent(".directory.wav.tmp", isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false)

        XCTAssertFalse(MindwtrCanonicalWave.validateFile(at: url, maximumFileSize: 1_000_000))
    }

    func testBuildsExactWhisperCompatibleHeader() throws {
        let oneSecondDataBytes = Int(MindwtrCanonicalWave.byteRate)
        let header = try MindwtrCanonicalWave.header(dataByteCount: oneSecondDataBytes)

        XCTAssertEqual(header.count, 44)
        XCTAssertTrue(MindwtrCanonicalWave.validateHeader(
            header,
            fileSize: header.count + oneSecondDataBytes,
            maximumFileSize: 1_000_000
        ))
    }

    func testRejectsNonCanonicalSampleRateChannelsAndChunkLayout() throws {
        let dataByteCount = 32_000
        let fileSize = 44 + dataByteCount
        let canonical = try MindwtrCanonicalWave.header(dataByteCount: dataByteCount)

        var wrongRate = canonical
        wrongRate[24] = 0x44
        wrongRate[25] = 0xAC
        XCTAssertFalse(MindwtrCanonicalWave.validateHeader(
            wrongRate,
            fileSize: fileSize,
            maximumFileSize: 1_000_000
        ))

        var stereo = canonical
        stereo[22] = 2
        XCTAssertFalse(MindwtrCanonicalWave.validateHeader(
            stereo,
            fileSize: fileSize,
            maximumFileSize: 1_000_000
        ))

        var nonCanonicalChunk = canonical
        nonCanonicalChunk.replaceSubrange(36..<40, with: Data("LIST".utf8))
        XCTAssertFalse(MindwtrCanonicalWave.validateHeader(
            nonCanonicalChunk,
            fileSize: fileSize,
            maximumFileSize: 1_000_000
        ))
    }

    func testRejectsHeaderWhoseDataSizeDoesNotMatchFile() throws {
        let header = try MindwtrCanonicalWave.header(dataByteCount: 32_000)
        XCTAssertFalse(MindwtrCanonicalWave.validateHeader(
            header,
            fileSize: header.count + 31_998,
            maximumFileSize: 1_000_000
        ))
    }

    private func makeTemporaryDirectory() throws -> URL {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        return directory
    }
}
