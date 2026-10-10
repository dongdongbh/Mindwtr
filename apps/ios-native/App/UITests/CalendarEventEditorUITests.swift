// Compiled with the production presenter; no EventKit store or permission is used.
import XCTest
import UIKit

@MainActor
final class NativeCalendarEventEditorOwnedUIChecks: XCTestCase {
    func testNestedControllerPrivacyAndWholeEditorDismissal() async throws {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        let root = UIViewController()
        window.rootViewController = root
        window.makeKeyAndVisible()
        defer { window.isHidden = true }

        let editor = UIViewController()
        editor.modalPresentationStyle = .fullScreen
        let nested = UIViewController()
        nested.modalPresentationStyle = .fullScreen
        await present(editor, from: root)
        await present(nested, from: editor)
        XCTAssertTrue(root.presentedViewController === editor)
        XCTAssertTrue(editor.presentedViewController === nested)

        let ownedUI = NativeCalendarEventEditorOwnedUI()
        let subviewCount = window.subviews.count
        ownedUI.conceal(editor)
        let cover = try XCTUnwrap(window.subviews.last)
        XCTAssertEqual(window.subviews.count, subviewCount + 1)
        XCTAssertEqual(cover.frame, window.bounds)
        XCTAssertEqual(cover.backgroundColor, .systemBackground)
        XCTAssertFalse(cover.isAccessibilityElement)
        XCTAssertTrue(editor.view.accessibilityElementsHidden)
        XCTAssertTrue(nested.view.accessibilityElementsHidden)
        ownedUI.conceal(editor)
        XCTAssertTrue(window.subviews.last === cover)
        XCTAssertEqual(window.subviews.count, subviewCount + 1)

        let presenter = try XCTUnwrap(NativeCalendarEventEditorOwnedUI.dismissalPresenter(for: editor))
        XCTAssertTrue(presenter === root)
        XCTAssertNil(NativeCalendarEventEditorOwnedUI.dismissalPresenter(for: UIViewController()))
        await dismiss(from: presenter)
        XCTAssertNil(root.presentedViewController)
        XCTAssertNil(editor.presentingViewController)
        XCTAssertNil(nested.presentingViewController)
        // Privacy remains through the actual UIKit completion, before release.
        XCTAssertTrue(cover.superview === window)
        let coveredCountAfterDismissal = window.subviews.count
        ownedUI.release()
        XCTAssertNil(cover.superview)
        XCTAssertEqual(window.subviews.count, coveredCountAfterDismissal - 1)
        ownedUI.release()
        XCTAssertNil(cover.superview)
    }

    func testCoverMovesFromUnmountedEditorToItsActualWindow() async throws {
        let editor = UIViewController()
        editor.modalPresentationStyle = .fullScreen
        editor.loadViewIfNeeded()
        let ownedUI = NativeCalendarEventEditorOwnedUI()
        ownedUI.conceal(editor)
        let cover = try XCTUnwrap(editor.view.subviews.last)
        XCTAssertTrue(cover.superview === editor.view)

        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        let root = UIViewController()
        window.rootViewController = root
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        await present(editor, from: root)
        ownedUI.conceal(editor)
        XCTAssertTrue(cover.superview === window)
        XCTAssertEqual(cover.frame, window.bounds)
        XCTAssertFalse(editor.view.subviews.contains(where: { $0 === cover }))
        let presenter = try XCTUnwrap(NativeCalendarEventEditorOwnedUI.dismissalPresenter(for: editor))
        await dismiss(from: presenter)
        ownedUI.release()
        XCTAssertNil(cover.superview)
    }

    private func present(_ controller: UIViewController, from presenter: UIViewController) async {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            presenter.present(controller, animated: false) { continuation.resume() }
        }
    }
    private func dismiss(from presenter: UIViewController) async {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            presenter.dismiss(animated: false) { continuation.resume() }
        }
    }
}
