import CloudKit
import Foundation
import XCTest
@testable import CloudKitAttachmentErrorClassifier

final class CloudKitOperationTimeoutsTests: XCTestCase {


    func testApplyKeepsTheTimeoutsOnTheOperation() {
        let op = CKFetchRecordZoneChangesOperation()
        op.qualityOfService = .userInitiated

        CloudKitOperationTimeouts.apply(to: op)

        XCTAssertEqual(op.configuration.timeoutIntervalForRequest, 30)
        XCTAssertEqual(op.configuration.timeoutIntervalForResource, 180)
        XCTAssertEqual(op.configuration.qualityOfService, .userInitiated)
    }


    func testAssetOperationsGetTheLongerResourceTimeout() {
        let op = CKModifyRecordsOperation()
        op.qualityOfService = .userInitiated

        CloudKitOperationTimeouts.apply(to: op, resourceSeconds: CloudKitOperationTimeouts.assetResourceSeconds)

        XCTAssertEqual(op.configuration.timeoutIntervalForRequest, 30)
        XCTAssertEqual(op.configuration.timeoutIntervalForResource, 600)
        XCTAssertEqual(op.configuration.qualityOfService, .userInitiated)
    }
}
