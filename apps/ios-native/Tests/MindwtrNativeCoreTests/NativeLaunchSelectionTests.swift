import Foundation
import XCTest
@testable import MindwtrNativeCore

/// Pure trusted-input selection. No host, notification center, authentication, or permission request.
final class NativeLaunchSelectionTests: XCTestCase {
    private let support = URL(fileURLWithPath: "/synthetic448/Application Support", isDirectory: true)
    private let home = URL(fileURLWithPath: "/synthetic448/Native Home", isDirectory: true)
    private let bundle = "tech.dongdongbh.mindwtr.native.dev"
    private let identifier = "abcdefab-cdef-4abc-8abc-abcdefabcdef"
    private let libraryFlag = "--native-ui-test-library"
    private let rehearsalFlag = "--native-rn-rehearsal"

    private func resolve(_ arguments: [String] = [], mode: NativeLaunchSelection.BuildMode = .simulatorDebug,
                         bundleIdentifier: String? = "tech.dongdongbh.mindwtr.native.dev") throws -> NativeLaunchSelection {
        try NativeLaunchSelection.resolve(arguments: arguments, bundleIdentifier: bundleIdentifier,
            supportURL: support, homeURL: home, mode: mode)
    }

    private func assertStandard(_ selection: NativeLaunchSelection, namespace: String? = nil,
                                file: StaticString = #filePath, line: UInt = #line) {
        guard case let .standard(databaseURL, containerURL, selectedNamespace) = selection else {
            return XCTFail("Expected standard selection", file: file, line: line)
        }
        XCTAssertEqual(databaseURL.path, "/synthetic448/Application Support/NativeFoundation/mindwtr.sqlite", file: file, line: line)
        XCTAssertEqual(containerURL.path, "/synthetic448/Native Home", file: file, line: line)
        XCTAssertEqual(selectedNamespace, namespace ?? bundle, file: file, line: line)
    }

    private func assertIsolated(_ selection: NativeLaunchSelection, file: StaticString = #filePath, line: UInt = #line) {
        guard case let .isolated(databaseURL, containerURL, namespace, selectedID) = selection else {
            return XCTFail("Expected isolated selection", file: file, line: line)
        }
        XCTAssertEqual(databaseURL.path, "/synthetic448/Application Support/NativeUITests/abcdefab-cdef-4abc-8abc-abcdefabcdef/mindwtr.sqlite", file: file, line: line)
        XCTAssertEqual(containerURL.path, "/synthetic448/Application Support/NativeUITests/abcdefab-cdef-4abc-8abc-abcdefabcdef", file: file, line: line)
        XCTAssertEqual(namespace, "tech.dongdongbh.mindwtr.native-ui.abcdefab-cdef-4abc-8abc-abcdefabcdef", file: file, line: line)
        XCTAssertEqual(selectedID.uuidString.lowercased(), identifier, file: file, line: line)
    }

    func testEveryAvailableModeSelectsExactStandardLibrary() throws {
        for mode in [NativeLaunchSelection.BuildMode.simulatorDebug, .simulatorRelease, .deviceTest] {
            assertStandard(try resolve(["MindwtrNative"], mode: mode))
        }
    }

    func testSimulatorAndDeviceDebugSelectExactIsolatedIdentity() throws {
        for mode in [NativeLaunchSelection.BuildMode.simulatorDebug, .deviceTest] {
            assertIsolated(try resolve(["MindwtrNative", libraryFlag, identifier, "--native-about-lookup-unavailable"], mode: mode))
        }
        // Simulator isolated selection never substitutes the installed bundle namespace.
        assertIsolated(try resolve([libraryFlag, identifier], bundleIdentifier: "tech.dongdongbh.mindwtr"))
        assertIsolated(try resolve([libraryFlag, identifier], bundleIdentifier: nil))
    }

    func testSimulatorRehearsalUsesOnlyStagedContainerAndCarriesNoNativeNamespace() throws {
        let selected = try resolve(["MindwtrNative", rehearsalFlag])
        guard case let .rehearsal(containerURL, databaseURL, bundleIdentifier) = selected else {
            return XCTFail("Expected rehearsal selection")
        }
        XCTAssertEqual(containerURL.path, "/synthetic448/Application Support/NativeRNRehearsal")
        XCTAssertEqual(databaseURL.path, "/synthetic448/Application Support/NativeRNRehearsal/Documents/SQLite/mindwtr.db")
        XCTAssertEqual(bundleIdentifier, bundle)
        XCTAssertNotEqual(containerURL, home)
        // Repeated rehearsal flag alone retains the previous contains-based selection policy.
        guard case .rehearsal = try resolve([rehearsalFlag, rehearsalFlag]) else { return XCTFail("Expected staged rehearsal") }
    }

    func testSimulatorReleaseIgnoresAllDebugOnlyArguments() throws {
        for arguments in [[libraryFlag], [libraryFlag, identifier.uppercased()], [libraryFlag, identifier, libraryFlag, "bad"],
                          [rehearsalFlag], [libraryFlag, identifier, rehearsalFlag], ["--native-app-lock-auth", "success"]] {
            assertStandard(try resolve(arguments, mode: .simulatorRelease))
        }
    }

    func testCanonicalUUIDAndUniqueLibraryFlagAreMandatoryWithoutFallback() {
        for mode in [NativeLaunchSelection.BuildMode.simulatorDebug, .deviceTest] {
            for arguments in [[libraryFlag], [libraryFlag, ""], [libraryFlag, "not-a-uuid"],
                              [libraryFlag, identifier.uppercased()], [libraryFlag, " " + identifier],
                              [libraryFlag, identifier + " "], [libraryFlag, "{" + identifier + "}"],
                              [libraryFlag, identifier, libraryFlag, identifier], [libraryFlag, libraryFlag, identifier],
                              [libraryFlag, identifier, rehearsalFlag], [rehearsalFlag, libraryFlag, identifier]] {
                XCTAssertThrowsError(try resolve(arguments, mode: mode), "Expected bounded refusal")
            }
        }
    }

    func testDeviceTestRequiresExactDevelopmentBundleBeforeAnySelection() {
        for bundleIdentifier in [nil, "", "tech.dongdongbh.mindwtr", "tech.dongdongbh.mindwtr.native.dev.other",
                                          "TECH.DONGDONGBH.MINDWTR.NATIVE.DEV"] as [String?] {
            for arguments in [[], [libraryFlag, identifier]] {
                XCTAssertThrowsError(try resolve(arguments, mode: .deviceTest, bundleIdentifier: bundleIdentifier))
            }
        }
    }

    func testDeviceTestRejectsAuthenticationAndRehearsalFlagsAnywhere() {
        for flag in ["--native-app-lock-auth", rehearsalFlag] {
            for arguments in [[flag], ["MindwtrNative", flag, "success"], [flag, libraryFlag, identifier],
                              [libraryFlag, identifier, flag], [libraryFlag, flag, identifier]] {
                XCTAssertThrowsError(try resolve(arguments, mode: .deviceTest))
            }
        }
    }

    func testNativeNamespaceValidationUsesExistingReminderGrammarAndBounds() throws {
        for mode in [NativeLaunchSelection.BuildMode.simulatorDebug, .simulatorRelease] {
            for bundleIdentifier in [nil, "", "bad/namespace", "bad namespace", "bad\0namespace", "準備",
                                              String(repeating: "a", count: 256)] as [String?] {
                XCTAssertThrowsError(try resolve(mode: mode, bundleIdentifier: bundleIdentifier))
            }
        }
        for namespace in ["A_z-0.example", String(repeating: "a", count: 255)] {
            XCTAssertTrue(NativeReminderRequest.validNamespace(namespace))
            assertStandard(try resolve(bundleIdentifier: namespace), namespace: namespace)
        }
        XCTAssertThrowsError(try resolve([rehearsalFlag], bundleIdentifier: nil))
        XCTAssertThrowsError(try resolve([rehearsalFlag], bundleIdentifier: ""))
    }

    func testUnavailableAlwaysRefusesWithoutStandardFallbackAndFailuresAreContentFree() {
        let privateSupport = URL(fileURLWithPath: "/PRIVATE_SUPPORT", isDirectory: true)
        for arguments in [[], [libraryFlag, identifier], [rehearsalFlag], ["PRIVATE_ARGUMENT"]] {
            XCTAssertThrowsError(try NativeLaunchSelection.resolve(arguments: arguments, bundleIdentifier: "PRIVATE_BUNDLE",
                supportURL: privateSupport, homeURL: home, mode: .unavailable)) { error in
                XCTAssertEqual(error.localizedDescription, "Native iOS launch selection is unavailable.")
                XCTAssertFalse(error.localizedDescription.contains("PRIVATE"))
                XCTAssertFalse(error.localizedDescription.contains(self.identifier))
            }
        }
    }

    func testArgumentsCannotSelectLiveRNOrAnAlternateContainer() throws {
        let arguments = [rehearsalFlag, "--container", "/LIVE_RN", "--database", "/LIVE_RN/Documents/SQLite/mindwtr.db"]
        guard case let .rehearsal(containerURL, databaseURL, _) = try resolve(arguments) else {
            return XCTFail("Expected fixed staged rehearsal")
        }
        XCTAssertFalse(containerURL.path.contains("LIVE_RN"))
        XCTAssertEqual(databaseURL.path, "/synthetic448/Application Support/NativeRNRehearsal/Documents/SQLite/mindwtr.db")
        assertStandard(try resolve(["--container", "/LIVE_RN", "--namespace", "foreign"]))
    }

    func testResolverCreatesNoDirectoriesAndDoesNotWritePreferences() throws {
        let untouched = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(
            ".mindwtr-native-launch-selection-tests/" + UUID().uuidString.lowercased(), isDirectory: true)
        XCTAssertFalse(FileManager.default.fileExists(atPath: untouched.path))
        let before = NSDictionary(dictionary: UserDefaults.standard.dictionaryRepresentation())
        for arguments in [[], [libraryFlag, identifier], [rehearsalFlag], [libraryFlag, "invalid"]] {
            _ = try? NativeLaunchSelection.resolve(arguments: arguments, bundleIdentifier: bundle,
                supportURL: untouched.appendingPathComponent("Support", isDirectory: true),
                homeURL: untouched.appendingPathComponent("Home", isDirectory: true), mode: .simulatorDebug)
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: untouched.path))
        XCTAssertEqual(NSDictionary(dictionary: UserDefaults.standard.dictionaryRepresentation()), before)
    }

    func testSelectionPreservesDistinctValidUnicodePathBytes() throws {
        let paths = ["/synthetic448/é 🧭", "/synthetic448/e\u{301} 🧭"]
        var selectedPaths: [Data] = []
        for path in paths {
            // File-path initialization normalizes Unicode on macOS before selection sees it.
            let encodedPath = try XCTUnwrap(path.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed))
            let supportURL = try XCTUnwrap(URL(string: "file://" + encodedPath + "/"))
            let homeURL = try XCTUnwrap(URL(string: "file://" + encodedPath + "/Home/"))
            for arguments in [[], [libraryFlag, identifier], [rehearsalFlag]] {
                let selected = try NativeLaunchSelection.resolve(arguments: arguments, bundleIdentifier: bundle,
                    supportURL: supportURL, homeURL: homeURL, mode: .simulatorDebug)
                switch selected {
                case let .standard(databaseURL, containerURL, _):
                    XCTAssertEqual(Data(databaseURL.path.utf8), Data((path + "/NativeFoundation/mindwtr.sqlite").utf8))
                    XCTAssertEqual(Data(containerURL.path.utf8), Data((path + "/Home").utf8))
                    selectedPaths.append(Data(databaseURL.path.utf8))
                case let .isolated(databaseURL, containerURL, _, _):
                    let directory = path + "/NativeUITests/" + identifier
                    XCTAssertEqual(Data(databaseURL.path.utf8), Data((directory + "/mindwtr.sqlite").utf8))
                    XCTAssertEqual(Data(containerURL.path.utf8), Data(directory.utf8))
                case let .rehearsal(containerURL, databaseURL, _):
                    let directory = path + "/NativeRNRehearsal"
                    XCTAssertEqual(Data(databaseURL.path.utf8), Data((directory + "/Documents/SQLite/mindwtr.db").utf8))
                    XCTAssertEqual(Data(containerURL.path.utf8), Data(directory.utf8))
                }
            }
        }
        XCTAssertNotEqual(selectedPaths[0], selectedPaths[1])
    }
}
