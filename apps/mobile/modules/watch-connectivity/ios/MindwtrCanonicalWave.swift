#if canImport(AudioToolbox)
import AudioToolbox
#endif
import Foundation

enum MindwtrCanonicalWaveError: Error {
    case invalidDataSize
}


enum MindwtrCanonicalWave {
    static let headerSize = 44
    static let sampleRate: UInt32 = 16_000
    static let channelCount: UInt16 = 1
    static let bitsPerSample: UInt16 = 16
    static let bytesPerFrame: UInt16 = 2
    static let byteRate: UInt32 = sampleRate * UInt32(bytesPerFrame)

    #if canImport(AudioToolbox)


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
    #endif

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
        appendLittleEndian(UInt16(1), to: &data)
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
