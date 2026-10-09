import CoreFoundation
import Foundation

/// A frozen provider witness is not ownership; the caller still requires the exact owner and a successful read.
enum NativeCalendarPushWitness {
    static func markCreateEvent(requestJSON: String, id: UUID) throws -> String {
        do {
            guard case .createEvent(_, let details) = try NativeCalendarWriteRequest(json: requestJSON),
                  !containsMarker(details.notes, id: id),
                  var request = try NativeJSON.jsonObject(with: Data(requestJSON.utf8)) as? [String: Any],
                  var fields = request["details"] as? [String: Any] else { throw NativeCalendarWriteError.invalid }
            fields["notes"] = details.notes + marker(id)
            request["details"] = fields
            let data = try JSONSerialization.data(withJSONObject: request, options: [.sortedKeys])
            guard data.count <= NativeCalendarJobs.maximumRequestBytes else { throw NativeCalendarWriteError.invalid }
            let marked = String(decoding: data, as: UTF8.self)
            _ = try NativeCalendarWriteRequest(json: marked)
            return marked
        } catch { throw NativeCalendarWriteError.invalid }
    }

    static func createdEvent(effect: NativeCalendarPushEffect, events: [[String: Any]]) throws -> String {
        guard effect.phase == .started, case .createEvent(let calendarID, let details) = effect.request,
              details.notes.utf8.suffix(marker(effect.id).utf8.count).elementsEqual(marker(effect.id).utf8),
              events.count <= 10_000 else { throw NativeCalendarWriteError.invalid }
        let candidates = events.filter {
            guard let calendar = $0["calendarId"] as? String, let notes = $0["notes"] as? String else { return false }
            return NativeCalendarWriteValidation.equalID(calendar, calendarID) && containsMarker(notes, id: effect.id)
        }
        guard candidates.count <= 1 else { throw NativeCalendarWriteError.ambiguous }
        guard let row = candidates.first else { throw NativeCalendarWriteError.unavailable }
        let id = try text(row, "id"), title = try text(row, "title"), notes = try text(row, "notes")
        let location = try text(row, "location"), url = try optionalURL(row)
        let allDay = try boolean(row, "allDay"), recurring = try boolean(row, "isRecurring")
        let start = try instant(row, "startDate"), end = try instant(row, "endDate")
        guard NativeCalendarWriteValidation.id(id) else { throw NativeCalendarWriteError.invalid }
        guard NativeCalendarWriteValidation.equalID(title, details.title),
              NativeCalendarWriteValidation.equalID(notes, details.notes),
              NativeCalendarWriteValidation.equalID(location, details.location),
              url.map({ Data($0.utf8) }) == details.url.map({ Data($0.utf8) }),
              allDay == details.allDay, !recurring,
              milliseconds(start) == milliseconds(details.start), milliseconds(end) == milliseconds(details.end) else {
            throw NativeCalendarWriteError.unavailable
        }
        return id
    }

    static func createdCalendar(effect: NativeCalendarPushEffect, calendars: [[String: Any]]) throws -> String {
        guard effect.phase == .started, case .createCalendar(let details) = effect.request,
              details.title.hasPrefix("Mindwtr ("), details.title.hasSuffix(")"),
              let titleID = UUID(uuidString: String(details.title.dropFirst(9).dropLast())),
              NativeCalendarWriteValidation.equalID(details.title, "Mindwtr (\(titleID.uuidString.lowercased()))") else {
            throw NativeCalendarWriteError.invalid
        }
        let candidates = calendars.filter {
            guard let title = $0["title"] as? String, let source = $0["source"] as? [String: Any],
                  let sourceID = source["id"] as? String else { return false }
            return NativeCalendarWriteValidation.equalID(title, details.title) &&
                NativeCalendarWriteValidation.equalID(sourceID, details.sourceID)
        }
        guard candidates.count <= 1 else { throw NativeCalendarWriteError.ambiguous }
        guard let row = candidates.first else { throw NativeCalendarWriteError.unavailable }
        let id = try text(row, "id"), color = try text(row, "color")
        let writable = try boolean(row, "allowsModifications")
        guard NativeCalendarWriteValidation.id(id), NativeCalendarWriteValidation.color(color) else {
            throw NativeCalendarWriteError.invalid
        }
        guard writable, color.uppercased() == details.color.uppercased() else { throw NativeCalendarWriteError.unavailable }
        return id
    }

    private static func marker(_ id: UUID) -> String {
        "\n\n[Mindwtr native calendar operation: \(id.uuidString.lowercased())]"
    }
    private static func containsMarker(_ notes: String, id: UUID) -> Bool {
        Data(notes.utf8).range(of: Data(marker(id).utf8)) != nil
    }
    private static func text(_ row: [String: Any], _ name: String) throws -> String {
        guard let value = row[name] as? String else { throw NativeCalendarWriteError.invalid }
        return value
    }
    private static func boolean(_ row: [String: Any], _ name: String) throws -> Bool {
        guard let value = row[name] as? NSNumber, CFGetTypeID(value) == CFBooleanGetTypeID() else {
            throw NativeCalendarWriteError.invalid
        }
        return value.boolValue
    }
    private static func optionalURL(_ row: [String: Any]) throws -> String? {
        if row["url"] == nil || row["url"] is NSNull { return nil }
        return try text(row, "url")
    }
    private static func instant(_ row: [String: Any], _ name: String) throws -> Date {
        let raw = try text(row, name), formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var date = formatter.date(from: raw)
        if date == nil {
            formatter.formatOptions = [.withInternetDateTime]
            date = formatter.date(from: raw)
        }
        guard let date, NativeCalendarEventOpenRequest.validDate(date) else { throw NativeCalendarWriteError.invalid }
        return date
    }
    private static func milliseconds(_ date: Date) -> Int64 {
        Int64((date.timeIntervalSince1970 * 1000).rounded())
    }
}
