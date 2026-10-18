import Foundation

// Shared by the WidgetKit templates and the Foundation-only widget tests.
struct MindwtrWidgetTaskItem: Decodable {
    let id: String
    let title: String
    let statusLabel: String?
    let dueLabel: String?
    let dueTone: String?
    let openUri: String?
    let priorityColor: String?
    let contextLabel: String?
    let identityColor: String?
    let completionToken: String?
    // Optional so cached payloads from older app versions still decode.
    let contexts: [String]?
    let upcomingDate: String?
    let upcomingLabel: String?

    var isUpcomingPreview: Bool { upcomingDate != nil }

    var displayDueLabel: String? {
        MindwtrWidgetUpcomingProjection.label(date: upcomingDate, prefix: upcomingLabel) ?? dueLabel
    }

    var contextsLabel: String? {
        let labels = (contexts ?? []).compactMap(Self.nonEmpty)
        return labels.isEmpty ? nil : labels.joined(separator: " ")
    }

    var detailLabel: String? {
        let labels = [contextsLabel, Self.nonEmpty(contextLabel)].compactMap { $0 }
        return labels.isEmpty ? nil : labels.joined(separator: " · ")
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
            return nil
        }
        return trimmed
    }
}

// Cached previews expire by local day even when the app has not republished.
enum MindwtrWidgetUpcomingProjection {
    static func isVisible(_ value: String?, at now: Date, calendar: Calendar = .current) -> Bool {
        guard let value, let date = parsedDate(value, calendar: calendar),
              let tomorrow = calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: now)),
              let windowEnd = calendar.date(byAdding: .day, value: 8, to: calendar.startOfDay(for: now))
        else { return false }
        return date >= tomorrow && date < windowEnd
    }

    static func timelineDates(now: Date, calendar: Calendar = .current) -> [Date] {
        (1...7).compactMap { calendar.date(byAdding: .day, value: $0, to: calendar.startOfDay(for: now)) }
    }

    static func label(
        date value: String?, prefix: String?, calendar: Calendar = .current, locale: Locale = .current
    ) -> String? {
        guard let value, let prefix, let date = parsedDate(value, calendar: calendar) else { return nil }
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.calendar = calendar
        formatter.timeZone = calendar.timeZone
        formatter.dateStyle = .medium
        formatter.timeStyle = value.contains("T") ? .short : .none
        formatter.doesRelativeDateFormatting = false
        return "\(prefix) \(formatter.string(from: date))"
    }

    private static func parsedDate(_ value: String, calendar: Calendar) -> Date? {
        guard value.range(
            of: #"^[0-9]{4}-[0-9]{2}-[0-9]{2}(?:T(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9](?:\.[0-9]{1,9})?)?(?:Z|[+-](?:[01][0-9]|2[0-3]):?[0-5][0-9])?)?$"#,
            options: .regularExpression
        ) != nil else { return nil }
        let parts = value.prefix(10).split(separator: "-").compactMap { Int($0) }
        var localCalendar = Calendar(identifier: .gregorian)
        localCalendar.timeZone = calendar.timeZone
        let components = DateComponents(year: parts[0], month: parts[1], day: parts[2])
        guard let localDate = localCalendar.date(from: components),
              localCalendar.component(.year, from: localDate) == parts[0],
              localCalendar.component(.month, from: localDate) == parts[1],
              localCalendar.component(.day, from: localDate) == parts[2]
        else { return nil }
        if value.range(of: #"^[0-9]{4}-[0-9]{2}-[0-9]{2}$"#, options: .regularExpression) != nil {
            return localDate
        }
        if value.range(
            of: #"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(?::[0-9]{2}(?:\.[0-9]{1,9})?)?$"#,
            options: .regularExpression
        ) != nil {
            let formatter = DateFormatter()
            formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.calendar = Calendar(identifier: .gregorian)
            formatter.timeZone = calendar.timeZone
            formatter.isLenient = false
            formatter.dateFormat = value.contains(".") ? "yyyy-MM-dd'T'HH:mm:ss.SSSSSSSSS"
                : (value.count == 16 ? "yyyy-MM-dd'T'HH:mm" : "yyyy-MM-dd'T'HH:mm:ss")
            return formatter.date(from: value)
        }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: value) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: value)
    }
}

enum MindwtrCompactTaskLayout {
    // Context-bearing rows have one extra line. Budget those rows individually
    // so bare tasks keep the compact widget's existing density at every size.
    static func visibleTaskCount(
        items: [MindwtrWidgetTaskItem],
        availableHeight: Double,
        titleRowHeight: Double,
        contextRowHeight: Double,
        rowSpacing: Double,
        limit: Int
    ) -> Int {
        var remaining = max(0, availableHeight)
        var count = 0
        for item in items.prefix(max(0, limit)) {
            let height = titleRowHeight + (item.contextsLabel == nil ? 0 : contextRowHeight)
            let cost = height + (count == 0 ? 0 : rowSpacing)
            guard cost <= remaining else { break }
            remaining -= cost
            count += 1
        }
        return count
    }
}
