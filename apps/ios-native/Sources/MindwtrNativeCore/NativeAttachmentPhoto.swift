import Foundation
import ImageIO
import UniformTypeIdentifiers
#if canImport(UIKit)
import UIKit
#endif


struct NativeAttachmentPhotoSelection: Sendable {
    let loadType: String
    let preferredType: String?
    let suggestedName: String?
    init(provider: NSItemProvider) throws {
        let types = provider.registeredTypeIdentifiers, name = provider.suggestedName
        guard !types.isEmpty, types.count <= 64,
              types.allSatisfy({ !$0.isEmpty && $0.utf8.count <= 500 }),
              let imageType = types.first(where: { UTType($0)?.conforms(to: .image) == true }),
              name.map({ $0.utf8.count <= 1_000 }) ?? true else {
            throw NativeAttachmentFilesError.invalidRequest
        }
        loadType = imageType

        preferredType = types.first
        suggestedName = name
    }
    #if DEBUG
    init(loadType: String, preferredType: String?, suggestedName: String?) {
        self.loadType = loadType; self.preferredType = preferredType; self.suggestedName = suggestedName
    }
    #endif
}

enum NativeAttachmentPhotoEncoder {
    static let maximumInputBytes: Int64 = 100 * 1024 * 1024
    static let maximumPixels: UInt64 = 64_000_000
    static let maximumGIFFrames = 256
    static let maximumGIFPixels: UInt64 = 128_000_000
    struct Encoded {
        let bytes: Data
        let fileExtension: String
        var mimeType: String? { UTType(filenameExtension: fileExtension)?.preferredMIMEType }
    }

    static func pixels(width: Double, height: Double) throws -> UInt64 {
        guard width.isFinite, height.isFinite, width > 0, height > 0,
              width.rounded(.towardZero) == width, height.rounded(.towardZero) == height,
              width <= Double(maximumPixels), height <= Double(maximumPixels) else {
            throw NativeAttachmentFilesError.providerTooLarge
        }
        let count = UInt64(width).multipliedReportingOverflow(by: UInt64(height))
        guard !count.overflow, count.partialValue <= maximumPixels else { throw NativeAttachmentFilesError.providerTooLarge }
        return count.partialValue
    }
    private static func sourcePixels(_ source: CGImageSource, index: Int) throws -> UInt64 {
        guard let properties = CGImageSourceCopyPropertiesAtIndex(source, index, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? NSNumber,
              let height = properties[kCGImagePropertyPixelHeight] as? NSNumber else {
            throw NativeAttachmentFilesError.unavailable
        }
        return try pixels(width: width.doubleValue, height: height.doubleValue)
    }

    static func encode(_ data: Data, selection: NativeAttachmentPhotoSelection,
                       checkCancellation: () throws -> Void) throws -> Encoded {
        guard Int64(data.count) <= maximumInputBytes else { throw NativeAttachmentFilesError.providerTooLarge }
        try checkCancellation()
        guard let source = CGImageSourceCreateWithData(data as CFData, nil), CGImageSourceGetCount(source) > 0 else {
            throw NativeAttachmentFilesError.unavailable
        }
        _ = try sourcePixels(source, index: 0)
        let gif = selection.preferredType == UTType.gif.identifier || CGImageSourceGetType(source) as String? == UTType.gif.identifier
        if gif {
            let frames = CGImageSourceGetCount(source)
            guard frames <= maximumGIFFrames else { throw NativeAttachmentFilesError.providerTooLarge }
            var aggregate: UInt64 = 0
            for index in 0..<frames {
                try checkCancellation()
                let added = aggregate.addingReportingOverflow(try sourcePixels(source, index: index))
                guard !added.overflow, added.partialValue <= maximumGIFPixels else { throw NativeAttachmentFilesError.providerTooLarge }
                aggregate = added.partialValue
            }
        }
        #if canImport(UIKit)
        return try autoreleasepool {


            guard let image = UIImage(data: data) else { throw NativeAttachmentFilesError.unavailable }
            try checkCancellation()
            let encoded: Encoded
            switch selection.preferredType {
            case UTType.bmp.identifier: encoded = Encoded(bytes: data, fileExtension: "bmp")
            case UTType.webP.identifier: encoded = Encoded(bytes: data, fileExtension: "webp")
            case UTType.heic.identifier: encoded = Encoded(bytes: data, fileExtension: "heic")
            case UTType.tiff.identifier: encoded = Encoded(bytes: data, fileExtension: "tiff")
            case "public.avif": encoded = Encoded(bytes: data, fileExtension: "avif")
            case UTType.png.identifier:
                guard let bytes = image.pngData() else { throw NativeAttachmentFilesError.unavailable }
                encoded = Encoded(bytes: bytes, fileExtension: "png")
            case UTType.gif.identifier:
                let output = NSMutableData(), count = CGImageSourceGetCount(source)
                guard let destination = CGImageDestinationCreateWithData(output, UTType.gif.identifier as CFString, count, nil) else {
                    throw NativeAttachmentFilesError.unavailable
                }
                CGImageDestinationSetProperties(destination, CGImageSourceCopyProperties(source, nil))
                for index in 0..<count {
                    try checkCancellation()
                    guard let frame = CGImageSourceCreateImageAtIndex(source, index, nil) else { throw NativeAttachmentFilesError.unavailable }
                    var properties = CGImageSourceCopyPropertiesAtIndex(source, index, nil) as? [String: Any] ?? [:]
                    properties[kCGImageDestinationLossyCompressionQuality as String] = 0.9
                    CGImageDestinationAddImage(destination, frame, properties as CFDictionary)
                    guard output.length <= Int(NativeAttachmentFiles.maximumProviderBytes) else { throw NativeAttachmentFilesError.providerTooLarge }
                }
                try checkCancellation()
                guard CGImageDestinationFinalize(destination) else { throw NativeAttachmentFilesError.unavailable }
                encoded = Encoded(bytes: output as Data, fileExtension: "gif")
            default:
                guard let bytes = image.jpegData(compressionQuality: 0.9) else { throw NativeAttachmentFilesError.unavailable }
                encoded = Encoded(bytes: bytes, fileExtension: "jpg")
            }
            try checkCancellation()
            guard Int64(encoded.bytes.count) <= NativeAttachmentFiles.maximumProviderBytes else { throw NativeAttachmentFilesError.providerTooLarge }
            return encoded
        }
        #else

        throw NativeAttachmentFilesError.unavailable
        #endif
    }
}


final class NativeAttachmentPhotoCapture: @unchecked Sendable {
    let id: UUID
    private let jobs: NativeAttachmentFileJobs
    private let cancellation: NativeAttachmentCancellation
    private let selection: NativeAttachmentPhotoSelection
    init(id: UUID, jobs: NativeAttachmentFileJobs, cancellation: NativeAttachmentCancellation,
         selection: NativeAttachmentPhotoSelection) {
        self.id = id; self.jobs = jobs; self.cancellation = cancellation; self.selection = selection
    }
    func load(_ provider: NSItemProvider) async throws -> NativeAttachmentFiles.ProviderCacheCopyReceipt {
        let frame = NativeAttachmentPhotoLoadFrame { [jobs, cancellation, selection] url in
            try jobs.copyPhotoProviderSource(url, selection: selection, cancellation: cancellation)
        }
        cancellation.setCancellationHandler { [weak frame] in frame?.cancel() }
        defer { cancellation.setCancellationHandler(nil) }
        return try await frame.load(provider, typeIdentifier: selection.loadType)
    }
}


final class NativeAttachmentPhotoLoadFrame: @unchecked Sendable {
    private enum State { case waiting, copying, finished }
    private let lock = NSLock()
    private var state: State = .waiting
    private var continuation: CheckedContinuation<NativeAttachmentFiles.ProviderCacheCopyReceipt, Error>?
    private var progress: Progress?
    private var cancelled = false
    private var capture: ((URL) throws -> NativeAttachmentFiles.ProviderCacheCopyReceipt)?
    init(capture: @escaping (URL) throws -> NativeAttachmentFiles.ProviderCacheCopyReceipt) { self.capture = capture }

    func load(_ provider: NSItemProvider, typeIdentifier: String) async throws -> NativeAttachmentFiles.ProviderCacheCopyReceipt {
        try await withCheckedThrowingContinuation { pending in
            lock.lock()
            if case .finished = state {
                lock.unlock(); pending.resume(throwing: CancellationError()); return
            }
            continuation = pending
            lock.unlock()
            let returned = provider.loadFileRepresentation(forTypeIdentifier: typeIdentifier) { [self] url, error in
                receive(url: url, failed: error != nil)
            }
            lock.lock()
            let shouldCancel = cancelled
            if case .finished = state {} else { progress = returned }
            lock.unlock()
            if shouldCancel { returned.cancel() }
        }
    }

    func cancel() {
        lock.lock(); cancelled = true
        let currentProgress = progress
        var pending: CheckedContinuation<NativeAttachmentFiles.ProviderCacheCopyReceipt, Error>?
        if case .waiting = state {
            state = .finished; pending = continuation; continuation = nil; capture = nil; progress = nil
        }
        lock.unlock()
        currentProgress?.cancel()
        pending?.resume(throwing: CancellationError())
    }

    private func receive(url: URL?, failed: Bool) {
        lock.lock()
        guard case .waiting = state else { lock.unlock(); return }
        state = .copying
        let work = capture
        lock.unlock()
        let result: Result<NativeAttachmentFiles.ProviderCacheCopyReceipt, Error>
        if !failed, let url, let work { result = Result { try work(url) } }
        else { result = .failure(NativeAttachmentFilesError.unavailable) }


        lock.lock(); state = .finished
        let pending = continuation
        continuation = nil; capture = nil; progress = nil
        lock.unlock()
        pending?.resume(with: result)
    }
}
