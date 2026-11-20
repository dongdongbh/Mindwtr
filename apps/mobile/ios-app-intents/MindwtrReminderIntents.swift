#if compiler(>=6.4) && canImport(MindwtrIosSiriActions)
import AppIntents
import Foundation
import GeoToolbox
import MindwtrIosSiriActions
import UniformTypeIdentifiers

@available(iOS 27.0, *)
private enum MindwtrReminderError: Error, CustomLocalizedStringResourceConvertible {
    case unavailable
    case unsupported
    case invalidTitle
    case invalidDate
    case stale
    case missing
    case incomplete
    case ambiguous
    case failed
    case unconfirmed

    var localizedStringResource: LocalizedStringResource {
        switch self {
        case .unavailable: return "Open Mindwtr to use reminders. This action requires App Lock to be off."
        case .unsupported: return "Mindwtr supports creating Inbox tasks and changing their due dates."
        case .invalidTitle: return "Enter a title for the Mindwtr task."
        case .invalidDate: return "Give Mindwtr a complete due date."
        case .stale: return "The Mindwtr task list has changed. Choose the task again."
        case .missing: return "That task is unavailable. Open Mindwtr to find it."
        case .incomplete: return "Mindwtr couldn't search all tasks. Choose the task in Mindwtr."
        case .ambiguous: return "More than one Mindwtr task matches that name. Choose the task in Mindwtr."
        case .failed: return "Mindwtr could not finish the request. Open the app and try again."
        case .unconfirmed: return "Mindwtr couldn't confirm the save. Check the task in Mindwtr before trying again."
        }
    }
}

@available(iOS 27.0, *)
private enum MindwtrReminderDate {
    private static let day: Set<Calendar.Component> = [.year, .month, .day]
    private static let clock: Set<Calendar.Component> = [.hour, .minute, .second, .nanosecond]

    static func encode(_ components: DateComponents) throws -> String {
        var calendar = components.calendar ?? Calendar(identifier: .gregorian)
        calendar.timeZone = components.timeZone ?? calendar.timeZone
        guard components.year != nil, components.month != nil, components.day != nil,
              components.isValidDate(in: calendar),
              let date = calendar.date(from: components) else {
            throw MindwtrReminderError.invalidDate
        }
        if components.hour != nil {
            return date.ISO8601Format()
        }
        guard components.minute == nil, components.second == nil, components.nanosecond == nil else {
            throw MindwtrReminderError.invalidDate
        }
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = calendar.timeZone
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd"
        let value = formatter.string(from: date)
        guard value.utf8.count == 10 else { throw MindwtrReminderError.invalidDate }
        return value
    }

    static func decode(_ value: String) -> DateComponents? {
        var calendar = Calendar(identifier: .gregorian)
        if value.utf8.count == 10 {
            calendar.timeZone = .gmt
            let formatter = DateFormatter()
            formatter.calendar = calendar
            formatter.timeZone = .gmt
            formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.dateFormat = "yyyy-MM-dd"
            guard let date = formatter.date(from: value), formatter.string(from: date) == value else { return nil }
            return calendar.dateComponents(day, from: date)
        }
        let date = try? Date(value, strategy: .iso8601)
        let fractionalDate = try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(value)
        guard let instant = date ?? fractionalDate else { return nil }
        var components = calendar.dateComponents(day.union(clock), from: instant)
        components.calendar = calendar
        components.timeZone = calendar.timeZone
        return components
    }
}

@available(iOS 27.0, *)
private struct MindwtrReminderProjection: Decodable {
    let id: String
    let title: String
    let token: String
    let dueDate: String?
}

@available(iOS 27.0, *)
private struct MindwtrReminderSnapshot: Decodable {
    let version: Int
    let generatedAt: String
    let items: [MindwtrReminderProjection]
    let omittedCount: Int

    static func load() throws -> Self {
        guard let json = try MindwtrSiriActionStore.readSnapshot() else {
            throw MindwtrReminderError.unavailable
        }
        guard let snapshot = try? JSONDecoder().decode(Self.self, from: Data(json.utf8)),
              snapshot.version == 1, snapshot.omittedCount >= 0,
              Set(snapshot.items.map(\.id)).count == snapshot.items.count,
              let generatedAt = try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(snapshot.generatedAt),
              (0...86_400).contains(Date().timeIntervalSince(generatedAt)) else {
            throw MindwtrReminderError.stale
        }
        return snapshot
    }
}

@available(iOS 27.0, *)
@AppEnum(schema: .reminders.listType)
enum MindwtrReminderListType: String {
    case standard

    static let caseDisplayRepresentations: [Self: DisplayRepresentation] = [.standard: "Standard"]
}

@available(iOS 27.0, *)
@AppEntity(schema: .reminders.list)
struct MindwtrReminderList {
    static let inboxID = "mindwtr-inbox"
    static let defaultQuery = ListQuery()

    let id = inboxID
    var name: String
    var type: MindwtrReminderListType

    init() {
        name = String(localized: "Inbox")
        type = .standard
    }

    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)") }

    struct ListQuery: EntityStringQuery {
        func entities(for identifiers: [String]) async throws -> [MindwtrReminderList] {
            identifiers.contains(inboxID) ? [MindwtrReminderList()] : []
        }

        func suggestedEntities() async throws -> [MindwtrReminderList] {
            [MindwtrReminderList()]
        }

        func entities(matching string: String) async throws -> [MindwtrReminderList] {
            let inbox = MindwtrReminderList()
            return inbox.name.localizedCaseInsensitiveCompare(string) == .orderedSame ? [inbox] : []
        }
    }
}

@available(iOS 27.0, *)
@AppEntity(schema: .reminders.section)
struct MindwtrReminderSection {
    static let defaultQuery = SectionQuery()

    let id: String
    var name: String
    var list: MindwtrReminderList

    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)") }

    struct SectionQuery: EntityStringQuery {
        func entities(for identifiers: [String]) async throws -> [MindwtrReminderSection] { [] }
        func entities(matching string: String) async throws -> [MindwtrReminderSection] { [] }
    }
}

@available(iOS 27.0, *)
@AppEnum(schema: .reminders.locationTriggerEvent)
enum MindwtrReminderLocationEvent: String {
    case arrive
    case depart

    static let caseDisplayRepresentations: [Self: DisplayRepresentation] = [
        .arrive: "Arrive",
        .depart: "Depart"
    ]
}

@available(iOS 27.0, *)
@AppEntity(schema: .reminders.locationTrigger)
struct MindwtrReminderLocation {
    static let defaultQuery = LocationQuery()

    let id: String
    var place: PlaceDescriptor
    var event: MindwtrReminderLocationEvent

    var displayRepresentation: DisplayRepresentation { "Location" }

    struct LocationQuery: EntityStringQuery {
        func entities(for identifiers: [String]) async throws -> [MindwtrReminderLocation] { [] }
        func entities(matching string: String) async throws -> [MindwtrReminderLocation] { [] }
    }
}

@available(iOS 27.0, *)
@AppEntity(schema: .reminders.reminder)
struct MindwtrReminderEntity {
    static let defaultQuery = MindwtrReminderQuery()

    let id: String
    fileprivate let token: String
    var title: String
    var note: AttributedString?
    var tags: Set<String>
    var urls: [URL]
    var dueDate: DateComponents?
    var recurrence: Calendar.RecurrenceRule?
    var isCompleted: Bool
    var isFlagged: Bool?
    var creationDate: Date?
    var completionDate: Date?
    var list: MindwtrReminderList
    var locationTrigger: MindwtrReminderLocation?

    fileprivate init(item: MindwtrReminderProjection) {
        id = item.id
        token = item.token
        title = item.title
        tags = []
        urls = []
        dueDate = item.dueDate.flatMap(MindwtrReminderDate.decode)
        isCompleted = false
        list = MindwtrReminderList()
    }

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(title)")
    }
}

@available(iOS 27.0, *)
struct MindwtrReminderQuery: EntityStringQuery {
    static var allowedExecutionTargets: ExecutionTargets { .main }

    func entities(for identifiers: [String]) async throws -> [MindwtrReminderEntity] {
        let items = try MindwtrReminderSnapshot.load().items
        let itemsByID = Dictionary(uniqueKeysWithValues: items.map { ($0.id, $0) })
        return identifiers.compactMap { itemsByID[$0] }.map(MindwtrReminderEntity.init(item:))
    }

    func entities(matching string: String) async throws -> [MindwtrReminderEntity] {
        let name = string.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return [] }
        let snapshot = try MindwtrReminderSnapshot.load()
        let matches = snapshot.items.filter { $0.title.localizedCaseInsensitiveCompare(name) == .orderedSame }
        guard matches.count <= 1 else { throw MindwtrReminderError.ambiguous }
        guard snapshot.omittedCount == 0 else { throw MindwtrReminderError.incomplete }
        return matches.map(MindwtrReminderEntity.init(item:))
    }
}

@available(iOS 27.0, *)
private enum MindwtrReminderRequests {
    static func wasSupplied<Value>(_ parameter: IntentParameter<Value>) -> Bool {
        if case .set = parameter.valueState { return true }
        return false
    }

    static func waitForAccess() async throws -> UUID {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: .seconds(8))
        repeat {
            try Task.checkCancellation()
            if let session = MindwtrSiriActionStore.allowedAccessSession { return session }
            try await Task.sleep(for: .milliseconds(200))
        } while clock.now < deadline
        throw MindwtrReminderError.unavailable
    }

    static func execute(
        operation: MindwtrSiriActionOperation,
        target: MindwtrReminderEntity? = nil,
        fields: MindwtrSiriActionFields,
        clearFields: [MindwtrSiriActionClearField] = [],
        session: UUID
    ) async throws -> MindwtrReminderEntity {
        try Task.checkCancellation()
        guard MindwtrSiriActionStore.allowedAccessSession == session else {
            throw MindwtrReminderError.unavailable
        }
        let now = Date()
        let timestamp = now.timeIntervalSince1970 * 1_000
        let request = MindwtrSiriActionRequest(
            id: UUID().uuidString,
            operation: operation,
            targetId: target?.id,
            expectedToken: target?.token,
            createdAt: timestamp,
            expiresAt: timestamp + 12_000,
            fields: fields,
            clearFields: clearFields
        )
        let store: MindwtrSiriActionStore
        do {
            store = try MindwtrSiriActionStore.appGroupStore()
            try store.enqueue(request, now: now, accessSession: session)
        } catch {
            throw MindwtrReminderError.failed
        }
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: .seconds(12))
        defer { _ = try? store.cancelUnclaimed(id: request.id, now: Date()) }
        repeat {
            try Task.checkCancellation()
            guard MindwtrSiriActionStore.allowedAccessSession == session else {
                throw MindwtrReminderError.unconfirmed
            }
            let result: MindwtrSiriActionResult?
            do {
                result = try store.result(id: request.id, now: Date())
            } catch {
                throw MindwtrReminderError.unconfirmed
            }
            if let result {
                try Task.checkCancellation()
                guard MindwtrSiriActionStore.allowedAccessSession == session else {
                    throw MindwtrReminderError.unconfirmed
                }
                return try completedEntity(result, expectedId: target?.id ?? request.id.lowercased())
            }
            try await Task.sleep(for: .milliseconds(200))
        } while clock.now < deadline
        throw MindwtrReminderError.unconfirmed
    }

    private static func completedEntity(
        _ result: MindwtrSiriActionResult,
        expectedId: String
    ) throws -> MindwtrReminderEntity {
        if result.outcome == .rejected {
            switch result.reason {
            case .stale: throw MindwtrReminderError.stale
            case .missing: throw MindwtrReminderError.missing
            case .unsupported: throw MindwtrReminderError.unsupported
            default: throw MindwtrReminderError.failed
            }
        }
        guard let task = result.task,
              let item = try? JSONDecoder().decode(MindwtrReminderProjection.self, from: Data(task.utf8)),
              item.id == expectedId, !item.title.isEmpty, !item.token.isEmpty else {
            throw MindwtrReminderError.unconfirmed
        }
        return MindwtrReminderEntity(item: item)
    }
}

@available(iOS 27.0, *)
@AppIntent(schema: .reminders.createReminder)
struct MindwtrCreateReminderIntent {
    static let title: LocalizedStringResource = "Create Mindwtr Reminder"
    static let description = IntentDescription("Creates a task in the Mindwtr Inbox with an optional due date.")
    static var supportedModes: IntentModes { .foreground }
    static var authenticationPolicy: IntentAuthenticationPolicy { .requiresLocalDeviceAuthentication }
    static var allowedExecutionTargets: ExecutionTargets { .main }

    var title: String
    var list: MindwtrReminderList?
    var note: AttributedString?
    var isFlagged: Bool?
    @Parameter(default: [], supportedContentTypes: [.image])
    var images: [IntentFile]
    @Parameter(default: [])
    var tags: Set<String>
    @Parameter(default: [])
    var urls: [URL]
    var dueDate: DateComponents?
    var recurrence: Calendar.RecurrenceRule?
    var locationTrigger: MindwtrReminderLocation?
    var section: MindwtrReminderSection?

    func perform() async throws -> some IntentResult & ReturnsValue<MindwtrReminderEntity> & ProvidesDialog {
        guard (list == nil || list?.id == MindwtrReminderList.inboxID),
              note == nil, isFlagged == nil, images.isEmpty, tags.isEmpty, urls.isEmpty,
              recurrence == nil, locationTrigger == nil, section == nil else {
            throw MindwtrReminderError.unsupported
        }
        let name = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, name.utf8.count <= 2_000 else { throw MindwtrReminderError.invalidTitle }
        let date = try dueDate.map(MindwtrReminderDate.encode)
        let session = try await MindwtrReminderRequests.waitForAccess()
        let reminder = try await MindwtrReminderRequests.execute(
            operation: .create,
            fields: MindwtrSiriActionFields(title: name, dueDate: date),
            session: session
        )
        return .result(value: reminder, dialog: "Added to the Mindwtr Inbox.")
    }
}

@available(iOS 27.0, *)
@AppIntent(schema: .reminders.updateReminder)
struct MindwtrUpdateReminderIntent {
    static let title: LocalizedStringResource = "Change Mindwtr Reminder Due Date"
    static let description = IntentDescription("Sets or clears the due date of a Mindwtr task.")
    static var supportedModes: IntentModes { .foreground }
    static var authenticationPolicy: IntentAuthenticationPolicy { .requiresLocalDeviceAuthentication }
    static var allowedExecutionTargets: ExecutionTargets { .main }

    var target: MindwtrReminderEntity
    var title: String?
    var note: AttributedString?
    var tags: Set<String>?
    var urls: [URL]?
    var dueDate: DateComponents?
    var recurrence: Calendar.RecurrenceRule?
    var isCompleted: Bool?
    var isFlagged: Bool?
    var list: MindwtrReminderList?
    var locationTrigger: MindwtrReminderLocation?

    func perform() async throws -> some IntentResult & ReturnsValue<MindwtrReminderEntity> & ProvidesDialog {
        guard case .set(let proposedDate) = $dueDate.valueState,
              !MindwtrReminderRequests.wasSupplied($title),
              !MindwtrReminderRequests.wasSupplied($note),
              !MindwtrReminderRequests.wasSupplied($tags),
              !MindwtrReminderRequests.wasSupplied($urls),
              !MindwtrReminderRequests.wasSupplied($recurrence),
              !MindwtrReminderRequests.wasSupplied($isCompleted),
              !MindwtrReminderRequests.wasSupplied($isFlagged),
              !MindwtrReminderRequests.wasSupplied($list),
              !MindwtrReminderRequests.wasSupplied($locationTrigger) else {
            throw MindwtrReminderError.unsupported
        }
        let date = try proposedDate.map(MindwtrReminderDate.encode)
        let session = try await MindwtrReminderRequests.waitForAccess()
        guard let item = try MindwtrReminderSnapshot.load().items.first(where: { $0.id == target.id }) else {
            throw MindwtrReminderError.missing
        }
        guard item.token == target.token else { throw MindwtrReminderError.stale }
        let reminder = try await MindwtrReminderRequests.execute(
            operation: .update,
            target: target,
            fields: MindwtrSiriActionFields(dueDate: date),
            clearFields: date == nil ? [.dueDate] : [],
            session: session
        )
        return .result(value: reminder, dialog: "Updated the Mindwtr task’s due date.")
    }
}
#endif
