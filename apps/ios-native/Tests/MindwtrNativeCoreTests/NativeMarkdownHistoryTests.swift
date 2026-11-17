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

    func testBackspaceInAPairJustInsertedLeavesTheOpenerAndASecondBackspaceDeletesItAsInRN() {
        for pair in ["()", "[]", "``"] {
            for prefix in ["", "note ", "😀"] {
                var history = NativeMarkdownHistory()
                let open = String(pair.prefix(1)), caret = prefix.utf16.count + 1
                history.record(NativeMarkdownEdit(text: prefix, start: caret - 1, end: caret - 1))
                let ticket = history.ticket(expecting: prefix + open)
                XCTAssertEqual(history.applyAssist(ticket, current: prefix + open, reply: ["changed": true, "value": prefix + pair, "start": caret, "end": caret]),
                               NativeMarkdownEdit(text: prefix + pair, start: caret, end: caret))
                let paired = NativeMarkdownEdit(text: prefix + pair, start: caret, end: caret)
                XCTAssertEqual(history.backspaceInJustInsertedPair(paired, deleting: NSRange(location: caret - 1, length: 1), replacement: ""),
                               NativeMarkdownEdit(text: prefix + open, start: caret, end: caret))
                XCTAssertNil(history.backspaceInJustInsertedPair(NativeMarkdownEdit(text: prefix + open, start: caret, end: caret),
                                                                deleting: NSRange(location: caret - 1, length: 1), replacement: ""))
                XCTAssertEqual(history.undo(), paired)
            }
        }
    }

    func testOnlyABackspaceRightAfterThePairInsertionKeepsTheOpener() {
        let paired = NativeMarkdownEdit(text: "a[]", start: 2, end: 2), backspace = NSRange(location: 1, length: 1)
        func armed() -> NativeMarkdownHistory {
            var history = NativeMarkdownHistory()
            let ticket = history.ticket(expecting: "a[")
            _ = history.applyAssist(ticket, current: "a[", reply: ["changed": true, "value": "a[]", "start": 2, "end": 2])
            return history
        }
        var history = NativeMarkdownHistory()
        XCTAssertNil(history.backspaceInJustInsertedPair(paired, deleting: backspace, replacement: ""))
        history = armed()
        XCTAssertNil(history.backspaceInJustInsertedPair(paired, deleting: NSRange(location: 2, length: 0), replacement: "x"))
        XCTAssertNil(history.backspaceInJustInsertedPair(NativeMarkdownEdit(text: "a[]", start: 3, end: 3), deleting: NSRange(location: 2, length: 1), replacement: ""))
        XCTAssertNil(history.backspaceInJustInsertedPair(NativeMarkdownEdit(text: "a[]", start: 1, end: 2), deleting: NSRange(location: 1, length: 1), replacement: ""))
        XCTAssertNil(history.backspaceInJustInsertedPair(NativeMarkdownEdit(text: "b[]", start: 2, end: 2), deleting: backspace, replacement: ""))
        history.record(paired)
        XCTAssertNil(history.backspaceInJustInsertedPair(paired, deleting: backspace, replacement: ""))
        history = armed()
        history.externalChange()
        XCTAssertNil(history.backspaceInJustInsertedPair(paired, deleting: backspace, replacement: ""))
        history = NativeMarkdownHistory()
        let continued = history.ticket(expecting: "- milk\n")
        _ = history.applyAssist(continued, current: "- milk\n", reply: ["changed": true, "value": "- milk\n- ", "start": 9, "end": 9])
        XCTAssertNil(history.backspaceInJustInsertedPair(NativeMarkdownEdit(text: "- milk\n- ", start: 9, end: 9),
                                                        deleting: NSRange(location: 8, length: 1), replacement: ""))
        let skipped = history.ticket(expecting: "a]]")
        _ = history.applyAssist(skipped, current: "a]]", reply: ["changed": true, "value": "a]", "start": 2, "end": 2])
        XCTAssertNil(history.backspaceInJustInsertedPair(NativeMarkdownEdit(text: "a]", start: 2, end: 2), deleting: backspace, replacement: ""))
    }

    func testEditsClampToTheTextInUTF16Units() {
        XCTAssertEqual(NativeMarkdownEdit(text: "😀", start: 5, end: -1), NativeMarkdownEdit(text: "😀", start: 0, end: 2))
        XCTAssertEqual(NativeMarkdownEdit(reply: ["value": "😀[]", "start": 3, "end": 3]), NativeMarkdownEdit(text: "😀[]", start: 3, end: 3))
    }
}
