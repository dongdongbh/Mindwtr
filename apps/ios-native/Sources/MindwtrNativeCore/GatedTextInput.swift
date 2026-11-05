import Foundation

public struct GatedTextInput: Equatable, Sendable {
    public struct Ticket: Equatable, Sendable {
        fileprivate let revision: UInt64
    }

    public let limit: Int
    public private(set) var text = ""
    public private(set) var validating = false
    public private(set) var deferred = false
    public private(set) var rejected = false
    private var revision: UInt64 = 0
    private var savableRevision: UInt64?

    public init(limit: Int) { self.limit = limit }

    public var canSave: Bool { savableRevision == revision }

    public func isUnchanged(_ value: String) -> Bool { !rejected && value.utf8.elementsEqual(text.utf8) }

    @discardableResult
    public mutating func accept(_ value: String) -> Bool {
        guard !isUnchanged(value) else { return false }
        guard value.utf16.count <= limit else {
            invalidate()
            rejected = true
            return false
        }
        text = value
        rejected = false
        invalidate()
        return true
    }

    @discardableResult
    public mutating func beginValidation() -> Ticket {
        invalidate()
        validating = true
        return Ticket(revision: revision)
    }

    public mutating func deferValidation() {
        invalidate()
        deferred = true
    }

    public func isCurrent(_ ticket: Ticket) -> Bool { validating && ticket.revision == revision }

    @discardableResult
    public mutating func finish(_ ticket: Ticket, canSave: Bool) -> Bool {
        guard isCurrent(ticket) else { return false }
        validating = false
        savableRevision = canSave ? revision : nil
        return true
    }

    @discardableResult
    public mutating func fail(_ ticket: Ticket) -> Bool {
        guard isCurrent(ticket) else { return false }
        validating = false
        return true
    }

    public mutating func reset() {
        text = ""
        rejected = false
        invalidate()
    }

    public mutating func invalidate() {
        revision &+= 1
        savableRevision = nil
        validating = false
        deferred = false
    }
}
