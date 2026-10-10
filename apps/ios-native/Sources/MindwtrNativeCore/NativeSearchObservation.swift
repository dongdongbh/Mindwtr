import CoreFoundation
import Foundation

public struct NativeSearchObservation: Sendable, Equatable {
    public let ready: Bool
    public let revision: UInt64
    public let nextAt: Double?

    public init(json: String) throws {
        let invalid = HostFailure("NOT_READY: Native search observation is unavailable")
        guard json.utf8.count <= 2_048,
              let value = try NativeJSON.jsonObject(with: Data(json.utf8)) as? [String: Any],
              Set(value.keys) == Set(["ready", "revision", "nextAt"]), try NativeJSON.hasUniqueObjectKeys(json),
              let ready = value["ready"] as? NSNumber, CFGetTypeID(ready) == CFBooleanGetTypeID(),
              let revision = value["revision"] as? NSNumber, CFGetTypeID(revision) != CFBooleanGetTypeID(),
              revision.doubleValue.rounded() == revision.doubleValue,
              (0...9_007_199_254_740_991).contains(revision.doubleValue) else { throw invalid }
        let nextAt: Double?
        if value["nextAt"] is NSNull { nextAt = nil }
        else {
            guard let number = value["nextAt"] as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
                  number.doubleValue.isFinite, (0...9_007_199_254_740_991).contains(number.doubleValue) else { throw invalid }
            nextAt = number.doubleValue
        }
        self.init(ready: ready.boolValue, revision: revision.uint64Value, nextAt: nextAt)
    }

    init(ready: Bool, revision: UInt64, nextAt: Double?) {
        self.ready = ready; self.revision = revision; self.nextAt = nextAt
    }
}
