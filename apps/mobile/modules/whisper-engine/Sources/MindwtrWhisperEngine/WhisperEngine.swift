import Foundation
#if canImport(rnwhisper)
import rnwhisper
import Darwin
#endif

public enum WhisperEngineError: Error, Equatable, Sendable {
    case invalidModelURL, invalidSamples, invalidLanguage, unavailable, initializationFailed, closed
    case transcriptionFailed(Int32)
}

final class WhisperCancellation: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false
    private var completed = false

    func cancel() { lock.lock(); defer { lock.unlock() }; if !completed { cancelled = true } }
    var isCancelled: Bool { lock.lock(); defer { lock.unlock() }; return cancelled }
    func check() throws { if isCancelled { throw CancellationError() } }
    func finish() throws {
        lock.lock(); defer { lock.unlock() }
        if cancelled { throw CancellationError() }
        completed = true
    }
}

public final class WhisperEngine: @unchecked Sendable {
    public static let sampleRate = 16_000
    public static let maximumSamples = 120 * sampleRate
    private let worker = DispatchQueue(label: "tech.dongdongbh.mindwtr.whisper", qos: .userInitiated)
    private final class State: @unchecked Sendable {
        var context: OpaquePointer?
        var closed = false
        func close() {
            #if canImport(rnwhisper)
            if let context { whisper_free(context) }
            #endif
            context = nil; closed = true
        }
    }
    private let state = State()
    private static let quiet: Void = {
        #if canImport(rnwhisper)
        whisper_log_set({ _, _, _ in }, nil)
        #endif
    }()
    private init() {}

    deinit {
        let state = state
        worker.async { state.close() }
    }

    public static func open(modelURL: URL) async throws -> WhisperEngine {
        guard modelURL.isFileURL, modelURL.user == nil, modelURL.password == nil, modelURL.query == nil,
              modelURL.fragment == nil, modelURL.host == nil || modelURL.host == "" || modelURL.host == "localhost",
              !modelURL.path.isEmpty, !modelURL.path.utf8.contains(0) else { throw WhisperEngineError.invalidModelURL }
        return try await load { _ in
            #if canImport(rnwhisper)
            return modelURL.path.withCString { whisper_init_from_file_with_params($0, parameters()) }
            #else
            throw WhisperEngineError.unavailable
            #endif
        }
    }

    public static func open(modelDescriptor: Int32) async throws -> WhisperEngine {
        #if canImport(rnwhisper)
        let descriptor = Darwin.dup(modelDescriptor)
        guard descriptor >= 0 else { throw WhisperEngineError.invalidModelURL }
        defer { Darwin.close(descriptor) }
        return try await load { cancellation in
            let reader = try WhisperModelReader(descriptor: descriptor, cancellation: cancellation)
            let retained = Unmanaged.passRetained(reader)
            defer { retained.release() }
            var loader = whisper_model_loader()
            loader.context = retained.toOpaque()
            loader.read = { context, output, size in
                guard let context, let output else { return 0 }
                return Unmanaged<WhisperModelReader>.fromOpaque(context).takeUnretainedValue().read(output, count: size)
            }
            loader.eof = { context in
                guard let context else { return true }
                return Unmanaged<WhisperModelReader>.fromOpaque(context).takeUnretainedValue().atEnd
            }
            loader.close = { _ in }
            let context = whisper_init_with_params(&loader, parameters())
            guard reader.valid else {
                if let context { whisper_free(context) }
                try cancellation.check()
                throw WhisperEngineError.initializationFailed
            }
            return context
        }
        #else
        throw WhisperEngineError.unavailable
        #endif
    }

    #if canImport(rnwhisper)
    private static func parameters() -> whisper_context_params {
        var parameters = whisper_context_default_params()
        parameters.flash_attn = false
        #if targetEnvironment(simulator)
        parameters.use_gpu = false
        #endif
        return parameters
    }
    #endif

    private static func load(_ initialize: @escaping @Sendable (WhisperCancellation) throws -> OpaquePointer?) async throws -> WhisperEngine {
        let engine = WhisperEngine()
        do {
            try await engine.enqueue { cancellation in
                _ = Self.quiet
                let context = try initialize(cancellation)
                guard let context else { throw WhisperEngineError.initializationFailed }
                engine.state.context = context
                try cancellation.check()
            }
            return engine
        } catch {
            await engine.close()
            throw error
        }
    }

    static func validate(samples: [Float], language: String) throws {
        guard !samples.isEmpty, samples.count <= maximumSamples,
              samples.allSatisfy({ $0.isFinite && $0 >= -1 && $0 <= 1 }) else { throw WhisperEngineError.invalidSamples }
        guard !language.isEmpty, language.utf8.count <= 200, language == language.trimmingCharacters(in: .whitespacesAndNewlines),
              !language.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else { throw WhisperEngineError.invalidLanguage }
    }

    public func transcribe(samples: [Float], language: String) async throws -> String {
        try Self.validate(samples: samples, language: language)
        return try await enqueue { cancellation in
            guard !self.state.closed, let context = self.state.context else { throw WhisperEngineError.closed }
            #if canImport(rnwhisper)
            var parameters = whisper_full_default_params(WHISPER_SAMPLING_GREEDY)
            parameters.n_threads = ProcessInfo.processInfo.processorCount == 4 ? 2 : Int32(min(4, ProcessInfo.processInfo.processorCount))
            parameters.no_context = true
            parameters.single_segment = false
            parameters.translate = false
            parameters.token_timestamps = false
            parameters.print_realtime = false
            parameters.print_progress = false
            parameters.print_timestamps = false
            parameters.print_special = false
            let owner = Unmanaged.passRetained(cancellation)
            defer { owner.release() }
            parameters.abort_callback_user_data = owner.toOpaque()
            parameters.abort_callback = { pointer in
                guard let pointer else { return true }
                return Unmanaged<WhisperCancellation>.fromOpaque(pointer).takeUnretainedValue().isCancelled
            }
            let code = language.withCString { language in
                parameters.language = language
                return samples.withUnsafeBufferPointer { whisper_full(context, parameters, $0.baseAddress, Int32($0.count)) }
            }
            try cancellation.check()
            guard code == 0 else { throw WhisperEngineError.transcriptionFailed(code) }
            let count = whisper_full_n_segments(context)
            guard count >= 0 else { throw WhisperEngineError.transcriptionFailed(-1) }
            var text = ""
            for index in 0..<count {
                guard let segment = whisper_full_get_segment_text(context, index) else { throw WhisperEngineError.transcriptionFailed(-1) }
                text += String(cString: segment)
            }
            return text.trimmingCharacters(in: .whitespacesAndNewlines)
            #else
            _ = context
            throw WhisperEngineError.unavailable
            #endif
        }
    }

    public func close() async {
        await withCheckedContinuation { continuation in
            worker.async { self.state.close(); continuation.resume() }
        }
    }

    private func enqueue<T: Sendable>(_ body: @escaping @Sendable (WhisperCancellation) throws -> T) async throws -> T {
        let cancellation = WhisperCancellation()
        return try await withTaskCancellationHandler(operation: {
            try await withCheckedThrowingContinuation { continuation in
                worker.async {
                    do {
                        try cancellation.check()
                        let result = try body(cancellation)
                        try cancellation.finish()
                        continuation.resume(returning: result)
                    } catch { continuation.resume(throwing: error) }
                }
            }
        }, onCancel: { cancellation.cancel() })
    }
}

#if canImport(rnwhisper)
private final class WhisperModelReader {
    let descriptor: Int32
    let cancellation: WhisperCancellation
    let original: stat
    var offset: Int64 = 0
    var failed = false

    init(descriptor: Int32, cancellation: WhisperCancellation) throws {
        var info = stat()
        guard Darwin.fstat(descriptor, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_size > 0 else {
            throw WhisperEngineError.invalidModelURL
        }
        self.descriptor = descriptor; self.cancellation = cancellation; original = info
    }
    var atEnd: Bool { failed || offset >= original.st_size }
    var valid: Bool {
        var current = stat()
        return !failed && !cancellation.isCancelled && Darwin.fstat(descriptor, &current) == 0
            && current.st_dev == original.st_dev && current.st_ino == original.st_ino
            && current.st_mode == original.st_mode && current.st_size == original.st_size
            && current.st_mtimespec.tv_sec == original.st_mtimespec.tv_sec && current.st_mtimespec.tv_nsec == original.st_mtimespec.tv_nsec
            && current.st_ctimespec.tv_sec == original.st_ctimespec.tv_sec && current.st_ctimespec.tv_nsec == original.st_ctimespec.tv_nsec
    }
    func read(_ output: UnsafeMutableRawPointer, count: Int) -> Int {
        if offset == original.st_size { return 0 }
        guard count >= 0, count <= original.st_size - offset else { failed = true; return 0 }
        var received = 0
        while received < count {
            let result = Darwin.pread(descriptor, output.advanced(by: received), min(count - received, 1_048_576), off_t(offset))
            if result < 0 && errno == EINTR { continue }
            guard result > 0 else { failed = true; return received }
            received += result; offset += Int64(result)
        }
        return received
    }
}
#endif
