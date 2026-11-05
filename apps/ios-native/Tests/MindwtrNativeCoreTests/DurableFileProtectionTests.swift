import XCTest
import Darwin
@testable import MindwtrNativeCore

final class DurableFileProtectionTests: XCTestCase {
    private var root: URL!
    private var descriptors: [Int32] = []

    override func setUpWithError() throws {
        root = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".mindwtr-native-tests/protection/" + UUID().uuidString.lowercased())
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }
    override func tearDownWithError() throws {
        descriptors.reversed().forEach { Darwin.close($0) }
        descriptors.removeAll()
        if let root { try FileManager.default.removeItem(at: root) }
    }
    private func directory(_ name: String) throws -> Int32 {
        let url = root.appendingPathComponent(name)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false)
        let fd = open(url.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw HostFailure("Fixture directory unavailable") }
        descriptors.append(fd); return fd
    }
    private func file(_ parent: Int32) throws -> Int32 {
        let fd = openat(parent, UUID().uuidString, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw HostFailure("Fixture file unavailable") }
        descriptors.append(fd); return fd
    }
    func testDirectoryZeroRetainsFreshLegalClassWithoutSettingZero() throws {
        let parent = try directory("same")
        var classes: [Int32: Int32] = [parent: 0]
        let read: (Int32) -> Int32 = { classes[$0] ?? -1 }
        let policy = try DurableFile.protectionSnapshot(source: parent, directory: parent, readClass: read)
        let target = try file(parent); classes[target] = 3
        var sets: [Int32] = []
        let protected = try DurableFile.protectFreshFile(policy, source: parent, directory: parent, file: target, readClass: read, setClass: { _, value in
            sets.append(value); errno = EINVAL; return -1
        })
        XCTAssertTrue(sets.isEmpty)
        XCTAssertEqual(protected.fileClass, 3)
        try DurableFile.verifyProtection(protected, source: parent, directory: parent, file: target, readClass: read)
    }
    func testCrossDirectoryDefaultRequiresMatchingPolicy() throws {
        let source = try directory("source"), destination = try directory("destination")
        var classes: [Int32: Int32] = [source: 0, destination: 0]
        let read: (Int32) -> Int32 = { classes[$0] ?? -1 }
        let policy = try DurableFile.protectionSnapshot(source: source, directory: destination, readClass: read)
        let target = try file(destination); classes[target] = 3
        _ = try DurableFile.protectFreshFile(policy, source: source, directory: destination, file: target, readClass: read, setClass: { _, _ in XCTFail("Inherited file must not be reclassified"); return -1 })
        classes[destination] = 1
        XCTAssertThrowsError(try DurableFile.protectionSnapshot(source: source, directory: destination, readClass: read))
    }
    func testExplicitFileAndDirectoryClassesKeepExactSetAndReadback() throws {
        let sourceDirectory = try directory("explicit"), destination = try directory("target"), sourceFile = try file(sourceDirectory)
        for (source, values) in [(sourceDirectory, [Int32(1), 2, 3, 4, 7]), (sourceFile, [Int32(1), 2, 3, 4, 5, 6, 7])] {
            for value in values {
                let target = try file(destination)
                var classes: [Int32: Int32] = [source: value, destination: 0, target: 4]
                let read: (Int32) -> Int32 = { classes[$0] ?? -1 }
                let policy = try DurableFile.protectionSnapshot(source: source, directory: destination, readClass: read)
                var writes: [Int32] = []
                let protected = try DurableFile.protectFreshFile(policy, source: source, directory: destination, file: target, readClass: read, setClass: { fd, value in
                    writes.append(value); classes[fd] = value; return 0
                })
                XCTAssertEqual(writes, [value]); XCTAssertEqual(protected.fileClass, value)
                try DurableFile.verifyProtection(protected, source: source, directory: destination, file: target, readClass: read)
            }
        }
    }
    func testExplicitSetAndReadbackFailuresNeverFallBackToInheritedClass() throws {
        let source = try directory("explicit-failure"), destination = try directory("fallback")
        let target = try file(destination)
        var classes: [Int32: Int32] = [source: 3, destination: 0, target: 4]
        let read: (Int32) -> Int32 = { classes[$0] ?? -1 }
        let policy = try DurableFile.protectionSnapshot(source: source, directory: destination, readClass: read)
        XCTAssertThrowsError(try DurableFile.protectFreshFile(policy, source: source, directory: destination, file: target, readClass: read, setClass: { _, _ in errno = EPERM; return -1 }))
        XCTAssertThrowsError(try DurableFile.protectFreshFile(policy, source: source, directory: destination, file: target, readClass: read, setClass: { _, _ in 0 }))
        classes[target] = -1
        XCTAssertThrowsError(try DurableFile.protectFreshFile(policy, source: source, directory: destination, file: target, readClass: read, setClass: { _, _ in 0 }))
        var info = stat(); XCTAssertEqual(fstat(target, &info), 0); XCTAssertEqual(info.st_size, 0)
    }
    func testRegularZeroAndInvalidFreshFileClassAreRefused() throws {
        let source = try directory("regular-source"), destination = try directory("regular-target"), regular = try file(source)
        var classes: [Int32: Int32] = [source: 0, destination: 0, regular: 0]
        let read: (Int32) -> Int32 = { classes[$0] ?? -1 }
        for value in [Int32(0), -1, 8] {
            classes[regular] = value
            XCTAssertThrowsError(try DurableFile.protectionSnapshot(source: regular, directory: destination, readClass: read))
        }
        let policy = try DurableFile.protectionSnapshot(source: source, directory: destination, readClass: read)
        let target = try file(destination)
        for value in [Int32(0), -1, 8] {
            classes[target] = value
            XCTAssertThrowsError(try DurableFile.protectFreshFile(policy, source: source, directory: destination, file: target, readClass: read, setClass: { _, _ in XCTFail("Invalid inheritance must not be repaired by SET"); return -1 }))
        }
    }
    func testSourceDestinationAndTargetPolicyDriftRefuseRevalidation() throws {
        let source = try directory("drift-source"), destination = try directory("drift-target")
        var classes: [Int32: Int32] = [source: 0, destination: 0]
        let read: (Int32) -> Int32 = { classes[$0] ?? -1 }
        let policy = try DurableFile.protectionSnapshot(source: source, directory: destination, readClass: read)
        let target = try file(destination); classes[target] = 3
        let protected = try DurableFile.protectFreshFile(policy, source: source, directory: destination, file: target, readClass: read, setClass: { _, _ in -1 })
        for (fd, changed) in [(source, Int32(1)), (destination, Int32(1)), (target, Int32(4))] {
            let before = classes[fd]; classes[fd] = changed
            XCTAssertThrowsError(try DurableFile.verifyProtection(protected, source: source, directory: destination, file: target, readClass: read))
            classes[fd] = before
        }
    }
    #if os(iOS) && !targetEnvironment(simulator)
    func testPhysicalDirectoryZeroAndExplicitClassPublishThroughDurableFile() throws {
        let source = try directory("physical-source"), destination = try directory("physical-target")
        XCTAssertEqual(fcntl(source, F_SETPROTECTIONCLASS, 0), 0)
        XCTAssertEqual(fcntl(destination, F_SETPROTECTIONCLASS, 0), 0)
        XCTAssertEqual(fcntl(source, F_GETPROTECTIONCLASS), 0)
        let bytes = Data("owned protection fixture".utf8)
        var retained: Int32 = -1; defer { if retained >= 0 { Darwin.close(retained) } }
        try DurableFile.write(bytes, to: "inherited.json", in: destination, retainingFile: &retained, preservingProtectionFrom: source, exclusive: true)
        XCTAssertTrue((1...7).contains(fcntl(retained, F_GETPROTECTIONCLASS)))
        Darwin.close(retained); retained = -1
        XCTAssertEqual(fcntl(source, F_SETPROTECTIONCLASS, 3), 0)
        try DurableFile.write(bytes, to: "explicit.json", in: destination, retainingFile: &retained, preservingProtectionFrom: source, exclusive: true)
        XCTAssertEqual(fcntl(retained, F_GETPROTECTIONCLASS), 3)
    }
    #endif
}
