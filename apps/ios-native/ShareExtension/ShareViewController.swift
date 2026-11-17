import UIKit
import UniformTypeIdentifiers

@MainActor
final class ShareViewController: UIViewController {
    private let requestID = UUID()
    private let receivedAt = Date()
    private var frozenEnvelope: NativeShareEnvelope?
    private var operation: Task<Void, Never>?
    private var finished = false
    private let status = UILabel()
    private let detail = UILabel()
    private let spinner = UIActivityIndicatorView(style: .medium)
    private let retry = UIButton(type: .system)
    private let close = UIButton(type: .system)
    private let cancellation = ShareCancellation()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        let title = UILabel()
        title.text = "Mindwtr"; title.font = .preferredFont(forTextStyle: .title2)
        title.adjustsFontForContentSizeCategory = true; title.accessibilityTraits.insert(.header)
        for label in [status, detail] {
            label.font = .preferredFont(forTextStyle: .body)
            label.adjustsFontForContentSizeCategory = true; label.numberOfLines = 0
        }
        detail.text = localized("share.openLater")
        detail.textColor = .secondaryLabel
        retry.setTitle(localized("common.retry"), for: .normal)
        retry.addTarget(self, action: #selector(retryPressed), for: .touchUpInside)
        retry.accessibilityIdentifier = "native-share-retry"
        close.setTitle(localized("common.close"), for: .normal)
        close.addTarget(self, action: #selector(closePressed), for: .touchUpInside)
        close.accessibilityIdentifier = "native-share-close"
        status.accessibilityIdentifier = "native-share-status"
        let buttons = UIStackView(arrangedSubviews: [retry, close])
        buttons.axis = .vertical; buttons.spacing = 8; buttons.distribution = .fillEqually
        for button in [retry, close] { button.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true }
        let content = UIStackView(arrangedSubviews: [title, detail, status, spinner, buttons])
        content.axis = .vertical; content.alignment = .fill; content.spacing = 16
        content.translatesAutoresizingMaskIntoConstraints = false
        let scroll = UIScrollView(); scroll.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(scroll); scroll.addSubview(content)
        NSLayoutConstraint.activate([
            scroll.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
            scroll.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            scroll.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            content.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor, constant: 24),
            content.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor, constant: -24),
            content.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 24),
            content.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -24),
            content.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor, constant: -48),
        ])
        begin()
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        if !finished { finished = true; cancellation.cancel(); operation?.cancel(); discardPayload() }
    }

    private func localized(_ name: String) -> String { NSLocalizedString(name, comment: "Native text/URL share extension") }
    @objc private func retryPressed() { begin() }
    @objc private func closePressed() {
        guard !finished, close.isEnabled else { return }
        finished = true; cancellation.cancel(); operation?.cancel(); discardPayload()
        extensionContext?.cancelRequest(withError: NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError))
    }
    private func discardPayload() {
        guard let mailbox = try? NativeShareMailbox.current() else { return }
        let id = requestID.uuidString.lowercased()
        Task { try? await mailbox.removePayload(id, unlessPublished: true) }
    }
    private func begin() {
        guard operation == nil, !finished else { return }
        retry.isHidden = true; close.isEnabled = true
        status.text = localized("share.preparing"); status.textColor = .label; spinner.startAnimating()
        operation = Task { [weak self] in
            guard let self else { return }
            defer { self.operation = nil }
            do {
                let mailbox = try NativeShareMailbox.current()
                let envelope: NativeShareEnvelope
                if let frozenEnvelope = self.frozenEnvelope { envelope = frozenEnvelope }
                else {
                    do { envelope = try await self.readEnvelope(mailbox) }
                    catch { try? await mailbox.removePayload(self.requestID.uuidString.lowercased(), unlessPublished: true); throw error }
                    self.frozenEnvelope = envelope
                }
                try Task.checkCancellation()
                guard !self.finished else { return }
                self.close.isEnabled = false
                try await mailbox.publish(envelope)
                guard !self.finished else { return }
                self.finished = true; self.spinner.stopAnimating()
                self.extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
            } catch {
                guard !self.finished else { return }
                self.spinner.stopAnimating(); self.status.text = self.localized("share.queueFailed")
                self.status.textColor = .systemRed; self.retry.isHidden = false; self.close.isEnabled = true
            }
        }
    }

    private func readEnvelope(_ mailbox: NativeShareMailbox) async throws -> NativeShareEnvelope {
        guard let items = extensionContext?.inputItems as? [NSExtensionItem], (1...8).contains(items.count) else { throw NativeShareError.invalidInput }
        var subject: String?, text: String?, webURL: String?, providers = 0
        var files: [NativeShareEnvelope.File] = [], skipped = 0, writer: NativeSharePayloadWriter?
        func accept(_ value: String, into existing: inout String?, limit: Int) throws {
            guard value.utf16.count <= limit else { throw NativeShareError.invalidInput }
            if let existing, existing != value { throw NativeShareError.invalidInput }
            existing = value
        }
        for item in items {
            if let title = item.attributedTitle, title.length > 0 {
                guard title.length <= NativeShareEnvelope.subjectLimit else { throw NativeShareError.invalidInput }
                try accept(title.string, into: &subject, limit: NativeShareEnvelope.subjectLimit)
            }
            if let body = item.attributedContentText, body.length > 0 {
                guard body.length <= NativeShareEnvelope.textLimit else { throw NativeShareError.invalidInput }
                try accept(body.string, into: &text, limit: NativeShareEnvelope.textLimit)
            }
            for provider in item.attachments ?? [] {
                providers += 1; guard providers <= 32 else { throw NativeShareError.invalidInput }
                try Task.checkCancellation()
                if let type = fileType(provider) {
                    guard files.count < NativeShareEnvelope.fileLimit else { continue }
                    if writer == nil { writer = try mailbox.payloadWriter(for: requestID) }
                    do { files.append(try await copy(provider, type: type, into: writer!)) }
                    catch is CancellationError { throw CancellationError() }
                    catch { skipped += 1 }
                } else if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
                    guard webURL == nil else { throw NativeShareError.invalidInput }
                    let value = try await load(provider, type: UTType.url.identifier)
                    if let url = value as? URL { webURL = url.absoluteString }
                    else { webURL = try string(value, limit: NativeShareEnvelope.webURLLimit) }
                } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
                    let value = try await load(provider, type: UTType.plainText.identifier)
                    try accept(string(value, limit: NativeShareEnvelope.textLimit), into: &text, limit: NativeShareEnvelope.textLimit)
                } else { throw NativeShareError.invalidInput }
            }
        }
        return try NativeShareEnvelope(id: requestID, receivedAt: receivedAt, subject: subject, text: text, webUrl: webURL,
            files: writer == nil ? nil : files, skippedFiles: writer == nil ? nil : skipped)
    }
    private nonisolated static func copyImageItem(_ item: NSSecureCoding?, type: UTType, into writer: NativeSharePayloadWriter,
                                                  check: @escaping () throws -> Void) throws -> ((id: UUID, size: Int64, sha256: String), URL) {
        if let url = item as? URL, url.isFileURL { return (try writer.copy(from: url, checkCancellation: check), url) }
        let bytes: Data
        if let data = item as? Data, data.count <= NativeShareEnvelope.File.maximumBytes { bytes = data }
        else if let image = item as? UIImage, let data = image.pngData() { bytes = data }
        else { throw NativeShareError.invalidInput }
        let pathExtension = item is UIImage ? "png" : type.preferredFilenameExtension ?? "png"
        let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("Image-" + UUID().uuidString.lowercased() + "." + pathExtension)
        try bytes.write(to: temporary, options: [.withoutOverwriting])
        defer { try? FileManager.default.removeItem(at: temporary) }
        return (try writer.copy(from: temporary, checkCancellation: check), temporary)
    }
    private func fileType(_ provider: NSItemProvider) -> UTType? {
        let types = provider.registeredTypeIdentifiers.compactMap { UTType($0) }
        for target in [UTType.image, .movie, .fileURL, .pdf] {
            if let match = types.first(where: { $0.conforms(to: target) }) { return match }
        }
        guard !types.contains(where: { $0.conforms(to: .url) || $0.conforms(to: .plainText) }) else { return nil }
        return types.first { $0.conforms(to: .data) }
    }
    private func copy(_ provider: NSItemProvider, type: UTType, into writer: NativeSharePayloadWriter) async throws -> NativeShareEnvelope.File {
        let check = cancellation.check
        let suggested = provider.suggestedName.flatMap { $0.isEmpty ? nil : $0 }
        let (copied, original): ((id: UUID, size: Int64, sha256: String), URL) = try await withCheckedThrowingContinuation { continuation in
            if type.conforms(to: .fileURL) {
                provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { item, _ in
                    guard let url = item as? URL, url.isFileURL else { continuation.resume(throwing: NativeShareError.invalidInput); return }
                    let scoped = url.startAccessingSecurityScopedResource(); defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                    continuation.resume(with: Result { (try writer.copy(from: url, checkCancellation: check), url) })
                }
                return
            }
            _ = provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { url, _ in
                if let url { continuation.resume(with: Result { (try writer.copy(from: url, checkCancellation: check), url) }); return }
                guard type.conforms(to: .image) else { continuation.resume(throwing: NativeShareError.invalidInput); return }
                provider.loadItem(forTypeIdentifier: type.identifier, options: nil) { item, _ in
                    continuation.resume(with: Result { try Self.copyImageItem(item, type: type, into: writer, check: check) })
                }
            }
        }
        let fileExtension = original.pathExtension.isEmpty ? type.preferredFilenameExtension ?? "" : original.pathExtension
        var name = original.lastPathComponent
        if let suggested, !type.conforms(to: .fileURL) {
            name = (suggested as NSString).pathExtension.isEmpty && !fileExtension.isEmpty ? suggested + "." + fileExtension : suggested
        }
        name = name.replacingOccurrences(of: "/", with: "-")
        let mimeType = UTType(filenameExtension: (name as NSString).pathExtension)?.preferredMIMEType
            ?? type.preferredMIMEType ?? "application/octet-stream"
        return try NativeShareEnvelope.File(id: copied.id, name: String(name.prefix(255)), mimeType: mimeType, size: copied.size, sha256: copied.sha256)
    }
    private func load(_ provider: NSItemProvider, type: String) async throws -> NSSecureCoding {
        try await withCheckedThrowingContinuation { continuation in
            provider.loadItem(forTypeIdentifier: type, options: nil) { item, error in
                if error != nil { continuation.resume(throwing: NativeShareError.invalidInput) }
                else if let item { continuation.resume(returning: item) }
                else { continuation.resume(throwing: NativeShareError.invalidInput) }
            }
        }
    }
    private func string(_ item: NSSecureCoding, limit: Int) throws -> String {
        if let value = item as? NSString, value.length <= limit { return value as String }
        if let data = item as? Data, data.count <= NativeShareEnvelope.maximumBytes,
           let value = String(data: data, encoding: .utf8), value.utf16.count <= limit { return value }
        throw NativeShareError.invalidInput
    }
}

private final class ShareCancellation: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false
    func cancel() { lock.lock(); cancelled = true; lock.unlock() }
    func check() throws {
        lock.lock(); defer { lock.unlock() }
        if cancelled { throw CancellationError() }
    }
}
