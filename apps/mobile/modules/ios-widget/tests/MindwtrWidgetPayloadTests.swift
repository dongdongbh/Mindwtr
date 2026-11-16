import Foundation
import XCTest

final class MindwtrWidgetPayloadTests: XCTestCase {
    func testPublishedMembershipSurvivesMidnightUntilTheAppReplacesTheSnapshot() throws {
        try compileAndRun(Self.checks)
    }

    func testNativeDevelopmentBuildUsesItsOwnAppGroupAndLinkScheme() throws {
        try compileAndRun(Self.productionIdentityChecks)
        try compileAndRun(Self.developmentIdentityChecks, conditions: ["MINDWTR_NATIVE_DEV"])
    }

    func testNativePublishedFamilySnapshotDecodesForEveryWidgetList() throws {
        try compileAndRun(Self.nativeSnapshotChecks, resources: ["native-family-snapshot.json"])
    }

    private func compileAndRun(_ checks: String, conditions: [String] = [], resources: [String] = []) throws {
        let package = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        let mobile = package.deletingLastPathComponent().deletingLastPathComponent()
        let widget = try String(contentsOf: mobile.appendingPathComponent("widgets-ios/MindwtrTasksWidget.swift"))
        let boundary = try XCTUnwrap(widget.range(of: "struct MindwtrTasksWidgetEntry: TimelineEntry"))
        let links = try XCTUnwrap(widget.range(of: "func safeMindwtrURL"))
        let linksEnd = try XCTUnwrap(widget.range(of: "func hexColor"))

        let payload = "import Foundation\n" + (widget[..<boundary.lowerBound] + widget[links.lowerBound..<linksEnd.lowerBound])
            .replacingOccurrences(of: "import AppIntents\n", with: "")
            .replacingOccurrences(of: "import SwiftUI\n", with: "")
            .replacingOccurrences(of: "import WidgetKit\n", with: "")
        let output = package.appendingPathComponent(".build/widget-payload-tests/\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: output) }
        let projection = output.appendingPathComponent("Payload.swift")
        let main = output.appendingPathComponent("main.swift")
        let executable = output.appendingPathComponent("projection")
        try payload.write(to: projection, atomically: true, encoding: .utf8)
        try checks.write(to: main, atomically: true, encoding: .utf8)
        let compilation = try run("/usr/bin/env", [
            "swiftc", package.appendingPathComponent("ios/MindwtrWidgetActionStore.swift").path,
            package.appendingPathComponent("ios/MindwtrWidgetTaskItem.swift").path,
            projection.path, main.path, "-o", executable.path,
        ] + conditions.flatMap { ["-D", $0] })
        XCTAssertEqual(compilation.status, 0, compilation.log)
        guard compilation.status == 0 else { return }
        let result = try run(executable.path, resources.map {
            URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures/" + $0).path
        })
        XCTAssertEqual(result.status, 0, result.log)
    }

    private func run(_ executable: String, _ arguments: [String]) throws -> (status: Int32, log: String) {
        let process = Process()
        let pipe = Pipe()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        process.standardOutput = pipe
        process.standardError = pipe
        try process.run()
        let log = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return (process.terminationStatus, String(decoding: log, as: UTF8.self))
    }

    private static let checks = ##"""
    import Foundation

    let json = #"""
    {
      "headerTitle":"Focus","subtitle":"Inbox: 2","dateLabel":"Mar 7","focusedCount":1,
      "items":[{"id":"focused","title":"Focus row","completionToken":"focus-token"}],
      "lists":{
        "focus":{"title":"Today","dateLabel":"Mar 7","items":[{"id":"focused","title":"Focus row","completionToken":"focus-token"}]},
        "next":{"title":"Next","items":[{"id":"next","title":"Next row"}]},
        "upcoming":{"title":"Upcoming","dateLabel":"Published Mar 7",
          "items":[{"id":"tomorrow","title":"Preview","upcomingDate":"2026-03-08","upcomingLabel":"Starts","dueLabel":"Starts Mar 8, 2026","completionToken":"preview-token"}],
          "sections":[{"key":"future","title":"Future","detail":"7 days","items":[{"id":"later","title":"Later preview","upcomingDate":"2026-03-14","upcomingLabel":"Returns"}]}]}
      },
      "emptyMessage":"No tasks","captureLabel":"Capture","focusUri":"mindwtr:///focus",
      "quickCaptureUri":"mindwtr:///capture-quick?mode=text",
      "upcomingDays":{"today":"Today","tomorrow":"Tomorrow","weekdays":["Sun","Mon","Tue","Wed","Thu","Fri","Sat"],"dayFirst":false},
      "palette":{"background":"#FFFFFF","card":"#FFFFFF","border":"#CCCCCC","text":"#000000","mutedText":"#777777","accent":"#0000FF","onAccent":"#FFFFFF"}
    }
    """#
    let original = try JSONDecoder().decode(MindwtrTasksWidgetPayload.self, from: Data(json.utf8))
    func instant(_ value: String) -> Date { ISO8601DateFormatter().date(from: value)! }
    let before = instant("2026-03-08T04:59:59Z")
    let midnight = instant("2026-03-08T05:00:00Z")
    let actions = [MindwtrWidgetPendingAction(
        id: "complete", taskId: "focused", token: "focus-token",
        createdAt: before.timeIntervalSince1970 * 1000,
        notBefore: midnight.timeIntervalSince1970 * 1000, claimed: false
    ), MindwtrWidgetPendingAction(
        id: "preview", taskId: "tomorrow", token: "preview-token",
        createdAt: 0, notBefore: 1, claimed: true
    )]
    for zone in ["America/New_York", "America/Los_Angeles", "Asia/Tokyo"] {
        NSTimeZone.default = TimeZone(identifier: zone)!
        for date in [before, midnight, instant("2026-03-09T04:00:00Z"), instant("2026-03-20T12:00:00Z")] {
            let upcoming = original.selectingList("upcoming", pendingActions: actions, at: date)
            precondition(upcoming.items.map(\.id) == ["tomorrow"], "cached Upcoming row vanished at \(date) in \(zone)")
            precondition(upcoming.sections?.flatMap(\.items).map(\.id) == ["later"], "cached section changed")
            precondition(upcoming.sections?.first?.detail == "7 days", "section metadata changed")
            precondition(upcoming.headerTitle == "Upcoming" && upcoming.dateLabel == "Published Mar 7", "header advanced without app publication")
            precondition(upcoming.items.first?.isUpcomingPreview == true, "preview became completable")
            let local = Calendar.current.dateComponents([.year, .month, .day], from: date)
            let expected = local.day == 7 ? "Starts Tomorrow" : local.day == 8 ? "Starts Today" : "Starts 3/8"
            precondition(local.year == 2026 && local.month == 3, "unexpected test date \(date)")
            precondition(upcoming.items.first?.dueLabel == expected, "preview label \(upcoming.items.first?.dueLabel ?? "nil") at \(date) in \(zone)")
            let focus = original.selectingList("focus", at: date)
            precondition(focus.items.map(\.id) == ["focused"], "native code promoted Upcoming into Focus")
            precondition(focus.dateLabel == "Mar 7" && focus.focusedCount == 1, "Focus metadata advanced")
        }
    }
    precondition(original.selectingList("focus", pendingActions: actions, at: before).items.map(\.id) == ["focused"], "completion grace removed")
    precondition(original.selectingList("focus", pendingActions: actions, at: midnight).items.map(\.id) == ["next"], "expired completion did not hide/fall back")
    precondition(MindwtrWidgetActionProjection.timelineDates(pendingActions: [], now: before) == [before], "idle snapshot gained a timeline boundary")
    precondition(MindwtrWidgetActionProjection.timelineDates(pendingActions: actions, now: before) == [before, midnight], "completion expiry timeline changed")

    var groupedJSON = try JSONSerialization.jsonObject(with: Data(json.utf8)) as! [String: Any]
    groupedJSON["lists"] = ["filter:grouped": ["title": "Grouped", "items": [], "sections": [
        ["key": "context:@a", "title": "A", "detail": "8", "items": [
            ["id": "focused", "title": "Completed", "completionToken": "focus-token"],
            ["id": "other", "title": "Other"]]],
        ["key": "context:@b", "title": "B", "detail": "3", "items": [
            ["id": "focused", "title": "Completed", "completionToken": "focus-token"],
            ["id": "another", "title": "Another"]]]
    ]]] as [String: Any]
    let grouped = try JSONDecoder().decode(MindwtrTasksWidgetPayload.self, from: JSONSerialization.data(withJSONObject: groupedJSON))
    let hidden = grouped.selectingList("filter:grouped", pendingActions: actions, at: midnight)
    precondition(hidden.sections?.map(\.detail) == ["7", "2"], "group counts did not mask completed appearances")
    precondition(grouped.selectingList("filter:grouped", pendingActions: [], at: midnight).sections?.map(\.detail) == ["8", "3"], "undo lost full counts")

    var fresh = try JSONSerialization.jsonObject(with: Data(json.utf8)) as! [String: Any]
    var lists = fresh["lists"] as! [String: Any]
    lists["upcoming"] = ["title": "Upcoming", "dateLabel": "Published Mar 8", "items": [], "sections": []] as [String: Any]
    lists["focus"] = ["title": "Today", "dateLabel": "Mar 8", "items": [["id": "tomorrow", "title": "Now current", "completionToken": "fresh-token"]]] as [String: Any]
    fresh["lists"] = lists
    let replacement = try JSONDecoder().decode(MindwtrTasksWidgetPayload.self, from: JSONSerialization.data(withJSONObject: fresh))
    precondition(replacement.selectingList("upcoming", at: midnight).items.isEmpty, "fresh app membership ignored")
    precondition(replacement.selectingList("upcoming", at: midnight).dateLabel == "Published Mar 8", "fresh app header ignored")
    precondition(replacement.selectingList("focus", at: midnight).items.map(\.id) == ["tomorrow"], "fresh Focus membership ignored")
    print("Production widget payload: cached midnight/DST/timezone retention, app replacement, and completion projection passed")
    """##
    private static let productionIdentityChecks = ##"""
    import Foundation

    precondition(MindwtrWidgetActionStore.appGroupIdentifier == "group.tech.dongdongbh.mindwtr", "production widget group changed")
    precondition(safeMindwtrURL("mindwtr:///widget-list/filter:a%20b").absoluteString == "mindwtr:///widget-list/filter:a%20b", "production link changed")
    precondition(safeMindwtrURL("mindwtr://open?task=t").absoluteString == "mindwtr://open?task=t", "production task link changed")
    precondition(safeMindwtrURL("https://example.com").absoluteString == "mindwtr:///focus", "foreign link was not refused")
    print("Production widget identity unchanged")
    """##

    private static let developmentIdentityChecks = ##"""
    import Foundation

    precondition(MindwtrWidgetActionStore.appGroupIdentifier == "group.tech.dongdongbh.mindwtr.native.dev", "dev widget group")
    precondition(safeMindwtrURL("mindwtr:///widget-list/filter:a%20b").absoluteString == "mindwtr-native-dev:///widget-list/filter:a%20b", "dev list link")
    precondition(safeMindwtrURL("MINDWTR://open?task=t").absoluteString == "mindwtr-native-dev://open?task=t", "dev task link")
    precondition(safeMindwtrURL("https://example.com").absoluteString == "mindwtr-native-dev:///focus", "dev foreign link was not refused")
    print("Native development widget identity uses its own group and scheme")
    """##

    private static let nativeSnapshotChecks = ##"""
    import Foundation

    let root = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))) as! [String: Any]
    let payloads = root["payloads"] as! [String: String]
    precondition(Set(payloads.keys) == ["default", "small", "medium", "large", "extraLarge"], "family set changed")
    for (family, json) in payloads {
        let payload = try JSONDecoder().decode(MindwtrTasksWidgetPayload.self, from: Data(json.utf8))
        precondition(payload.quickCaptureUri.hasPrefix("mindwtr:///capture-quick"), "\(family) capture link")
        for list in ["focus", "focus:available", "inbox", "next", "upcoming", "waiting", "someday"] {
            let selected = payload.selectingList(list)
            precondition(!selected.headerTitle.isEmpty, "\(family) \(list) lost its title")
            precondition(safeMindwtrURL(selected.focusUri).scheme == "mindwtr", "\(family) \(list) header link")
        }
        for filter in payload.savedFilters ?? [] {
            precondition(payload.title(forList: "filter:" + filter.id) == filter.name, "\(family) saved filter title")
        }
        let next = payload.selectingList("next")
        let rows = next.items + (next.sections ?? []).flatMap(\.items)
        precondition(!rows.isEmpty, "\(family) Next list is empty")
        for row in rows {
            precondition(row.completionToken.map { !$0.isEmpty } == true, "\(family) row cannot be checked off")
            precondition(row.openUri.map { $0.hasPrefix("mindwtr://open?task=") } == true, "\(family) row link")
        }
    }
    print("Native family snapshot decodes for every list in every size")
    """##
}
