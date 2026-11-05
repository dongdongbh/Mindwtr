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
        if !finished { finished = true; operation?.cancel() }
    }

    private func localized(_ name: String) -> String { NSLocalizedString(name, comment: "Native text/URL share extension") }
    @objc private func retryPressed() { begin() }
    @objc private func closePressed() {
        guard !finished, close.isEnabled else { return }
        finished = true; operation?.cancel()
        extensionContext?.cancelRequest(withError: NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError))
    }
    private func begin() {
        guard operation == nil, !finished else { return }
        retry.isHidden = true; close.isEnabled = true
        status.text = localized("share.preparing"); status.textColor = .label; spinner.startAnimating()
        operation = Task { [weak self] in
            guard let self else { return }
            defer { self.operation = nil }
            do {
                let envelope: NativeShareEnvelope
                if let frozenEnvelope = self.frozenEnvelope { envelope = frozenEnvelope }
                else {
                    envelope = try await self.readEnvelope()
                    self.frozenEnvelope = envelope
                }
                try Task.checkCancellation()
                guard !self.finished else { return }
                let mailbox = try NativeShareMailbox.current()
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

    private func readEnvelope() async throws -> NativeShareEnvelope {
        guard let items = extensionContext?.inputItems as? [NSExtensionItem], (1...2).contains(items.count) else { throw NativeShareError.invalidInput }
        var subject: String?, text: String?, webURL: String?, providers = 0
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
                providers += 1; guard providers <= 2 else { throw NativeShareError.invalidInput }
                try Task.checkCancellation()
                if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
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
        return try NativeShareEnvelope(id: requestID, receivedAt: receivedAt, subject: subject, text: text, webUrl: webURL)
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
