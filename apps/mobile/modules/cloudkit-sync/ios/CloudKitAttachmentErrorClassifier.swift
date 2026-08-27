import CloudKit
import Foundation

/// Classifies only CloudKit attachment states that cannot become downloadable by retrying.
/// Provider, authentication, throttling, and network failures deliberately remain transient.
enum CloudKitAttachmentErrorClassifier {
    static let mindwtrErrorDomain = "MindwtrCloudKit"
    static let recordNotFoundCode = 1002
    static let assetMissingCode = 1003

    static func isTerminalNotFound(_ error: Error) -> Bool {
        let nsError = error as NSError
        if nsError.domain == mindwtrErrorDomain {
            return nsError.code == recordNotFoundCode || nsError.code == assetMissingCode
        }
        return nsError.domain == CKErrorDomain
            && nsError.code == CKError.Code.unknownItem.rawValue
    }
}
