import XCTest
@testable import MindwtrNativeCore

final class NativeMarkdownHistoryTests: XCTestCase {
    func testTypedTextStaysWhenAnAssistReplyArrivesLate() {
        var history = NativeMarkdownHistory()
        history.record(NativeMarkdownEdit(text: "a", start: 1, end: 1))
        let ticket = history.ticket(expecting: "a[")
        history.record(NativeMarkdownEdit(text: "a[", start: 2, end: 2))
        XCTAssertNil(history.applyAssist(ticket, current: "a[x", reply: ["changed": true, "value": "a[]", "start": 2, "end": 2]))
        XCTAssertEqual(history.depth, 2)
    }

    func testAnAssistReplaceReplacesTheTypedCharacterWithoutItsOwnUndoStep() {
        var history = NativeMarkdownHistory()
        history.record(NativeMarkdownEdit(text: "a", start: 1, end: 1))
        let ticket = history.ticket(expecting: "a[")
        let edit = history.applyAssist(ticket, current: "a[", reply: ["changed": true, "value": "a[]", "start": 2, "end": 2])
        XCTAssertEqual(edit, NativeMarkdownEdit(text: "a[]", start: 2, end: 2))
        XCTAssertEqual(history.depth, 1)
        XCTAssertEqual(history.undo(), NativeMarkdownEdit(text: "a", start: 1, end: 1))
        XCTAssertFalse(history.canUndo)
    }

    func testAnUnchangedAssistReplyOrAnExternalChangeAppliesNothing() {
        var history = NativeMarkdownHistory()
        let unchanged = history.ticket(expecting: "ab")
        XCTAssertNil(history.applyAssist(unchanged, current: "ab", reply: ["changed": false, "value": "ab", "start": 2, "end": 2]))
        let stale = history.ticket(expecting: "ab")
        history.externalChange()
        XCTAssertNil(history.applyAssist(stale, current: "ab", reply: ["changed": true, "value": "ab]", "start": 2, "end": 2]))
    }

    func testAnUnreadableReplyAppliesNothing() {
        var history = NativeMarkdownHistory()
        let ticket = history.ticket(expecting: "a")
        for reply: [String: Any] in [[:], ["changed": true, "value": "a", "start": 2, "end": 2],
                                     ["changed": true, "value": "a", "start": 1, "end": 0], ["changed": true, "value": 1, "start": 0, "end": 0]] {
            XCTAssertNil(history.applyAssist(ticket, current: "a", reply: reply))
        }
    }

    func testAToolbarReplyAppliesOnlyToTheTextItWasAskedFor() {
        var history = NativeMarkdownHistory()
        let before = NativeMarkdownEdit(text: "pack the boxes", start: 5, end: 8)
        let ticket = history.ticket(expecting: before.text)
        let edit = history.applyToolbar(ticket, current: before.text, before: before, reply: ["value": "pack **the** boxes", "start": 7, "end": 10])
        XCTAssertEqual(edit, NativeMarkdownEdit(text: "pack **the** boxes", start: 7, end: 10))
        XCTAssertEqual(history.undo(), before)
        let typed = history.ticket(expecting: before.text)
        XCTAssertNil(history.applyToolbar(typed, current: before.text + "x", before: before, reply: ["value": "pack **the** boxes", "start": 7, "end": 10]))

        let late = history.ticket(expecting: before.text)
        history.record(before)
        XCTAssertNil(history.applyToolbar(late, current: before.text, before: before, reply: ["value": "pack **the** boxes", "start": 7, "end": 10]))
    }

    func testHistoryKeepsRNsLastHundredStepsAndSkipsARepeatedStep() {
        var history = NativeMarkdownHistory()
        for index in 0..<120 { history.record(NativeMarkdownEdit(text: String(index), start: 0, end: 0)) }
        history.record(NativeMarkdownEdit(text: "119", start: 0, end: 0))
        XCTAssertEqual(history.depth, NativeMarkdownHistory.limit)
        XCTAssertEqual(history.undo()?.text, "119")
        history.reset()
        XCTAssertFalse(history.canUndo)
    }

    func testEditsClampToTheTextInUTF16Units() {
        XCTAssertEqual(NativeMarkdownEdit(text: "😀", start: 5, end: -1), NativeMarkdownEdit(text: "😀", start: 0, end: 2))
        XCTAssertEqual(NativeMarkdownEdit(reply: ["value": "😀[]", "start": 3, "end": 3]), NativeMarkdownEdit(text: "😀[]", start: 3, end: 3))
    }
}
