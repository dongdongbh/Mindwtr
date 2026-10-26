import Foundation

/// Private migration prerequisite: durable original-route callbacks, without App dispatch or Sandbox bootstrap.
public actor NativePersonalIntake {
    public enum Stage: String, Sendable, Codable { case captured, admitting, terminal }
    public enum Outcome: String, Sendable, Codable { case completed, ignored }
    public struct Item: Sendable {
        public let id: String
        public let kind: NativePersonalIntakeEvent.Kind
        public let receivedAtMs: Int64
        public let sequence: Int64
        public let stage: Stage
        public let event: NativePersonalIntakeEvent?
        public let outcome: Outcome?
        fileprivate let owner: UUID
        fileprivate let witness: IntakeFileWitness
        fileprivate let fingerprint: String
    }
    public struct Cursor: Sendable {
        fileprivate let owner: UUID
        fileprivate let frontier: Int64
        fileprivate let next: Int64
    }
    public struct Page: Sendable {
        public let items: [Item]
        public let scanned: Int
        public let next: Cursor?
    }
    /// Fixed fields only. Future App binding must deliver this to Diagnostics without reopening a personal host.
    public struct Diagnostic: Sendable {
        public let message = "Native iOS personal intake capture confirmed"
        public let releaseCheck = "v1.3.8/ios-personal-intake"
        public let operation = "capture"
        public let outcome = "confirmed"
    }
    public typealias DiagnosticSink = @Sendable (Diagnostic) -> Void
    private let files: NativePersonalIntakeFiles
    private let owner = UUID()
    private let diagnostic: DiagnosticSink
    private var header: IntakeHeader

    public init(route: NativePersonalIntakeRoute, diagnostic: @escaping DiagnosticSink) throws {
        let files = try NativePersonalIntakeFiles(route: route)
        self.files = files; self.diagnostic = diagnostic
        do {
            if files.created {
                let initial = IntakeHeader(version: 1, origin: route.descriptor, root: UUID().uuidString.lowercased(),
                    directory: try files.rootIdentity, records: try files.recordDirectoryIdentity,
                    order: try files.orderDirectoryIdentity, lease: try files.leaseWitness, nextSequence: 1, pending: nil)
                self.header = initial
                _ = try files.publish(IntakeWire.encode(initial, limit: IntakeWire.headerLimit), to: .header, before: nil, exclusive: true)
            } else {
                guard let snapshot = files.headerSnapshot else { throw NativePersonalIntakeError.unavailable }
                let existing = try IntakeWire.decode(IntakeHeader.self, snapshot.bytes, limit: IntakeWire.headerLimit)
                try existing.validate(files: files); self.header = existing
            }
        } catch { files.close(); throw NativePersonalIntakeError.unavailable }
    }

    /// First accepted bytes/clock win. A matching reservation is settled before any duplicate acknowledgement.
    public func capture(_ event: NativePersonalIntakeEvent) throws -> Item {
        try files.check(); try event.validate(namespace: files.route.namespace)
        guard header.pending == nil || header.pending?.event.id == event.id else { throw NativePersonalIntakeError.pendingPublication }
        if let pending = header.pending {
            guard compatible(pending.event.kind, pending.event.notificationIdentity, event) else { throw NativePersonalIntakeError.unavailable }
            try settleCapture()
        }
        if let (record, snapshot) = try readRecord(event.id) {
            guard compatible(record.kind, record.notification, event) else { throw NativePersonalIntakeError.unavailable }
            try verifyOrder(record)
            return item(record, snapshot: snapshot)
        }
        guard header.nextSequence < IntakeWire.maximumSequence else { throw NativePersonalIntakeError.unavailable }
        var next = header
        next.pending = .init(sequence: next.nextSequence, event: event, recordWitness: nil, orderWitness: nil)
        next.nextSequence += 1
        try writeHeader(next)
        try settleCapture()
        guard let (record, snapshot) = try readRecord(event.id) else { throw NativePersonalIntakeError.unavailable }
        return item(record, snapshot: snapshot)
    }

    /// A cursor bounds both the frontier and scanned slots. Empty nonfinal pages do not prove global emptiness.
    public func pendingPage(after cursor: Cursor? = nil) throws -> Page {
        try ready()
        if let cursor {
            guard cursor.owner == owner, cursor.frontier >= 1, cursor.frontier <= header.nextSequence,
                  cursor.next >= 1, cursor.next <= cursor.frontier else { throw NativePersonalIntakeError.staleItem }
        }
        let frontier = cursor?.frontier ?? header.nextSequence
        var sequence = cursor?.next ?? 1
        var items: [Item] = [], scanned = 0
        while sequence < frontier && scanned < IntakeWire.pageLimit {
            let slot = try readOrder(sequence)
            guard let (record, snapshot) = try readRecord(slot.id), record.sequence == sequence,
                  record.captureFingerprint == slot.captureFingerprint else {
                files.refuse(); throw NativePersonalIntakeError.unavailable
            }
            if record.stage != .terminal { items.append(item(record, snapshot: snapshot)) }
            scanned += 1; sequence += 1
        }
        return .init(items: items, scanned: scanned,
            next: sequence < frontier ? .init(owner: owner, frontier: frontier, next: sequence) : nil)
    }

    /// Storage admission only. All reminders remain held until a future original-producer seal exists.
    public func markAdmitting(_ item: Item) throws -> Item {
        try ready()
        let (record, snapshot) = try exact(item)
        guard record.kind != .reminder else { throw NativePersonalIntakeError.legacyHeld }
        guard record.stage == .captured || record.stage == .admitting else { throw NativePersonalIntakeError.staleItem }
        if record.stage == .admitting { return self.item(record, snapshot: snapshot) }
        var next = record; next.stage = .admitting; next.revision = 1
        let written = try files.publish(IntakeWire.encode(next, limit: IntakeWire.recordLimit),
            to: .record(record.id), before: snapshot, exclusive: false)
        files.clearHotArtifacts(); return self.item(next, snapshot: written)
    }

    /// The dispatcher must first possess its actual domain receipt. This primitive never calls Core.
    public func finish(_ item: Item, outcome: Outcome) throws {
        try ready()
        let (record, snapshot) = try exact(item)
        guard record.kind != .reminder else { throw NativePersonalIntakeError.legacyHeld }
        guard record.stage == .admitting else { throw NativePersonalIntakeError.staleItem }
        var next = record; next.stage = .terminal; next.revision = 2; next.event = nil; next.outcome = outcome
        _ = try files.publish(IntakeWire.encode(next, limit: IntakeWire.recordLimit),
            to: .record(record.id), before: snapshot, exclusive: false)
        files.clearHotArtifacts()
    }

    /// Retries the exact retained publication, then the one durable capture intent. No fresh sequence is allocated.
    public func retry() throws {
        let hotCaptureClear = header.pending != nil && files.attempt?.target == .header
        try files.retryPublication()
        guard let snapshot = files.headerSnapshot else { throw NativePersonalIntakeError.unavailable }
        let recovered = try IntakeWire.decode(IntakeHeader.self, snapshot.bytes, limit: IntakeWire.headerLimit)
        try recovered.validate(files: files); header = recovered
        if header.pending != nil { try settleCapture() }
        else {
            files.clearHotArtifacts()
            if hotCaptureClear { diagnostic(.init()) }
        }
    }
    /// Teardown only; closing never certifies capture, domain completion or legacy quiescence.
    public func close() { files.close() }

    #if DEBUG
    func retainedArtifactCount() -> Int { files.retainedArtifactCount }
    func setIOFaults(beforePublication: ((String) throws -> Void)? = nil, afterPublication: ((String) throws -> Void)? = nil) {
        files.beforePublication = beforePublication; files.afterPublication = afterPublication
    }
    #endif

    private func ready() throws {
        try files.check(); guard header.pending == nil else { throw NativePersonalIntakeError.pendingPublication }
    }
    private func compatible(_ kind: NativePersonalIntakeEvent.Kind, _ notification: IntakeNotificationIdentity?,
                            _ incoming: NativePersonalIntakeEvent) -> Bool {
        kind == incoming.kind && notification == incoming.notificationIdentity
    }
    private func writeHeader(_ next: IntakeHeader) throws {
        _ = try files.publish(IntakeWire.encode(next, limit: IntakeWire.headerLimit), to: .header,
                              before: files.headerSnapshot, exclusive: false)
        header = next
    }
    private func settleCapture() throws {
        guard var pending = header.pending else { return }
        let record = try IntakeRecord(header: header, pending: pending)
        let recordBytes = try IntakeWire.encode(record, limit: IntakeWire.recordLimit)
        let recordWitness = try files.ensureArtifact(recordBytes, target: .record(record.id), witness: pending.recordWitness)
        if pending.recordWitness == nil {
            pending.recordWitness = recordWitness
            var next = header; next.pending = pending; try writeHeader(next)
        }
        let slot = IntakeOrder(version: 1, root: header.root, sequence: pending.sequence, id: record.id,
                               captureFingerprint: record.captureFingerprint)
        let slotBytes = try IntakeWire.encode(slot, limit: IntakeWire.recordLimit)
        let orderWitness = try files.ensureArtifact(slotBytes, target: .order(pending.sequence), witness: pending.orderWitness)
        if pending.orderWitness == nil {
            pending.orderWitness = orderWitness
            var next = header; next.pending = pending; try writeHeader(next)
        }
        // Verify both exact witnessed files immediately before the header clear that authorizes ACK.
        _ = try files.ensureArtifact(recordBytes, target: .record(record.id), witness: pending.recordWitness)
        _ = try files.ensureArtifact(slotBytes, target: .order(pending.sequence), witness: pending.orderWitness)
        var next = header; next.pending = nil; try writeHeader(next); files.clearHotArtifacts()
        diagnostic(.init())
    }
    private func item(_ record: IntakeRecord, snapshot: IntakeFileSnapshot) -> Item {
        .init(id: record.id, kind: record.kind, receivedAtMs: record.receivedAtMs, sequence: record.sequence,
              stage: record.stage, event: record.event, outcome: record.outcome, owner: owner,
              witness: snapshot.witness, fingerprint: IntakeWire.digest(snapshot.bytes))
    }
    private func exact(_ item: Item) throws -> (IntakeRecord, IntakeFileSnapshot) {
        guard item.owner == owner, let (record, snapshot) = try readRecord(item.id),
              snapshot.witness == item.witness, IntakeWire.digest(snapshot.bytes) == item.fingerprint,
              record.sequence == item.sequence, record.stage == item.stage else { throw NativePersonalIntakeError.staleItem }
        try verifyOrder(record); return (record, snapshot)
    }
    private func readRecord(_ id: String) throws -> (IntakeRecord, IntakeFileSnapshot)? {
        guard IntakeWire.uuid(id) else { throw NativePersonalIntakeError.unavailable }
        do {
            guard let snapshot = try files.read(.record(id)) else { return nil }
            let record = try IntakeWire.decode(IntakeRecord.self, snapshot.bytes, limit: IntakeWire.recordLimit)
            try record.validate(header: header, namespace: files.route.namespace)
            guard record.id == id else { throw NativePersonalIntakeError.unavailable }; return (record, snapshot)
        } catch { files.refuse(); throw NativePersonalIntakeError.unavailable }
    }
    private func readOrder(_ sequence: Int64) throws -> IntakeOrder {
        do {
            guard sequence >= 1, sequence < header.nextSequence, let snapshot = try files.read(.order(sequence)) else {
                throw NativePersonalIntakeError.unavailable
            }
            let slot = try IntakeWire.decode(IntakeOrder.self, snapshot.bytes, limit: IntakeWire.recordLimit)
            guard slot.version == 1, slot.root == header.root, slot.sequence == sequence, IntakeWire.uuid(slot.id),
                  slot.captureFingerprint.utf8.count == 64 else { throw NativePersonalIntakeError.unavailable }; return slot
        } catch { files.refuse(); throw NativePersonalIntakeError.unavailable }
    }
    private func verifyOrder(_ record: IntakeRecord) throws {
        let slot = try readOrder(record.sequence)
        guard slot.id == record.id, slot.captureFingerprint == record.captureFingerprint else {
            files.refuse(); throw NativePersonalIntakeError.unavailable
        }
    }
}

private struct IntakeHeader: Codable {
    let version: Int
    let origin: Data
    let root: String
    let directory: IntakeDirectoryIdentity
    let records: IntakeDirectoryIdentity
    let order: IntakeDirectoryIdentity
    let lease: IntakeFileWitness
    var nextSequence: Int64
    var pending: IntakeCaptureIntent?
    func validate(files: NativePersonalIntakeFiles) throws {
        guard version == 1, origin == files.route.descriptor, IntakeWire.uuid(root),
              directory == (try files.rootIdentity), records == (try files.recordDirectoryIdentity),
              order == (try files.orderDirectoryIdentity), lease == (try files.leaseWitness),
              nextSequence >= 1, nextSequence <= IntakeWire.maximumSequence else {
            throw NativePersonalIntakeError.unavailable
        }
        if let pending {
            guard nextSequence > 1, pending.sequence == nextSequence - 1,
                  pending.orderWitness == nil || pending.recordWitness != nil else { throw NativePersonalIntakeError.unavailable }
            try pending.event.validate(namespace: files.route.namespace)
        }
    }
}
private struct IntakeCaptureIntent: Codable {
    let sequence: Int64
    let event: NativePersonalIntakeEvent
    var recordWitness: IntakeFileWitness?
    var orderWitness: IntakeFileWitness?
}
private struct IntakeOrder: Codable {
    let version: Int
    let root: String
    let sequence: Int64
    let id: String
    let captureFingerprint: String
}
private struct IntakeRecord: Codable {
    let version: Int
    let root: String
    let sequence: Int64
    let id: String
    let kind: NativePersonalIntakeEvent.Kind
    let receivedAtMs: Int64
    let captureFingerprint: String
    let notification: IntakeNotificationIdentity?
    var revision: Int
    var stage: NativePersonalIntake.Stage
    var event: NativePersonalIntakeEvent?
    var outcome: NativePersonalIntake.Outcome?
    init(header: IntakeHeader, pending: IntakeCaptureIntent) throws {
        version = 1; root = header.root; sequence = pending.sequence; id = pending.event.id
        kind = pending.event.kind; receivedAtMs = pending.event.receivedAtMs
        captureFingerprint = IntakeWire.digest(try IntakeWire.encode(pending.event, limit: IntakeWire.recordLimit))
        notification = pending.event.notificationIdentity; revision = 0; stage = .captured; event = pending.event; outcome = nil
    }
    func validate(header: IntakeHeader, namespace: String) throws {
        guard version == 1, root == header.root, sequence >= 1, sequence < header.nextSequence, IntakeWire.uuid(id),
              abs(Double(receivedAtMs)) <= 8_640_000_000_000_000, captureFingerprint.utf8.count == 64,
              captureFingerprint.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }),
              (kind == .reminder) == (notification != nil) else { throw NativePersonalIntakeError.unavailable }
        if stage == .terminal {
            guard revision == 2, event == nil, outcome != nil else { throw NativePersonalIntakeError.unavailable }
        } else {
            guard revision == (stage == .captured ? 0 : 1), outcome == nil, let event,
                  event.id == id, event.kind == kind, event.receivedAtMs == receivedAtMs,
                  event.notificationIdentity == notification,
                  IntakeWire.digest(try IntakeWire.encode(event, limit: IntakeWire.recordLimit)) == captureFingerprint else {
                throw NativePersonalIntakeError.unavailable
            }
            try event.validate(namespace: namespace)
        }
        // This private slice cannot create terminal reminders: producer sealing is deliberately absent.
        guard kind != .reminder || stage == .captured else { throw NativePersonalIntakeError.legacyHeld }
    }
}
