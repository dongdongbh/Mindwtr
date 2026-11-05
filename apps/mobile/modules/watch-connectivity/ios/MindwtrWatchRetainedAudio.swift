import Darwin
import Foundation

struct MindwtrWatchRetainedAudio: Sendable {
    static let maximumBytes = 4 * 1024 * 1024
    let bytes: Data
    let proof: MindwtrWatchFileProof

    static func read(at url: URL, afterRead: () throws -> Void = {}) throws -> Self? {
        guard let file = try MindwtrWatchFileProof.read(directory: url.deletingLastPathComponent(), name: url.lastPathComponent,
                                                       maximumBytes: maximumBytes, afterRead: afterRead) else { return nil }
        guard MindwtrCanonicalWave.validateHeader(Data(file.bytes.prefix(MindwtrCanonicalWave.headerSize)),
                                                  fileSize: file.bytes.count, maximumFileSize: maximumBytes) else {
            throw MindwtrWatchFileProof.unavailable
        }
        return Self(bytes: file.bytes, proof: file.proof)
    }

    static func proofForRetirement(at url: URL) throws -> MindwtrWatchFileProof? {
        let parent = open(url.deletingLastPathComponent().path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        if parent < 0 {
            if errno == ENOENT { return nil }
            throw MindwtrWatchFileProof.unavailable
        }
        close(parent)
        return try read(at: url)?.proof
    }
}

/// Identity retained before upload; this record never authorizes cleanup by itself.
struct MindwtrWatchAudioAdmission: Codable, Equatable {
    let version: Int
    let id: String
    let source: MindwtrWatchFileProof
    let receipt: MindwtrWatchFileProof
    let wave: MindwtrWatchFileProof

    init(id: String, source: MindwtrWatchFileProof, receipt: MindwtrWatchFileProof, wave: MindwtrWatchFileProof) {
        version = 1; self.id = id; self.source = source; self.receipt = receipt; self.wave = wave
    }

    func validateName(_ name: String) throws {
        guard version == 1, let uuid = UUID(uuidString: id), uuid.uuidString.lowercased() == id,
              name == id + ".json" else { throw MindwtrWatchFileProof.unavailable }
    }

    func confirmedCleanup(source: MindwtrWatchFileProof, receipt: MindwtrWatchFileProof,
                          audioDirectory: URL) throws -> MindwtrWatchAudioCleanup {
        try validateName(id + ".json")
        guard self.source == source, self.receipt == receipt else { throw MindwtrWatchFileProof.unavailable }
        try wave.validateForRetirement(directory: audioDirectory, name: id + ".wav",
                                       maximumBytes: MindwtrWatchRetainedAudio.maximumBytes)
        return MindwtrWatchAudioCleanup(id: id, source: source, receipt: receipt, wave: wave)
    }
}

/// Durable acknowledgement of the host callback; it grants cleanup of these generations only.
struct MindwtrWatchAudioCleanup: Codable, Equatable {
    let version: Int
    let id: String
    let source: MindwtrWatchFileProof
    let receipt: MindwtrWatchFileProof
    let wave: MindwtrWatchFileProof?

    init(id: String, source: MindwtrWatchFileProof, receipt: MindwtrWatchFileProof, wave: MindwtrWatchFileProof?) {
        version = 1; self.id = id; self.source = source; self.receipt = receipt; self.wave = wave
    }

    func validateName(_ name: String) throws {
        guard version == 1, let uuid = UUID(uuidString: id), uuid.uuidString.lowercased() == id,
              name == id + ".json" else { throw MindwtrWatchFileProof.unavailable }
    }

    func retire(pendingDirectory: URL, audioDirectory: URL, beforeQueueRemoval: () throws -> Void = {}) throws {
        try validateName(id + ".json")
        try source.retire(directory: pendingDirectory, name: id + ".json", maximumBytes: 32 * 1024,
                          beforeRemoval: {
            try beforeQueueRemoval()
            if let wave {
                try wave.validateForRetirement(directory: audioDirectory, name: id + ".wav",
                                               maximumBytes: MindwtrWatchRetainedAudio.maximumBytes)
            } else {
                guard try MindwtrWatchRetainedAudio.proofForRetirement(at: audioDirectory.appendingPathComponent(id + ".wav")) == nil else {
                    throw MindwtrWatchFileProof.unavailable
                }
            }
        })
        if let wave {
            try wave.retire(directory: audioDirectory, name: id + ".wav", maximumBytes: MindwtrWatchRetainedAudio.maximumBytes)
        }
    }
}
