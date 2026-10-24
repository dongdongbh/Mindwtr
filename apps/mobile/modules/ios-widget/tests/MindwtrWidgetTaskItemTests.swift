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

    func testUpcomingRowsAreReadOnlyAndLabelsSurviveCachedDecoding() throws {
        let row = try decode([
            "upcomingDate": "2026-03-08", "upcomingLabel": "Starts", "dueLabel": "Starts Mar 8, 2026",
        ])
        XCTAssertTrue(row.isUpcomingPreview)
        XCTAssertNil(row.completionToken)
        XCTAssertEqual(row.upcomingLabel, "Starts")
        XCTAssertEqual(try decode(["dueLabel": "Today"]).displayDueLabel, "Today")
    }

    func testUpcomingLabelsRejectMalformedDatesWithoutExpiringCachedRows() {
        let local = calendar("America/New_York")
        for date in ["2026-03-07", "2026-03-08", "2026-03-15", "2026-03-14T23:59:59-04:00", "2026-03-08T09:30"] {
            XCTAssertNotNil(MindwtrWidgetUpcomingProjection.label(date: date, prefix: "Starts", calendar: local), date)
        }
        for date in [nil, "", "invalid", "2026-02-30", "2026-02-30T12:00:00Z", "2026-03-08T24:00:00Z"] {
            XCTAssertNil(MindwtrWidgetUpcomingProjection.label(date: date, prefix: "Starts", calendar: local), date ?? "nil")
        }
    }

    func testUpcomingDatesAndLabelsFollowTimezoneWithoutShiftingDateOnlyValues() {
        let west = calendar("America/Los_Angeles")
        let east = calendar("Asia/Tokyo")
        let locale = Locale(identifier: "en_US")
        func label(_ value: String, _ calendar: Calendar) -> String? {
            MindwtrWidgetUpcomingProjection.label(date: value, prefix: "Returns", calendar: calendar, locale: locale)
        }
        XCTAssertEqual(label("2026-03-08", west), label("2026-03-08", east))
        XCTAssertNotEqual(label("2026-03-08T00:30:00Z", west), label("2026-03-08T00:30:00Z", east))
        XCTAssertTrue(label("2026-03-08", west)?.hasPrefix("Returns ") == true)
        XCTAssertTrue(label("2026-03-08", west)?.contains("2026") == true)
    }

}
