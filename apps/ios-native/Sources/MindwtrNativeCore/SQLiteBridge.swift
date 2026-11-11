import Foundation
import Darwin
import SQLite3
import SQLiteSupport

final class SQLiteBridge {
    private var database: OpaquePointer?
    private var loggedLeadingBOM = false
    #if DEBUG
    var faults: HostIOFaults?
    #endif

    init(url: URL) throws {
        guard sqlite3_open_v2(url.path, &database, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_NOMUTEX, nil) == SQLITE_OK else {
            close()
            throw HostFailure("Cannot open native SQLite database")
        }


        guard mindwtr_disable_close_checkpoint(database) == SQLITE_OK else {
            close()
            throw HostFailure("Cannot disable SQLite close checkpoint")
        }
        sqlite3_busy_timeout(database, 5_000)
    }

    func close() {
        if let database { sqlite3_close(database) }
        database = nil
    }

    private func failure(_ operation: String) -> HostFailure {

        HostFailure("SQLite \(operation) failed (\(sqlite3_extended_errcode(database)))")
    }

    private func checkIntegrity(_ connection: OpaquePointer?) throws {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(connection, "PRAGMA quick_check", -1, &statement, nil) == SQLITE_OK else {
            throw HostFailure("SQLite integrity check failed")
        }
        defer { sqlite3_finalize(statement) }
        guard sqlite3_step(statement) == SQLITE_ROW,
              let text = sqlite3_column_text(statement, 0), String(cString: text) == "ok",
              sqlite3_step(statement) == SQLITE_DONE else { throw HostFailure("SQLite integrity check failed") }
    }

    private func makeCheckpointStandalone(_ connection: OpaquePointer?) throws {


        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(connection, "PRAGMA journal_mode = DELETE", -1, &statement, nil) == SQLITE_OK else {
            throw HostFailure("Cannot finalize prewrite recovery checkpoint")
        }
        defer { sqlite3_finalize(statement) }
        guard sqlite3_step(statement) == SQLITE_ROW,
              let text = sqlite3_column_text(statement, 0), String(cString: text) == "delete",
              sqlite3_step(statement) == SQLITE_DONE else { throw HostFailure("Cannot finalize prewrite recovery checkpoint") }
    }


    func prepareRecovery(at url: URL) throws {
        #if DEBUG
        try faults?.checkpoint?()
        #endif
        try checkIntegrity(database)
        #if DEBUG
        try faults?.afterIntegrity?()
        #endif
        var createdStandaloneCheckpoint = false
        if FileManager.default.fileExists(atPath: url.path) {
            var checkpoint: OpaquePointer?
            guard sqlite3_open_v2(url.path, &checkpoint, SQLITE_OPEN_READONLY | SQLITE_OPEN_NOMUTEX, nil) == SQLITE_OK else {
                if let checkpoint { sqlite3_close(checkpoint) }
                throw HostFailure("Cannot open prewrite recovery checkpoint")
            }
            defer { sqlite3_close(checkpoint) }
            try checkIntegrity(checkpoint)
            try DurableFile.sync(url)
        } else {
            let temporary = url.appendingPathExtension("building")
            if FileManager.default.fileExists(atPath: temporary.path) { try FileManager.default.removeItem(at: temporary) }
            var checkpoint: OpaquePointer?
            guard sqlite3_open_v2(temporary.path, &checkpoint, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_NOMUTEX, nil) == SQLITE_OK else {
                if let checkpoint { sqlite3_close(checkpoint) }
                throw HostFailure("Cannot create prewrite recovery checkpoint")
            }
            do {
                guard let backup = sqlite3_backup_init(checkpoint, "main", database, "main") else {
                    throw HostFailure("Cannot start prewrite recovery checkpoint")
                }
                let step = sqlite3_backup_step(backup, -1)
                let finish = sqlite3_backup_finish(backup)
                guard step == SQLITE_DONE, finish == SQLITE_OK else { throw HostFailure("Cannot complete prewrite recovery checkpoint") }
                try makeCheckpointStandalone(checkpoint)
                try checkIntegrity(checkpoint)
                sqlite3_close(checkpoint)
                checkpoint = nil
                try DurableFile.sync(temporary)
                try FileManager.default.moveItem(at: temporary, to: url)
                createdStandaloneCheckpoint = true
            } catch {
                if let checkpoint { sqlite3_close(checkpoint) }
                try? FileManager.default.removeItem(at: temporary)
                throw error
            }
        }
        try DurableFile.sync(url.deletingLastPathComponent(), directory: true)
        if createdStandaloneCheckpoint {
            NSLog("Native iOS prewrite snapshot releaseCheck=v1.3.3/native-ios-prewrite-snapshot outcome=standalone")
        }
        _ = try execute("PRAGMA journal_mode = WAL")
        _ = try execute("PRAGMA synchronous = FULL")
        _ = try execute("PRAGMA fullfsync = ON")
        _ = try execute("PRAGMA checkpoint_fullfsync = ON")
        _ = try execute("PRAGMA foreign_keys = ON")
    }

    #if DEBUG

    func captureAISummaryEvidence(at url: URL, maximumBytes: Int = 64 * 1024 * 1024) throws {
        guard let database, sqlite3_get_autocommit(database) != 0, maximumBytes > 0 else {
            throw HostFailure("AI summary evidence is unavailable")
        }
        guard sqlite3_exec(database, "BEGIN DEFERRED", nil, nil, nil) == SQLITE_OK else { throw failure("evidence read transaction") }
        func copySnapshot() throws {
            func requireBoundedSource() throws {
                var size: OpaquePointer?
                guard sqlite3_prepare_v2(database, "SELECT page_count, page_size FROM pragma_page_count, pragma_page_size", -1, &size, nil) == SQLITE_OK,
                      let size else { throw failure("evidence size") }
                defer { sqlite3_finalize(size) }
                guard sqlite3_stmt_readonly(size) != 0, sqlite3_step(size) == SQLITE_ROW else { throw failure("evidence size") }
                let pages = sqlite3_column_int64(size, 0), pageSize = sqlite3_column_int64(size, 1)
                guard pages >= 0, pageSize > 0, pages <= Int64(maximumBytes) / pageSize,
                      sqlite3_step(size) == SQLITE_DONE else { throw HostFailure("AI summary evidence exceeds its limit") }
            }
            try requireBoundedSource()
            let path = try NativeAttachmentFiles.filePath(url.absoluteString)
            let fd = Darwin.open(path, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW_ANY | O_CLOEXEC, 0o600)
            guard fd >= 0 else { throw HostFailure("AI summary evidence already exists or is unavailable") }
            defer { Darwin.close(fd) }
            #if os(iOS)
            guard fcntl(fd, F_SETPROTECTIONCLASS, NativeAISummaryEvidence.protectionClassC) == 0 else { throw HostFailure("AI summary evidence is unavailable") }
            #endif
            var original = stat()
            guard fstat(fd, &original) == 0, original.st_nlink == 1 else { throw HostFailure("AI summary evidence is unavailable") }
            var destination: OpaquePointer?
            guard sqlite3_open_v2(path, &destination, SQLITE_OPEN_READWRITE | SQLITE_OPEN_NOMUTEX, nil) == SQLITE_OK else {
                if let destination { sqlite3_close(destination) }
                throw HostFailure("AI summary evidence cannot be opened")
            }
            defer { if let destination { sqlite3_close(destination) } }
            guard let backup = sqlite3_backup_init(destination, "main", database, "main") else {
                throw HostFailure("AI summary evidence cannot be started")
            }
            let step = sqlite3_backup_step(backup, -1), finish = sqlite3_backup_finish(backup)
            guard step == SQLITE_DONE, finish == SQLITE_OK else { throw HostFailure("AI summary evidence is incomplete") }
            guard sqlite3_close(destination) == SQLITE_OK else { throw HostFailure("AI summary evidence cannot be closed") }
            destination = nil
            var current = stat(), named = stat()
            guard fstat(fd, &current) == 0, lstat(path, &named) == 0,
                  current.st_dev == original.st_dev, current.st_ino == original.st_ino,
                  named.st_dev == original.st_dev, named.st_ino == original.st_ino,
                  current.st_mode & S_IFMT == S_IFREG, current.st_nlink == 1,
                  current.st_size >= 0, current.st_size <= Int64(maximumBytes),
                  fsync(fd) == 0, fcntl(fd, F_FULLFSYNC) == 0 else { throw HostFailure("AI summary evidence is unavailable") }
        }
        do { try copySnapshot() }
        catch {
            guard sqlite3_exec(database, "ROLLBACK", nil, nil, nil) == SQLITE_OK, sqlite3_get_autocommit(database) != 0 else {
                throw failure("evidence read transaction cleanup")
            }
            throw error
        }
        guard sqlite3_exec(database, "ROLLBACK", nil, nil, nil) == SQLITE_OK, sqlite3_get_autocommit(database) != 0 else {
            throw failure("evidence read transaction cleanup")
        }
    }
    #endif

    func readCalendarPushMapping(taskID: String) throws -> NativeCalendarPushMapping? {
        guard NativeCalendarWriteValidation.id(taskID) else { throw NativeCalendarWriteError.invalid }
        let parameters = try calendarPushParameters([taskID, "ios"])
        let raw = try execute("SELECT task_id, calendar_event_id, calendar_id, platform, last_synced_at FROM calendar_sync WHERE task_id = ? AND platform = ?", parametersJSON: parameters)
        guard let rows = try NativeJSON.jsonObject(with: Data(raw.utf8)) as? [[String: Any]], rows.count <= 1 else {
            throw NativeCalendarWriteError.invalid
        }
        guard let row = rows.first else { return nil }
        guard let task = row["task_id"] as? String, let event = row["calendar_event_id"] as? String,
              let calendar = row["calendar_id"] as? String, let platform = row["platform"] as? String,
              let stamp = row["last_synced_at"] as? String,
              NativeCalendarWriteValidation.equalID(task, taskID) else { throw NativeCalendarWriteError.invalid }
        return try NativeCalendarPushMapping(taskId: task, calendarEventId: event, calendarId: calendar,
                                            platform: platform, lastSyncedAt: stamp)
    }


    func compareAndSetCalendarPushMapping(taskID: String, expected: NativeCalendarPushMapping?, next: NativeCalendarPushMapping?) throws {
        guard NativeCalendarWriteValidation.id(taskID),
              expected.map({ NativeCalendarWriteValidation.equalID($0.taskId, taskID) }) ?? true,
              next.map({ NativeCalendarWriteValidation.equalID($0.taskId, taskID) }) ?? true else {
            throw NativeCalendarWriteError.invalid
        }
        guard let database, sqlite3_get_autocommit(database) != 0 else {
            throw HostFailure("Calendar mapping transaction is unavailable")
        }
        do {
            _ = try execute("BEGIN IMMEDIATE")
            let current = try readCalendarPushMapping(taskID: taskID)

            if current != next {
                guard current == expected else { throw HostFailure("Calendar mapping changed") }
                if let next {
                    _ = try execute("INSERT INTO calendar_sync (task_id, calendar_event_id, calendar_id, platform, last_synced_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(task_id, platform) DO UPDATE SET calendar_event_id = excluded.calendar_event_id, calendar_id = excluded.calendar_id, last_synced_at = excluded.last_synced_at",
                        parametersJSON: calendarPushParameters([next.taskId, next.calendarEventId, next.calendarId, next.platform, next.lastSyncedAt]))
                } else {
                    _ = try execute("DELETE FROM calendar_sync WHERE task_id = ? AND platform = ?", parametersJSON: calendarPushParameters([taskID, "ios"]))
                }
                guard try readCalendarPushMapping(taskID: taskID) == next else { throw HostFailure("Calendar mapping changed") }
            }
            _ = try execute("COMMIT")
        } catch {
            if sqlite3_get_autocommit(database) == 0 { _ = try? execute("ROLLBACK") }
            throw error
        }
    }

    private func calendarPushParameters(_ values: [String]) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: values), as: UTF8.self)
    }

    func execute(_ sql: String, parametersJSON: String = "[]", readOnly: Bool = false) throws -> String {
        #if DEBUG
        try faults?.beforeSQL?(sql)
        #endif
        guard let parameters = try NativeJSON.jsonObject(with: Data(parametersJSON.utf8)) as? [Any] else {
            throw HostFailure("SQLite parameters must be an array")
        }
        if readOnly {


            let query = sql.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
            guard query.hasPrefix("SELECT ") || query == "PRAGMA DATA_VERSION"
                    || query == "PRAGMA TABLE_INFO(NATIVE_POMODORO_SESSION)" else {
                throw HostFailure("SQLite recovery requires read-only statements")
            }
        }
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
            throw failure("prepare")
        }
        defer { sqlite3_finalize(statement) }
        guard !readOnly || sqlite3_stmt_readonly(statement) != 0 else {
            throw HostFailure("SQLite recovery requires read-only statements")
        }
        guard sqlite3_bind_parameter_count(statement) == parameters.count else { throw HostFailure("SQLite parameter count mismatch") }
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        for (offset, value) in parameters.enumerated() {
            let index = Int32(offset + 1)
            let result: Int32
            if value is NSNull {
                result = sqlite3_bind_null(statement, index)
            } else if let text = value as? String {
                result = sqlite3_bind_text(statement, index, text, Int32(text.utf8.count), transient)
            } else if let number = value as? NSNumber {
                result = sqlite3_bind_double(statement, index, number.doubleValue)
            } else { throw HostFailure("Unsupported SQLite parameter") }
            guard result == SQLITE_OK else { throw failure("bind") }
        }
        let columns = SQLiteRowJSONColumns(statement)
        var output: [UInt8] = [0x5b]
        var firstRow = true
        while true {
            let result = sqlite3_step(statement)
            if result == SQLITE_DONE { break }
            guard result == SQLITE_ROW else { throw failure("step") }
            if !firstRow { output.append(0x2c) }
            firstRow = false
            output.append(0x7b)
            for (position, column) in columns.entries.enumerated() {
                if position > 0 { output.append(0x2c) }
                output.append(contentsOf: column.key)
                switch sqlite3_column_type(statement, column.index) {
                case SQLITE_NULL: output.append(contentsOf: SQLiteRowJSON.null)
                case SQLITE_INTEGER: SQLiteRowJSON.appendInteger(sqlite3_column_int64(statement, column.index), to: &output)
                case SQLITE_FLOAT: try SQLiteRowJSON.appendDouble(sqlite3_column_double(statement, column.index), to: &output)
                case SQLITE_TEXT:
                    let count = Int(sqlite3_column_bytes(statement, column.index))
                    let bytes = UnsafeBufferPointer(start: sqlite3_column_text(statement, column.index), count: count)
                    guard SQLiteRowJSON.appendText(bytes, to: &output) else { throw HostFailure("Invalid SQLite text") }
                    if !loggedLeadingBOM && bytes.starts(with: [0xEF, 0xBB, 0xBF]) {
                        loggedLeadingBOM = true
                        NSLog("Native iOS SQLite text preserved leading BOM releaseCheck=v1.3.3/native-ios-sqlite-leading-bom outcome=preserved")
                    }
                default: throw HostFailure("Unsupported SQLite column")
                }
            }
            output.append(0x7d)
        }
        output.append(0x5d)
        #if DEBUG
        try faults?.afterSQL?(sql)
        #endif
        return String(decoding: output, as: UTF8.self)
    }
}

struct SQLiteRowJSONColumns {
    let entries: [(key: [UInt8], index: Int32)]

    init(_ statement: OpaquePointer) {
        var order: [String] = []
        var lastIndex: [String: Int32] = [:]
        for column in 0..<sqlite3_column_count(statement) {
            let name = String(cString: sqlite3_column_name(statement, column))
            if lastIndex[name] == nil { order.append(name) }
            lastIndex[name] = column
        }
        entries = order.map { name in
            var key: [UInt8] = []
            Array(name.utf8).withUnsafeBufferPointer { _ = SQLiteRowJSON.appendText($0, to: &key) }
            key.append(0x3a)
            return (key, lastIndex[name]!)
        }
    }
}

enum SQLiteRowJSON {
    static let null: [UInt8] = Array("null".utf8)
    private static let hex: [UInt8] = Array("0123456789abcdef".utf8)

    static func appendInteger(_ value: Int64, to output: inout [UInt8]) {
        if value == 0 { output.append(0x30); return }
        if value < 0 { output.append(0x2d) }
        let first = output.count
        var magnitude = value.magnitude
        while magnitude > 0 {
            output.append(0x30 + UInt8(magnitude % 10))
            magnitude /= 10
        }
        output[first...].reverse()
    }

    static func appendDouble(_ value: Double, to output: inout [UInt8]) throws {
        guard value.isFinite else { throw HostFailure("Unsupported SQLite real") }
        if value == value.rounded(), abs(value) < 9_007_199_254_740_992 {
            if value == 0 && value.sign == .minus { output.append(0x2d) }
            appendInteger(Int64(value), to: &output)
            return
        }
        output.append(contentsOf: value.description.utf8)
    }

    static func appendText(_ bytes: UnsafeBufferPointer<UInt8>, to output: inout [UInt8]) -> Bool {
        output.append(0x22)
        var ascii = true
        for byte in bytes {
            switch byte {
            case 0x22: output.append(0x5c); output.append(0x22)
            case 0x5c: output.append(0x5c); output.append(0x5c)
            case 0x0a: output.append(0x5c); output.append(0x6e)
            case 0x0d: output.append(0x5c); output.append(0x72)
            case 0x09: output.append(0x5c); output.append(0x74)
            case 0x08: output.append(0x5c); output.append(0x62)
            case 0x0c: output.append(0x5c); output.append(0x66)
            case 0x00..<0x20:
                output.append(contentsOf: [0x5c, 0x75, 0x30, 0x30, hex[Int(byte >> 4)], hex[Int(byte & 0x0f)]])
            default:
                if byte >= 0x80 { ascii = false }
                output.append(byte)
            }
        }
        output.append(0x22)
        return ascii || String(decoding: bytes, as: UTF8.self).utf8.elementsEqual(bytes)
    }
}
