import Foundation

public enum NativeValueEquality {
    public static func same(_ lhs: Any, _ rhs: Any) -> Bool {
        switch (lhs, rhs) {
        case let (left as [String: Any], right as [String: Any]):
            return left.count == right.count && left.allSatisfy { key, value in right[key].map { same(value, $0) } ?? false }
        case let (left as [Any], right as [Any]):
            return left.count == right.count && zip(left, right).allSatisfy { same($0, $1) }
        case let (left as NSNumber, right as NSNumber):
            return isBoolean(left) == isBoolean(right) && left.isEqual(to: right)
        default:
            return (lhs as? NSObject)?.isEqual(rhs) ?? false
        }
    }

    private static func isBoolean(_ number: NSNumber) -> Bool { CFGetTypeID(number) == CFBooleanGetTypeID() }
}
