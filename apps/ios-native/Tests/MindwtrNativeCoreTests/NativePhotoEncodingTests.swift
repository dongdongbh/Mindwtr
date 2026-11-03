#if canImport(UIKit)
import XCTest
import Foundation
import UIKit
import ImageIO
import UniformTypeIdentifiers
@testable import MindwtrNativeCore

final class NativePhotoEncodingTests: XCTestCase {
    private enum Cancelled: Error { case stopped }

    private func selection(_ preferred: String?, load: String = UTType.png.identifier) -> NativeAttachmentPhotoSelection {
        NativeAttachmentPhotoSelection(loadType: load, preferredType: preferred, suggestedName: "selected.photo")
    }

    private func image(transparent: Bool = false, alternate: Bool = false) throws -> CGImage {
        var pixels: [UInt8] = []
        for index in 0..<8 {
            pixels += [alternate ? 20 : UInt8(30 + index * 20), UInt8(210 - index * 15),
                       alternate ? 220 : UInt8(index * 25), transparent && index == 0 ? 0 : 255]
        }
        let provider = try XCTUnwrap(CGDataProvider(data: Data(pixels) as CFData))
        return try XCTUnwrap(CGImage(width: 4, height: 2, bitsPerComponent: 8, bitsPerPixel: 32,
            bytesPerRow: 16, space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.last.rawValue), provider: provider,
            decode: nil, shouldInterpolate: false, intent: .defaultIntent))
    }

    private func fixture(_ type: String, orientation: Int = 1, transparent: Bool = false) throws -> Data {
        let data = NSMutableData()
        let destination = try XCTUnwrap(CGImageDestinationCreateWithData(data, type as CFString, 1, nil))
        CGImageDestinationAddImage(destination, try image(transparent: transparent), [
            kCGImagePropertyOrientation: orientation,
            kCGImageDestinationLossyCompressionQuality: 1.0
        ] as CFDictionary)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        return data as Data
    }

    private func source(_ data: Data) throws -> CGImageSource {
        try XCTUnwrap(CGImageSourceCreateWithData(data as CFData, nil))
    }

    private func properties(_ data: Data, index: Int = 0) throws -> [String: Any] {
        try XCTUnwrap(CGImageSourceCopyPropertiesAtIndex(try source(data), index, nil) as? [String: Any])
    }

    private func rgba(_ image: CGImage) throws -> [UInt8] {
        var bytes = [UInt8](repeating: 0, count: image.width * image.height * 4)
        try bytes.withUnsafeMutableBytes { storage in
            let context = try XCTUnwrap(CGContext(data: storage.baseAddress, width: image.width,
                height: image.height, bitsPerComponent: 8, bytesPerRow: image.width * 4,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
            context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        }
        return bytes
    }

    private func gif(frames: Int = 2) throws -> Data {
        let data = NSMutableData()
        let destination = try XCTUnwrap(CGImageDestinationCreateWithData(data, UTType.gif.identifier as CFString, frames, nil))
        CGImageDestinationSetProperties(destination, [kCGImagePropertyGIFDictionary: [
            kCGImagePropertyGIFLoopCount: 3
        ]] as CFDictionary)
        for index in 0..<frames {
            let delay = index.isMultiple(of: 2) ? 0.04 : 0.12
            CGImageDestinationAddImage(destination, try image(alternate: !index.isMultiple(of: 2)), [
                kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFDelayTime: delay,
                    kCGImagePropertyGIFUnclampedDelayTime: delay]
            ] as CFDictionary)
        }
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        return data as Data
    }


    private func rnGIF(_ data: Data) throws -> Data {
        let input = try source(data)
        let output = NSMutableData()
        let destination = try XCTUnwrap(CGImageDestinationCreateWithData(output, UTType.gif.identifier as CFString,
            CGImageSourceGetCount(input), nil))
        CGImageDestinationSetProperties(destination, CGImageSourceCopyProperties(input, nil))
        for index in 0..<CGImageSourceGetCount(input) {
            let frame = try XCTUnwrap(CGImageSourceCreateImageAtIndex(input, index, nil))
            var metadata = CGImageSourceCopyPropertiesAtIndex(input, index, nil) as? [String: Any] ?? [:]
            metadata[kCGImageDestinationLossyCompressionQuality as String] = 0.9
            CGImageDestinationAddImage(destination, frame, metadata as CFDictionary)
        }
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        return output as Data
    }

    private func assertError(_ expected: NativeAttachmentFilesError, _ body: () throws -> Void,
                             file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertThrowsError(try body(), file: file, line: line) { error in
            XCTAssertEqual(error as? NativeAttachmentFilesError, expected, file: file, line: line)
        }
    }


    private func gifWithRepeatedSolidFrame(frames: Int) throws -> Data {
        let pixels = Data(repeating: 0x70, count: 1_000 * 1_000 * 4)
        let provider = try XCTUnwrap(CGDataProvider(data: pixels as CFData))
        let frame = try XCTUnwrap(CGImage(width: 1_000, height: 1_000, bitsPerComponent: 8, bitsPerPixel: 32,
            bytesPerRow: 4_000, space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue), provider: provider,
            decode: nil, shouldInterpolate: false, intent: .defaultIntent))
        let single = NSMutableData()
        let destination = try XCTUnwrap(CGImageDestinationCreateWithData(single, UTType.gif.identifier as CFString, 1, nil))
        CGImageDestinationAddImage(destination, frame, nil)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        let bytes = [UInt8](single as Data)
        guard bytes.count >= 14, bytes.last == 0x3b else { throw CocoaError(.coderReadCorrupt) }
        var headerCount = 13
        if bytes[10] & 0x80 != 0 { headerCount += 3 * (1 << (Int(bytes[10] & 0x07) + 1)) }
        guard headerCount < bytes.count - 1 else { throw CocoaError(.coderReadCorrupt) }
        let frameBlocks = Data(bytes[headerCount..<(bytes.count - 1)])
        var result = Data(bytes[..<headerCount])
        for _ in 0..<frames { result.append(frameBlocks) }
        result.append(0x3b)
        return result
    }

    func testJPEGExifOrientationsMatchLiteralRNUIImageOracle() throws {
        for orientation in 1...8 {
            let input = try fixture(UTType.jpeg.identifier, orientation: orientation)
            XCTAssertEqual(try properties(input)[kCGImagePropertyOrientation as String] as? Int, orientation)
            let original = try XCTUnwrap(UIImage(data: input))
            let oracle = try XCTUnwrap(original.jpegData(compressionQuality: 0.9))
            let encoded = try NativeAttachmentPhotoEncoder.encode(input, selection: selection(UTType.jpeg.identifier,
                load: UTType.jpeg.identifier), checkCancellation: {})
            XCTAssertEqual(encoded.bytes, oracle, "EXIF orientation \(orientation)")
            XCTAssertEqual(encoded.fileExtension, "jpg")
            XCTAssertEqual(encoded.mimeType, "image/jpeg")
            let decoded = try XCTUnwrap(UIImage(data: encoded.bytes))
            let expected = try XCTUnwrap(UIImage(data: oracle))
            XCTAssertEqual(decoded.imageOrientation, expected.imageOrientation)
            XCTAssertEqual(decoded.size, expected.size)
            XCTAssertEqual(try rgba(XCTUnwrap(decoded.cgImage)), try rgba(XCTUnwrap(expected.cgImage)))
        }
    }

    func testPNGTransparencyAndOrientationMatchLiteralRNUIImageOracle() throws {
        for orientation in [1, 6] {
            let input = try fixture(UTType.png.identifier, orientation: orientation, transparent: true)
            XCTAssertEqual(try properties(input)[kCGImagePropertyOrientation as String] as? Int, orientation)
            let original = try XCTUnwrap(UIImage(data: input))
            let oracle = try XCTUnwrap(original.pngData())
            let encoded = try NativeAttachmentPhotoEncoder.encode(input, selection: selection(UTType.png.identifier), checkCancellation: {})
            XCTAssertEqual(encoded.bytes, oracle)
            XCTAssertEqual(encoded.fileExtension, "png")
            XCTAssertEqual(encoded.mimeType, "image/png")
            let decoded = try XCTUnwrap(UIImage(data: encoded.bytes))
            let expected = try XCTUnwrap(UIImage(data: oracle))
            XCTAssertEqual(decoded.imageOrientation, expected.imageOrientation)
            XCTAssertEqual(decoded.size, expected.size)
            let pixels = try rgba(XCTUnwrap(decoded.cgImage))
            XCTAssertTrue(stride(from: 3, to: pixels.count, by: 4).contains { pixels[$0] < 255 })
            XCTAssertEqual(pixels, try rgba(XCTUnwrap(expected.cgImage)))
        }
    }

    func testGIFFramesLoopAndDelayPropertiesMatchRNOracle() throws {
        let input = try gif()
        let encoded = try NativeAttachmentPhotoEncoder.encode(input, selection: selection(UTType.gif.identifier,
            load: UTType.gif.identifier), checkCancellation: {})
        XCTAssertEqual(encoded.bytes, try rnGIF(input))
        XCTAssertEqual(encoded.fileExtension, "gif")
        XCTAssertEqual(encoded.mimeType, "image/gif")
        let before = try source(input), after = try source(encoded.bytes)
        XCTAssertEqual(CGImageSourceGetCount(before), 2)
        XCTAssertEqual(CGImageSourceGetCount(after), 2)
        let beforeGlobal = try XCTUnwrap(CGImageSourceCopyProperties(before, nil) as? [String: Any])
        let afterGlobal = try XCTUnwrap(CGImageSourceCopyProperties(after, nil) as? [String: Any])
        XCTAssertEqual(try XCTUnwrap(beforeGlobal[kCGImagePropertyGIFDictionary as String] as? NSDictionary),
                       try XCTUnwrap(afterGlobal[kCGImagePropertyGIFDictionary as String] as? NSDictionary))
        for index in 0..<2 {
            XCTAssertEqual(try XCTUnwrap(properties(input, index: index)[kCGImagePropertyGIFDictionary as String] as? NSDictionary),
                           try XCTUnwrap(properties(encoded.bytes, index: index)[kCGImagePropertyGIFDictionary as String] as? NSDictionary))
            XCTAssertEqual(try rgba(XCTUnwrap(CGImageSourceCreateImageAtIndex(before, index, nil))),
                           try rgba(XCTUnwrap(CGImageSourceCreateImageAtIndex(after, index, nil))))
        }
    }

    func testRealBMPAndTIFFValidUIImageInputsPreserveExactRawBytes() throws {
        for (type, ext) in [(UTType.bmp.identifier, "bmp"), (UTType.tiff.identifier, "tiff")] {
            let input = try fixture(type)
            XCTAssertNotNil(UIImage(data: input))
            let encoded = try NativeAttachmentPhotoEncoder.encode(input, selection: selection(type, load: type), checkCancellation: {})
            XCTAssertEqual(encoded.bytes, input)
            XCTAssertEqual(encoded.fileExtension, ext)
            XCTAssertEqual(encoded.mimeType, UTType(filenameExtension: ext)?.preferredMIMEType)
        }
    }

    func testPreferredRegisteredTypeDeterminesBranchRatherThanLoadedImageType() throws {
        let input = try fixture(UTType.png.identifier, transparent: true)
        let uiImage = try XCTUnwrap(UIImage(data: input))
        let jpeg = try XCTUnwrap(uiImage.jpegData(compressionQuality: 0.9))


        for preferred in [nil, "public.data", "org.example.unknown-image", UTType.jpeg.identifier] {
            let encoded = try NativeAttachmentPhotoEncoder.encode(input, selection: selection(preferred), checkCancellation: {})
            XCTAssertEqual(encoded.bytes, jpeg)
            XCTAssertEqual(encoded.fileExtension, "jpg")
        }
        let branches = [(UTType.bmp.identifier, "bmp"), (UTType.webP.identifier, "webp"),
                        (UTType.heic.identifier, "heic"), (UTType.tiff.identifier, "tiff"), ("public.avif", "avif")]
        for (preferred, ext) in branches {


            let encoded = try NativeAttachmentPhotoEncoder.encode(input, selection: selection(preferred), checkCancellation: {})
            XCTAssertEqual(encoded.bytes, input)
            XCTAssertEqual(encoded.fileExtension, ext)
        }
        let animated = try gif()
        let gifUIImage = try XCTUnwrap(UIImage(data: animated))
        let gifJPEG = try XCTUnwrap(gifUIImage.jpegData(compressionQuality: 0.9))
        let encodedGIFAsJPEG = try NativeAttachmentPhotoEncoder.encode(animated,
            selection: selection(UTType.jpeg.identifier, load: UTType.gif.identifier), checkCancellation: {})
        XCTAssertEqual(encodedGIFAsJPEG.bytes, gifJPEG)
        XCTAssertEqual(encodedGIFAsJPEG.fileExtension, "jpg")
        XCTAssertEqual(encodedGIFAsJPEG.mimeType, "image/jpeg")
    }

    func testMalformedOrUndecodableBytesRefuseIncludingRawBranches() throws {
        for input in [Data(), Data("not an image".utf8), Data(try fixture(UTType.png.identifier).prefix(20))] {
            for type in [UTType.jpeg.identifier, UTType.png.identifier, UTType.tiff.identifier] {
                assertError(.unavailable) {
                    _ = try NativeAttachmentPhotoEncoder.encode(input, selection: selection(type), checkCancellation: {})
                }
            }
        }
    }

    func testCancellationAtAdmissionAfterUIImageAndDuringGIFWorkIsPreserved() throws {
        let png = try fixture(UTType.png.identifier)
        for stopAt in [1, 2, 3] {
            var checks = 0
            XCTAssertThrowsError(try NativeAttachmentPhotoEncoder.encode(png, selection: selection(UTType.png.identifier)) {
                checks += 1
                if checks == stopAt { throw Cancelled.stopped }
            }) { error in XCTAssertTrue(error is Cancelled) }
            XCTAssertEqual(checks, stopAt)
        }
        let animated = try gif(frames: 3)
        var checks = 0


        XCTAssertThrowsError(try NativeAttachmentPhotoEncoder.encode(animated, selection: selection(UTType.gif.identifier)) {
            checks += 1
            if checks == 7 { throw Cancelled.stopped }
        }) { error in XCTAssertTrue(error is Cancelled) }
        XCTAssertEqual(checks, 7)
    }

    func testPixelAdmissionRejectsNonfiniteFractionalAndOverBudgetDimensions() throws {
        XCTAssertEqual(try NativeAttachmentPhotoEncoder.pixels(width: 8_000, height: 8_000), 64_000_000)
        XCTAssertEqual(try NativeAttachmentPhotoEncoder.pixels(width: 1, height: 64_000_000), 64_000_000)
        for pair in [(0.0, 1.0), (-1, 1), (1, 0), (1.5, 2), (2, 1.5),
                     (Double.nan, 1), (1, Double.infinity), (Double.infinity, 1),
                     (1e300, 1e300), (8_001, 8_000), (8_192, 8_192)] {
            assertError(.providerTooLarge) { _ = try NativeAttachmentPhotoEncoder.pixels(width: pair.0, height: pair.1) }
        }
    }

    func testGIFFrameLimitAllows256AndRefuses257TinyFrames() throws {
        let allowed = try gif(frames: 256)
        XCTAssertEqual(CGImageSourceGetCount(try source(allowed)), 256)
        let encoded = try NativeAttachmentPhotoEncoder.encode(allowed, selection: selection(UTType.gif.identifier), checkCancellation: {})
        XCTAssertEqual(CGImageSourceGetCount(try source(encoded.bytes)), 256)
        let refused = try gif(frames: 257)
        XCTAssertEqual(CGImageSourceGetCount(try source(refused)), 257)
        for preferred in [UTType.gif.identifier, UTType.jpeg.identifier] {
            assertError(.providerTooLarge) {
                _ = try NativeAttachmentPhotoEncoder.encode(refused,
                    selection: selection(preferred, load: UTType.gif.identifier), checkCancellation: {})
            }
        }
    }

    func testGIFAggregatePixelBudgetRefusesValidCompressedFramesBeforeDecode() throws {
        let input = try gifWithRepeatedSolidFrame(frames: 129)
        XCTAssertLessThan(input.count, 2 * 1024 * 1024)
        XCTAssertEqual(CGImageSourceGetCount(try source(input)), 129)
        let firstFrame = try XCTUnwrap(CGImageSourceCreateImageAtIndex(try source(input), 0, nil))
        XCTAssertEqual(firstFrame.width, 1_000)
        XCTAssertEqual(firstFrame.height, 1_000)
        for index in 0..<129 {
            let metadata = try properties(input, index: index)
            XCTAssertEqual(metadata[kCGImagePropertyPixelWidth as String] as? Int, 1_000)
            XCTAssertEqual(metadata[kCGImagePropertyPixelHeight as String] as? Int, 1_000)
            XCTAssertEqual(try NativeAttachmentPhotoEncoder.pixels(width: 1_000, height: 1_000), 1_000_000)
        }
        for preferred in [UTType.gif.identifier, UTType.jpeg.identifier] {
            assertError(.providerTooLarge) {
                _ = try NativeAttachmentPhotoEncoder.encode(input,
                    selection: selection(preferred, load: UTType.gif.identifier), checkCancellation: {})
            }
        }
    }
}
#endif
