import CoreFoundation
import CryptoKit
import Darwin
import Foundation


public actor NativeReminderInbox {
    public enum Stage: String, Sendable { case captured, admitting }
    public struct Item: Equatable, Sendable {
        public let response: NativeReminderResponse
        public let stage: Stage
    }

    /// Hot owner authority only. Neither the token nor exported equality data is a cold import receipt.
    struct Seal: Equatable, Sendable { fileprivate let identifier: UUID }
    struct SealedExport: Sendable {
        struct Active: Sendable { let sequence: Int64; let item: Item }
        struct Terminal: Sendable { let requestID: String; let deliveredAtBits: String }
        let namespace: String
        let nextSequence: Int64
        let active: [Active]
        let terminal: [Terminal]
        let retiredThrough: String?
        let sourceGeneration: Data
    }
    struct HeldReplayProof: Equatable, Sendable {
        let origin: Data
        let generation: Data
        fileprivate init(origin: Data, generation: Data) { self.origin = origin; self.generation = generation }
    }
    struct SealDiagnostic: Sendable {
        let message = "Native iOS legacy reminder owner sealed"
        let releaseCheck = "v1.3.8/ios-personal-intake-seal"
        let operation = "seal"
        let outcome = "confirmed"
    }
    struct ImportDiagnostic: Sendable {
        let message = "Native iOS sealed reminder import completed"
        let releaseCheck = "v1.3.8/ios-personal-intake-import"
        let operation = "import"
        let outcome = "confirmed"
    }

    private let files: ReminderInboxFiles
    private var sealed: (token: Seal, origin: Data, generation: Data)?
    private weak var confirmedImportDestination: NativePersonalIntake?
    private var confirmedImportGeneration: Data?
    #if DEBUG
    private var importAcknowledgementBarrier: (@Sendable () async -> Void)?
    #endif

    // Read-only grammar reuse; personal intake does not alter the legacy writer or its v1 bytes.
    public static func validateForPersonalIntake(_ response: NativeReminderResponse, namespace: String) throws {
        try ReminderInboxState.validate(response, namespace: namespace)
    }
    static func validateTerminalForPersonalIntake(_ id: String, deliveredAtBits: String) throws -> Double {
        guard ReminderInboxState.uuid(id) else { throw ReminderInboxFiles.failure }
        return try ReminderInboxState.delivery(deliveredAtBits)
    }
    static func deliveryForPersonalIntake(_ bits: String) throws -> Double { try ReminderInboxState.delivery(bits) }


    public init(selection: NativeLaunchSelection) throws {
        do { files = try ReminderInboxFiles(selection: selection) }
        catch { throw ReminderInboxFiles.failure }
    }

    /// Reacquire only an existing original source. Missing cold handover data is held, never recreated.
    public static func openExistingForHandover(selection: NativeLaunchSelection) throws -> NativeReminderInbox {
        try NativeReminderInbox(existingSelection: selection)
    }
    private init(existingSelection selection: NativeLaunchSelection) throws {
        do { files = try ReminderInboxFiles(selection: selection, requireExisting: true) }
        catch { throw ReminderInboxFiles.failure }
    }
    public enum CaptureHandoverFailure: Error, Equatable, Sendable { case refused, unavailable }
    /// After its App/domain wrapper drain, the original owner may establish a never-used empty source.
    public func prepareEmptySourceForPersonalIntake(route: NativePersonalIntakeRoute) throws {
        do {
            try files.prepareEmptySourceForPersonalIntake(route: route)
            if let sealed { _ = try exportSealed(sealed.token, route: route) }
        } catch let failure as CaptureHandoverFailure { throw failure }
        catch { throw CaptureHandoverFailure.unavailable }
    }
    /// The actual App consumer retains this same original actor through its final native acknowledgement.
    public func handoverCaptures(into destination: NativePersonalIntake, route: NativePersonalIntakeRoute) async throws {
        let alreadySealed = sealed != nil
        let token: Seal
        do { token = try sealForPersonalIntake(route: route, diagnostic: { _ in }) }
        catch { throw alreadySealed ? CaptureHandoverFailure.unavailable : CaptureHandoverFailure.refused }
        do { try await importSealed(token, into: destination, route: route, diagnostic: { _ in }) }
        catch { throw CaptureHandoverFailure.unavailable }
    }

    /// The original sealed producer alone may admit its confirmed destination's exact held reminder.
    public func admitHeldReminder(_ item: NativePersonalIntake.Item, in destination: NativePersonalIntake,
                                  route: NativePersonalIntakeRoute) async throws -> NativePersonalIntake.Item {
        let proof = try heldReplayProof(destination: destination, route: route)
        let admitted = try await destination.admitHeldReminder(item, proof: proof)
        guard try heldReplayProof(destination: destination, route: route) == proof else { throw ReminderInboxFiles.failure }
        return admitted
    }

    public func heldReminderDispatchItem(_ admitted: NativePersonalIntake.Item, in destination: NativePersonalIntake,
                                         route: NativePersonalIntakeRoute) async throws -> Item {
        let proof = try heldReplayProof(destination: destination, route: route)
        let response = try await destination.heldReminderResponse(admitted, proof: proof)
        guard try heldReplayProof(destination: destination, route: route) == proof else { throw ReminderInboxFiles.failure }
        return .init(response: response, stage: .admitting)
    }

    /// App must already hold its exact domain receipt; a repeat settles only this retained finish.
    public func finishHeldReminder(_ originalAdmittingItem: NativePersonalIntake.Item, outcome: NativePersonalIntake.Outcome,
                                   in destination: NativePersonalIntake, route: NativePersonalIntakeRoute) async throws -> NativePersonalIntake.FinishSettlement {
        let proof = try heldReplayProof(destination: destination, route: route)
        let settlement = try await destination.finishHeldReminder(originalAdmittingItem, outcome: outcome, proof: proof)
        guard try heldReplayProof(destination: destination, route: route) == proof else { throw ReminderInboxFiles.failure }
        return settlement
    }

    private func heldReplayProof(destination: NativePersonalIntake, route: NativePersonalIntakeRoute) throws -> HeldReplayProof {
        guard !Task.isCancelled, let sealed, confirmedImportDestination === destination,
              confirmedImportGeneration == sealed.generation else { throw ReminderInboxFiles.failure }
        let source = try exportSealed(sealed.token, route: route)
        return .init(origin: route.descriptor, generation: source.sourceGeneration)
    }

    public func capture(_ response: NativeReminderResponse) throws -> Item? {
        try requireUnsealed()
        try files.check()
        do { try ReminderInboxState.validate(response, namespace: files.namespace) }
        catch { throw ReminderInboxFiles.failure }
        if let record = files.state.active.first(where: { $0.response.requestID == response.requestID }) {
            guard record.response.notificationIdentifier == response.notificationIdentifier,
                  record.response.action == response.action,
                  record.response.deliveredAtBits == response.deliveredAtBits else { throw ReminderInboxFiles.failure }
            return record.item
        }
        if files.state.tombstones.contains(where: { $0.requestID == response.requestID }) { return nil }
        if let floor = files.state.retiredThrough,
           try ReminderInboxState.delivery(response.deliveredAtBits) <= ReminderInboxState.delivery(floor) { return nil }
        guard files.state.active.count < 128, files.state.nextSequence < 9_007_199_254_740_991 else {
            throw ReminderInboxFiles.failure
        }
        var next = files.state
        let record = ReminderInboxState.Record(sequence: next.nextSequence, response: response, stage: .captured)
        next.nextSequence += 1
        next.active.append(record)
        try files.publish(next)
        return record.item
    }

    public func pending() throws -> [Item] {
        try files.check()
        return files.state.active.map(\.item)
    }

    public func markAdmitting(_ requestID: String) throws -> Item {
        try requireUnsealed()
        try files.check()
        guard let index = files.state.active.firstIndex(where: { $0.response.requestID == requestID }) else {
            throw ReminderInboxFiles.failure
        }
        if files.state.active[index].stage == .admitting { return files.state.active[index].item }
        var next = files.state
        next.active[index].stage = .admitting
        try files.publish(next)
        return next.active[index].item
    }

    public func finish(_ item: Item) throws {
        try requireUnsealed()
        try files.check()
        guard item.stage == .admitting else { throw ReminderInboxFiles.failure }
        do { try ReminderInboxState.validate(item.response, namespace: files.namespace) }
        catch { throw ReminderInboxFiles.failure }
        guard let index = files.state.active.firstIndex(where: { $0.response.requestID == item.response.requestID }) else {
            if files.state.tombstones.contains(where: { $0.requestID == item.response.requestID }) { return }
            if let floor = files.state.retiredThrough,
               try ReminderInboxState.delivery(item.response.deliveredAtBits) <= ReminderInboxState.delivery(floor) { return }
            throw ReminderInboxFiles.failure
        }
        let accepted = files.state.active[index]
        guard accepted.stage == .admitting, accepted.response.requestedAtMs == item.response.requestedAtMs,
              accepted.response.notificationIdentifier == item.response.notificationIdentifier,
              accepted.response.action == item.response.action, accepted.response.deliveredAtBits == item.response.deliveredAtBits,
              Data(accepted.response.payloadJSON.utf8) == Data(item.response.payloadJSON.utf8) else { throw ReminderInboxFiles.failure }
        var next = files.state
        let response = next.active.remove(at: index).response
        let aboveFloor: Bool
        if let floor = next.retiredThrough {
            aboveFloor = try ReminderInboxState.delivery(response.deliveredAtBits) > ReminderInboxState.delivery(floor)
        } else { aboveFloor = true }
        if aboveFloor {
            next.tombstones.append(.init(requestID: response.requestID, deliveredAtBits: response.deliveredAtBits))
        }
        if next.tombstones.count > 16_384 {
            let ordered = try next.tombstones.sorted {
                try ReminderInboxState.delivery($0.deliveredAtBits) < ReminderInboxState.delivery($1.deliveredAtBits)
            }
            let floor = ordered[next.tombstones.count - 16_384 - 1].deliveredAtBits

            next.retiredThrough = floor
            next.tombstones = try next.tombstones.filter {
                try ReminderInboxState.delivery($0.deliveredAtBits) > ReminderInboxState.delivery(floor)
            }
        }
        try files.publish(next)
    }

    public func retry() throws { try requireUnsealed(); try files.retry() }
    public func close() { files.close() }

    /// The future App handoff must first join its entire original wrapper/domain tails.
    /// An uncertain original publication needs explicit retry before this operation can succeed.
    func sealForPersonalIntake(route: NativePersonalIntakeRoute,
                               diagnostic: @Sendable (SealDiagnostic) -> Void) throws -> Seal {
        let generation = try files.checkedSealGeneration(route: route)
        if let sealed {
            guard sealed.origin == route.descriptor, sealed.generation == generation else { throw ReminderInboxFiles.failure }
            return sealed.token
        }
        let token = Seal(identifier: UUID())
        sealed = (token, route.descriptor, generation)
        diagnostic(.init())
        return token
    }

    func exportSealed(_ token: Seal, route: NativePersonalIntakeRoute) throws -> SealedExport {
        guard let sealed, sealed.token == token, sealed.origin == route.descriptor else { throw ReminderInboxFiles.failure }
        // Legacy state is already bounded/validated by its existing decoder (128 active, 16,384 terminal).
        let exported = SealedExport(namespace: files.namespace, nextSequence: files.state.nextSequence,
            active: files.state.active.map { .init(sequence: $0.sequence, item: $0.item) },
            terminal: files.state.tombstones.map { .init(requestID: $0.requestID, deliveredAtBits: $0.deliveredAtBits) },
            retiredThrough: files.state.retiredThrough, sourceGeneration: sealed.generation)
        guard try files.checkedSealGeneration(route: route) == sealed.generation else { throw ReminderInboxFiles.failure }
        return exported
    }

    /// Data transfer only. The original actor owns the final acknowledgement after all target awaits.
    func importSealed(_ token: Seal, into destination: NativePersonalIntake, route: NativePersonalIntakeRoute,
                      diagnostic: @Sendable (ImportDiagnostic) -> Void) async throws {
        guard !Task.isCancelled else { throw ReminderInboxFiles.failure }
        let original = try exportSealed(token, route: route)
        let acknowledgement = try await destination.importSealedReminders(from: self, seal: token, route: route)
        #if DEBUG
        await importAcknowledgementBarrier?()
        #endif
        try acknowledgement.confirm {
            guard !Task.isCancelled else { throw ReminderInboxFiles.failure }
            let current = try exportSealed(token, route: route)
            guard current.sourceGeneration == original.sourceGeneration else { throw ReminderInboxFiles.failure }
            if confirmedImportDestination !== destination || confirmedImportGeneration != original.sourceGeneration {
                confirmedImportDestination = destination; confirmedImportGeneration = original.sourceGeneration
                diagnostic(.init())
            }
        }
    }

    private func requireUnsealed() throws {
        guard sealed == nil else { throw ReminderInboxFiles.failure }
    }

    #if DEBUG
    public func setImportAcknowledgementBarrier(_ barrier: (@Sendable () async -> Void)?) { importAcknowledgementBarrier = barrier }
    public func setIOFaults(beforePublication: (() throws -> Void)? = nil, afterPublication: (() throws -> Void)? = nil) {
        files.beforePublication = beforePublication
        files.afterPublication = afterPublication
    }
    #endif
}

private struct ReminderInboxState {
    struct Record {
        let sequence: Int64
        let response: NativeReminderResponse
        var stage: NativeReminderInbox.Stage
        var item: NativeReminderInbox.Item { .init(response: response, stage: stage) }
    }
    struct Tombstone { let requestID: String; let deliveredAtBits: String }
    var nextSequence: Int64 = 1
    var active: [Record] = []
    var tombstones: [Tombstone] = []
    var retiredThrough: String?

    static func object(_ value: Any?, fields: Set<String>) throws -> NSDictionary {
        guard let value = value as? NSDictionary, value.count == fields.count,
              Set(value.allKeys.compactMap { $0 as? String }) == fields else { throw ReminderInboxFiles.failure }
        return value
    }
    static func integer(_ value: Any?, range: ClosedRange<Int64>) throws -> Int64 {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue.isFinite, number.doubleValue.rounded() == number.doubleValue,
              number.doubleValue >= Double(range.lowerBound), number.doubleValue <= Double(range.upperBound) else {
            throw ReminderInboxFiles.failure
        }
        return number.int64Value
    }
    static func uuid(_ value: String) -> Bool { UUID(uuidString: value)?.uuidString.lowercased() == value }
    static func delivery(_ bits: String) throws -> Double {
        guard bits.utf8.count == 16, bits.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }),
              let raw = UInt64(bits, radix: 16) else { throw ReminderInboxFiles.failure }
        let date = Double(bitPattern: raw)
        let milliseconds = (date + Date.timeIntervalBetween1970AndReferenceDate) * 1_000
        guard date.isFinite, milliseconds.isFinite, abs(milliseconds) <= 8_640_000_000_000_000 else {
            throw ReminderInboxFiles.failure
        }
        return date
    }
    static func text(_ value: Any?, matching: String) -> Bool {
        (value as? String).map { Data($0.utf8) == Data(matching.utf8) } == true
    }
    static func validate(_ response: NativeReminderResponse, namespace: String) throws {
        let prefix = "mindwtr-native:\(namespace):"
        guard uuid(response.requestID), response.notificationIdentifier.hasPrefix(prefix),
              let id = Int(response.notificationIdentifier.dropFirst(prefix.count)), (1...2_147_483_647).contains(id),
              response.notificationIdentifier == prefix + String(id),
              (-8_640_000_000_000_000...8_640_000_000_000_000).contains(response.requestedAtMs),
              response.payloadJSON.utf8.count <= (response.action == .complete ? 4_096 : 65_536) else { throw ReminderInboxFiles.failure }
        _ = try delivery(response.deliveredAtBits)
        guard try NativeJSON.hasUniqueObjectKeys(response.payloadJSON),
              let payload = try NativeJSON.jsonObject(with: Data(response.payloadJSON.utf8)) as? NSDictionary else {
            throw ReminderInboxFiles.failure
        }
        switch response.action {
        case .dismiss:
            guard payload.count == 0 else { throw ReminderInboxFiles.failure }
        case .open:
            let names = Set(payload.allKeys.compactMap { $0 as? String })
            guard names.isSubset(of: ["notificationId", "actionIdentifier", "kind", "taskId", "projectId", "context"]),
                  payload.allSatisfy({ $0.key is String && $0.value is String }),
                  text(payload["notificationId"], matching: response.notificationIdentifier),
                  text(payload["actionIdentifier"], matching: "open") else { throw ReminderInboxFiles.failure }
        case .complete:
            _ = try object(payload, fields: ["requestId", "taskId"])
            guard text(payload["requestId"], matching: response.requestID), let task = payload["taskId"] as? String,
                  !task.isEmpty, task.utf16.count <= 500 else { throw ReminderInboxFiles.failure }
        case .snooze:
            _ = try object(payload, fields: ["requestId", "requestedAt", "details"])
            guard text(payload["requestId"], matching: response.requestID),
                  try integer(payload["requestedAt"], range: -8_640_000_000_000_000...8_640_000_000_000_000) == response.requestedAtMs,
                  let details = payload["details"] as? NSDictionary,
                  let title = details["title"] as? String, title.utf16.count <= 10_000,
                  details["message"] is String, details["tag"] is String,
                  let sound = details["play_sound"] as? NSNumber, CFGetTypeID(sound) == CFBooleanGetTypeID(),
                  let data = details["data"] as? NSDictionary, data.allSatisfy({ $0.key is String && $0.value is String }),
                  let owner = data["alarmKey"] as? String,
                  ["digest:morning", "digest:evening", "digest:weekly-review"].contains(owner)
                    || owner.range(of: #"\A(task|project):.+\z"#, options: .regularExpression) != nil,
                  let interval = details["snooze_interval"] as? NSNumber, CFGetTypeID(interval) != CFBooleanGetTypeID(),
                  interval.doubleValue.isFinite, interval.doubleValue > 0 else { throw ReminderInboxFiles.failure }
        }
    }

    static func decode(_ bytes: Data, namespace: String) throws -> Self {
        guard let encoded = String(data: bytes, encoding: .utf8), try NativeJSON.hasUniqueObjectKeys(encoded),
              let raw = try NativeJSON.jsonObject(with: bytes) as? NSDictionary else { throw ReminderInboxFiles.failure }
        var fields: Set<String> = ["version", "namespace", "nextSequence", "active", "tombstones"]
        if raw["retiredThrough"] != nil { fields.insert("retiredThrough") }
        _ = try object(raw, fields: fields)
        guard try integer(raw["version"], range: 1...1) == 1, text(raw["namespace"], matching: namespace),
              let active = raw["active"] as? NSArray, active.count <= 128,
              let tombstones = raw["tombstones"] as? NSArray, tombstones.count <= 16_384 else { throw ReminderInboxFiles.failure }
        var state = Self()
        state.nextSequence = try integer(raw["nextSequence"], range: 1...9_007_199_254_740_991)
        guard active.count == 0 || state.nextSequence > 1 else { throw ReminderInboxFiles.failure }
        if raw["retiredThrough"] != nil {
            guard let floor = raw["retiredThrough"] as? String else { throw ReminderInboxFiles.failure }
            _ = try delivery(floor); state.retiredThrough = floor
        }
        var ids = Set<String>(), sequences = Set<Int64>()
        for value in active {
            let raw = try object(value, fields: ["sequence", "response", "stage"])
            let sequence = try integer(raw["sequence"], range: 1...(state.nextSequence - 1))
            let response = try object(raw["response"], fields: ["requestID", "notificationIdentifier", "action", "deliveredAtBits", "requestedAtMs", "payloadJSON"])
            guard let id = response["requestID"] as? String, let identifier = response["notificationIdentifier"] as? String,
                  let actionText = response["action"] as? String, let action = NativeReminderResponse.Action(rawValue: actionText),
                  let bits = response["deliveredAtBits"] as? String, let json = response["payloadJSON"] as? String,
                  let stageText = raw["stage"] as? String, let stage = NativeReminderInbox.Stage(rawValue: stageText),
                  ids.insert(id).inserted, sequences.insert(sequence).inserted else { throw ReminderInboxFiles.failure }
            let timestamp = try integer(response["requestedAtMs"], range: -8_640_000_000_000_000...8_640_000_000_000_000)
            let item = NativeReminderResponse(requestID: id, notificationIdentifier: identifier, action: action,
                deliveredAtBits: bits, requestedAtMs: timestamp, payloadJSON: json)
            try validate(item, namespace: namespace)
            state.active.append(.init(sequence: sequence, response: item, stage: stage))
        }
        for value in tombstones {
            let raw = try object(value, fields: ["requestID", "deliveredAtBits"])
            guard let id = raw["requestID"] as? String, uuid(id), ids.insert(id).inserted,
                  let bits = raw["deliveredAtBits"] as? String else { throw ReminderInboxFiles.failure }
            let date = try delivery(bits)
            if let floor = state.retiredThrough, date <= (try delivery(floor)) { throw ReminderInboxFiles.failure }
            state.tombstones.append(.init(requestID: id, deliveredAtBits: bits))
        }
        state.active.sort { $0.sequence < $1.sequence }
        return state
    }

    func encode(namespace: String) throws -> Data {

        func quotedBound(_ text: String) -> Int {
            text.unicodeScalars.reduce(2) { size, scalar in
                size + ([8, 9, 10, 12, 13].contains(scalar.value) ? 2 : scalar.value < 32 ? 6 : scalar.value == 34 || scalar.value == 92 ? 2
                    : scalar.value == 0x2028 || scalar.value == 0x2029 ? 6 : scalar.utf8.count)
            }
        }
        let bound = active.reduce(1_024 + tombstones.count * 128) {
            $0 + 256 + quotedBound($1.response.payloadJSON) + quotedBound($1.response.notificationIdentifier)
        }
        guard bound <= ReminderInboxFiles.byteLimit else { throw ReminderInboxFiles.failure }
        var object: [String: Any] = ["version": 1, "namespace": namespace, "nextSequence": nextSequence,
            "active": active.map { record -> [String: Any] in
                let value = record.response
                return ["sequence": record.sequence, "stage": record.stage.rawValue,
                    "response": ["requestID": value.requestID, "notificationIdentifier": value.notificationIdentifier,
                        "action": value.action.rawValue, "deliveredAtBits": value.deliveredAtBits,
                        "requestedAtMs": value.requestedAtMs, "payloadJSON": value.payloadJSON]]
            },
            "tombstones": tombstones.map { ["requestID": $0.requestID, "deliveredAtBits": $0.deliveredAtBits] }]
        if let retiredThrough { object["retiredThrough"] = retiredThrough }
        let bytes = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes])
        guard bytes.count <= ReminderInboxFiles.byteLimit else { throw ReminderInboxFiles.failure }
        return bytes
    }
}


private final class ReminderInboxFiles {
    static let byteLimit = 24 * 1024 * 1024
    static var failure: HostFailure { HostFailure("Native reminder response storage is unavailable") }
    private struct Identity: Equatable {
        let device: dev_t; let inode: ino_t
        init(_ value: stat) { device = value.st_dev; inode = value.st_ino }
    }
    private struct Directory { let name: String; let fd: Int32; let identity: Identity }
    private final class File {
        let fd: Int32; let generation: stat; let bytes: Data
        init(fd: Int32, generation: stat, bytes: Data) { self.fd = fd; self.generation = generation; self.bytes = bytes }
        deinit { Darwin.close(fd) }
    }
    private final class Attempt {
        let before: File?; let bytes: Data; let state: ReminderInboxState
        var fd: Int32 = -1
        var generation: stat?
        init(before: File?, bytes: Data, state: ReminderInboxState) { self.before = before; self.bytes = bytes; self.state = state }
        func release() { if fd >= 0 { Darwin.close(fd); fd = -1 }; generation = nil }
        deinit { release() }
    }

    let namespace: String
    private let selection: NativeLaunchSelection
    private let rootPath: String
    private var directories: [Directory] = []
    private var lockFD: Int32 = -1
    private var hasLease = false
    private var lockGeneration: stat?
    private var snapshot: File?
    private var attempt: Attempt?
    private var closed = false
    private var poisoned = false
    private var initiallyAbsent = false
    private(set) var state = ReminderInboxState()
    #if DEBUG
    var beforePublication: (() throws -> Void)?
    var afterPublication: (() throws -> Void)?
    #endif

    init(selection: NativeLaunchSelection, requireExisting: Bool = false) throws {
        self.selection = selection
        let database: URL, container: URL
        switch selection {
        case let .production(owner):
            database = owner.appendingPathComponent("Documents/SQLite/mindwtr.db")
            container = owner; namespace = NativeLaunchSelection.productionNamespace
        case let .standard(databaseURL, containerURL, name), let .isolated(databaseURL, containerURL, name, _):
            database = databaseURL; container = containerURL; namespace = name
        case .rehearsal: throw Self.failure
        }
        guard NativeReminderRequest.validNamespace(namespace), database.isFileURL, container.isFileURL,
              database.absoluteString.utf8.count <= 16 * 1024, container.absoluteString.utf8.count <= 16 * 1024 else { throw Self.failure }
        rootPath = try NativeAttachmentFiles.filePath(container.absoluteString)
        let databasePath = try NativeAttachmentFiles.filePath(database.absoluteString)
        let rootParts = rootPath.split(separator: "/").map(String.init)
        let parentParts = databasePath.split(separator: "/").dropLast().map(String.init)
        guard parentParts.count >= rootParts.count,
              zip(parentParts, rootParts).allSatisfy({ Data($0.utf8) == Data($1.utf8) }) else { throw Self.failure }
        do {
            let fd = Darwin.open(rootPath, O_RDONLY | O_DIRECTORY | O_NOFOLLOW_ANY | O_CLOEXEC)
            guard fd >= 0 else { throw Self.failure }
            do { directories.append(.init(name: "", fd: fd, identity: Identity(try Self.directoryStat(fd)))) }
            catch { Darwin.close(fd); throw error }
            for name in parentParts.dropFirst(rootParts.count) { try appendDirectory(name, creating: !requireExisting) }
            try appendDirectory("NotificationResponses", creating: !requireExisting)
            lockFD = openat(try directoryFD(), ".lock", O_RDWR | (requireExisting ? 0 : O_CREAT) | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC, 0o600)
            guard lockFD >= 0 else { throw Self.failure }
            lockGeneration = try Self.fileStat(lockFD)
            guard flock(lockFD, LOCK_EX | LOCK_NB) == 0 else { throw Self.failure }
            hasLease = true
            try verifyNamespace()
            guard fsync(try directoryFD()) == 0 else { throw Self.failure }
            snapshot = try read()
            if let snapshot {
                state = try ReminderInboxState.decode(snapshot.bytes, namespace: namespace)
                try synchronize(snapshot)
            } else {
                guard !requireExisting, fsync(try directoryFD()) == 0 else { throw Self.failure }
                try verifyNamespace(); try verifyAbsent()
                initiallyAbsent = true
            }
        } catch { close(); throw Self.failure }
    }
    deinit { close() }
    func close() {
        guard !closed else { return }
        closed = true; attempt = nil; snapshot = nil
        if lockFD >= 0 {
            if hasLease { _ = flock(lockFD, LOCK_UN); hasLease = false }
            Darwin.close(lockFD); lockFD = -1
        }
        for directory in directories.reversed() { Darwin.close(directory.fd) }
        directories.removeAll()
    }

    func check() throws {
        guard !closed, !poisoned, attempt == nil else { throw Self.failure }
        do {
            try verifyNamespace()
            guard Self.matches(try read(), snapshot) else { throw Self.failure }
        } catch { poisoned = true; throw Self.failure }
    }
    func checkedSealGeneration(route: NativePersonalIntakeRoute) throws -> Data {
        try check()
        guard hasLease, let snapshot, let lockGeneration,
              try Self.sameSelection(selection, route.selection) else { throw Self.failure }
        // Fixed native equality evidence only; no serialized legacy marker or decoded IO path.
        let values = [route.fingerprint, SHA256.hash(data: snapshot.bytes).map { String(format: "%02x", $0) }.joined(),
                      Self.generationText(snapshot.generation), Self.generationText(lockGeneration)]
            + directories.map { "\($0.identity.device):\($0.identity.inode)" }
        return Data(SHA256.hash(data: Data(values.joined(separator: "|").utf8)))
    }
    func prepareEmptySourceForPersonalIntake(route: NativePersonalIntakeRoute) throws {
        try check()
        guard try Self.sameSelection(selection, route.selection) else { throw NativeReminderInbox.CaptureHandoverFailure.refused }
        guard snapshot == nil else { return }
        guard hasLease, lockGeneration != nil, initiallyAbsent,
              state.nextSequence == 1, state.active.isEmpty, state.tombstones.isEmpty,
              state.retiredThrough == nil else { throw Self.failure }
        initiallyAbsent = false
        try publish(state)
    }
    private static func sameSelection(_ lhs: NativeLaunchSelection, _ rhs: NativeLaunchSelection) throws -> Bool {
        func same(_ a: URL, _ b: URL) throws -> Bool {
            try Data(NativeAttachmentFiles.filePath(a.absoluteString).utf8) == Data(NativeAttachmentFiles.filePath(b.absoluteString).utf8)
        }
        switch (lhs, rhs) {
        case let (.production(a), .production(b)):
            return try same(a, b)
        case let (.standard(a, b, c), .standard(x, y, z)):
            return try c == z && same(a, x) && same(b, y)
        case let (.isolated(a, b, c, d), .isolated(x, y, z, w)):
            return try c == z && d == w && same(a, x) && same(b, y)
        default: return false
        }
    }
    private static func generationText(_ value: stat) -> String {
        "\(value.st_dev):\(value.st_ino):\(value.st_mode):\(value.st_nlink):\(value.st_size):\(value.st_mtimespec.tv_sec):\(value.st_mtimespec.tv_nsec):\(value.st_ctimespec.tv_sec):\(value.st_ctimespec.tv_nsec)"
    }
    func publish(_ state: ReminderInboxState) throws {
        let bytes: Data
        do { bytes = try state.encode(namespace: namespace) }
        catch { throw Self.failure }
        let pending = Attempt(before: snapshot, bytes: bytes, state: state)
        attempt = pending
        try perform(pending)
    }
    func retry() throws {
        guard !closed, !poisoned else { throw Self.failure }
        guard let pending = attempt else { try check(); return }
        let current: File?
        do { try verifyNamespace(); current = try read() }
        catch { poisoned = true; throw Self.failure }
        if Self.matches(current, pending.before) { try perform(pending); return }
        guard let current, let generation = pending.generation, pending.fd >= 0,
              current.bytes == pending.bytes, Self.sameGeneration(current.generation, generation),
              let owned = try? Self.fileStat(pending.fd), Self.sameGeneration(owned, generation) else {
            poisoned = true; throw Self.failure
        }
        do { try synchronize(current) }
        catch { throw Self.failure }
        snapshot = current; state = pending.state; attempt = nil
    }
    private func perform(_ pending: Attempt) throws {
        do {
            try verifyNamespace()
            guard Self.matches(try read(), pending.before) else { poisoned = true; throw Self.failure }
            #if DEBUG
            try beforePublication?()
            #endif

            try verifyNamespace()
            guard Self.matches(try read(), pending.before) else { poisoned = true; throw Self.failure }
            pending.release()
            do {
                try DurableFile.write(pending.bytes, to: "inbox.json", in: try directoryFD(), retainingFile: &pending.fd,
                                      preservingProtectionFrom: pending.before?.fd ?? lockFD)
            } catch {
                if pending.fd >= 0 { pending.generation = try? Self.fileStat(pending.fd) }
                throw Self.failure
            }
            pending.generation = try Self.fileStat(pending.fd)
            #if DEBUG
            try afterPublication?()
            #endif
            try verifyNamespace()
            guard let current = try read(), current.bytes == pending.bytes,
                  let generation = pending.generation, Self.sameGeneration(current.generation, generation) else {
                poisoned = true; throw Self.failure
            }
            try synchronize(current)
            snapshot = current; state = pending.state; attempt = nil
        } catch { throw Self.failure }
    }
    private func synchronize(_ file: File) throws {
        do {
            try verifyNamespace()
            guard Self.matches(try read(), file) else { poisoned = true; throw Self.failure }
            guard fsync(file.fd) == 0, fcntl(file.fd, F_FULLFSYNC) == 0, fsync(try directoryFD()) == 0 else { throw Self.failure }
            try verifyNamespace()
            guard Self.matches(try read(), file) else { poisoned = true; throw Self.failure }
        } catch { throw Self.failure }
    }
    private func appendDirectory(_ name: String, creating: Bool = true) throws {
        guard let parent = directories.last else { throw Self.failure }
        if creating {
            if mkdirat(parent.fd, name, 0o700) == 0 {
                guard fsync(parent.fd) == 0 else { throw Self.failure }
            } else if errno != EEXIST { throw Self.failure }
        }
        let fd = openat(parent.fd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw Self.failure }
        do { directories.append(.init(name: name, fd: fd, identity: Identity(try Self.directoryStat(fd)))) }
        catch { Darwin.close(fd); throw error }
    }
    private func directoryFD() throws -> Int32 {
        guard let directory = directories.last else { throw Self.failure }; return directory.fd
    }
    private func verifyNamespace() throws {
        guard !closed, !poisoned, let root = directories.first, let expectedLock = lockGeneration else { throw Self.failure }
        let fd = Darwin.open(rootPath, O_RDONLY | O_DIRECTORY | O_NOFOLLOW_ANY | O_CLOEXEC)
        guard fd >= 0 else { poisoned = true; throw Self.failure }
        defer { Darwin.close(fd) }
        do {
            guard Identity(try Self.directoryStat(fd)) == root.identity else { throw Self.failure }
            for index in directories.indices {
                let directory = directories[index]
                guard Identity(try Self.directoryStat(directory.fd)) == directory.identity else { throw Self.failure }
                if index > 0 {
                    var named = stat()
                    guard fstatat(directories[index - 1].fd, directory.name, &named, AT_SYMLINK_NOFOLLOW) == 0,
                          named.st_mode & S_IFMT == S_IFDIR, Identity(named) == directory.identity else { throw Self.failure }
                }
            }
            var named = stat()
            guard fstatat(try directoryFD(), ".lock", &named, AT_SYMLINK_NOFOLLOW) == 0,
                  Self.sameGeneration(try Self.fileStat(lockFD), expectedLock), Self.sameGeneration(named, expectedLock) else { throw Self.failure }
        } catch { poisoned = true; throw Self.failure }
    }
    private func verifyAbsent() throws {
        var named = stat()
        guard fstatat(try directoryFD(), "inbox.json", &named, AT_SYMLINK_NOFOLLOW) != 0, errno == ENOENT else { throw Self.failure }
    }
    private func read() throws -> File? {
        try verifyNamespace()
        let directory = try directoryFD()
        let fd = openat(directory, "inbox.json", O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        if fd < 0 {
            if errno == ENOENT { try verifyNamespace(); try verifyAbsent(); return nil }
            throw Self.failure
        }
        do {
            let initial = try Self.fileStat(fd)
            guard initial.st_size >= 0, initial.st_size <= Int64(Self.byteLimit) else { throw Self.failure }
            var bytes = Data(), buffer = [UInt8](repeating: 0, count: 64 * 1024)
            while true {
                let count = buffer.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress!, $0.count) }
                if count < 0 && errno == EINTR { continue }
                guard count >= 0, count <= Int(initial.st_size) - bytes.count else { throw Self.failure }
                if count == 0 { break }
                bytes.append(contentsOf: buffer.prefix(count))
            }
            var named = stat()
            guard bytes.count == Int(initial.st_size), Self.sameGeneration(initial, try Self.fileStat(fd)),
                  fstatat(directory, "inbox.json", &named, AT_SYMLINK_NOFOLLOW) == 0,
                  Self.sameGeneration(initial, named) else { throw Self.failure }
            try verifyNamespace()
            return File(fd: fd, generation: initial, bytes: bytes)
        } catch { Darwin.close(fd); throw Self.failure }
    }
    private static func directoryStat(_ fd: Int32) throws -> stat {
        var value = stat()
        guard fstat(fd, &value) == 0, value.st_mode & S_IFMT == S_IFDIR else { throw failure }; return value
    }
    private static func fileStat(_ fd: Int32) throws -> stat {
        var value = stat()
        guard fstat(fd, &value) == 0, value.st_mode & S_IFMT == S_IFREG, value.st_nlink == 1 else { throw failure }; return value
    }
    private static func sameGeneration(_ lhs: stat, _ rhs: stat) -> Bool {
        Identity(lhs) == Identity(rhs) && lhs.st_mode == rhs.st_mode && lhs.st_nlink == 1 && rhs.st_nlink == 1
            && lhs.st_size == rhs.st_size && lhs.st_mtimespec.tv_sec == rhs.st_mtimespec.tv_sec
            && lhs.st_mtimespec.tv_nsec == rhs.st_mtimespec.tv_nsec && lhs.st_ctimespec.tv_sec == rhs.st_ctimespec.tv_sec
            && lhs.st_ctimespec.tv_nsec == rhs.st_ctimespec.tv_nsec
    }
    private static func matches(_ lhs: File?, _ rhs: File?) -> Bool {
        switch (lhs, rhs) {
        case (nil, nil): return true
        case let (left?, right?): return left.bytes == right.bytes && sameGeneration(left.generation, right.generation)
        default: return false
        }
    }
}
