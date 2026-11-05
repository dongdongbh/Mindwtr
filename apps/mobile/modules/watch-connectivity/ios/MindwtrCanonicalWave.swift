#if canImport(AudioToolbox)
import AudioToolbox
#endif
import Foundation

enum MindwtrCanonicalWaveError: Error {
    case invalidDataSize
    case audioConversion(Int32)
}

/// whisper.rn's iOS decoder removes exactly 44 bytes, then interprets every
/// remaining byte as little-endian Int16 PCM. Keep this layout deliberately
/// narrower than the many valid RIFF/WAVE layouts accepted by AVFoundation.
public enum MindwtrCanonicalWave {
    static let headerSize = 44
    static let sampleRate: UInt32 = 16_000
    static let channelCount: UInt16 = 1
    static let bitsPerSample: UInt16 = 16
    static let bytesPerFrame: UInt16 = 2
    static let byteRate: UInt32 = sampleRate * UInt32(bytesPerFrame)

    #if canImport(AudioToolbox)
    /// The client format given to Extended Audio File Services. Keeping this
    /// next to the header contract makes the resampling/downmixing target part
    /// of the package-tested compatibility seam.
    static func clientFormat() -> AudioStreamBasicDescription {
        AudioStreamBasicDescription(
            mSampleRate: Double(sampleRate),
            mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked,
            mBytesPerPacket: UInt32(bytesPerFrame),
            mFramesPerPacket: 1,
            mBytesPerFrame: UInt32(bytesPerFrame),
            mChannelsPerFrame: UInt32(channelCount),
            mBitsPerChannel: UInt32(bitsPerSample),
            mReserved: 0
        )
    }

    /// The receiver and local voice decoder share the same bounded resampling lane.
    static func streamPCM(_ input: ExtAudioFileRef, maximumDataBytes: Int,
                          checkCancellation: () throws -> Void = {}, consume: (Data) throws -> Void) throws -> Int {
        var source = AudioStreamBasicDescription(), size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        try audioStatus(ExtAudioFileGetProperty(input, kExtAudioFileProperty_FileDataFormat, &size, &source))
        guard source.mSampleRate.isFinite, (8_000.0...96_000.0).contains(source.mSampleRate),
              (1...8).contains(source.mChannelsPerFrame) else { throw MindwtrCanonicalWaveError.invalidDataSize }
        var format = clientFormat()
        try audioStatus(ExtAudioFileSetProperty(input, kExtAudioFileProperty_ClientDataFormat, size, &format))
        var samples = [Int16](repeating: 0, count: 16_384), total = 0
        try samples.withUnsafeMutableBytes { buffer in
            guard let address = buffer.baseAddress else { throw MindwtrCanonicalWaveError.invalidDataSize }
            while true {
                try checkCancellation()
                var frames: UInt32 = 16_384
                var list = AudioBufferList(mNumberBuffers: 1, mBuffers: AudioBuffer(mNumberChannels: 1,
                    mDataByteSize: UInt32(buffer.count), mData: address))
                try audioStatus(ExtAudioFileRead(input, &frames, &list))
                if frames == 0 { break }
                let count = Int(frames) * Int(bytesPerFrame)
                guard count <= maximumDataBytes - total else { throw MindwtrCanonicalWaveError.invalidDataSize }
                total += count
                try consume(Data(bytes: address, count: count))
            }
        }
        guard total > 0 else { throw MindwtrCanonicalWaveError.invalidDataSize }
        return total
    }

    private static func audioStatus(_ code: OSStatus) throws {
        if code != noErr { throw MindwtrCanonicalWaveError.audioConversion(code) }
    }

    private final class MemoryAudio {
        let bytes: Data
        init(_ bytes: Data) { self.bytes = bytes }
        static func owner(_ pointer: UnsafeMutableRawPointer?) -> MemoryAudio? {
            pointer.map { Unmanaged<MemoryAudio>.fromOpaque($0).takeUnretainedValue() }
        }
        func read(position: Int64, requested: UInt32, buffer: UnsafeMutableRawPointer?, actual: UnsafeMutablePointer<UInt32>?) -> OSStatus {
            guard position >= 0, position <= Int64(bytes.count), let buffer, let actual else { return kAudioFileUnspecifiedError }
            let count = min(Int(requested), bytes.count - Int(position))
            if count > 0 { bytes.withUnsafeBytes { buffer.copyMemory(from: $0.baseAddress!.advanced(by: Int(position)), byteCount: count) } }
            actual.pointee = UInt32(count); return noErr
        }
    }

    /// Converts immutable proof-checked audio without reopening a caller path.
    public static func samplesFromAudio(_ bytes: Data, maximumSamples: Int, checkCancellation: () throws -> Void = {}) throws -> [Float] {
        guard !bytes.isEmpty, bytes.count <= 4 * 1024 * 1024, maximumSamples > 0, maximumSamples <= 120 * 16_000 else {
            throw MindwtrCanonicalWaveError.invalidDataSize
        }
        let owner = Unmanaged.passRetained(MemoryAudio(bytes)); defer { owner.release() }
        var file: AudioFileID?
        let read: AudioFile_ReadProc = { data, position, count, buffer, actual in
            MemoryAudio.owner(data)?.read(position: position, requested: count, buffer: buffer, actual: actual) ?? kAudioFileUnspecifiedError
        }
        let size: AudioFile_GetSizeProc = { data in Int64(MemoryAudio.owner(data)?.bytes.count ?? 0) }
        try audioStatus(AudioFileOpenWithCallbacks(owner.toOpaque(), read, nil, size, nil, 0, &file))
        guard let file else { throw MindwtrCanonicalWaveError.invalidDataSize }; defer { AudioFileClose(file) }
        var extended: ExtAudioFileRef?
        try audioStatus(ExtAudioFileWrapAudioFileID(file, false, &extended))
        guard let extended else { throw MindwtrCanonicalWaveError.invalidDataSize }; defer { ExtAudioFileDispose(extended) }
        var pcm = Data()
        _ = try streamPCM(extended, maximumDataBytes: maximumSamples * 2, checkCancellation: checkCancellation) { pcm.append($0) }
        return floats(pcm)
    }
    #endif

    public static func samplesFromCanonicalWave(_ bytes: Data, maximumSamples: Int) throws -> [Float] {
        guard maximumSamples > 0, maximumSamples <= 120 * 16_000,
              validateHeader(Data(bytes.prefix(headerSize)), fileSize: bytes.count, maximumFileSize: headerSize + maximumSamples * 2) else {
            throw MindwtrCanonicalWaveError.invalidDataSize
        }
        return floats(Data(bytes.dropFirst(headerSize)))
    }

    private static func floats(_ bytes: Data) -> [Float] {
        bytes.withUnsafeBytes { (buffer: UnsafeRawBufferPointer) in
            stride(from: 0, to: buffer.count, by: 2).map { offset in
                Float(Int16(bitPattern: UInt16(buffer[offset]) | UInt16(buffer[offset + 1]) << 8)) / 32768
            }
        }
    }

    static func header(dataByteCount: Int) throws -> Data {
        guard dataByteCount >= 0,
              dataByteCount.isMultiple(of: Int(bytesPerFrame)),
              dataByteCount <= Int(UInt32.max) - 36 else {
            throw MindwtrCanonicalWaveError.invalidDataSize
        }

        var data = Data()
        data.reserveCapacity(headerSize)
        data.append(contentsOf: "RIFF".utf8)
        appendLittleEndian(UInt32(36 + dataByteCount), to: &data)
        data.append(contentsOf: "WAVE".utf8)
        data.append(contentsOf: "fmt ".utf8)
        appendLittleEndian(UInt32(16), to: &data)
        appendLittleEndian(UInt16(1), to: &data) // uncompressed PCM
        appendLittleEndian(channelCount, to: &data)
        appendLittleEndian(sampleRate, to: &data)
        appendLittleEndian(byteRate, to: &data)
        appendLittleEndian(bytesPerFrame, to: &data)
        appendLittleEndian(bitsPerSample, to: &data)
        data.append(contentsOf: "data".utf8)
        appendLittleEndian(UInt32(dataByteCount), to: &data)
        return data
    }

    static func validateHeader(_ header: Data, fileSize: Int, maximumFileSize: Int) -> Bool {
        guard header.count == headerSize,
              fileSize > headerSize,
              fileSize <= maximumFileSize,
              fileSize <= Int(UInt32.max) + 8,
              slice(header, 0..<4) == Data("RIFF".utf8),
              readUInt32(header, at: 4) == UInt32(fileSize - 8),
              slice(header, 8..<12) == Data("WAVE".utf8),
              slice(header, 12..<16) == Data("fmt ".utf8),
              readUInt32(header, at: 16) == 16,
              readUInt16(header, at: 20) == 1,
              readUInt16(header, at: 22) == channelCount,
              readUInt32(header, at: 24) == sampleRate,
              readUInt32(header, at: 28) == byteRate,
              readUInt16(header, at: 32) == bytesPerFrame,
              readUInt16(header, at: 34) == bitsPerSample,
              slice(header, 36..<40) == Data("data".utf8),
              readUInt32(header, at: 40) == UInt32(fileSize - headerSize) else {
            return false
        }
        return (fileSize - headerSize).isMultiple(of: Int(bytesPerFrame))
    }

    /// Validates canonical WAV bytes independently of the file's staging or
    /// public name. Callers enforce any filename contract at publication.
    static func validateFile(at url: URL, maximumFileSize: Int) -> Bool {
        guard url.isFileURL,
              let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey]),
              values.isRegularFile == true,
              let size = values.fileSize,
              size > headerSize,
              size <= maximumFileSize,
              let handle = try? FileHandle(forReadingFrom: url) else {
            return false
        }
        defer { try? handle.close() }

        let header: Data
        do {
            guard let value = try handle.read(upToCount: headerSize) else {
                return false
            }
            header = value
        } catch {
            return false
        }
        return validateHeader(header, fileSize: size, maximumFileSize: maximumFileSize)
    }

    private static func appendLittleEndian(_ value: UInt16, to data: inout Data) {
        data.append(UInt8(truncatingIfNeeded: value))
        data.append(UInt8(truncatingIfNeeded: value >> 8))
    }

    private static func appendLittleEndian(_ value: UInt32, to data: inout Data) {
        data.append(UInt8(truncatingIfNeeded: value))
        data.append(UInt8(truncatingIfNeeded: value >> 8))
        data.append(UInt8(truncatingIfNeeded: value >> 16))
        data.append(UInt8(truncatingIfNeeded: value >> 24))
    }

    private static func readUInt16(_ data: Data, at offset: Int) -> UInt16 {
        UInt16(byte(data, at: offset))
            | (UInt16(byte(data, at: offset + 1)) << 8)
    }

    private static func readUInt32(_ data: Data, at offset: Int) -> UInt32 {
        UInt32(byte(data, at: offset))
            | (UInt32(byte(data, at: offset + 1)) << 8)
            | (UInt32(byte(data, at: offset + 2)) << 16)
            | (UInt32(byte(data, at: offset + 3)) << 24)
    }

    private static func byte(_ data: Data, at offset: Int) -> UInt8 {
        data[data.index(data.startIndex, offsetBy: offset)]
    }

    private static func slice(_ data: Data, _ range: Range<Int>) -> Data {
        let lower = data.index(data.startIndex, offsetBy: range.lowerBound)
        let upper = data.index(data.startIndex, offsetBy: range.upperBound)
        return Data(data[lower..<upper])
    }
}
