import AppIntentsTesting
import Foundation
import XCTest

final class MindwtrReminderIntentsTests: XCTestCase {
    @MainActor
    func testCreateThenUpdateTheReturnedInboxTask() async throws {
        let bundleID = "tech.dongdongbh.mindwtr.dev"
        let app = XCUIApplication(bundleIdentifier: bundleID)
        app.launch()
        let definitions = IntentDefinitions(bundleIdentifier: bundleID)
        let title = "Siri reminder test \(UUID().uuidString)"
        let initialDate = DateComponents(year: 2030, month: 2, day: 28)
        let nextDate = DateComponents(year: 2030, month: 3, day: 1)

        let creation = try await definitions.intents["MindwtrCreateReminderIntent"]
            .makeIntent(title: title, dueDate: initialDate)
            .run()
        let created: AnyAppEntity = try creation.value
        XCTAssertEqual(try created.title as String, title)
        let createdDate: DateComponents = try created.dueDate
        XCTAssertEqual(createdDate.day, 28)
        XCTAssertNil(createdDate.hour)

        let updateDefinition = definitions.intents["MindwtrUpdateReminderIntent"]
        do {
            _ = try await updateDefinition.makeIntent(target: created, dueDate: nextDate, isCompleted: true).run()
            XCTFail("Changing completion together with the due date succeeded.")
        } catch {
            let matches = try await definitions.entities["MindwtrReminderEntity"].entities(matching: title)
            let unchanged = try XCTUnwrap(matches.first)
            let unchangedDate: DateComponents = try unchanged.dueDate
            XCTAssertEqual(unchanged.identifier, created.identifier)
            XCTAssertEqual(unchangedDate.day, 28)
            XCTAssertFalse(try unchanged.isCompleted as Bool)
        }

        let update = try await updateDefinition
            .makeIntent(target: created, dueDate: nextDate)
            .run()
        let updated: AnyAppEntity = try update.value
        XCTAssertEqual(updated.identifier, created.identifier)
        let updatedDate: DateComponents = try updated.dueDate
        XCTAssertEqual(updatedDate.month, 3)
        XCTAssertEqual(updatedDate.day, 1)
        XCTAssertNil(updatedDate.hour)

        app.terminate()
        app.launch()
        let deadline = ContinuousClock.now.advanced(by: .seconds(10))
        repeat {
            if let matches = try? await definitions.entities["MindwtrReminderEntity"].entities(matching: title),
               let task = matches.first {
                XCTAssertEqual(matches.count, 1)
                XCTAssertEqual(task.identifier, created.identifier)
                let persistedDate: DateComponents = try task.dueDate
                XCTAssertEqual(persistedDate.month, 3)
                XCTAssertEqual(persistedDate.day, 1)
                XCTAssertNil(persistedDate.hour)
                return
            }
            try await Task.sleep(for: .milliseconds(200))
        } while ContinuousClock.now < deadline
        XCTFail("The updated task did not resolve after restarting Mindwtr.")
    }
}
