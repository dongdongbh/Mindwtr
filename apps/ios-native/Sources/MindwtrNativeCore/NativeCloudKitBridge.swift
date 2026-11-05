import Foundation
import CloudKitAttachmentErrorClassifier

final class NativeCloudKitBridge: @unchecked Sendable {
    static var configuredContainer: String? {
        let bundle = Bundle.main
        guard bundle.bundleIdentifier == "tech.dongdongbh.mindwtr.native.dev",
              let identifier = bundle.object(forInfoDictionaryKey: "NativeCloudKitContainer") as? String,
              identifier == "iCloud.tech.dongdongbh.mindwtr.native.dev" else { return nil }
        return identifier
    }
    private let transport: NativeCloudKitTransport
    private let files: NativeAttachmentFileJobs
    private let cancellation = NativeAttachmentCancellation()
    private let selectedRecordName: String?
    private let stageLock = NSLock()
    private var selectedStage: NativeAttachmentFiles.BaselineAttachmentProof?
    private var selectedFetchStarted = false

    init(transport: NativeCloudKitTransport, files: NativeAttachmentFileJobs, selectedRecordName: String? = nil) {
        self.transport = transport; self.files = files; self.selectedRecordName = selectedRecordName
    }
    convenience init(containerIdentifier: String, files: NativeAttachmentFileJobs, selectedRecordName: String? = nil) throws {
        try self.init(transport: NativeCloudKitTransport(containerIdentifier: containerIdentifier, zoneName: "MindwtrZone"), files: files,
                      selectedRecordName: selectedRecordName)
    }

    func selectedStageProof(for uri: String) -> NativeAttachmentFiles.BaselineAttachmentProof? {
        stageLock.lock(); defer { stageLock.unlock() }
        guard let proof = selectedStage, proof.targetURI.utf8.elementsEqual(uri.utf8) else { return nil }
        return proof
    }
    func retireSelectedStage() {
        stageLock.lock(); let proof = selectedStage; stageLock.unlock()
        if let proof { try? files.retireCloudKitStage(proof) }
    }
    private func captureSelectedStage(_ proof: NativeAttachmentFiles.BaselineAttachmentProof) {
        stageLock.lock(); selectedStage = proof; stageLock.unlock()
    }
    private func admitSelectedFetch(_ request: NativeCloudKitRequest) throws {
        guard let selectedRecordName else { return }
        guard case .fetchAttachmentAsset(let name, let path) = request, name.utf8.elementsEqual(selectedRecordName.utf8),
              files.isCloudKitDownloadStage(path) else { throw HostFailure("Selected CloudKit attachment request is invalid") }
        stageLock.lock(); defer { stageLock.unlock() }
        guard !selectedFetchStarted else { throw HostFailure("Selected CloudKit attachment request is unavailable") }
        selectedFetchStarted = true
    }

    func cancel() async {
        cancellation.cancel()
        await transport.cancelOperations()
    }

    func call(_ json: String) async throws -> String {
        try cancellation.check()
        let request = try NativeCloudKitRequest(json: json)
        try admitSelectedFetch(request)
        let result: String
        switch request {
        case .accountStatus:
            result = try Self.encode(await transport.accountStatus())
        case .ensureZone:
            try await transport.ensureZone(); result = "null"
        case .fetchAllRecords(let type):
            result = try await transport.fetchAllRecords(recordType: type.rawValue)
        case .saveRecords(let type, let records):
            result = try Self.encode(await transport.saveRecords(recordType: type.rawValue, recordsJSON: records))
        case .deleteRecords(let type, let ids):
            try await transport.deleteRecords(recordType: type.rawValue, recordIDs: ids); result = "null"
        case .saveAttachmentAsset(let name, let path, let metadata):
            guard let object = try NativeJSON.jsonObject(with: Data(metadata.utf8)) as? [String: Any] else {
                throw HostFailure("CloudKit attachment metadata is invalid")
            }
            let receipt = try files.prepareCloudKitUpload(path, expectedHash: object["fileHash"] as? String,
                expectedSize: (object["size"] as? NSNumber)?.int64Value, cancellation: cancellation)
            defer { _ = try? files.retireProviderSource(receipt, requireOwner: {}) }
            try cancellation.check()
            guard let url = URL(string: receipt.sourceURI), url.isFileURL else { throw HostFailure("CloudKit source is unavailable") }
            result = try await transport.saveAttachmentAsset(recordName: name, filePath: url.path, metadataJSON: metadata)
            try files.requireProviderSource(receipt)
        case .fetchAttachmentAsset(let name, let path):
            result = try await transport.fetchAttachmentAsset(recordName: name) { [self] source, _ in
                try cancellation.check()
                let receipt = try files.copyProviderSource(source, cancellation: cancellation,
                    maximumProviderBytes: selectedRecordName == nil ? NativeAttachmentFiles.maximumProviderBytes : 8_388_608)
                defer { _ = try? files.retireProviderSource(receipt, requireOwner: {}) }
                let proof = try files.stageCloudKitSource(receipt, targetURI: path, cancellation: cancellation,
                    maximumBytes: selectedRecordName == nil ? nil : 8_388_608)
                if let proof { captureSelectedStage(proof) }
            }
        }
        try cancellation.check()
        return result
    }

    private static func encode(_ value: Any) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]), as: UTF8.self)
    }
}
