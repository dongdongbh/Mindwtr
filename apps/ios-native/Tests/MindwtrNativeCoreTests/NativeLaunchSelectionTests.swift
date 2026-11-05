import Foundation
import XCTest
@testable import MindwtrNativeCore


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
        XCTAssertEqual(bundleIdentifier, "tech.dongdongbh.mindwtr")
        XCTAssertNotEqual(containerURL, home)

        guard case .rehearsal = try resolve([rehearsalFlag, rehearsalFlag]) else { return XCTFail("Expected staged rehearsal") }
    }

    func testSimulatorRehearsalReadsProductionPreferencesIndependentlyOfRunningBundle() throws {
        let root = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(
            ".mindwtr-native-launch-selection-tests/" + UUID().uuidString.lowercased(), isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let support = root.appendingPathComponent("Support", isDirectory: true)
        let staged = support.appendingPathComponent("NativeRNRehearsal", isDirectory: true)
        let manifest = staged.appendingPathComponent(
            "Library/Application Support/tech.dongdongbh.mindwtr/RCTAsyncLocalStorage_V1/manifest.json")
        try FileManager.default.createDirectory(at: manifest.deletingLastPathComponent(), withIntermediateDirectories: true)
        let original = Data(#"{"mindwtr-language":"de","mindwtr:quickCapture:addAnother":"true","unknown-preference":"keep"}"#.utf8)
        try original.write(to: manifest)

        for runningBundle in [bundle, "tech.dongdongbh.mindwtr"] {
            let selected = try NativeLaunchSelection.resolve(arguments: [rehearsalFlag], bundleIdentifier: runningBundle,
                supportURL: support, homeURL: root, mode: .simulatorDebug)
            guard case let .rehearsal(container, _, sourceIdentifier) = selected else {
                return XCTFail("Expected staged rehearsal")
            }
            let storage = try LegacyRNStorage(containerURL: container, bundleIdentifier: sourceIdentifier)
            XCTAssertEqual(try storage.value(forKey: "mindwtr-language"), "de")
            XCTAssertEqual(try storage.value(forKey: "mindwtr:quickCapture:addAnother"), "true")
            XCTAssertEqual(try storage.value(forKey: "unknown-preference"), "keep")
            XCTAssertEqual(try Data(contentsOf: manifest), original)
        }
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

            let encodedPath = try XCTUnwrap(path.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed))
            let supportURL = try XCTUnwrap(URL(string: "file://" + encodedPath + "/"))
            let homeURL = try XCTUnwrap(URL(string: "file://" + encodedPath + "/Home/"))
            for arguments in [[], [libraryFlag, identifier], [rehearsalFlag]] {
                let selected = try NativeLaunchSelection.resolve(arguments: arguments, bundleIdentifier: bundle,
                    supportURL: supportURL, homeURL: homeURL, mode: .simulatorDebug)
                switch selected {
                case .production: XCTFail("Simulator fixture cannot select production")
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
    func testProductionSelectionUsesOnlySystemHomeWithoutCreatingAFreshLibrary() throws {
        let root = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(
            ".mindwtr-native-launch-selection-tests/" + UUID().uuidString.lowercased(), isDirectory: true)
        let defaults = NSDictionary(dictionary: UserDefaults.standard.dictionaryRepresentation())
        let selected = try NativeLaunchSelection.resolve(arguments: ["MindwtrNative", "-AppleLanguages", "(de)"],
            bundleIdentifier: NativeLaunchSelection.productionNamespace,
            supportURL: root.appendingPathComponent("Library/Application Support"), homeURL: root, mode: .production)
        guard case let .production(container) = selected else { return XCTFail("Expected production selection") }
        XCTAssertEqual(container, root)
        XCTAssertEqual(NativeLaunchSelection.productionNamespace, "tech.dongdongbh.mindwtr")
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.path))
        XCTAssertEqual(NSDictionary(dictionary: UserDefaults.standard.dictionaryRepresentation()), defaults)
    }

    func testProductionSelectionRefusesWrongBundlesAndEveryNativeTestArgument() throws {
        for bundle in [nil, "", "tech.dongdongbh.mindwtr.native.dev", "TECH.DONGDONGBH.MINDWTR",
                       "tech.dongdongbh.mindwtr.other"] as [String?] {
            XCTAssertThrowsError(try resolve(mode: .production, bundleIdentifier: bundle))
        }
        for arguments in [[libraryFlag, identifier], [rehearsalFlag], ["--native-app-lock-auth", "success"],
                          ["--native-response-context-read-failure"], ["MindwtrNative", "--native-about-lookup-unavailable"]] {
            XCTAssertThrowsError(try resolve(arguments, mode: .production,
                bundleIdentifier: NativeLaunchSelection.productionNamespace))
        }
        XCTAssertThrowsError(try NativeLaunchSelection.resolve(arguments: [],
            bundleIdentifier: NativeLaunchSelection.productionNamespace, supportURL: support,
            homeURL: XCTUnwrap(URL(string: "https://example.invalid/home")), mode: .production))
    }

}
