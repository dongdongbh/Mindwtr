import Foundation

public struct NativeMarkdownEdit: Equatable, Sendable {
    public let text: String
    public let start: Int
    public let end: Int

    public init(text: String, start: Int, end: Int) {
        let length = text.utf16.count
        let lower = min(max(0, min(start, end)), length), upper = min(max(0, max(start, end)), length)
        self.text = text
        self.start = lower
        self.end = upper
    }

    public init?(reply: [String: Any]) {
        guard let text = reply["value"] as? String, let start = reply["start"] as? Int, let end = reply["end"] as? Int,
              start >= 0, start <= end, end <= text.utf16.count else { return nil }
        self.init(text: text, start: start, end: end)
    }
}

public struct NativeMarkdownHistory: Sendable {
    public static let limit = 100

    public struct Ticket: Equatable, Sendable {
        fileprivate let revision: UInt64
        public let expected: String
    }

    private var entries: [NativeMarkdownEdit] = []
    private var revision: UInt64 = 0

    public init() {}

    public var canUndo: Bool { !entries.isEmpty }
    public var depth: Int { entries.count }

    public mutating func record(_ before: NativeMarkdownEdit) {
        revision &+= 1
        guard entries.last != before else { return }
        entries.append(before)
        if entries.count > Self.limit { entries.removeFirst(entries.count - Self.limit) }
    }

    public mutating func undo() -> NativeMarkdownEdit? {
        guard let last = entries.popLast() else { return nil }
        revision &+= 1
        return last
    }

    public mutating func reset() {
        entries = []
        revision &+= 1
    }

    public mutating func externalChange() { revision &+= 1 }

    public func ticket(expecting text: String) -> Ticket { Ticket(revision: revision, expected: text) }

    public func isCurrent(_ ticket: Ticket, text: String) -> Bool {
        ticket.revision == revision && ticket.expected.utf16.elementsEqual(text.utf16)
    }

    public mutating func applyAssist(_ ticket: Ticket, current: String, reply: [String: Any]) -> NativeMarkdownEdit? {
        guard isCurrent(ticket, text: current), reply["changed"] as? Bool == true,
              let edit = NativeMarkdownEdit(reply: reply) else { return nil }
        revision &+= 1
        return edit
    }

    public mutating func applyToolbar(_ ticket: Ticket, current: String, before: NativeMarkdownEdit, reply: [String: Any]) -> NativeMarkdownEdit? {
        guard isCurrent(ticket, text: current), ticket.expected.utf16.elementsEqual(before.text.utf16),
              let edit = NativeMarkdownEdit(reply: reply) else { return nil }
        guard !edit.text.utf16.elementsEqual(before.text.utf16) || edit.start != before.start || edit.end != before.end else {
            return nil
        }
        if !edit.text.utf16.elementsEqual(before.text.utf16) { record(before) } else { revision &+= 1 }
        return edit
    }
}
