import CryptoKit
import Darwin
import Foundation
import JavaScriptCore
import Security
import XCTest
import CoreFoundation
@testable import SyncFileLockEngine

private enum LiveFailure: Error { case setup, malformed, unsupported, timeout, end, duplicate }
private typealias LiveOwner = NativeFileSyncReadOwner
private let liveCurrent = Data(#"{"tasks":[],"projects":[],"sections":[],"areas":[],"settings":{"weekStart":"sunday"}}"#.utf8)
private let livePeer = Data(#"{"tasks":[],"projects":[],"sections":[],"areas":[],"settings":{"weekStart":"monday"}}"#.utf8)
private let liveNext = Data("""
{
  "tasks": [],
  "projects": [],
  "sections": [],
  "areas": [],
  "settings": {
    "theme": "dark"
  }
}
""".utf8)
private let liveBackup = Data([0, 255, 7, 42]), liveSentinel = Data([0, 255, 3, 7])
private func liveHash(_ bytes: Data) -> String { SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined() }
private func liveJSON(_ value: Any) throws -> String {
  String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .fragmentsAllowed]), as: UTF8.self)
}
private func liveObject(_ text: String) throws -> [String: Any] {
  guard let value = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any] else { throw LiveFailure.malformed }
  return value
}
private func liveBytes(_ value: Any?) throws -> Data {
  guard let array = value as? [NSNumber], array.count <= 262_144 else { throw LiveFailure.malformed }
  var bytes = Data()
  for number in array {
    guard CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite,
          number.doubleValue == Double(number.intValue), (0...255).contains(number.intValue) else { throw LiveFailure.malformed }
    bytes.append(UInt8(number.intValue))
  }
  return bytes
}
private struct LiveRequest: Sendable {
  let op: String, name: String?, destination: String?, bytes: Data?
  init(_ text: String) throws {
    guard text.utf8.count <= 2_000_000 else { throw LiveFailure.malformed }
    let row = try liveObject(text)
    guard let op = row["op"] as? String else { throw LiveFailure.malformed }
    let fields: Set<String>
    switch op {
    case "end", "list", "checkpoint": fields = ["op"]
    case "metadata", "read", "create": fields = ["op", "name"]
    case "writeCreated", "deleteOwned": fields = ["op", "name", "bytes"]
    case "renameObserved": fields = ["op", "name", "bytes", "destination"]
    default: throw LiveFailure.unsupported
    }
    guard Set(row.keys) == fields else { throw LiveFailure.malformed }
    self.op = op
    if fields.contains("name") {
      guard let name = row["name"] as? String,
            (op == "metadata" && name.isEmpty) || Self.child(name) else { throw LiveFailure.malformed }
      self.name = name
    } else { name = nil }
    if fields.contains("destination") {
      guard let destination = row["destination"] as? String, Self.child(destination) else { throw LiveFailure.malformed }
      self.destination = destination
    } else { destination = nil }
    bytes = fields.contains("bytes") ? try liveBytes(row["bytes"]) : nil
  }
  static func child(_ value: String) -> Bool {
    !value.isEmpty && value != "." && value != ".." && value.utf8.allSatisfy {
      (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || [45, 46, 95].contains($0)
    }
  }
}
private final class LiveState: @unchecked Sendable {
  let mode: String, root: URL
  let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
  let endStarted = DispatchSemaphore(value: 0), endAcknowledged = DispatchSemaphore(value: 0)
  private let lock = NSLock()
  private var events = [[String: Any]](), counts = [String: Int](), fds = Set<Int32>()
  private var current: LiveRequest?, failures = Set<String>()
  private var closing = false, closed = false, ownerFailed = false
  init(_ mode: String, root: URL) { self.mode = mode; self.root = root }
  private func locked<T>(_ work: () throws -> T) rethrows -> T { lock.lock(); defer { lock.unlock() }; return try work() }
  func record(_ event: String, _ fields: [String: Any] = [:]) {
    locked { var row = fields; row["event"] = event; row["ordinal"] = events.count; row["uptimeNanos"] = String(DispatchTime.now().uptimeNanoseconds); events.append(row) }
  }
  @discardableResult func bump(_ key: String) -> Int { locked { counts[key, default: 0] += 1; return counts[key]! } }
  func count(_ key: String) -> Int { locked { counts[key, default: 0] } }
  func begin(_ request: LiveRequest) throws {
    record("request", ["operation": request.op, "name": request.name ?? "", "destination": request.destination ?? "", "bytes": request.bytes.map { Array($0) } ?? []])
    try locked {
      if closing || closed { counts["lateIO", default: 0] += 1; throw LiveFailure.end }
      guard current == nil else { throw LiveFailure.duplicate }; current = request
    }
  }
  func finishRequest() { locked { current = nil } }
  func isRequest(_ op: String, _ name: String? = nil) -> Bool { locked { current?.op == op && (name == nil || current?.name == name) } }
  func stageWrite() -> Bool { locked { current?.op == "writeCreated" && current?.name?.hasPrefix(".mindwtr-et-s-") == true } }
  func once(_ key: String) -> Bool { locked { failures.insert(key).inserted } }
  func capture(_ fd: Int32) { locked { _ = fds.insert(fd) } }
  func markFailure() { locked { ownerFailed = true }; record("native-failure") }
  func hadFailure() -> Bool { locked { ownerFailed } }
  func beginEnd() { locked { closing = true }; record("end-request"); endStarted.signal() }
  func acknowledgeEnd() { locked { closed = true }; record("end-ack"); endAcknowledged.signal() }
  func closedFDs() -> Bool { locked { fds.allSatisfy { Darwin.fcntl($0, F_GETFD) == -1 && errno == EBADF } } }
  func observedBytes(_ op: String, _ name: String) -> [Data] {
    locked { events.filter { $0["event"] as? String == "request" && $0["operation"] as? String == op && $0["name"] as? String == name }.compactMap { ($0["bytes"] as? [UInt8]).map { Data($0) } } }
  }
  func terminalOrdering() -> Bool {
    locked {
      guard let ack = events.firstIndex(where: { $0["event"] as? String == "end-ack" }),
            let finished = events.firstIndex(where: { $0["event"] as? String == "shared-finished" }), ack < finished else { return false }
      return events.enumerated().allSatisfy { index, row in row["terminal"] as? Bool != true || index > ack }
    }
  }
  func summary() -> [String: Any] { locked { ["mode": mode, "events": events, "counts": counts, "closed": closed, "capturedFDCount": fds.count] } }
  func access() -> LiveOwner.Access {
    var io = LiveOwner.Access()
    let read = io.read, write = io.write, syncFile = io.syncFile, syncDirectory = io.syncDirectory
    let coordinate = io.coordinate, rename = io.renameExclusive
    io.read = { [self] fd, buffer, length in
      if mode == "read-failure", isRequest("read", "data.json") {
        if bump("prefixReads") == 1 { return read(fd, buffer, min(3, length)) }
        record("fault-read-after-prefix"); errno = EIO; return -1
      }
      return read(fd, buffer, length)
    }
    io.write = { [self] fd, buffer, length in
      capture(fd)
      if mode == "entered-end", stageWrite(), once("entered") {
        record("entered-write"); entered.signal()
        guard release.wait(timeout: .now() + 10) == .success else { errno = EIO; return -1 }
        record("released-write")
      }
      return write(fd, buffer, length)
    }
    io.renameExclusive = { [self] fd, source, destination in
      capture(fd); bump("renameSyscalls"); return rename(fd, source, destination)
    }
    io.syncFile = { [self] fd in
      try syncFile(fd)
      if mode == "late-write", isRequest("writeCreated", "data.json"), once("late-write") {
        record("fault-after-real-canonical-flush"); throw LiveOwner.Failure.incompleteWrite
      }
    }
    io.syncDirectory = { [self] fd in
      try syncDirectory(fd)
      if mode == "late-backup", isRequest("renameObserved", "data.json.bak"), once("late-backup") {
        record("fault-after-real-backup-rename-sync"); throw LiveOwner.Failure.incompleteWrite
      }
    }
    io.coordinate = { [self] url, body in
      if mode == "metadata-failure", isRequest("metadata", "data.json") {
        record("fault-metadata-coordination"); throw LiveOwner.Failure.coordination
      }
      try coordinate(url, body)
    }
    return io
  }
}
private final class LiveSession: @unchecked Sendable {
  let owner: LiveOwner, handle: LiveOwner.Handle, state: LiveState
  private let endLock = NSLock()
  private var ending: Task<Void, Error>?
  init(owner: LiveOwner, handle: LiveOwner.Handle, state: LiveState) { self.owner = owner; self.handle = handle; self.state = state }
  private func endTask() -> Task<Void, Error> {
    endLock.lock(); defer { endLock.unlock() }
    if let ending { return ending }
    let owner = owner, handle = handle, state = state
    state.beginEnd()
    let task = Task<Void, Error> {
      do { try await owner.close(handle) }
      catch let failure as LiveOwner.Failure where failure == .closed && state.hadFailure() { }
      guard state.closedFDs() else { throw LiveFailure.end }
      state.record("captured-fds-closed")
      let competitor = SyncFileLockEngine(); defer { competitor.drain() }
      let token = try competitor.acquireDirectory(state.root); try competitor.release(token)
      state.record("lease-free-before-ack"); state.acknowledgeEnd()
    }
    ending = task; return task
  }
  func end() async throws { try await endTask().value }
  func perform(_ text: String) async -> String {
    do {
      let request = try LiveRequest(text)
      if request.op == "end" { try await end(); return try liveJSON(["ok": true, "value": NSNull()]) }
      try state.begin(request)
      defer { state.finishRequest() }
      let value: Any
      if request.op == "checkpoint" {
        if state.mode == "stale-early" { try livePeer.write(to: state.root.appendingPathComponent("data.json")); state.record("injected-peer-before-write") }
        value = NSNull()
      } else {
        state.bump("ownerCalls"); state.bump(request.op)
        state.record("native-enter", ["operation": request.op, "name": request.name ?? ""])
        switch request.op {
        case "read":
          switch try await owner.read(request.name!, using: handle) {
          case .absent: value = ["state": "absent"]
          case .bytes(let bytes): value = ["state": "bytes", "bytes": Array(bytes)]
          }
        case "metadata":
          if request.name == "" { _ = try await owner.list(using: handle); value = ["state": "entry", "node": "directory"] }
          else if let row = try await owner.metadata(request.name!, using: handle) {
            var result: [String: Any] = ["state": "entry", "node": row.kind == .file ? "file" : "directory"]
            if let bytes = row.byteCount { result["size"] = bytes }; value = result
          } else { value = ["state": "absent"] }
        case "list": value = try await owner.list(using: handle).map(\.name)
        case "create": value = try await owner.createExclusive(request.name!, using: handle) == .created ? "created" : "exists"
        case "writeCreated": try await owner.writeCreated(request.name!, bytes: request.bytes!, using: handle); value = NSNull()
        case "renameObserved":
          if state.mode == "stale-late", request.name == "data.json" { try livePeer.write(to: state.root.appendingPathComponent("data.json")); state.record("injected-peer-before-real-observed-rename") }
          try await owner.renameObserved(request.name!, to: request.destination!, expectedBytes: request.bytes!, using: handle); value = NSNull()
        case "deleteOwned": try await owner.deleteOwned(request.name!, expectedBytes: request.bytes!, using: handle); value = NSNull()
        default: throw LiveFailure.unsupported
        }
        state.record("native-success", ["operation": request.op])
      }
      if state.mode == "malformed-metadata", request.op == "metadata", request.name == "data.json", state.once("malformed") {
        state.record("injected-malformed-actual-metadata-reply"); return try liveJSON(["ok": true, "value": ["state": "unknown"]])
      }
      return try liveJSON(["ok": true, "value": value])
    } catch {
      state.markFailure()
      do { try await end() } catch { state.bump("cleanupErrors") }
      return #"{"ok":false,"terminal":true}"#
    }
  }
}
private final class LiveJavaScript: @unchecked Sendable {
  private let queue = DispatchQueue(label: "test.file-sync-live.jsc")
  private let session: LiveSession
  private var context: JSContext?, continuation: CheckedContinuation<String, Error>?, nextTicket = 0
  private var completed = false
  init(_ session: LiveSession) { self.session = session }
  private func finish(_ result: Result<String, Error>) {
    dispatchPrecondition(condition: .onQueue(queue))
    guard !completed else { return }; completed = true
    let saved = continuation; continuation = nil; context = nil
    saved?.resume(with: result)
  }
  private func deliver(_ id: String, _ text: String) {
    queue.async { [weak self] in
      guard let self, let context = self.context, !self.completed else { return }
      let terminal = (try? liveObject(text))?["ok"] as? Bool == false
      self.session.state.record("reply-delivered", ["ticket": id, "terminal": terminal])
      context.objectForKeyedSubscript("__fileSyncLive")?.invokeMethod("deliver", withArguments: [id, text])
      if context.exception != nil { self.finish(.failure(LiveFailure.malformed)) }
    }
  }
  func run(bundle: String, rootURI: String) async throws -> String {
    try await withCheckedThrowingContinuation { continuation in
      queue.async { [self] in
        self.continuation = continuation
        guard let context = JSContext() else { finish(.failure(LiveFailure.setup)); return }
        self.context = context
        context.exceptionHandler = { [weak self] _, _ in self?.finish(.failure(LiveFailure.malformed)) }
        let request: @convention(block) (String) -> String = { [weak self] text in
          guard let self else { return "0" }
          self.nextTicket += 1; let id = String(self.nextTicket), session = self.session
          Task { [weak self] in let answer = await session.perform(text); self?.deliver(id, answer) }
          return id
        }
        let done: @convention(block) (String) -> Void = { [weak self] text in
          self?.session.state.bump("sharedFinished"); self?.session.state.record("shared-finished"); self?.finish(.success(text))
        }
        let hash: @convention(block) (String) -> String = { [weak self] text in
          self?.session.state.bump("hashCalls")
          guard let raw = try? JSONSerialization.jsonObject(with: Data(text.utf8)), let bytes = try? liveBytes(raw) else { return "" }
          return liveHash(bytes)
        }
        let random: @convention(block) (Int) -> String = { [weak self] count in
          guard (0...4096).contains(count) else { return "invalid" }
          self?.session.state.bump("entropyCalls"); if count == 0 { return "[]" }; var bytes = [UInt8](repeating: 0, count: count)
          guard bytes.withUnsafeMutableBytes({ SecRandomCopyBytes(kSecRandomDefault, count, $0.baseAddress!) }) == errSecSuccess else { return "invalid" }
          return (try? liveJSON(bytes)) ?? "invalid"
        }
        let now: @convention(block) () -> Double = { ProcessInfo.processInfo.systemUptime * 1000 }
        let log: @convention(block) (String) -> Void = { _ in }
        let native = JSValue(newObjectIn: context)!
        native.setObject(request, forKeyedSubscript: "request" as NSString); native.setObject(done, forKeyedSubscript: "finish" as NSString); native.setObject(hash, forKeyedSubscript: "hash" as NSString)
        context.setObject(native, forKeyedSubscript: "__mindwtrFileSync" as NSString)
        let services = JSValue(newObjectIn: context)!
        services.setObject(random, forKeyedSubscript: "randomBytes" as NSString); services.setObject(now, forKeyedSubscript: "nowMs" as NSString); services.setObject(log, forKeyedSubscript: "log" as NSString)
        context.setObject(services, forKeyedSubscript: "__mindwtrNative" as NSString)
        context.evaluateScript(bundle)
        guard !completed, context.exception == nil, let config = try? liveJSON(["rootURI": rootURI]) else { finish(.failure(LiveFailure.setup)); return }
        context.objectForKeyedSubscript("__fileSyncLive")?.invokeMethod("start", withArguments: [config])
        if context.exception != nil { finish(.failure(LiveFailure.malformed)) }
        queue.asyncAfter(deadline: .now() + 20) { [weak self] in self?.finish(.failure(LiveFailure.timeout)) }
      }
    }
  }
}

final class NativeFileSyncLivePublicationTests: XCTestCase {
  private struct Configuration { let bundle: String, root: URL, evidence: URL, hash: String }
  private func configuration() throws -> Configuration {
    let env = ProcessInfo.processInfo.environment
    guard env["NATIVE_FILE_SYNC_LIVE_REQUESTED"] == "1" else { throw XCTSkip("Live JSCore publication gate was not requested") }
    guard let path = env["NATIVE_FILE_SYNC_LIVE_BUNDLE"], let expected = env["NATIVE_FILE_SYNC_LIVE_BUNDLE_SHA256"],
          let rootPath = env["NATIVE_FILE_SYNC_LIVE_ROOT"], let evidencePath = env["NATIVE_FILE_SYNC_LIVE_EVIDENCE"],
          expected.count == 64 else { throw LiveFailure.setup }
    let file = URL(fileURLWithPath: path), root = URL(fileURLWithPath: rootPath, isDirectory: true), evidence = URL(fileURLWithPath: evidencePath, isDirectory: true)
    for url in [file, root, evidence] {
      guard url.path.hasPrefix("/Users/dd/scratch/"), url.standardizedFileURL == url, url.resolvingSymlinksInPath() == url else { throw LiveFailure.setup }
    }
    let bytes = try Data(contentsOf: file)
    guard liveHash(bytes) == expected, let source = String(data: bytes, encoding: .utf8), !source.isEmpty,
          FileManager.default.fileExists(atPath: root.path), FileManager.default.fileExists(atPath: evidence.path) else { throw LiveFailure.setup }
    return Configuration(bundle: source, root: root, evidence: evidence, hash: expected)
  }
  private func snapshot(_ root: URL, copyTo destination: URL? = nil) throws -> [String: Any] {
    var result = [String: Any]()
    if let destination { try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: false) }
    for name in try FileManager.default.contentsOfDirectory(atPath: root.path).sorted() where name != ".mindwtr.lock" {
      let url = root.appendingPathComponent(name), bytes = try Data(contentsOf: url)
      result[name] = ["bytes": bytes.count, "sha256": liveHash(bytes)]
      if let destination { try bytes.write(to: destination.appendingPathComponent(name), options: .withoutOverwriting) }
    }
    return result
  }
  private func wait(_ semaphore: DispatchSemaphore, seconds: Double) async -> DispatchTimeoutResult {
    await withCheckedContinuation { continuation in
      DispatchQueue.global().async { continuation.resume(returning: semaphore.wait(timeout: .now() + seconds)) }
    }
  }
  private func runCase(_ mode: String) async throws {
    let config = try configuration(), fm = FileManager.default
    let root = config.root.appendingPathComponent(mode, isDirectory: true), evidence = config.evidence.appendingPathComponent(mode, isDirectory: true)
    try fm.createDirectory(at: root, withIntermediateDirectories: false); try fm.createDirectory(at: evidence, withIntermediateDirectories: false)
    let initiallyAbsent = ["absent", "metadata-failure", "malformed-metadata"].contains(mode)
    if !initiallyAbsent { try liveCurrent.write(to: root.appendingPathComponent("data.json"), options: .withoutOverwriting) }
    if ["happy", "empty-backup", "late-backup"].contains(mode) { try (mode == "empty-backup" ? Data() : liveBackup).write(to: root.appendingPathComponent("data.json.bak"), options: .withoutOverwriting) }
    try liveSentinel.write(to: root.appendingPathComponent("sentinel"), options: .withoutOverwriting)
    let before = try snapshot(root, copyTo: evidence.appendingPathComponent("before", isDirectory: true))
    let state = LiveState(mode, root: root)
    let owner = LiveOwner(selection: .pickedDirectory(root), access: state.access(), diagnostic: { event in
      if event == .admitted { state.bump("admission") }
      state.record("owner-diagnostic", event.context)
    })
    let handle = try await owner.open(), session = LiveSession(owner: owner, handle: handle, state: state)
    let engine = LiveJavaScript(session)
    let running = Task { try await engine.run(bundle: config.bundle, rootURI: root.absoluteString.hasSuffix("/") ? root.absoluteString : root.absoluteString + "/") }
    if mode == "entered-end" {
      let entered = await wait(state.entered, seconds: 10); XCTAssertEqual(entered, .success)
      XCTAssertEqual(state.count("sharedFinished"), 0)
      let competitor = SyncFileLockEngine(); defer { competitor.drain() }
      XCTAssertThrowsError(try competitor.acquireDirectory(root))
      let closing = Task { try await session.end() }
      let endStarted = await wait(state.endStarted, seconds: 2); XCTAssertEqual(endStarted, .success)
      let acknowledged = await wait(state.endAcknowledged, seconds: 0.05); XCTAssertEqual(acknowledged, .timedOut)
      XCTAssertEqual(state.count("sharedFinished"), 0)
      state.release.signal(); try await closing.value
    }
    let response: String
    do { response = try await running.value }
    catch { state.release.signal(); try await session.end(); throw error }
    try await session.end()
    let after = try snapshot(root), result = try liveObject(response)
    try Data(try liveJSON(["scenario": mode, "processID": ProcessInfo.processInfo.processIdentifier, "bundleSHA256": config.hash,
                          "before": before, "after": after, "shared": result, "native": state.summary()]).utf8)
      .write(to: evidence.appendingPathComponent("result.json"), options: .withoutOverwriting)
    XCTAssertEqual(state.count("cleanupErrors"), 0); XCTAssertEqual(state.count("lateIO"), 0)
    XCTAssertTrue(state.terminalOrdering()); XCTAssertEqual(state.count("admission"), 1)
    XCTAssertEqual(result["cleanupSucceeded"] as? Bool, true); XCTAssertEqual(result["pending"] as? Int, 0)
    let metrics = try XCTUnwrap(result["metrics"] as? [String: Int])
    for label in ["generic", "encryption", "bookmark", "storage", "network"] { XCTAssertEqual(metrics[label], 0, label) }
    XCTAssertGreaterThan(state.count("entropyCalls"), 0); XCTAssertGreaterThan(state.count("hashCalls"), 0)
    XCTAssertEqual(result["payloadDigest"] as? String, liveHash(liveNext))
    XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("sentinel")), liveSentinel)
    let names = Set(try fm.contentsOfDirectory(atPath: root.path).filter { $0 != ".mindwtr.lock" })
    let stages = names.filter { $0.hasPrefix(".mindwtr-et-s-") }, quarantines = names.filter { $0.hasPrefix(".mindwtr-et-q-") }
    if ["happy", "empty-backup", "absent"].contains(mode) {
      XCTAssertEqual(result["outcome"] as? String, "fulfilled"); XCTAssertEqual(metrics["completed"], 1)
      XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("data.json")), liveNext)
      XCTAssertTrue(stages.isEmpty); XCTAssertTrue(quarantines.isEmpty)
      if mode != "absent" {
        XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("data.json.bak")), liveCurrent)
        for op in ["create", "writeCreated", "renameObserved", "deleteOwned"] { XCTAssertGreaterThan(state.count(op), 0) }
        XCTAssertEqual(state.observedBytes("renameObserved", "data.json.bak").first, mode == "empty-backup" ? Data() : liveBackup)
        XCTAssertEqual(state.observedBytes("renameObserved", "data.json").first, liveCurrent)
        XCTAssertEqual(result["observedFingerprint"] as? String, "sha256:" + liveHash(liveCurrent) + ":length=" + String(liveCurrent.count))
      }
    } else {
      XCTAssertEqual(result["outcome"] as? String, "rejected"); XCTAssertEqual(metrics["completed"], 0)
      if mode == "stale-early" {
        XCTAssertEqual(result["conflict"] as? Bool, true)
        XCTAssertEqual(state.count("create"), 0); XCTAssertEqual(state.count("renameObserved"), 0)
        XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("data.json")), livePeer)
      } else {
        XCTAssertEqual(result["terminal"] as? Bool, true)
        if mode == "stale-late" {
          XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("data.json")), livePeer); XCTAssertFalse(stages.isEmpty)
          for name in stages { XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent(name)), liveNext) }
        } else if mode == "late-backup" {
          XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("data.json")), liveCurrent)
          XCTAssertFalse(fm.fileExists(atPath: root.appendingPathComponent("data.json.bak").path)); XCTAssertEqual(quarantines.count, 1)
          for name in quarantines { XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent(name)), liveBackup) }
          XCTAssertEqual(state.count("create"), 0); XCTAssertTrue(stages.isEmpty)
        } else if mode == "late-write" {
          XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent("data.json")), liveNext)
          XCTAssertFalse(stages.isEmpty); XCTAssertEqual(quarantines.count, 1)
          for name in stages { XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent(name)), liveNext) }
          for name in quarantines { XCTAssertEqual(try Data(contentsOf: root.appendingPathComponent(name)), liveCurrent) }
        } else if ["metadata-failure", "read-failure", "malformed-metadata"].contains(mode) {
          XCTAssertEqual(try liveJSON(before), try liveJSON(after)); XCTAssertEqual(state.count("create"), 0)
          XCTAssertEqual(state.count("writeCreated"), 0); XCTAssertEqual(state.count("renameObserved"), 0); XCTAssertEqual(state.count("deleteOwned"), 0)
          if mode == "read-failure" { XCTAssertEqual(state.count("prefixReads"), 2) }
        } else if mode == "entered-end" { XCTAssertEqual(state.count("sharedFinished"), 1); XCTAssertFalse(stages.isEmpty) }
      }
    }
  }
  func testActualSharedWriterPublishesWithNonemptyBackup() async throws { try await runCase("happy") }
  func testActualSharedWriterPublishesWithEmptyBackup() async throws { try await runCase("empty-backup") }
  func testActualSharedWriterPublishesTrueAbsence() async throws { try await runCase("absent") }
  func testActualSharedWriterRejectsStaleBeforeWrite() async throws { try await runCase("stale-early") }
  func testActualSharedWriterRejectsStaleBeforeRename() async throws { try await runCase("stale-late") }
  func testActualSharedWriterRetainsLateBackupFailure() async throws { try await runCase("late-backup") }
  func testActualSharedWriterRetainsLateCanonicalWriteFailure() async throws { try await runCase("late-write") }
  func testActualSharedWriterRejectsMetadataFailure() async throws { try await runCase("metadata-failure") }
  func testActualSharedWriterRejectsPrefixReadFailure() async throws { try await runCase("read-failure") }
  func testActualSharedWriterRejectsMalformedActualMetadataReply() async throws { try await runCase("malformed-metadata") }
  func testActualSharedWriterAwaitsEnteredWriteEndDrain() async throws { try await runCase("entered-end") }
}
