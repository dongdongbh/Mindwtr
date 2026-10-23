import Foundation
import CoreFoundation

enum NativeAppleRemindersPermission: String, Sendable { case granted, denied, undetermined, unavailable }
enum NativeAppleRemindersError: Error, Equatable, Sendable { case denied, unavailable, invalid, listChanged, tooLarge, cancelled, failed }

struct NativeAppleReminderListIdentity: Sendable {
    let id: String
    let sourceID: String
    func matches(_ other: Self) -> Bool { Data(id.utf8) == Data(other.id.utf8) && Data(sourceID.utf8) == Data(other.sourceID.utf8) }
}
struct NativeAppleReminderListDTO: Sendable {
    let identity: NativeAppleReminderListIdentity
    let title: String
    let color: String?
    // Private native job JSON retains source identity; a later public list facade projects it out.
    var value: [String: Any] {
        var result: [String: Any] = ["id": identity.id, "sourceId": identity.sourceID, "title": title]
        if let color { result["color"] = color }; return result
    }
}
struct NativeAppleReminderSourceDTO: Sendable {
    let id: String?, title: String?, notes: String?
    let completed: Bool
    let creationDate: String?, startDate: String?, dueDate: String?
    var revision: String? = nil
    var providerValue: [String: Any] {
        var result = value; if let revision { result["revision"] = revision }; return result
    }
    var value: [String: Any] {
        var result: [String: Any] = ["completed": completed]
        for (name, value) in [("id", id), ("title", title), ("notes", notes),
                              ("creationDate", creationDate), ("startDate", startDate), ("dueDate", dueDate)] {
            if let value { result[name] = value }
        }
        return result
    }
}
struct NativeAppleReminderReadDTO: Sendable {
    let list: NativeAppleReminderListIdentity
    let sources: [NativeAppleReminderSourceDTO]
    var value: [String: Any] { ["listId": list.id, "sourceId": list.sourceID, "sources": sources.map(\.providerValue)] }
}

/// SDK callback input stays on its stack; only validated immutable DTOs leave it.
struct NativeAppleReminderSDKRow: Sendable {
    let list: NativeAppleReminderListIdentity
    let source: NativeAppleReminderSourceDTO
}
protocol NativeAppleRemindersSDK: AnyObject {
    func requestPermission(_ completion: @escaping (Result<Void, NativeAppleRemindersError>) -> Void)
    func lists() throws -> [NativeAppleReminderListDTO]
    func fetch(list: NativeAppleReminderListIdentity,
               receive: @escaping (() throws -> [NativeAppleReminderSDKRow]?) -> Void) throws -> Any
    func cancelFetch(_ token: Any)
    func remove(list: NativeAppleReminderListIdentity, source: NativeAppleReminderSourceDTO, cancellation: NativeAttachmentCancellation) throws
}

enum NativeAppleRemindersValidation {
    static let maximumRows = 10_000
    static func identity(_ identity: NativeAppleReminderListIdentity) throws {
        guard NativeCalendarWriteValidation.id(identity.id), NativeCalendarWriteValidation.id(identity.sourceID) else {
            throw NativeAppleRemindersError.invalid
        }
    }
    static func text(_ value: String?) throws {
        if let value, value.utf8.count > NativeCalendarJobs.maximumRequestBytes { throw NativeAppleRemindersError.tooLarge }
    }
    static func lists(_ values: [NativeAppleReminderListDTO]) throws {
        guard values.count <= maximumRows else { throw NativeAppleRemindersError.tooLarge }
        var ids = Set<Data>(), minimumBytes = 0
        for value in values {
            try identity(value.identity); try text(value.title); try text(value.color)
            guard ids.insert(Data(value.identity.id.utf8)).inserted else { throw NativeAppleRemindersError.invalid }
            minimumBytes += value.identity.id.utf8.count + value.identity.sourceID.utf8.count + value.title.utf8.count + (value.color?.utf8.count ?? 0)
            guard minimumBytes <= NativeCalendarJobs.maximumReplyBytes else { throw NativeAppleRemindersError.tooLarge }
        }
    }
    static func source(_ row: [String: Any]) throws -> NativeAppleReminderSourceDTO {
        guard Set(row.keys).isSubset(of: ["id", "title", "notes", "completed", "creationDate", "startDate", "dueDate", "revision"]),
              let completed = row["completed"] as? NSNumber, CFGetTypeID(completed) == CFBooleanGetTypeID(),
              row.allSatisfy({ $0.key == "completed" || $0.value is String }) else { throw NativeAppleRemindersError.invalid }
        return .init(id: row["id"] as? String, title: row["title"] as? String, notes: row["notes"] as? String,
            completed: completed.boolValue, creationDate: row["creationDate"] as? String, startDate: row["startDate"] as? String,
            dueDate: row["dueDate"] as? String, revision: row["revision"] as? String)
    }
    static func removal(_ source: NativeAppleReminderSourceDTO) throws {
        guard let id = source.id, NativeCalendarWriteValidation.id(id), !source.completed,
              let revision = source.revision, NativeCalendarWriteValidation.id(revision) else { throw NativeAppleRemindersError.invalid }
    }
    static func unchanged(_ actual: NativeAppleReminderSourceDTO, expected: NativeAppleReminderSourceDTO) throws {
        try removal(expected)
        guard try JSONSerialization.data(withJSONObject: actual.providerValue, options: [.sortedKeys])
            == JSONSerialization.data(withJSONObject: expected.providerValue, options: [.sortedKeys]) else { throw NativeAppleRemindersError.listChanged }
    }
    static func read(_ rows: [NativeAppleReminderSDKRow]?, list: NativeAppleReminderListIdentity) throws -> NativeAppleReminderReadDTO {
        guard let rows else { throw NativeAppleRemindersError.failed }
        guard rows.count <= maximumRows else { throw NativeAppleRemindersError.tooLarge }
        var ids = Set<Data>(), minimumBytes = list.id.utf8.count + list.sourceID.utf8.count
        for row in rows {
            guard row.list.matches(list) else { throw NativeAppleRemindersError.listChanged }
            let source = row.source
            if let id = source.id {
                guard id.utf8.count <= 1024 else { throw NativeAppleRemindersError.tooLarge }
                if !id.isEmpty, !ids.insert(Data(id.utf8)).inserted { throw NativeAppleRemindersError.invalid }
            }
            for value in [source.id, source.title, source.notes, source.creationDate, source.startDate, source.dueDate, source.revision] {
                try text(value); minimumBytes += value?.utf8.count ?? 0
            }
            // Bound raw payload before whole JSON encoding; jobs also check escapes/envelope bytes.
            guard minimumBytes <= NativeCalendarJobs.maximumReplyBytes else { throw NativeAppleRemindersError.tooLarge }
        }
        return NativeAppleReminderReadDTO(list: list, sources: rows.map(\.source))
    }
}

/// Expo's primitive fallback date bytes, not task dates or a new date policy.
enum NativeAppleRemindersDates {
    static func date(_ value: Date?) -> String? {
        guard let value else { return nil }
        let formatter = DateFormatter()
        formatter.timeZone = TimeZone(identifier: "UTC"); formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ss.SSSZZZZZ"
        return formatter.string(from: value)
    }
    static func components(_ value: DateComponents?, calendar: Calendar) -> String? {
        value.flatMap { date(calendar.date(from: $0)) }
    }
}

/// Created/used by one jobs worker. Callback gates alone may cross queues.
final class NativeAppleRemindersProvider {
    private let status: () -> NativeAppleRemindersPermission
    private let sdkFactory: () -> any NativeAppleRemindersSDK
    private var ownedSDK: (any NativeAppleRemindersSDK)?
    private let lock = NSLock()
    private var reads: [UUID: Read] = [:]

    init(status: @escaping () -> NativeAppleRemindersPermission = NativeAppleRemindersSystemSDK.permission,
         sdkFactory: @escaping () -> any NativeAppleRemindersSDK = { NativeAppleRemindersSystemSDK() }) {
        self.status = status; self.sdkFactory = sdkFactory
    }
    func permission() -> NativeAppleRemindersPermission { status() }
    private func sdk() -> any NativeAppleRemindersSDK {
        if let ownedSDK { return ownedSDK }; let value = sdkFactory(); ownedSDK = value; return value
    }
    private func requireAccess() throws {
        switch permission() {
        case .granted: return
        case .unavailable: throw NativeAppleRemindersError.unavailable
        default: throw NativeAppleRemindersError.denied
        }
    }
    func requestPermission(_ completion: @escaping (Result<NativeAppleRemindersPermission, NativeAppleRemindersError>) -> Void) {
        guard permission() != .unavailable else { completion(.failure(.unavailable)); return }
        let gate = NSLock(), readStatus = status
        var finished = false
        sdk().requestPermission { result in
            gate.lock(); guard !finished else { gate.unlock(); return }; finished = true; gate.unlock()
            completion(result.map { readStatus() })
        }
    }
    func lists() throws -> [NativeAppleReminderListDTO] {
        try requireAccess(); let values = try sdk().lists(); try NativeAppleRemindersValidation.lists(values)
        try requireAccess(); return values
    }
    func requireList(_ identity: NativeAppleReminderListIdentity) throws {
        try NativeAppleRemindersValidation.identity(identity)
        guard try lists().filter({ $0.identity.matches(identity) }).count == 1 else { throw NativeAppleRemindersError.listChanged }
    }
    func remove(list: NativeAppleReminderListIdentity, source: NativeAppleReminderSourceDTO, cancellation: NativeAttachmentCancellation) throws {
        try NativeAppleRemindersValidation.removal(source)
        _ = try NativeAppleRemindersValidation.read([.init(list: list, source: source)], list: list)
        try requireList(list)
        guard !cancellation.isCancelled else { throw NativeAppleRemindersError.cancelled }
        try sdk().remove(list: list, source: source, cancellation: cancellation)
    }
    func beginRead(list: NativeAppleReminderListIdentity, cancellation: NativeAttachmentCancellation,
                   completion: @escaping (Result<NativeAppleReminderReadDTO, NativeAppleRemindersError>) -> Void) throws -> UUID {
        try requireList(list)
        guard !cancellation.isCancelled else { throw NativeAppleRemindersError.cancelled }
        let id = UUID(), sdk = sdk()
        let read = Read(list: list, cancellation: cancellation, completion: completion,
                        cancel: { [weak sdk] token in sdk?.cancelFetch(token) }, retired: { [weak self] in
            guard let self else { return }; self.lock.lock(); self.reads.removeValue(forKey: id); self.lock.unlock()
        })
        lock.lock(); reads[id] = read; lock.unlock()
        do {
            let token = try sdk.fetch(list: list) { conversion in read.receive(conversion) }
            read.started(token)
        } catch {
            read.receive { throw error }; read.started(nil)
        }
        return id
    }
    func cancelRead(_ id: UUID, drained: @escaping () -> Void) {
        lock.lock(); let read = reads[id]; lock.unlock()
        if let read { read.cancel(drained) } else { drained() }
    }
    func whenReadDrained(_ id: UUID, _ drained: @escaping () -> Void) {
        lock.lock(); let read = reads[id]; lock.unlock()
        if let read { read.whenDrained(drained) } else { drained() }
    }

    /// Cancellation acknowledgement is independent of EventKit's suppressed callback.
    private final class Read: @unchecked Sendable {
        private let lock = NSLock(), list: NativeAppleReminderListIdentity, cancellation: NativeAttachmentCancellation
        private let cancelSDK: (Any) -> Void
        private var completion: ((Result<NativeAppleReminderReadDTO, NativeAppleRemindersError>) -> Void)?
        private var onRetired: (() -> Void)?
        private var token: Any?, startupComplete = false, taken = false, converting = false, finished = false
        private var cancelled = false, cancelIssued = false, cancelReturned = false, retired = false
        private var waiters: [() -> Void] = []
        init(list: NativeAppleReminderListIdentity, cancellation: NativeAttachmentCancellation,
             completion: @escaping (Result<NativeAppleReminderReadDTO, NativeAppleRemindersError>) -> Void,
             cancel: @escaping (Any) -> Void, retired: @escaping () -> Void) {
            self.list = list; self.cancellation = cancellation; self.completion = completion
            cancelSDK = cancel; onRetired = retired
        }
        func receive(_ conversion: () throws -> [NativeAppleReminderSDKRow]?) {
            lock.lock()
            guard !taken, !cancelled, !cancellation.isCancelled else { lock.unlock(); return }
            taken = true; converting = true; lock.unlock()
            let result: Result<NativeAppleReminderReadDTO, NativeAppleRemindersError>
            do { result = .success(try NativeAppleRemindersValidation.read(conversion(), list: list)) }
            catch { result = .failure(error as? NativeAppleRemindersError ?? .failed) }
            lock.lock()
            let callback = !cancelled && !cancellation.isCancelled ? completion : nil
            completion = nil; lock.unlock()
            // Drain also owns the admitted publication, which can enqueue worker settlement.
            callback?(result)
            lock.lock(); converting = false; finished = true; lock.unlock(); retireIfReady()
        }
        func started(_ token: Any?) {
            lock.lock(); self.token = token; startupComplete = true; let shouldCancel = cancelled || cancellation.isCancelled; lock.unlock()
            if shouldCancel { cancel {} } else { retireIfReady() }
        }
        func cancel(_ drained: @escaping () -> Void) {
            lock.lock(); guard !retired else { lock.unlock(); drained(); return }
            cancelled = true; waiters.append(drained)
            let handle = startupComplete && !cancelIssued ? token : nil
            if startupComplete && !cancelIssued { cancelIssued = true; if token == nil { cancelReturned = true } }
            lock.unlock()
            if let handle { cancelSDK(handle); lock.lock(); cancelReturned = true; lock.unlock() }
            retireIfReady()
        }
        func whenDrained(_ drained: @escaping () -> Void) {
            lock.lock(); guard !retired else { lock.unlock(); drained(); return }
            waiters.append(drained); lock.unlock(); retireIfReady()
        }
        private func retireIfReady() {
            lock.lock()
            guard !retired, startupComplete, !converting, (cancelled ? cancelReturned : finished) else { lock.unlock(); return }
            retired = true; token = nil; completion = nil
            let cleanup = onRetired; onRetired = nil; let callbacks = waiters; waiters.removeAll(); lock.unlock()
            cleanup?(); callbacks.forEach { $0() }
        }
    }
}

#if os(iOS) && canImport(EventKit)
import EventKit
import CoreGraphics

private final class NativeAppleRemindersSystemSDK: NativeAppleRemindersSDK {
    private var ownedStore: EKEventStore?
    private var store: EKEventStore {
        if let ownedStore { return ownedStore }; let value = EKEventStore(); ownedStore = value; return value
    }
    static func permission() -> NativeAppleRemindersPermission {
        let status = EKEventStore.authorizationStatus(for: .reminder)
        if #available(iOS 17.0, *) {
            switch status {
            case .fullAccess: return .granted
            case .writeOnly, .restricted, .denied: return .denied
            case .notDetermined: return .undetermined
            default: return .unavailable
            }
        }
        switch status {
        case .authorized: return .granted
        case .restricted, .denied: return .denied
        case .notDetermined: return .undetermined
        default: return .unavailable
        }
    }
    func requestPermission(_ completion: @escaping (Result<Void, NativeAppleRemindersError>) -> Void) {
        let store = store
        let callback: (Bool, Error?) -> Void = { [store] _, error in
            withExtendedLifetime(store) { completion(error == nil ? .success(()) : .failure(.failed)) }
        }
        if #available(iOS 17.0, *) { store.requestFullAccessToReminders(completion: callback) }
        else { store.requestAccess(to: .reminder, completion: callback) }
    }
    private static func identity(_ calendar: EKCalendar) throws -> NativeAppleReminderListIdentity {
        guard let source = calendar.source, calendar.allowedEntityTypes.contains(.reminder) else { throw NativeAppleRemindersError.listChanged }
        return .init(id: calendar.calendarIdentifier, sourceID: source.sourceIdentifier)
    }
    func lists() throws -> [NativeAppleReminderListDTO] {
        let calendars = store.calendars(for: .reminder)
        guard calendars.count <= NativeAppleRemindersValidation.maximumRows else { throw NativeAppleRemindersError.tooLarge }
        return try calendars.map { calendar in
            let color: String?
            if let components = calendar.cgColor?.components, components.count == 2 || components.count >= 3 {
                let rgb = components.count == 2 ? [components[0], components[0], components[0]] : Array(components.prefix(3))
                color = String(format: "#%02X%02X%02X", Int((rgb[0] * 255).rounded()), Int((rgb[1] * 255).rounded()), Int((rgb[2] * 255).rounded()))
            } else { color = nil }
            return .init(identity: try Self.identity(calendar), title: calendar.title, color: color)
        }
    }
    func fetch(list: NativeAppleReminderListIdentity,
               receive: @escaping (() throws -> [NativeAppleReminderSDKRow]?) -> Void) throws -> Any {
        let store = store
        let selected = try store.calendars(for: .reminder).filter { try Self.identity($0).matches(list) }
        guard selected.count == 1 else { throw NativeAppleRemindersError.listChanged }
        let predicate = store.predicateForReminders(in: selected)
        return store.fetchReminders(matching: predicate) { reminders in
            // This thunk is invoked synchronously only after the callback gate admits conversion.
            receive {
                guard let reminders else { return nil }
                guard reminders.count <= NativeAppleRemindersValidation.maximumRows else { throw NativeAppleRemindersError.tooLarge }
                let calendar = Calendar.current
                return try reminders.map { reminder in
                    guard let sourceList = reminder.calendar else { throw NativeAppleRemindersError.listChanged }
                    return NativeAppleReminderSDKRow(list: try Self.identity(sourceList), source: Self.source(reminder, calendar: calendar))
                }
            }
        }
    }
    private static func source(_ reminder: EKReminder, calendar: Calendar) -> NativeAppleReminderSourceDTO {
        .init(id: reminder.calendarItemIdentifier, title: reminder.title, notes: reminder.notes,
            completed: reminder.isCompleted, creationDate: NativeAppleRemindersDates.date(reminder.creationDate),
            startDate: NativeAppleRemindersDates.components(reminder.startDateComponents, calendar: calendar),
            dueDate: NativeAppleRemindersDates.components(reminder.dueDateComponents, calendar: calendar),
            revision: reminder.lastModifiedDate.map { String($0.timeIntervalSince1970.bitPattern, radix: 16) })
    }
    func remove(list: NativeAppleReminderListIdentity, source: NativeAppleReminderSourceDTO, cancellation: NativeAttachmentCancellation) throws {
        try NativeAppleRemindersValidation.removal(source)
        let store = store
        store.reset()
        guard let reminder = store.calendarItem(withIdentifier: source.id!) as? EKReminder,
              let calendar = reminder.calendar, calendar.allowsContentModifications,
              try Self.identity(calendar).matches(list) else { throw NativeAppleRemindersError.listChanged }
        try NativeAppleRemindersValidation.unchanged(Self.source(reminder, calendar: .current), expected: source)
        guard Self.permission() == .granted else { throw NativeAppleRemindersError.denied }
        guard !cancellation.isCancelled else { throw NativeAppleRemindersError.cancelled }
        // EventKit has no compare-and-delete; never retry an uncertain commit.
        try store.remove(reminder, commit: true)
    }
    func cancelFetch(_ token: Any) { store.cancelFetchRequest(token) }
}
#else
private final class NativeAppleRemindersSystemSDK: NativeAppleRemindersSDK {
    static func permission() -> NativeAppleRemindersPermission { .unavailable }
    func requestPermission(_ completion: @escaping (Result<Void, NativeAppleRemindersError>) -> Void) { completion(.failure(.unavailable)) }
    func lists() throws -> [NativeAppleReminderListDTO] { throw NativeAppleRemindersError.unavailable }
    func fetch(list: NativeAppleReminderListIdentity,
               receive: @escaping (() throws -> [NativeAppleReminderSDKRow]?) -> Void) throws -> Any { throw NativeAppleRemindersError.unavailable }
    func remove(list: NativeAppleReminderListIdentity, source: NativeAppleReminderSourceDTO, cancellation: NativeAttachmentCancellation) throws {
        throw NativeAppleRemindersError.unavailable
    }
    func cancelFetch(_ token: Any) {}
}
#endif

#if DEBUG && targetEnvironment(simulator)
final class NativeAppleRemindersFixtureSDK: NativeAppleRemindersSDK {
    private var removed = Set<String>()
    func requestPermission(_ completion: @escaping (Result<Void, NativeAppleRemindersError>) -> Void) { completion(.success(())) }
    func lists() throws -> [NativeAppleReminderListDTO] {
        [.init(identity: .init(id: "fixture-capture", sourceID: "fixture-account"), title: "Capture List", color: nil),
         .init(identity: .init(id: "fixture-other", sourceID: "fixture-account"), title: "Other List", color: nil)]
    }
    func fetch(list: NativeAppleReminderListIdentity, receive: @escaping (() throws -> [NativeAppleReminderSDKRow]?) -> Void) throws -> Any {
        let rows = [("fixture-first", "Literal @home /due:tomorrow", false), ("fixture-second", "Second reminder", false),
                    ("fixture-done", "Completed reminder", true), ("fixture-empty", "  ", false)]
            .filter { !removed.contains($0.0) }
            .map { id, title, completed in NativeAppleReminderSDKRow(list: list,
                source: .init(id: id, title: title, notes: "Native Reminders fixture notes", completed: completed,
                    creationDate: nil, startDate: nil, dueDate: nil, revision: "fixture-1")) }
        receive { rows }; return UUID()
    }
    func remove(list: NativeAppleReminderListIdentity, source: NativeAppleReminderSourceDTO, cancellation: NativeAttachmentCancellation) throws {
        try NativeAppleRemindersValidation.removal(source)
        guard !cancellation.isCancelled else { throw NativeAppleRemindersError.cancelled }
        removed.insert(source.id!)
    }
    func cancelFetch(_ token: Any) {}
}
#endif
