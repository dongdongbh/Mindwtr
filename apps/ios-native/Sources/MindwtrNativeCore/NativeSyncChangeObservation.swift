import Foundation

public struct NativeSyncChangeObservation: Sendable, Equatable {
    public let pending: Bool

    public init(json: String) throws {
        guard json.utf8.count <= 256, try NativeJSON.hasUniqueObjectKeys(json),
              let value = try NativeJSON.jsonObject(with: Data(json.utf8)) as? [String: Any],
              Set(value.keys) == Set(["pending"]),
              let pending = value["pending"] as? NSNumber, CFGetTypeID(pending) == CFBooleanGetTypeID() else {
            throw HostFailure("NOT_READY: Native sync change observation is unavailable")
        }
        self.pending = pending.boolValue
    }
}
