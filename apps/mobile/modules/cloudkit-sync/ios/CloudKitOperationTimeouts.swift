import CloudKit
import Foundation


enum CloudKitOperationTimeouts {


    static let requestSeconds: TimeInterval = 30


    static let recordResourceSeconds: TimeInterval = 180


    static let assetResourceSeconds: TimeInterval = 600


    static func apply(to op: CKOperation, resourceSeconds: TimeInterval = recordResourceSeconds) {
        let config = op.configuration ?? CKOperation.Configuration()
        config.qualityOfService = op.qualityOfService
        config.timeoutIntervalForRequest = requestSeconds
        config.timeoutIntervalForResource = resourceSeconds
        op.configuration = config
    }
}
