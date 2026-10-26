import Foundation
import XCTest
@testable import MindwtrWidgetActionStore

final class MindwtrWidgetTaskItemTests: XCTestCase {
    private func decode(_ fields: [String: Any] = [:]) throws -> MindwtrWidgetTaskItem {
        let row = ["id": "task-1", "title": "Task"].merging(fields) { _, next in next }
        return try JSONDecoder().decode(MindwtrWidgetTaskItem.self, from: JSONSerialization.data(withJSONObject: row))
    }

    func testMixedListStatusSharesTheMetadataLine() throws {
        XCTAssertEqual(try decode(["statusLabel": "Waiting", "showStatus": true,
            "contextLabel": "Project"]).detailLabel, "Waiting · Project")
        XCTAssertEqual(try decode(["statusLabel": "Waiting", "contextLabel": "Project"]).detailLabel, "Project")
        XCTAssertEqual(try decode(["statusLabel": "Waiting", "showStatus": false]).detailLabel, nil)
    }

    func testCachedRowsWithoutContextsStillDecode() throws {
        let item = try decode(["contextLabel": "Project"])
        XCTAssertNil(item.contexts)
        XCTAssertNil(item.upcomingDate)
        XCTAssertNil(item.upcomingLabel)
        XCTAssertFalse(item.isUpcomingPreview)
        XCTAssertNil(item.contextsLabel)
        XCTAssertEqual(item.detailLabel, "Project")
        XCTAssertNil(try decode().detailLabel)
    }

    func testContextsRetainTheirTokensAndProjectIdentity() throws {
        let item = try decode([
            "contexts": ["@office", "@电话", "@home"],
            "contextLabel": "Launch",
            "identityColor": "#ABCDEF",
            "dueLabel": "Today",
            "completionToken": "token-1",
        ])
        XCTAssertEqual(item.contextsLabel, "@office @电话 @home")
        XCTAssertEqual(item.detailLabel, "@office @电话 @home · Launch")
        XCTAssertEqual(item.identityColor, "#ABCDEF")
        XCTAssertEqual(item.dueLabel, "Today")
        XCTAssertEqual(item.completionToken, "token-1")
    }

    func testBlankAndNullContextsDoNotConsumeADetailLine() throws {
        for contexts in [NSNull(), [], ["", " \n "]] as [Any] {
            let item = try decode(["contexts": contexts, "contextLabel": "  Home  "])
            XCTAssertNil(item.contextsLabel)
            XCTAssertEqual(item.detailLabel, "Home")
        }
        XCTAssertEqual(try decode(["contexts": [" @calls ", "", "@errands"]]).detailLabel, "@calls @errands")
    }

    func testCompactRowsFitWithMixedContextsAndAtExactHeight() throws {
        let bare = try decode()
        let contextual = try decode(["contexts": ["@office", "@calls"]])
        let items = [bare, contextual, bare, contextual]
        func count(_ height: Double, scale: Double = 1, limit: Int = 12) -> Int {
            MindwtrCompactTaskLayout.visibleTaskCount(
                items: items, availableHeight: height,
                titleRowHeight: 16 * scale, contextRowHeight: 12 * scale,
                rowSpacing: 2, limit: limit
            )
        }
        XCTAssertEqual(count(0), 0)
        XCTAssertEqual(count(15), 0)
        XCTAssertEqual(count(16), 1)
        XCTAssertEqual(count(45), 1)
        XCTAssertEqual(count(46), 2)
        XCTAssertEqual(count(64), 3)
        XCTAssertEqual(count(64, limit: 2), 2)
        XCTAssertEqual(count(64, scale: 2), 1)
    }

    func testBareRowsRetainCompactDensityAndFamilyCaps() throws {
        let bare = try decode()
        let items = Array(repeating: bare, count: 30)
        for limit in [3, 5, 12, 24] {
            XCTAssertEqual(MindwtrCompactTaskLayout.visibleTaskCount(
                items: items, availableHeight: 1000, titleRowHeight: 16,
                contextRowHeight: 12, rowSpacing: 2, limit: limit
            ), limit)
        }
        XCTAssertEqual(MindwtrCompactTaskLayout.visibleTaskCount(
            items: items, availableHeight: 52, titleRowHeight: 16,
            contextRowHeight: 12, rowSpacing: 2, limit: 5
        ), 3)
    }

    private func calendar(_ zone: String) -> Calendar {
        var result = Calendar(identifier: .gregorian)
        result.timeZone = TimeZone(identifier: zone)!
        return result
    }

    private let days = MindwtrWidgetUpcomingDays(
        today: "Today", tomorrow: "Tomorrow", weekdays: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], dayFirst: false
    )

    private func instant(_ value: String) -> Date { ISO8601DateFormatter().date(from: value)! }

    private func label(
        _ value: String?, now: String, _ calendar: Calendar, days: MindwtrWidgetUpcomingDays? = nil,
        locale: Locale = Locale(identifier: "en_US")
    ) -> String? {
        MindwtrWidgetUpcomingProjection.label(
            date: value, prefix: "Starts", days: days ?? self.days, now: instant(now), calendar: calendar, locale: locale
        )?.replacingOccurrences(of: "\u{202F}", with: " ")
    }

    func testUpcomingRowsAreReadOnlyAndLabelsSurviveCachedDecoding() throws {
        let row = try decode([
            "upcomingDate": "2026-03-08", "upcomingLabel": "Starts", "dueLabel": "Starts Mar 8, 2026",
        ])
        XCTAssertTrue(row.isUpcomingPreview)
        XCTAssertNil(row.completionToken)
        XCTAssertEqual(row.upcomingLabel, "Starts")
        let utc = calendar("UTC")
        // A payload cached before the day words existed keeps its published label.
        XCTAssertEqual(row.relabeled(days: nil, now: instant("2026-03-07T12:00:00Z"), calendar: utc).dueLabel, "Starts Mar 8, 2026")
        XCTAssertEqual(row.relabeled(days: days, now: instant("2026-03-07T12:00:00Z"), calendar: utc).dueLabel, "Starts Tomorrow")
        XCTAssertEqual(try decode(["dueLabel": "Today"]).relabeled(days: days, now: Date()).dueLabel, "Today")
    }

    func testUpcomingLabelsRejectMalformedDatesWithoutExpiringCachedRows() {
        let local = calendar("America/New_York")
        for date in ["2026-03-07", "2026-03-08", "2026-03-15", "2026-03-14T23:59:59-04:00", "2026-03-08T09:30"] {
            XCTAssertNotNil(label(date, now: "2026-03-07T12:00:00Z", local), date)
        }
        for date in [nil, "", "invalid", "2026-02-30", "2026-02-30T12:00:00Z", "2026-03-08T24:00:00Z"] {
            XCTAssertNil(label(date, now: "2026-03-07T12:00:00Z", local), date ?? "nil")
        }
        let broken = MindwtrWidgetUpcomingDays(today: "Today", tomorrow: "Tomorrow", weekdays: ["Sun"], dayFirst: false)
        XCTAssertNil(label("2026-03-08", now: "2026-03-07T12:00:00Z", local, days: broken))
    }

    func testUpcomingLabelsFollowTheNextActionsDayRuleAndRollOverAtLocalMidnight() {
        let utc = calendar("UTC")
        // Monday 2026-10-26, as in #1455.
        let cases = [
            "2026-10-26": "Starts Today", "2026-10-27": "Starts Tomorrow", "2026-10-28": "Starts Wed",
            "2026-11-01": "Starts Sun", "2026-11-02": "Starts 11/2", "2026-10-20": "Starts 10/20",
        ]
        for (date, expected) in cases {
            XCTAssertEqual(label(date, now: "2026-10-26T12:00:00Z", utc), expected, date)
        }
        let dayFirst = MindwtrWidgetUpcomingDays(today: "Today", tomorrow: "Tomorrow", weekdays: days.weekdays, dayFirst: true)
        XCTAssertEqual(label("2026-11-02", now: "2026-10-26T12:00:00Z", utc, days: dayFirst), "Starts 2/11")
        XCTAssertEqual(label("2026-10-27", now: "2026-10-26T23:59:59Z", utc), "Starts Tomorrow")
        XCTAssertEqual(label("2026-10-27", now: "2026-10-27T00:00:00Z", utc), "Starts Today")
        // The day is the device's local day, not UTC's.
        XCTAssertEqual(label("2026-10-27", now: "2026-10-26T15:00:00Z", calendar("Asia/Tokyo")), "Starts Today")
    }

    func testTimedLabelsKeepTheLocaleTimeAndFollowTimezoneWithoutShiftingDateOnlyValues() {
        let utc = calendar("UTC")
        XCTAssertEqual(label("2026-10-27T09:30", now: "2026-10-26T12:00:00Z", utc), "Starts Tomorrow 9:30 AM")
        XCTAssertEqual(label("2026-10-27T09:30:00Z", now: "2026-10-26T12:00:00Z", utc, locale: Locale(identifier: "en_GB")),
                       "Starts Tomorrow 09:30")
        let west = calendar("America/Los_Angeles")
        let east = calendar("Asia/Tokyo")
        XCTAssertEqual(label("2026-03-08", now: "2026-03-01T12:00:00Z", west), label("2026-03-08", now: "2026-03-01T12:00:00Z", east))
        XCTAssertNotEqual(label("2026-03-08T00:30:00Z", now: "2026-03-01T12:00:00Z", west),
                          label("2026-03-08T00:30:00Z", now: "2026-03-01T12:00:00Z", east))
    }

}
