import Foundation

enum MindwtrWatchAudioPathKind {
    case retainedOriginal
    case wave

    fileprivate var directoryName: String {
        switch self {
        case .retainedOriginal: return "watch-audio-original"
        case .wave: return "watch-audio"
        }
    }

    fileprivate var fileExtension: String {
        switch self {
        case .retainedOriginal: return "m4a"
        case .wave: return "wav"
        }
    }
}


enum MindwtrWatchAudioPathResolver {
    static func rebase(
        absoluteString: String,
        id: String,
        kind: MindwtrWatchAudioPathKind,
        currentDocumentsURL: URL
    ) -> URL? {
        guard let uuid = UUID(uuidString: id),
              uuid.uuidString.lowercased() == id,
              let stored = URL(string: absoluteString),
              stored.isFileURL,
              stored.host == nil || stored.host?.isEmpty == true,
              stored.user == nil,
              stored.password == nil,
              stored.query == nil,
              stored.fragment == nil,
              stored.path == stored.standardizedFileURL.path,
              currentDocumentsURL.isFileURL,
              currentDocumentsURL.path == currentDocumentsURL.standardizedFileURL.path,
              currentDocumentsURL.lastPathComponent == "Documents" else {
            return nil
        }

        let fileName = "\(id).\(kind.fileExtension)"
        let components = stored.pathComponents
        guard components.count >= 3,
              Array(components.suffix(3)) == ["Documents", kind.directoryName, fileName] else {
            return nil
        }

        let directory = currentDocumentsURL
            .appendingPathComponent(kind.directoryName, isDirectory: true)
            .standardizedFileURL
        let candidate = directory.appendingPathComponent(fileName, isDirectory: false)
            .standardizedFileURL
        guard candidate.deletingLastPathComponent() == directory,
              candidate.lastPathComponent == fileName else {
            return nil
        }
        return candidate
    }
}
