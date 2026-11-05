import XCTest
@testable import MindwtrWatchPayloadValidation

final class MindwtrCanonicalWaveSamplesTests: XCTestCase {
    private func wave() throws -> Data {
        var bytes = try MindwtrCanonicalWave.header(dataByteCount: 8)
        bytes.append(contentsOf: [0, 128, 0, 0, 255, 127, 0, 64])
        return bytes
    }
    func testCanonicalSamplesAndStrictBounds() throws {
        let bytes = try wave()
        let samples = try MindwtrCanonicalWave.samplesFromCanonicalWave(bytes, maximumSamples: 4)
        XCTAssertEqual(samples, [-1, 0, Float(32767) / 32768, 0.5])
        XCTAssertThrowsError(try MindwtrCanonicalWave.samplesFromCanonicalWave(bytes, maximumSamples: 3))
        var damaged = bytes; damaged[24] = 0
        XCTAssertThrowsError(try MindwtrCanonicalWave.samplesFromCanonicalWave(damaged, maximumSamples: 4))
        XCTAssertThrowsError(try MindwtrCanonicalWave.samplesFromCanonicalWave(Data(bytes.dropLast()), maximumSamples: 4))
        XCTAssertThrowsError(try MindwtrCanonicalWave.samplesFromCanonicalWave(bytes, maximumSamples: 0))
    }
    #if canImport(AudioToolbox)
    func testImmutableAudioDecoderUsesSamePCMAndCancellation() throws {
        let bytes = try wave()
        XCTAssertEqual(try MindwtrCanonicalWave.samplesFromAudio(bytes, maximumSamples: 4),
                       try MindwtrCanonicalWave.samplesFromCanonicalWave(bytes, maximumSamples: 4))
        XCTAssertThrowsError(try MindwtrCanonicalWave.samplesFromAudio(bytes, maximumSamples: 3))
        XCTAssertThrowsError(try MindwtrCanonicalWave.samplesFromAudio(Data("not audio".utf8), maximumSamples: 4))
        XCTAssertThrowsError(try MindwtrCanonicalWave.samplesFromAudio(bytes, maximumSamples: 4, checkCancellation: { throw CancellationError() }))
    }
    #endif
}
