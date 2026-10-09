import Foundation
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
        // A failed prewrite check must not checkpoint or delete the original WAL
        // during last-connection teardown. Apply and verify before the first read.
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
        // SQLite error text may contain stored data or paths; expose only its code.
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
        // Backup copies the source's WAL header. Only this new destination must
        // become a standalone file before rename; otherwise a later read-only
        // open can fail without its WAL sidecars.
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(connection, "PRAGMA journal_mode = DELETE", -1, &statement, nil) == SQLITE_OK else {
            throw HostFailure("Cannot finalize prewrite recovery checkpoint")
        }
        defer { sqlite3_finalize(statement) }
        guard sqlite3_step(statement) == SQLITE_ROW,
              let text = sqlite3_column_text(statement, 0), String(cString: text) == "delete",
              sqlite3_step(statement) == SQLITE_DONE else { throw HostFailure("Cannot finalize prewrite recovery checkpoint") }
    }

    /// The backup API includes committed WAL pages in one consistent snapshot.
    /// Nothing from core executes until the original snapshot is durably promoted.
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

    /// The push owner persists its acknowledging effect before this call, then clears it after success.
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
            // A committed mapping with a lost reply is already acknowledged; never write it again.
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

    func execute(_ sql: String, parametersJSON: String = "[]") throws -> String {
        #if DEBUG
        try faults?.beforeSQL?(sql)
        #endif
        guard let parameters = try NativeJSON.jsonObject(with: Data(parametersJSON.utf8)) as? [Any] else {
            throw HostFailure("SQLite parameters must be an array")
        }
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
            throw failure("prepare")
        }
        defer { sqlite3_finalize(statement) }
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
        var rows: [[String: Any]] = []
        while true {
            let result = sqlite3_step(statement)
            if result == SQLITE_DONE { break }
            guard result == SQLITE_ROW else { throw failure("step") }
            var row: [String: Any] = [:]
            for column in 0..<sqlite3_column_count(statement) {
                let name = String(cString: sqlite3_column_name(statement, column))
                switch sqlite3_column_type(statement, column) {
                case SQLITE_NULL: row[name] = NSNull()
                case SQLITE_INTEGER: row[name] = sqlite3_column_int64(statement, column)
                case SQLITE_FLOAT: row[name] = sqlite3_column_double(statement, column)
                case SQLITE_TEXT:
                    let count = Int(sqlite3_column_bytes(statement, column))
                    let data = Data(bytes: sqlite3_column_text(statement, column)!, count: count)
                    // Foundation's Data-to-String initializer discards a leading UTF-8 BOM.
                    // Decode without that normalization and reject replacement decoding.
                    let text = String(decoding: data, as: UTF8.self)
                    guard text.utf8.elementsEqual(data) else { throw HostFailure("Invalid SQLite text") }
                    if !loggedLeadingBOM && data.starts(with: [0xEF, 0xBB, 0xBF]) {
                        loggedLeadingBOM = true
                        NSLog("Native iOS SQLite text preserved leading BOM releaseCheck=v1.3.3/native-ios-sqlite-leading-bom outcome=preserved")
                    }
                    row[name] = text
                default: throw HostFailure("Unsupported SQLite column")
                }
            }
            rows.append(row)
        }
        #if DEBUG
        try faults?.afterSQL?(sql)
        #endif
        return String(decoding: try JSONSerialization.data(withJSONObject: rows), as: UTF8.self)
    }
}
