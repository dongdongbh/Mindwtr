#if (DEBUG || NATIVE_DEVICE_TEST) && !MINDWTR_SHARE_EXTENSION
import Foundation

public enum NativeShareMailboxExport {
    public struct Receipt: Sendable {
        public let directory: URL
        public let envelopes: Int
        public let bytes: Int
    }
    public static let flag = "--native-share-mailbox-export"

    public static func requested(arguments: [String]) -> Bool {
        arguments.dropFirst().contains { $0.hasPrefix(flag) }
    }

    static func run(arguments: [String], bundleIdentifier: String?) throws -> String {
        guard bundleIdentifier == NativeShareMailbox.appIdentifier, arguments.count == 3,
              arguments[1] == flag, UUID(uuidString: arguments[2])?.uuidString.lowercased() == arguments[2] else {
            throw NativeShareError.invalidInput
        }
        return arguments[2]
    }

    public static func failureCode(_ error: Error) -> String {
        if let failure = error as? DurableFile.ProtectionFailure {
            return "write-protection:\(failure.stage.rawValue):s=\(failure.sourceClass):t=\(failure.targetClass):e=\(failure.errorNumber)"
        }
        if let error = error as? NativeShareError {
            switch error {
            case .unavailable: return "mailbox-unavailable"
            case .invalidInput: return "invalid-input"
            case .changedSource: return "source-changed"
            case .full: return "mailbox-full"
            }
        }
        if let error = error as? HostFailure {
            switch error.message {
            case "Invalid anchored recovery publication": return "write-invalid"
            case "Cannot create pending command journal": return "write-create"
            case "Cannot retain recovery publication": return "write-retain"
            case "Cannot preserve recovery data protection": return "write-protection"
            case "Cannot write pending command journal": return "write-bytes"
            case "Cannot durably save pending command journal": return "write-sync"
            case "Cannot promote pending command journal": return "write-promote"
            case "Cannot synchronize recovery data": return "directory-sync"
            default: return "unexpected"
            }
        }
        return "unexpected"
    }

    public static func perform() async throws -> Receipt {
        let id = try run(arguments: ProcessInfo.processInfo.arguments, bundleIdentifier: Bundle.main.bundleIdentifier)
        let documents = try FileManager.default.url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let mailbox = try NativeShareMailbox.current()
        return try await mailbox.exportRaw(documents: documents, run: id)
    }
}
#endif
