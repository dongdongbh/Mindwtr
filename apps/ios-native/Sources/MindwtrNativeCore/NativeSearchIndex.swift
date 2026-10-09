import CryptoKit
import Foundation
#if canImport(CoreSpotlight)
import CoreSpotlight
import UniformTypeIdentifiers
#endif

struct NativeSearchIndexEntry {
    let identifier: String
    let title: String
    let projectName: String?
}

@MainActor
protocol NativeSearchIndexPort: AnyObject {
    func remove(domain: String) async throws
    func add(_ items: [NativeSearchIndexEntry], domain: String) async throws
}

/// Completion reports acceptance by the OS journal, not search visibility.
@MainActor
public final class NativeSearchIndex {
    static let domain = "tech.dongdongbh.mindwtr.native.search"
    private let scope: String
    private let port: any NativeSearchIndexPort
    private let event: (String, Int) -> Void
    private var desired: NativeSearchSnapshot?
    private var epoch: UInt64 = 0
    private var running = false
    private var dirty = true
    private var acceptedFingerprint: String?
    private var acceptedCount = 0
    public private(set) var status = "pending"

    public convenience init(selection: NativeLaunchSelection, event: @escaping (String, Int) -> Void) throws {
        try self.init(selection: selection, port: SystemSearchIndexPort(), event: event)
    }

    init(selection: NativeLaunchSelection, port: any NativeSearchIndexPort, event: @escaping (String, Int) -> Void) throws {
        scope = try Self.scope(selection)
        self.port = port; self.event = event
        start()
    }

    public func replace(_ snapshot: NativeSearchSnapshot) {
        if desired?.fingerprint == snapshot.fingerprint,
           running || !dirty && acceptedFingerprint == snapshot.fingerprint { return }
        desired = snapshot; epoch &+= 1; dirty = true
        start()
    }

    public func withdraw() {
        if desired == nil, running || status == "removalQueued" { return }
        desired = nil; epoch &+= 1; dirty = true
        start()
    }

    public func retry() {
        guard !running else { return }
        epoch &+= 1; dirty = true
        start()
    }

    public static func identifier(taskID: String, selection: NativeLaunchSelection) throws -> String {
        guard !taskID.isEmpty, taskID.utf16.count <= 500 else { throw unavailable }
        return try scope(selection) + "." + encode(Data(taskID.utf8))
    }

    public func taskID(for identifier: String) -> String? {
        let prefix = scope + "."
        guard identifier.utf8.count <= prefix.utf8.count + 2_668, identifier.hasPrefix(prefix) else { return nil }
        let encoded = String(identifier.dropFirst(prefix.count))
        guard !encoded.isEmpty, encoded.utf8.allSatisfy({
            (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 95
        }) else { return nil }
        let base64 = encoded.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        guard let data = Data(base64Encoded: base64 + String(repeating: "=", count: (4 - base64.utf8.count % 4) % 4)),
              Self.encode(data) == encoded else { return nil }
        let id = String(decoding: data, as: UTF8.self)
        guard Data(id.utf8) == data, !id.isEmpty, id.utf16.count <= 500 else { return nil }
        return id
    }

    private static var unavailable: HostFailure { HostFailure("Native iOS search is unavailable") }
    private static func scope(_ selection: NativeLaunchSelection) throws -> String {
        let namespace: String
        switch selection {
        case let .standard(_, _, value):
            guard value == "tech.dongdongbh.mindwtr.native.dev" else { throw unavailable }
            namespace = value
        case let .isolated(_, _, value, identifier):
            guard value == "tech.dongdongbh.mindwtr.native-ui." + identifier.uuidString.lowercased() else { throw unavailable }
            namespace = value
        case .rehearsal: throw unavailable
        }
        return SHA256.hash(data: Data(namespace.utf8)).map { String(format: "%02x", $0) }.joined()
    }
    private static func encode(_ bytes: Data) -> String {
        bytes.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }

    private func start() {
        guard !running, dirty else { return }
        running = true
        Task { await drain() }
    }
    private func drain() async {
        defer { running = false; if dirty { start() } }
        while dirty {
            dirty = false
            let currentEpoch = epoch, snapshot = desired
            do {
                // Replacing only our domain also removes tasks absent from the new snapshot.
                try await port.remove(domain: Self.domain)
                acceptedFingerprint = nil
                let removedCount = acceptedCount; acceptedCount = 0
                guard epoch == currentEpoch else { continue }
                if let snapshot {
                    let items = snapshot.items.map {
                        NativeSearchIndexEntry(identifier: scope + "." + Self.encode(Data($0.id.utf8)),
                                               title: $0.title, projectName: $0.projectName)
                    }
                    try await port.add(items, domain: Self.domain)
                    acceptedCount = items.count
                    guard epoch == currentEpoch else { continue }
                    acceptedFingerprint = snapshot.fingerprint
                    status = "publicationQueued"; event(status, items.count)
                } else {
                    status = "removalQueued"; event(status, removedCount)
                }
            } catch {
                acceptedFingerprint = nil
                guard epoch == currentEpoch else { continue }
                status = "failed"; event(status, snapshot?.items.count ?? acceptedCount)
                // Keep desired state for an explicit Retry or fresh lifecycle request; never spin.
                return
            }
        }
    }
}

@MainActor
private final class SystemSearchIndexPort: NativeSearchIndexPort {
    #if canImport(CoreSpotlight)
    private let index = CSSearchableIndex(name: "mindwtr.native.tasks")
    func remove(domain: String) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            index.deleteSearchableItems(withDomainIdentifiers: [domain]) { error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            }
        }
    }
    func add(_ items: [NativeSearchIndexEntry], domain: String) async throws {
        let searchable = items.map { item in
            let attributes = CSSearchableItemAttributeSet(contentType: .text)
            attributes.title = item.title
            attributes.contentDescription = item.projectName
            return CSSearchableItem(uniqueIdentifier: item.identifier, domainIdentifier: domain, attributeSet: attributes)
        }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            index.indexSearchableItems(searchable) { error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            }
        }
    }
    #else
    func remove(domain: String) async throws { throw HostFailure("Native iOS search is unavailable") }
    func add(_ items: [NativeSearchIndexEntry], domain: String) async throws { throw HostFailure("Native iOS search is unavailable") }
    #endif
}
