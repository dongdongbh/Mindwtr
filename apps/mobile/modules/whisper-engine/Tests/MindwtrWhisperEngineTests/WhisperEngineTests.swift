import Foundation
import Darwin
import XCTest
@testable import MindwtrWhisperEngine

final class WhisperEngineTests: XCTestCase {
    func testRejectsInvalidPCMAndLanguage() throws {
        let invalid: [[Float]] = [[], [.nan], [.infinity], [1.01], [-1.01], Array(repeating: 0, count: WhisperEngine.maximumSamples + 1)]
        for samples in invalid {
            XCTAssertThrowsError(try WhisperEngine.validate(samples: samples, language: "auto"))
        }
        for language in ["", " en", "en ", "en\ntext", String(repeating: "é", count: 101)] {
            XCTAssertThrowsError(try WhisperEngine.validate(samples: [0], language: language))
        }
        try WhisperEngine.validate(samples: [-1, 0, 1], language: "en")
        try WhisperEngine.validate(samples: Array(repeating: 0, count: WhisperEngine.maximumSamples), language: "auto")
    }

    func testCancellationIsCallScopedAndCompletionCannotBeCancelled() throws {
        let old = WhisperCancellation(), next = WhisperCancellation()
        old.cancel()
        XCTAssertThrowsError(try old.check())
        XCTAssertThrowsError(try old.finish())
        try next.finish(); next.cancel()
        XCTAssertFalse(next.isCancelled)
        try next.check()
    }

    func testRejectsRemoteModelURL() async throws {
        do {
            _ = try await WhisperEngine.open(modelURL: XCTUnwrap(URL(string: "https://example.invalid/model.bin")))
            XCTFail("Remote model URL must refuse")
        } catch { XCTAssertEqual(error as? WhisperEngineError, .invalidModelURL) }
    }

    private func realFixture() throws -> (model: URL, samples: [Float]) {
        let fixtures: URL
        if let path = ProcessInfo.processInfo.environment["MINDWTR_WHISPER_FIXTURES"] {
            fixtures = URL(fileURLWithPath: path, isDirectory: true)
        } else {
            fixtures = try XCTUnwrap(Bundle.module.url(forResource: "Fixtures", withExtension: nil))
        }
        let model = fixtures.appendingPathComponent("ggml-tiny.en.bin"), audio = fixtures.appendingPathComponent("jfk.f32")
        guard FileManager.default.fileExists(atPath: model.path), FileManager.default.fileExists(atPath: audio.path),
              FileManager.default.fileExists(atPath: fixtures.appendingPathComponent("manifest.json").path) else {
            XCTFail("Real Whisper fixtures missing: root must provide verified ggml-tiny.en.bin, jfk.f32 and manifest.json")
            throw CocoaError(.fileNoSuchFile)
        }
        let bytes = try Data(contentsOf: audio)
        guard bytes.count == 176_000 * 4 else { XCTFail("Unexpected JFK Float32 fixture size"); throw CocoaError(.fileReadCorruptFile) }
        let samples: [Float] = stride(from: 0, to: bytes.count, by: 4).map { offset in
            let bits = UInt32(bytes[offset]) | UInt32(bytes[offset + 1]) << 8 | UInt32(bytes[offset + 2]) << 16 | UInt32(bytes[offset + 3]) << 24
            return Float(bitPattern: bits)
        }
        return (model, samples)
    }

    func testRealSpeechRepeatedInferenceAndClose() async throws {
        let fixture = try realFixture()
        let engine = try await WhisperEngine.open(modelURL: fixture.model)
        do {
            for _ in 0..<2 {
                let text = try await engine.transcribe(samples: fixture.samples, language: "en")
                XCTAssertTrue(text.lowercased().contains("ask not what your country can do for you"))
            }
            await engine.close(); await engine.close()
            do { _ = try await engine.transcribe(samples: fixture.samples, language: "en"); XCTFail("Closed engine accepted inference") }
            catch { XCTAssertEqual(error as? WhisperEngineError, .closed) }
        } catch { await engine.close(); throw error }
    }

    func testRealSpeechDescriptorSurvivesUnlinkAndPreservesCallerOffset() async throws {
        let fixture = try realFixture()
        let copy = FileManager.default.temporaryDirectory.appendingPathComponent("whisper-descriptor-" + UUID().uuidString)
        try FileManager.default.copyItem(at: fixture.model, to: copy)
        defer { try? FileManager.default.removeItem(at: copy) }
        let descriptor = Darwin.open(copy.path, O_RDONLY | O_CLOEXEC)
        guard descriptor >= 0 else { throw CocoaError(.fileReadUnknown) }
        defer { Darwin.close(descriptor) }
        try FileManager.default.removeItem(at: copy)
        XCTAssertEqual(Darwin.lseek(descriptor, 64, SEEK_SET), 64)
        let engine = try await WhisperEngine.open(modelDescriptor: descriptor)
        do {
            let text = try await engine.transcribe(samples: fixture.samples, language: "en")
            XCTAssertTrue(text.lowercased().contains("ask not what your country can do for you"))
            XCTAssertEqual(Darwin.lseek(descriptor, 0, SEEK_CUR), 64)
            await engine.close()
            XCTAssertGreaterThanOrEqual(Darwin.fcntl(descriptor, F_GETFD), 0)
        } catch { await engine.close(); throw error }
    }

    func testRealSpeechCancellationInterruptsInferenceAndAllowsReuse() async throws {
        let fixture = try realFixture()
        let samples = Array(repeating: fixture.samples, count: 10).flatMap { $0 }
        let engine = try await WhisperEngine.open(modelURL: fixture.model)
        do {
            var baselines: [TimeInterval] = []
            for _ in 0..<2 {
                let started = ProcessInfo.processInfo.systemUptime
                let text = try await engine.transcribe(samples: samples, language: "en")
                baselines.append(ProcessInfo.processInfo.systemUptime - started)
                XCTAssertTrue(text.lowercased().contains("ask not what your country can do for you"))
            }
            let baseline = try XCTUnwrap(baselines.min())
            guard baseline > 0, baseline.isFinite else { XCTFail("Inference calibration is invalid"); throw CocoaError(.coderInvalidValue) }
            let started = ProcessInfo.processInfo.systemUptime
            let cancelled = Task { try await engine.transcribe(samples: samples, language: "en") }
            do {
                try await Task.sleep(nanoseconds: UInt64(baseline / 4 * 1_000_000_000))
                cancelled.cancel()
                do { _ = try await cancelled.value; XCTFail("Cancelled inference returned text") }
                catch { XCTAssertTrue(error is CancellationError) }
            } catch {
                cancelled.cancel()
                _ = try? await cancelled.value
                throw error
            }
            let elapsed = ProcessInfo.processInfo.systemUptime - started
            let evidence = XCTAttachment(string: "fullInferenceSeconds=\(baselines); cancelAfterSeconds=\(baseline / 4); cancelledTotalSeconds=\(elapsed); requiredTotalBelowSeconds=\(baseline * 0.75)")
            evidence.name = "Whisper cancellation calibration"; evidence.lifetime = .keepAlways; add(evidence)
            XCTAssertLessThan(elapsed, baseline * 0.75, "Cancellation did not interrupt the running C inference")
            let reused = try await engine.transcribe(samples: fixture.samples, language: "en")
            XCTAssertTrue(reused.lowercased().contains("ask not what your country can do for you"))
            await engine.close()
        } catch { await engine.close(); throw error }
    }
}
