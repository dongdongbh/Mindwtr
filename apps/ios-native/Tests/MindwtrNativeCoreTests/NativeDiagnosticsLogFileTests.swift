import XCTest
import Darwin
@testable import MindwtrNativeCore

final class NativeDiagnosticsLogFileTests: XCTestCase {
    private var directory: URL!
    override func setUpWithError() throws {
        directory = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".mindwtr-native-tests/task197-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }
    override func tearDownWithError() throws {
        if let directory { try FileManager.default.removeItem(at: directory) }
    }
    private func port(_ name: String) throws -> NativeDiagnosticsLogFile {
        let root = directory.appendingPathComponent(name)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return NativeDiagnosticsLogFile(libraryRoot: root)
    }

    func testDiagnostics197FixedUnicodeBytesIsolationAndClosedHandles() throws {
        let first = try port("first"), second = try port("second")
        let initialFDs = (0..<1_024).filter { fcntl(Int32($0), F_GETFD) != -1 }.count
        XCTAssertEqual(try first.perform("isAbsent", text: ""), "1")
        XCTAssertEqual(try first.perform("ensure", text: ""), first.mainURL.absoluteString)
        _ = try first.perform("append", text: "café 🧭\n")
        XCTAssertEqual(try first.perform("read", text: ""), "café 🧭\n")
        XCTAssertEqual(try first.perform("size", text: ""), String(Data("café 🧭\n".utf8).count))
        for _ in 0..<100 { _ = try first.perform("read", text: ""); _ = try first.perform("size", text: "") }
        let finalFDs = (0..<1_024).filter { fcntl(Int32($0), F_GETFD) != -1 }.count
        XCTAssertEqual(finalFDs, initialFDs, "Repeated operations must close every descriptor")
        XCTAssertEqual(try second.perform("isAbsent", text: ""), "1")
        XCTAssertThrowsError(try second.validatedShareURL(first.mainURL.absoluteString))
        XCTAssertEqual(try first.validatedShareURL(first.mainURL.absoluteString), first.mainURL)
        XCTAssertThrowsError(try first.perform("../read", text: ""))
        XCTAssertThrowsError(try first.perform("delete", text: first.mainURL.path))
    }

    func testDiagnostics197AtomicFailurePreservesMainAndRetainedSiblings() throws {
        let file = try port("atomic")
        _ = try file.perform("ensure", text: "")
        _ = try file.perform("write", text: "original")
        file.beforeReplace = { throw HostFailure("Injected replacement failure") }
        XCTAssertThrowsError(try file.perform("write", text: "new café"))
        XCTAssertEqual(try file.perform("read", text: ""), "original")
        let partial = file.mainURL.appendingPathExtension("partial")
        XCTAssertEqual(try String(contentsOf: partial, encoding: .utf8), "new café")
        file.beforeReplace = nil
        _ = try file.perform("moveAside", text: "")
        let unreadable = file.mainURL.appendingPathExtension("unreadable")
        XCTAssertEqual(try String(contentsOf: unreadable, encoding: .utf8), "original")
        _ = try file.perform("append", text: "fresh after unreadable rotation")
        XCTAssertEqual(try file.perform("read", text: ""), "fresh after unreadable rotation")
        XCTAssertEqual(try file.perform("delete", text: ""), "1")
        XCTAssertEqual(try file.perform("isAbsent", text: ""), "1")
        XCTAssertTrue(FileManager.default.fileExists(atPath: unreadable.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: partial.path))
    }

    func testDiagnostics197StrictUTF8AndPresentDirectoryAreNotAbsence() throws {
        let file = try port("invalid")
        _ = try file.perform("ensure", text: "")
        try Data([0xff, 0xfe]).write(to: file.mainURL)
        XCTAssertThrowsError(try file.perform("read", text: ""))
        XCTAssertEqual(try file.perform("size", text: ""), "2")
        _ = try file.perform("moveAside", text: "")
        try FileManager.default.createDirectory(at: file.mainURL, withIntermediateDirectories: false)
        XCTAssertEqual(try file.perform("exists", text: ""), "")
        XCTAssertEqual(try file.perform("isAbsent", text: ""), "")
        XCTAssertEqual(try file.perform("delete", text: ""), "")
        XCTAssertThrowsError(try file.perform("ensure", text: ""))
        XCTAssertThrowsError(try file.validatedShareURL(file.mainURL.absoluteString))
    }

    func testDiagnostics197RefusesSymlinkedLibraryLogsMainAndSiblings() throws {
        let outside = directory.appendingPathComponent("outside")
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: false)
        let secret = outside.appendingPathComponent("secret")
        try Data("outside retained".utf8).write(to: secret)
        let linkedRoot = directory.appendingPathComponent("linked-root")
        try FileManager.default.createSymbolicLink(at: linkedRoot, withDestinationURL: outside)
        let rootPort = NativeDiagnosticsLogFile(libraryRoot: linkedRoot)
        XCTAssertThrowsError(try rootPort.perform("ensure", text: ""))
        let logsRoot = directory.appendingPathComponent("logs-root")
        try FileManager.default.createDirectory(at: logsRoot, withIntermediateDirectories: false)
        try FileManager.default.createSymbolicLink(at: logsRoot.appendingPathComponent("logs"), withDestinationURL: outside)
        XCTAssertThrowsError(try NativeDiagnosticsLogFile(libraryRoot: logsRoot).perform("path", text: ""))
        let file = try port("main")
        _ = try file.perform("ensure", text: "")
        _ = try file.perform("delete", text: "")
        try FileManager.default.createSymbolicLink(at: file.mainURL, withDestinationURL: secret)
        for operation in ["read", "write", "append", "delete", "moveAside", "isAbsent", "path"] {
            XCTAssertThrowsError(try file.perform(operation, text: ["write", "append"].contains(operation) ? "attempt" : ""))
        }
        try FileManager.default.removeItem(at: file.mainURL)
        _ = try file.perform("ensure", text: "")
        try FileManager.default.createSymbolicLink(at: file.mainURL.appendingPathExtension("partial"), withDestinationURL: secret)
        XCTAssertThrowsError(try file.perform("write", text: "attempt"))
        try FileManager.default.createSymbolicLink(at: file.mainURL.appendingPathExtension("unreadable"), withDestinationURL: secret)
        XCTAssertThrowsError(try file.perform("moveAside", text: ""))
        XCTAssertEqual(try String(contentsOf: secret, encoding: .utf8), "outside retained")
    }

    func testDiagnostics197RefusesLinkedAncestorsAndAcceptsVerifiedVarAlias() throws {
        let outside = directory.appendingPathComponent("outside-parent/library/logs")
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
        let main = outside.appendingPathComponent("mindwtr.log"), original = Data("outside ancestor retained".utf8)
        let link = directory.appendingPathComponent("linked-parent")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: outside.deletingLastPathComponent().deletingLastPathComponent())
        let file = NativeDiagnosticsLogFile(libraryRoot: link.appendingPathComponent("library"))
        for operation in ["path", "ensure", "read", "append", "delete", "isAbsent"] {
            // Each probe owns its private outside control; the old implementation
            // must not let one destructive probe mask another refusal.
            try original.write(to: main)
            XCTAssertThrowsError(try file.perform(operation, text: operation == "append" ? "attempt" : ""), operation)
            XCTAssertEqual(try? Data(contentsOf: main), original, operation + " must preserve outside bytes")
        }
        try original.write(to: main)
        XCTAssertThrowsError(try file.validatedShareURL(file.mainURL.absoluteString))
        XCTAssertEqual(try Data(contentsOf: main), original)

        let destination = try FileManager.default.destinationOfSymbolicLink(atPath: "/var")
        XCTAssertTrue(["private/var", "/private/var"].contains(destination), "Positive control requires the actual supported OS alias")
        let absent = "task197-absent-" + UUID().uuidString.lowercased()
        let alias = NativeDiagnosticsLogFile(libraryRoot: URL(fileURLWithPath: "/var/" + absent, isDirectory: true))
        XCTAssertEqual(alias.mainURL.path, "/private/var/" + absent + "/logs/mindwtr.log")
        XCTAssertEqual(try alias.perform("isAbsent", text: ""), "1")
        // This control only probes an absent path; it creates nothing outside the test home.
    }
    #if os(macOS)
    func testDiagnostics197ContainerAccessWithoutAncestorReadPermission() throws {
        // Reproduce the device sandbox boundary: the app can open its home,
        // but cannot open the parent directory for reading. Do not broaden it.
        let parent = FileManager.default.homeDirectoryForCurrentUser.deletingLastPathComponent().path
        let encoded = try JSONSerialization.data(withJSONObject: [parent], options: .withoutEscapingSlashes)
        let quoted = String(decoding: encoded, as: UTF8.self).dropFirst().dropLast()
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/sandbox-exec")
        process.arguments = [
            "-p", "(version 1)(allow default)(deny file-read-data (literal \(quoted)))",
            "/usr/bin/xcrun", "xctest", "-XCTest",
            "MindwtrNativeCoreTests.NativeDiagnosticsLogFileTests/testDiagnostics197FixedUnicodeBytesIsolationAndClosedHandles",
            Bundle(for: Self.self).bundleURL.path,
        ]
        let output = Pipe()
        process.standardOutput = output
        process.standardError = output
        try process.run()
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        let transcript = String(decoding: data, as: UTF8.self)
        XCTAssertEqual(process.terminationStatus, 0, transcript)
        XCTAssertTrue(transcript.contains("Executed 1 test"), transcript)
        XCTAssertTrue(transcript.contains("with 0 failures"), transcript)
    }
    #endif

}
