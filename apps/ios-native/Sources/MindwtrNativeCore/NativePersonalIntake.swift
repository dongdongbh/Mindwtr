import Foundation

/// Private migration prerequisite: durable original-route callbacks, without App dispatch or Sandbox bootstrap.
public actor NativePersonalIntake {
    public enum Stage: String, Sendable, Codable { case captured, admitting, terminal }
    public enum Outcome: String, Sendable, Codable { case completed, ignored }
    public enum FinishSubmission: Sendable { case submitted, notSubmitted }
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
    /// Durable fact observed for one original finish, never authority to finish another item.
    public struct FinishSettlement: Sendable {
        public let id: String
        public let kind: NativePersonalIntakeEvent.Kind
        public let receivedAtMs: Int64
        public let sequence: Int64
        public let outcome: Outcome
        fileprivate init(item: Item, outcome: Outcome) {
            id = item.id; kind = item.kind; receivedAtMs = item.receivedAtMs
            sequence = item.sequence; self.outcome = outcome
        }
    }
    public enum ReminderCaptureDisposition: Sendable {
        case captured(Item)
        case knownTerminal
        case ambiguousFloor(Item)
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
        public let message: String
        public let releaseCheck: String
        public let operation: String
        public let outcome: String
        init() {
            message = "Native iOS personal intake capture confirmed"
            releaseCheck = "v1.3.8/ios-personal-intake"
            operation = "capture"; outcome = "confirmed"
        }
        fileprivate init(disposition: ReminderCaptureDisposition) {
            message = "Native iOS reminder capture disposition confirmed"
            releaseCheck = "v1.3.8/ios-personal-intake-disposition"
            operation = "reminder-capture"
            switch disposition {
            case .captured: outcome = "captured"
            case .knownTerminal: outcome = "knownTerminal"
            case .ambiguousFloor: outcome = "ambiguousFloor"
            }
        }
        fileprivate init(shareImported: Void) {
            message = "Native iOS share intake confirmed"
            releaseCheck = "v1.3.8/ios-share-text-url"
            operation = "share-import"; outcome = "confirmed"
        }
        fileprivate init(finish outcome: Outcome) {
            message = "Native iOS navigation finish settlement confirmed"
            releaseCheck = "v1.3.8/ios-navigation-finish-settlement"
            operation = "finish-settlement"; self.outcome = outcome.rawValue
        }
        fileprivate init(sameTreeReopen: Void) {
            message = "Native iOS personal intake reopened after container relocation"
            releaseCheck = "v1.3.8/ios-intake-same-tree-reopen"
            operation = "same-tree-reopen"; outcome = "confirmed"
        }
    }
    public typealias DiagnosticSink = @Sendable (Diagnostic) -> Void
    private let files: NativePersonalIntakeFiles
    private let owner = UUID()
    private let diagnostic: DiagnosticSink
    private var header: IntakeHeader
    private var importInFlight = false
    private var importPublicationDebt = false
    private var importAcknowledgement: IntakeImportAcknowledgement?
    private final class FinishSlot {
        enum State {
            case pending(before: IntakeFileSnapshot, header: IntakeFileSnapshot, attempt: IntakePublicationAttempt)
            case settled(IntakeFileSnapshot)
        }
        let original: Item
        let outcome: Outcome
        let root: String
        let captureFingerprint: String
        let order: IntakeFileSnapshot
        let terminalBytes: Data
        var state: State
        var diagnosticEmitted = false
        init(original: Item, outcome: Outcome, record: IntakeRecord, order: IntakeFileSnapshot,
             terminalBytes: Data, state: State) {
            self.original = original; self.outcome = outcome; root = record.root
            captureFingerprint = record.captureFingerprint; self.order = order
            self.terminalBytes = terminalBytes; self.state = state
        }
    }
    private var finishSlot: FinishSlot?
    #if DEBUG
    private var legacyReadBarrier: (@Sendable () async -> Void)?
    private var heldReminderReplayBarrier: (@Sendable () async -> Void)?
    #endif

    struct LegacyImportView: Sendable {
        let sourceGeneration: Data
        let activeCount: Int
        let importedCount: Int
        let terminal: [NativeReminderInbox.SealedExport.Terminal]
        let retiredThrough: String?
    }

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
                if existing.origin != route.descriptor { diagnostic(.init(sameTreeReopen: ())) }
            }
        } catch { files.close(); throw NativePersonalIntakeError.unavailable }
    }

    /// Existing-only cold inspection; an absent path creates no intake directories, lock or payload.
    public static func openExisting(route: NativePersonalIntakeRoute, diagnostic: @escaping DiagnosticSink) throws -> NativePersonalIntake? {
        guard try NativePersonalIntakeFiles.hasExistingRoot(route: route) else { return nil }
        return try NativePersonalIntake(existingRoute: route, diagnostic: diagnostic)
    }
    private init(existingRoute route: NativePersonalIntakeRoute, diagnostic: @escaping DiagnosticSink) throws {
        let files = try NativePersonalIntakeFiles(route: route, requireExisting: true)
        self.files = files; self.diagnostic = diagnostic
        do {
            guard let snapshot = files.headerSnapshot else { throw NativePersonalIntakeError.unavailable }
            let existing = try IntakeWire.decode(IntakeHeader.self, snapshot.bytes, limit: IntakeWire.headerLimit)
            try existing.validate(files: files); header = existing
            if existing.origin != route.descriptor { diagnostic(.init(sameTreeReopen: ())) }
        } catch { files.close(); throw NativePersonalIntakeError.unavailable }
    }
    /// A read-only stored-progress fact, never a live seal or successful original-owner acknowledgement.
    public func requiresReminderPreparation() throws -> Bool {
        guard !importInFlight, importAcknowledgement?.isPending != true else { throw NativePersonalIntakeError.legacyHeld }
        try files.check(); try header.validate(files: files)
        if header.legacy != nil { return true }
        guard try files.read(.legacyTerminals) == nil else { throw NativePersonalIntakeError.unavailable }
        return false
    }

    /// Capture quarantine only; this never certifies a previous App task or reminder handover.
    public func navigationReservationID() throws -> String? {
        try files.check(); try header.validate(files: files)
        if let claim = header.navigationReservation { return claim }
        guard header.pending == nil else { throw NativePersonalIntakeError.pendingPublication }
        guard !importInFlight, !importPublicationDebt, importAcknowledgement?.isConfirmed != false,
              header.legacy?.complete != false else { throw NativePersonalIntakeError.legacyHeld }
        return nil
    }

    /// The original writer settles any uncertain publication before joining or creating one sticky claim.
    public func reserveNavigationCapture(id: String) throws -> String {
        guard IntakeWire.uuid(id) else { throw NativePersonalIntakeError.unavailable }
        try retry()
        if let existing = header.navigationReservation { return existing }
        try ready()
        var next = header; next.navigationReservation = id
        try writeHeader(next)
        return id
    }

    /// First accepted bytes/clock win. A matching reservation is settled before any duplicate acknowledgement.
    public func capture(_ event: NativePersonalIntakeEvent) throws -> Item {
        if event.kind == .reminder {
            try event.validate(namespace: files.route.namespace)
            guard let response = event.response else { throw NativePersonalIntakeError.unavailable }
            switch try captureReminder(response) {
            case let .captured(item), let .ambiguousFloor(item): return item
            case .knownTerminal: throw NativePersonalIntakeError.legacyHeld
            }
        }
        return try captureRecord(event)
    }

    /// The App owns the private intake before the original producer envelope can be acknowledged.
    public func importShare(_ source: NativeShareMailbox.Item, from mailbox: NativeShareMailbox) async throws -> Item {
        guard files.route.namespace == source.namespace else { throw NativePersonalIntakeError.unavailable }
        let event = try NativePersonalIntakeEvent.shared(source.envelope)
        try requireNoImportWork(); try files.check(); try event.validate(namespace: files.route.namespace)
        let fingerprint = IntakeWire.digest(try IntakeWire.encode(event, limit: IntakeWire.recordLimit))
        if let pending = header.pending, pending.event.id == event.id {
            guard pending.event == event else { throw NativePersonalIntakeError.unavailable }
        }
        if let (record, _) = try readRecord(event.id) {
            guard record.kind == .share, record.captureFingerprint == fingerprint else { throw NativePersonalIntakeError.unavailable }
        }
        let accepted = try captureRecord(event)
        guard let (record, _) = try readRecord(event.id), record.kind == .share,
              record.captureFingerprint == fingerprint else { throw NativePersonalIntakeError.unavailable }
        try await mailbox.acknowledge(source)
        diagnostic(.init(shareImported: ()))
        return accepted
    }

    /// Stored facts only; a terminal has no truthful Item and the floor proves ambiguity, not completion.
    public func captureReminder(_ response: NativeReminderResponse) throws -> ReminderCaptureDisposition {
        try requireNoImportWork(); try files.check()
        let event = NativePersonalIntakeEvent.reminder(response)
        try event.validate(namespace: files.route.namespace)
        guard header.pending == nil || header.pending?.event.id == event.id else { throw NativePersonalIntakeError.pendingPublication }
        let legacy: LegacyTerminals?
        if header.legacy != nil { legacy = try readLegacyTerminals() }
        else { legacy = nil }
        let existing = try readRecord(event.id)
        if let terminal = legacy?.terminal.first(where: { $0.requestID == response.requestID }) {
            guard terminal.deliveredAtBits == response.deliveredAtBits, existing == nil, header.pending == nil else {
                throw NativePersonalIntakeError.unavailable
            }
            return try confirmReminderDisposition(.knownTerminal)
        }
        if let (record, _) = existing, record.stage == .terminal {
            guard record.kind == .reminder, record.notification == event.notificationIdentity,
                  record.captureFingerprint == IntakeWire.digest(try IntakeWire.encode(event, limit: IntakeWire.recordLimit)) else {
                throw NativePersonalIntakeError.unavailable
            }
            try verifyOrder(record)
            return try confirmReminderDisposition(.knownTerminal)
        }
        let originalActive: Bool
        if let (record, _) = existing { originalActive = record.legacySequence != nil }
        else { originalActive = false }
        let accepted = try captureRecord(event)
        if !originalActive, let floor = legacy?.retiredThrough,
           try NativeReminderInbox.deliveryForPersonalIntake(response.deliveredAtBits) <= NativeReminderInbox.deliveryForPersonalIntake(floor) {
            return try confirmReminderDisposition(.ambiguousFloor(accepted))
        }
        return try confirmReminderDisposition(.captured(accepted))
    }

    private func confirmReminderDisposition(_ disposition: ReminderCaptureDisposition) throws -> ReminderCaptureDisposition {
        if header.legacy != nil { _ = try readLegacyTerminals() }
        try files.check()
        diagnostic(.init(disposition: disposition))
        return disposition
    }

    private func captureRecord(_ event: NativePersonalIntakeEvent) throws -> Item {
        try requireNoImportWork()
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
            let (slot, _) = try readOrder(sequence)
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

    /// Generic storage admission never grants reminder authority.
    public func markAdmitting(_ item: Item) throws -> Item {
        try ready()
        let (record, snapshot, _) = try exact(item)
        guard record.kind != .reminder else { throw NativePersonalIntakeError.legacyHeld }
        return try admit(record, snapshot: snapshot)
    }

    func admitHeldReminder(_ item: Item, proof: NativeReminderInbox.HeldReplayProof) async throws -> Item {
        #if DEBUG
        await heldReminderReplayBarrier?()
        #endif
        try requireHeldReplay(proof)
        try ready()
        let (record, snapshot, _) = try exact(item)
        try requireHeldReminder(record)
        return try admit(record, snapshot: snapshot)
    }

    func heldReminderResponse(_ item: Item, proof: NativeReminderInbox.HeldReplayProof) async throws -> NativeReminderResponse {
        #if DEBUG
        await heldReminderReplayBarrier?()
        #endif
        try requireHeldReplay(proof)
        try ready()
        let (record, _, _) = try exact(item)
        try requireHeldReminder(record)
        guard record.stage == .admitting, let response = record.event?.response else { throw NativePersonalIntakeError.staleItem }
        return response
    }

    private func requireHeldReplay(_ proof: NativeReminderInbox.HeldReplayProof) throws {
        try checkNoImportWork()
        guard proof.origin == files.route.descriptor, let legacy = header.legacy,
              legacy.complete, legacy.generation == proof.generation else { throw NativePersonalIntakeError.legacyHeld }
    }

    private func requireHeldReminder(_ record: IntakeRecord) throws {
        guard record.kind == .reminder, let notification = record.notification else { throw NativePersonalIntakeError.staleItem }
        let terminals = try readLegacyTerminals()
        if record.legacySequence == nil, let floor = terminals.retiredThrough,
           try NativeReminderInbox.deliveryForPersonalIntake(notification.deliveredAtBits) <= NativeReminderInbox.deliveryForPersonalIntake(floor) {
            throw NativePersonalIntakeError.ambiguousReminderFloor
        }
    }

    private func admit(_ record: IntakeRecord, snapshot: IntakeFileSnapshot) throws -> Item {
        guard record.stage == .captured || record.stage == .admitting else { throw NativePersonalIntakeError.staleItem }
        if record.stage == .admitting { return self.item(record, snapshot: snapshot) }
        var next = record; next.stage = .admitting; next.revision = 1
        let written = try files.publish(IntakeWire.encode(next, limit: IntakeWire.recordLimit),
            to: .record(record.id), before: snapshot, exclusive: false)
        files.clearHotArtifacts(); return self.item(next, snapshot: written)
    }

    /// Matching retained intent stays submitted even when storage is unhealthy: debt, never a receipt.
    /// notSubmitted applies only to this call, never historical nonpublication or permission to resubmit.
    public func submitFinish(_ item: Item, outcome: Outcome) -> FinishSubmission {
        if let slot = finishSlot, matchesFinish(item, outcome: outcome, slot: slot) { return .submitted }
        do {
            try finish(item, outcome: outcome)
            return .submitted
        } catch {
            if let slot = finishSlot, matchesFinish(item, outcome: outcome, slot: slot) { return .submitted }
            return .notSubmitted
        }
    }

    /// The dispatcher must first possess its actual domain receipt. This primitive never calls Core.
    public func finish(_ item: Item, outcome: Outcome) throws {
        try ready()
        if let slot = finishSlot, case .pending = slot.state { throw NativePersonalIntakeError.pendingPublication }
        let (record, snapshot, orderSnapshot) = try exact(item)
        guard record.kind != .reminder else { throw NativePersonalIntakeError.legacyHeld }
        try finishAdmitting(item, outcome: outcome, record: record, snapshot: snapshot, orderSnapshot: orderSnapshot)
    }

    func finishHeldReminder(_ item: Item, outcome: Outcome, proof: NativeReminderInbox.HeldReplayProof) async throws -> FinishSettlement {
        #if DEBUG
        await heldReminderReplayBarrier?()
        #endif
        try requireHeldReplay(proof)
        guard item.kind == .reminder else { throw NativePersonalIntakeError.staleItem }
        if let slot = finishSlot, matchesFinish(item, outcome: outcome, slot: slot) {
            let settlement = try settleFinish(item, outcome: outcome)
            _ = try readLegacyTerminals()
            return settlement
        }
        try ready()
        if let slot = finishSlot, case .pending = slot.state { throw NativePersonalIntakeError.pendingPublication }
        let (record, snapshot, orderSnapshot) = try exact(item)
        try requireHeldReminder(record)
        try finishAdmitting(item, outcome: outcome, record: record, snapshot: snapshot, orderSnapshot: orderSnapshot)
        return try settleFinish(item, outcome: outcome)
    }

    private func finishAdmitting(_ item: Item, outcome: Outcome, record: IntakeRecord,
                                 snapshot: IntakeFileSnapshot, orderSnapshot: IntakeFileSnapshot) throws {
        guard record.stage == .admitting else { throw NativePersonalIntakeError.staleItem }
        guard let originalHeader = files.headerSnapshot else { throw NativePersonalIntakeError.unavailable }
        var next = record; next.stage = .terminal; next.revision = 2; next.event = nil; next.outcome = outcome
        let bytes = try IntakeWire.encode(next, limit: IntakeWire.recordLimit)
        do {
            let written = try files.publish(bytes, to: .record(record.id), before: snapshot, exclusive: false)
            finishSlot = .init(original: item, outcome: outcome, record: record, order: orderSnapshot,
                               terminalBytes: bytes, state: .settled(written))
        } catch {
            if let attempt = files.attempt, attempt.target == .record(record.id), attempt.before === snapshot,
               attempt.bytes == bytes, !attempt.exclusive {
                finishSlot = .init(original: item, outcome: outcome, record: record, order: orderSnapshot,
                    terminalBytes: bytes, state: .pending(before: snapshot, header: originalHeader, attempt: attempt))
            }
            throw error
        }
        files.clearHotArtifacts()
    }

    /// Confirms only the retained exact finish; terminal-looking bytes and absent pages grant no receipt.
    public func settleFinish(_ originalAdmittingItem: Item, outcome: Outcome) throws -> FinishSettlement {
        guard let slot = finishSlot, matchesFinish(originalAdmittingItem, outcome: outcome, slot: slot) else {
            throw NativePersonalIntakeError.staleItem
        }
        try checkNoImportWork()
        if case .pending = slot.state { try retry() }
        try files.check(); try header.validate(files: files)
        guard header.pending == nil else { throw NativePersonalIntakeError.pendingPublication }
        guard case let .settled(terminal) = slot.state else { throw NativePersonalIntakeError.pendingPublication }
        try files.validateSnapshot(slot.order, target: .order(slot.original.sequence))
        try files.validateSnapshot(terminal, target: .record(slot.original.id))
        let record = try IntakeWire.decode(IntakeRecord.self, terminal.bytes, limit: IntakeWire.recordLimit)
        try record.validate(header: header, namespace: files.route.namespace)
        guard record.root == slot.root, record.id == slot.original.id, record.kind == slot.original.kind,
              record.receivedAtMs == slot.original.receivedAtMs, record.sequence == slot.original.sequence,
              record.captureFingerprint == slot.captureFingerprint, record.revision == 2,
              record.stage == .terminal, record.event == nil, record.outcome == outcome,
              terminal.bytes == slot.terminalBytes else { throw NativePersonalIntakeError.unavailable }
        try files.check()
        if !slot.diagnosticEmitted {
            slot.diagnosticEmitted = true; diagnostic(.init(finish: outcome))
        }
        return .init(item: slot.original, outcome: outcome)
    }

    private func matchesFinish(_ item: Item, outcome: Outcome, slot: FinishSlot) -> Bool {
        let original = slot.original
        return item.owner == owner && original.owner == owner && item.stage == .admitting
            && item.id == original.id && item.kind == original.kind && item.receivedAtMs == original.receivedAtMs
            && item.sequence == original.sequence && item.witness == original.witness
            && item.fingerprint == original.fingerprint && outcome == slot.outcome
    }

    private func pendingFinishAttempt(_ slot: FinishSlot) throws -> IntakePublicationAttempt {
        guard case let .pending(before, originalHeader, attempt) = slot.state,
              files.attempt === attempt, attempt.target == .record(slot.original.id), !attempt.exclusive,
              attempt.before === before, before.witness == slot.original.witness,
              IntakeWire.digest(before.bytes) == slot.original.fingerprint,
              attempt.bytes == slot.terminalBytes, header.root == slot.root else {
            throw NativePersonalIntakeError.unavailable
        }
        try files.checkPendingPublication(attempt, header: originalHeader)
        try header.validate(files: files)
        try files.validateSnapshot(slot.order, target: .order(slot.original.sequence))
        return attempt
    }

    /// Retries the exact retained publication, then the one durable capture intent. No fresh sequence is allocated.
    public func retry() throws {
        try requireNoImportWork()
        let hotCaptureClear = header.pending != nil && files.attempt?.target == .header
        let pendingFinish: (FinishSlot, IntakePublicationAttempt)?
        if let slot = finishSlot, case .pending = slot.state {
            pendingFinish = (slot, try pendingFinishAttempt(slot))
        } else { pendingFinish = nil }
        let written = try files.retryPublication()
        if let (slot, attempt) = pendingFinish {
            guard let written, attempt.target == .record(slot.original.id), written.bytes == slot.terminalBytes else {
                throw NativePersonalIntakeError.unavailable
            }
            // Transfer the actual synchronized publication before generic retry clears its hot witness.
            slot.state = .settled(written)
        }
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
    public func close() {
        finishSlot = nil
        if let acknowledgement = importAcknowledgement {
            acknowledgement.invalidateBeforeClose { files.close() }
            importAcknowledgement = nil
        } else { files.close() }
    }

    /// Called only by the concrete original sealed owner; completion here is durable copied data, not admission.
    func importSealedReminders(from original: NativeReminderInbox, seal: NativeReminderInbox.Seal,
                               route: NativePersonalIntakeRoute) async throws -> IntakeImportAcknowledgement {
        guard !importInFlight, importAcknowledgement?.isPending != true else { throw NativePersonalIntakeError.legacyHeld }
        importAcknowledgement = nil // Only a terminal, one-use prior proof can reach an explicit sealed retry.
        importInFlight = true
        defer { importInFlight = false }
        guard route.descriptor == files.route.descriptor else { throw NativePersonalIntakeError.unavailable }
        #if DEBUG
        await legacyReadBarrier?()
        #endif
        let source = try await original.exportSealed(seal, route: route)
        guard source.namespace == files.route.namespace, source.active.count <= 128 else { throw NativePersonalIntakeError.unavailable }
        // An unrelated ordinary capture must settle through its original API before starting an import.
        guard files.attempt == nil || importPublicationDebt else { throw NativePersonalIntakeError.pendingPublication }
        guard header.pending == nil || header.pending?.legacy != nil else { throw NativePersonalIntakeError.pendingPublication }
        let terminals = LegacyTerminals(source: source)
        try terminals.validate(namespace: files.route.namespace)
        let bytes = try IntakeWire.encode(terminals, limit: IntakeTarget.legacyTerminals.limit)
        let digest = IntakeWire.digest(bytes)
        // Refuse source drift before settling even the retained original target attempt.
        if let legacy = header.legacy {
            guard legacy.matches(source, terminalDigest: digest) else { throw NativePersonalIntakeError.unavailable }
        }
        if let attempt = files.attempt, attempt.target == .header {
            let intended = try IntakeWire.decode(IntakeHeader.self, attempt.bytes, limit: IntakeWire.headerLimit)
            guard intended.legacy?.matches(source, terminalDigest: digest) == true else { throw NativePersonalIntakeError.unavailable }
        }
        try files.retryPublication()
        guard let current = files.headerSnapshot else { throw NativePersonalIntakeError.unavailable }
        header = try IntakeWire.decode(IntakeHeader.self, current.bytes, limit: IntakeWire.headerLimit)
        try header.validate(files: files)
        if let legacy = header.legacy {
            guard legacy.matches(source, terminalDigest: digest) else { throw NativePersonalIntakeError.unavailable }
        } else {
            guard header.pending == nil, header.nextSequence <= IntakeWire.maximumSequence - Int64(source.active.count) else {
                throw NativePersonalIntakeError.unavailable
            }
            // No adoption of previously accepted IDs, even when a weaker ordinary duplicate comparison matches.
            for entry in source.active {
                guard try readRecord(entry.item.response.requestID) == nil else { throw NativePersonalIntakeError.unavailable }
            }
            var next = header
            next.legacy = .init(generation: source.sourceGeneration, startSequence: next.nextSequence,
                                activeCount: source.active.count, imported: 0, terminalDigest: digest, terminalWitness: nil)
            importPublicationDebt = true
            try writeHeader(next)
        }
        importPublicationDebt = true
        guard var legacy = header.legacy else { throw NativePersonalIntakeError.unavailable }
        let witness = try files.ensureArtifact(bytes, target: .legacyTerminals, witness: legacy.terminalWitness)
        if legacy.terminalWitness == nil {
            legacy.terminalWitness = witness
            var next = header; next.legacy = legacy; try writeHeader(next)
        }
        files.clearHotArtifact(.legacyTerminals)
        var artifacts: [IntakeImportAcknowledgement.Artifact] = []
        for (index, entry) in source.active.enumerated() {
            guard let state = header.legacy else { throw NativePersonalIntakeError.unavailable }
            if index < state.imported { artifacts += try verifyImported(entry, index: index); continue }
            guard index == state.imported else { throw NativePersonalIntakeError.unavailable }
            let event = NativePersonalIntakeEvent.reminder(entry.item.response)
            try event.validate(namespace: files.route.namespace)
            let phase: Stage = entry.item.stage == .captured ? .captured : .admitting
            if let pending = header.pending {
                guard pending.sequence == state.startSequence + Int64(index), pending.legacy?.sequence == entry.sequence,
                      pending.legacy?.stage == phase,
                      try IntakeWire.encode(pending.event, limit: IntakeWire.recordLimit) == IntakeWire.encode(event, limit: IntakeWire.recordLimit) else {
                    throw NativePersonalIntakeError.unavailable
                }
            } else {
                guard try readRecord(event.id) == nil else { throw NativePersonalIntakeError.unavailable }
                var next = header
                next.pending = .init(sequence: next.nextSequence, event: event, recordWitness: nil, orderWitness: nil,
                                     legacy: .init(sequence: entry.sequence, stage: phase))
                next.nextSequence += 1
                try writeHeader(next)
            }
            try settleCapture()
            artifacts += try verifyImported(entry, index: index)
        }
        _ = try readLegacyTerminals()
        guard let legacy = header.legacy, legacy.complete, let terminalWitness = legacy.terminalWitness,
              header.pending == nil else { throw NativePersonalIntakeError.legacyHeld }
        artifacts.append(.init(target: .legacyTerminals, witness: terminalWitness, digest: legacy.terminalDigest))
        try files.settleImportedHotArtifacts(artifacts)
        let acknowledgement = try files.retainImportAcknowledgement(artifacts)
        importAcknowledgement = acknowledgement
        importPublicationDebt = false
        // This reservation, including close invalidation, survives the original actor's final synchronous ACK.
        return acknowledgement
    }

    func importedLegacy() throws -> LegacyImportView? {
        try ready()
        guard let legacy = header.legacy else { return nil }
        let terminal = try readLegacyTerminals()
        return .init(sourceGeneration: legacy.generation, activeCount: legacy.activeCount, importedCount: legacy.imported,
            terminal: terminal.terminal.map { .init(requestID: $0.requestID, deliveredAtBits: $0.deliveredAtBits) },
            retiredThrough: terminal.retiredThrough)
    }

    #if DEBUG
    func setLegacyReadBarrier(_ barrier: (@Sendable () async -> Void)?) { legacyReadBarrier = barrier }
    func setHeldReminderReplayBarrier(_ barrier: (@Sendable () async -> Void)?) { heldReminderReplayBarrier = barrier }
    func retainedArtifactCount() -> Int { importAcknowledgement == nil ? files.retainedArtifactCount : 0 }
    func retainedFinishProofCounts() -> (slots: Int, snapshots: Int, creationDescriptors: Int) {
        guard let slot = finishSlot else { return (0, 0, 0) }
        switch slot.state {
        case let .pending(_, _, attempt): return (1, 3, attempt.fd >= 0 ? 1 : 0) // Header aliases files.headerSnapshot.
        case .settled: return (1, 2, 0)
        }
    }
    public func setIOFaults(beforePublication: ((String) throws -> Void)? = nil, afterPublication: ((String) throws -> Void)? = nil) {
        guard importAcknowledgement?.isPending != true else { return }
        files.beforePublication = beforePublication; files.afterPublication = afterPublication
    }
    #endif

    private func ready() throws {
        try requireNoImportWork()
        try files.check(); guard header.pending == nil else { throw NativePersonalIntakeError.pendingPublication }
    }
    private func requireNoImportWork() throws {
        try checkNoImportWork()
        importAcknowledgement = nil
    }
    private func checkNoImportWork() throws {
        guard !importInFlight, !importPublicationDebt, importAcknowledgement?.isConfirmed != false,
              header.pending?.legacy == nil, header.legacy?.complete != false else { throw NativePersonalIntakeError.legacyHeld }
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
        var next = header; next.pending = nil
        if pending.legacy != nil {
            guard var legacy = next.legacy, legacy.imported < legacy.activeCount,
                  pending.sequence == legacy.startSequence + Int64(legacy.imported) else { throw NativePersonalIntakeError.unavailable }
            legacy.imported += 1; next.legacy = legacy
        }
        try writeHeader(next); files.clearHotArtifacts()
        if pending.legacy == nil { diagnostic(.init()) }
    }
    private func verifyImported(_ entry: NativeReminderInbox.SealedExport.Active, index: Int) throws -> [IntakeImportAcknowledgement.Artifact] {
        do {
            let original = NativePersonalIntakeEvent.reminder(entry.item.response)
            let fingerprint = IntakeWire.digest(try IntakeWire.encode(original, limit: IntakeWire.recordLimit))
            guard let legacy = header.legacy, let (record, snapshot) = try readRecord(entry.item.response.requestID),
                  record.sequence == legacy.startSequence + Int64(index), record.legacySequence == entry.sequence,
                  record.kind == .reminder, record.id == original.id, record.receivedAtMs == original.receivedAtMs,
                  record.captureFingerprint == fingerprint, record.notification == original.notificationIdentity,
                  entry.item.stage == .captured || record.stage != .captured,
                  record.stage != .terminal || legacy.complete else {
                throw NativePersonalIntakeError.unavailable
            }
            if let event = record.event {
                guard try IntakeWire.encode(event, limit: IntakeWire.recordLimit)
                    == IntakeWire.encode(original, limit: IntakeWire.recordLimit) else { throw NativePersonalIntakeError.unavailable }
            }
            let expected = IntakeOrder(version: 1, root: header.root, sequence: record.sequence,
                                       id: record.id, captureFingerprint: record.captureFingerprint)
            guard let order = try files.read(.order(record.sequence)),
                  order.bytes == (try IntakeWire.encode(expected, limit: IntakeWire.recordLimit)) else { throw NativePersonalIntakeError.unavailable }
            return [.init(target: .record(record.id), witness: snapshot.witness, digest: IntakeWire.digest(snapshot.bytes)),
                    .init(target: .order(record.sequence), witness: order.witness, digest: IntakeWire.digest(order.bytes))]
        } catch { files.refuse(); throw NativePersonalIntakeError.unavailable }
    }
    private func readLegacyTerminals() throws -> LegacyTerminals {
        do {
            guard let legacy = header.legacy, let witness = legacy.terminalWitness,
                  let file = try files.read(.legacyTerminals), file.witness == witness,
                  IntakeWire.digest(file.bytes) == legacy.terminalDigest else { throw NativePersonalIntakeError.unavailable }
            let value = try IntakeWire.decode(LegacyTerminals.self, file.bytes, limit: IntakeTarget.legacyTerminals.limit)
            guard value.generation == legacy.generation else { throw NativePersonalIntakeError.unavailable }
            try value.validate(namespace: files.route.namespace); return value
        } catch { files.refuse(); throw NativePersonalIntakeError.unavailable }
    }
    private func item(_ record: IntakeRecord, snapshot: IntakeFileSnapshot) -> Item {
        .init(id: record.id, kind: record.kind, receivedAtMs: record.receivedAtMs, sequence: record.sequence,
              stage: record.stage, event: record.event, outcome: record.outcome, owner: owner,
              witness: snapshot.witness, fingerprint: IntakeWire.digest(snapshot.bytes))
    }
    private func exact(_ item: Item) throws -> (IntakeRecord, IntakeFileSnapshot, IntakeFileSnapshot) {
        guard item.owner == owner, let (record, snapshot) = try readRecord(item.id),
              snapshot.witness == item.witness, IntakeWire.digest(snapshot.bytes) == item.fingerprint,
              record.sequence == item.sequence, record.stage == item.stage else { throw NativePersonalIntakeError.staleItem }
        let order = try verifyOrder(record); return (record, snapshot, order)
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
    private func readOrder(_ sequence: Int64) throws -> (IntakeOrder, IntakeFileSnapshot) {
        do {
            guard sequence >= 1, sequence < header.nextSequence, let snapshot = try files.read(.order(sequence)) else {
                throw NativePersonalIntakeError.unavailable
            }
            let slot = try IntakeWire.decode(IntakeOrder.self, snapshot.bytes, limit: IntakeWire.recordLimit)
            guard slot.version == 1, slot.root == header.root, slot.sequence == sequence, IntakeWire.uuid(slot.id),
                  slot.captureFingerprint.utf8.count == 64 else { throw NativePersonalIntakeError.unavailable }; return (slot, snapshot)
        } catch { files.refuse(); throw NativePersonalIntakeError.unavailable }
    }
    @discardableResult
    private func verifyOrder(_ record: IntakeRecord) throws -> IntakeFileSnapshot {
        let (slot, snapshot) = try readOrder(record.sequence)
        guard slot.id == record.id, slot.captureFingerprint == record.captureFingerprint else {
            files.refuse(); throw NativePersonalIntakeError.unavailable
        }
        return snapshot
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
    var legacy: LegacyImportState? = nil
    var navigationReservation: String? = nil
    func validate(files: NativePersonalIntakeFiles) throws {
        guard version == 1, files.route.matchesStoredOrigin(origin), IntakeWire.uuid(root),
              directory == (try files.rootIdentity), records == (try files.recordDirectoryIdentity),
              order == (try files.orderDirectoryIdentity), lease == (try files.leaseWitness),
              nextSequence >= 1, nextSequence <= IntakeWire.maximumSequence else {
            throw NativePersonalIntakeError.unavailable
        }
        if let navigationReservation, !IntakeWire.uuid(navigationReservation) {
            throw NativePersonalIntakeError.unavailable
        }
        if let legacy {
            guard legacy.generation.count == 32, (0...128).contains(legacy.activeCount),
                  (0...legacy.activeCount).contains(legacy.imported), legacy.startSequence >= 1,
                  legacy.startSequence <= IntakeWire.maximumSequence - Int64(legacy.activeCount) else {
                throw NativePersonalIntakeError.unavailable
            }
        }
        if let pending {
            guard nextSequence > 1, pending.sequence == nextSequence - 1,
                  pending.orderWitness == nil || pending.recordWitness != nil else { throw NativePersonalIntakeError.unavailable }
            try pending.event.validate(namespace: files.route.namespace)
            if let imported = pending.legacy {
                guard let legacy, legacy.terminalWitness != nil, legacy.imported < legacy.activeCount,
                      pending.sequence == legacy.startSequence + Int64(legacy.imported), pending.event.kind == .reminder,
                      imported.sequence >= 1, [.captured, .admitting].contains(imported.stage) else { throw NativePersonalIntakeError.unavailable }
            }
        }
        if let legacy {
            guard legacy.generation.count == 32, (0...128).contains(legacy.activeCount), (0...legacy.activeCount).contains(legacy.imported),
                  legacy.startSequence >= 1, legacy.startSequence <= IntakeWire.maximumSequence - Int64(legacy.activeCount),
                  legacy.terminalDigest.utf8.count == 64, legacy.terminalDigest.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) }),
                  legacy.terminalWitness != nil || (legacy.imported == 0 && pending == nil),
                  nextSequence >= legacy.startSequence + Int64(legacy.imported) else { throw NativePersonalIntakeError.unavailable }
            if !legacy.complete {
                guard pending == nil || pending?.legacy != nil,
                      nextSequence == legacy.startSequence + Int64(legacy.imported) + (pending == nil ? 0 : 1) else {
                    throw NativePersonalIntakeError.unavailable
                }
            }
        }
    }
}
private struct LegacyImportState: Codable {
    let generation: Data
    let startSequence: Int64
    let activeCount: Int
    var imported: Int
    let terminalDigest: String
    var terminalWitness: IntakeFileWitness?
    var complete: Bool { imported == activeCount && terminalWitness != nil }
    func matches(_ source: NativeReminderInbox.SealedExport, terminalDigest digest: String) -> Bool {
        generation == source.sourceGeneration && activeCount == source.active.count && terminalDigest == digest
    }
}
private struct LegacyCapture: Codable {
    let sequence: Int64
    let stage: NativePersonalIntake.Stage
}
private struct LegacyTerminals: Codable {
    struct Terminal: Codable { let requestID: String; let deliveredAtBits: String }
    let generation: Data
    let namespace: String
    let terminal: [Terminal]
    let retiredThrough: String?
    init(source: NativeReminderInbox.SealedExport) {
        generation = source.sourceGeneration; namespace = source.namespace
        terminal = source.terminal.map { .init(requestID: $0.requestID, deliveredAtBits: $0.deliveredAtBits) }
        retiredThrough = source.retiredThrough
    }
    func validate(namespace expected: String) throws {
        guard generation.count == 32, namespace == expected, terminal.count <= 16_384 else { throw NativePersonalIntakeError.unavailable }
        let floor = try retiredThrough.map { try NativeReminderInbox.deliveryForPersonalIntake($0) }
        var ids = Set<String>()
        for item in terminal {
            let date = try NativeReminderInbox.validateTerminalForPersonalIntake(item.requestID, deliveredAtBits: item.deliveredAtBits)
            guard ids.insert(item.requestID).inserted else { throw NativePersonalIntakeError.unavailable }
            if let floor { guard date > floor else { throw NativePersonalIntakeError.unavailable } }
        }
    }
}
private struct IntakeCaptureIntent: Codable {
    let sequence: Int64
    let event: NativePersonalIntakeEvent
    var recordWitness: IntakeFileWitness?
    var orderWitness: IntakeFileWitness?
    var legacy: LegacyCapture? = nil
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
    let legacySequence: Int64?
    var revision: Int
    var stage: NativePersonalIntake.Stage
    var event: NativePersonalIntakeEvent?
    var outcome: NativePersonalIntake.Outcome?
    init(header: IntakeHeader, pending: IntakeCaptureIntent) throws {
        version = 1; root = header.root; sequence = pending.sequence; id = pending.event.id
        kind = pending.event.kind; receivedAtMs = pending.event.receivedAtMs
        captureFingerprint = IntakeWire.digest(try IntakeWire.encode(pending.event, limit: IntakeWire.recordLimit))
        notification = pending.event.notificationIdentity; legacySequence = pending.legacy?.sequence
        stage = pending.legacy?.stage ?? .captured; revision = stage == .admitting ? 1 : 0; event = pending.event; outcome = nil
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
        if let legacySequence {
            guard kind == .reminder, legacySequence >= 1, let legacy = header.legacy,
                  sequence >= legacy.startSequence, sequence < legacy.startSequence + Int64(legacy.activeCount),
                  stage != .terminal || legacy.complete else { throw NativePersonalIntakeError.legacyHeld }
        } else {
            guard kind != .reminder || stage == .captured || header.legacy?.complete == true else { throw NativePersonalIntakeError.legacyHeld }
        }
    }
}
