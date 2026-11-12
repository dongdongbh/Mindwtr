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

public struct NativeSyncChangeSchedule: Sendable, Equatable {
    public static let maximumDelayMs = 3_600_000
    public let delayMs: Int?

    public init(json: String) throws {
        let invalid = HostFailure("NOT_READY: Native sync change schedule is unavailable")
        guard json.utf8.count <= 256, try NativeJSON.hasUniqueObjectKeys(json),
              let value = try NativeJSON.jsonObject(with: Data(json.utf8)) as? [String: Any],
              Set(value.keys) == Set(["delayMs"]) else { throw invalid }
        if value["delayMs"] is NSNull { delayMs = nil; return }
        guard let number = value["delayMs"] as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue.isFinite, number.doubleValue >= 0 else { throw invalid }
        delayMs = Int(min(number.doubleValue.rounded(.up), Double(Self.maximumDelayMs)))
    }
}
