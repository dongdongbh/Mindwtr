import XCTest
@testable import AppleImageCapture

final class AppleImageAnalysisCoordinatorTests: XCTestCase {
    func testCancelBeforeRegistrationNeverStartsAnalysis() async {
        let coordinator = AppleImageAnalysisCoordinator<String>()
        let id = "00000000-0000-4000-8000-000000000001"
        await coordinator.cancel(operationId: id)
        do {
            _ = try await coordinator.analyze(operationId: id) {
                XCTFail("Cancelled operation must not begin image analysis")
                return "unexpected"
            }
            XCTFail("Expected cancellation")
        } catch AppleImageCaptureError.cancelled {

        } catch {
            XCTFail("Unexpected error: \(error)")
        }
    }

    func testCancellationOfOldIdDoesNotCancelAnotherAnalysis() async throws {
        let coordinator = AppleImageAnalysisCoordinator<String>()
        await coordinator.cancel(operationId: "00000000-0000-4000-8000-000000000001")
        let result = try await coordinator.analyze(operationId: "00000000-0000-4000-8000-000000000002") {
            try Task.checkCancellation()
            return "current"
        }
        XCTAssertEqual(result, "current")
    }
}
