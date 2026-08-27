import CloudKit
import Foundation
import XCTest
@testable import CloudKitAttachmentErrorClassifier

final class CloudKitAttachmentErrorClassifierTests: XCTestCase {
    func testClassifiesMindwtrRecordAndAssetAbsenceAsTerminal() {
        for code in [
            CloudKitAttachmentErrorClassifier.recordNotFoundCode,
            CloudKitAttachmentErrorClassifier.assetMissingCode,
        ] {
            let error = NSError(
                domain: CloudKitAttachmentErrorClassifier.mindwtrErrorDomain,
                code: code
            )
            XCTAssertTrue(CloudKitAttachmentErrorClassifier.isTerminalNotFound(error))
        }
    }

    func testClassifiesCloudKitUnknownItemAsTerminal() {
        let error = NSError(
            domain: CKErrorDomain,
            code: CKError.Code.unknownItem.rawValue
        )
        XCTAssertTrue(CloudKitAttachmentErrorClassifier.isTerminalNotFound(error))
    }

    func testPreservesTransientAndUnrelatedErrors() {
        let transient = NSError(
            domain: CKErrorDomain,
            code: CKError.Code.networkUnavailable.rawValue
        )
        let wrongDomain = NSError(
            domain: "OtherCloudKitClient",
            code: CloudKitAttachmentErrorClassifier.recordNotFoundCode
        )
        let unrelatedMindwtrError = NSError(
            domain: CloudKitAttachmentErrorClassifier.mindwtrErrorDomain,
            code: 1004
        )

        XCTAssertFalse(CloudKitAttachmentErrorClassifier.isTerminalNotFound(transient))
        XCTAssertFalse(CloudKitAttachmentErrorClassifier.isTerminalNotFound(wrongDomain))
        XCTAssertFalse(CloudKitAttachmentErrorClassifier.isTerminalNotFound(unrelatedMindwtrError))
    }
}
