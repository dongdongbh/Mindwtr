import Foundation

/// A warm return may reuse an unlocked session; a cold launch has no departure to reuse.
public struct NativeAppLockRelockPolicy {
    private var leftUnlockedAt: TimeInterval?
    public init() {}
    public mutating func leave(unlocked: Bool, now: TimeInterval) {
        if unlocked && leftUnlockedAt == nil { leftUnlockedAt = now }
    }
    public mutating func reset() { leftUnlockedAt = nil }
    public mutating func resume(delayMinutes: Int, now: TimeInterval) -> Bool {
        defer { leftUnlockedAt = nil }
        guard [1, 5, 15].contains(delayMinutes), let departure = leftUnlockedAt else { return false }
        let elapsed = now - departure
        return elapsed.isFinite && elapsed >= 0 && elapsed < Double(delayMinutes * 60)
    }
}
