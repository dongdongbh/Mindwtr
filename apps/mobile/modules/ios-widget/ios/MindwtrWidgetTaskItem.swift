import Foundation

// Shared by the WidgetKit templates and the Foundation-only widget tests.
struct MindwtrWidgetTaskItem: Decodable {
    let id: String
    let title: String
    let statusLabel: String?
    let showStatus: Bool?
    var dueLabel: String?
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

    /// An Upcoming row relabeled for the day `now` falls on; other rows, and
    /// payloads cached before the day words existed, keep the published label.
    func relabeled(
        days: MindwtrWidgetUpcomingDays?, now: Date, calendar: Calendar = .current, locale: Locale = .current
    ) -> MindwtrWidgetTaskItem {
        guard let days, let label = MindwtrWidgetUpcomingProjection.label(
            date: upcomingDate, prefix: upcomingLabel, days: days, now: now, calendar: calendar, locale: locale
        ) else { return self }
        var copy = self
        copy.dueLabel = label
        return copy
    }

    var contextsLabel: String? {
        let labels = (contexts ?? []).compactMap(Self.nonEmpty)
        return labels.isEmpty ? nil : labels.joined(separator: " ")
    }

    var detailLabel: String? {
        let labels = [showStatus == true ? Self.nonEmpty(statusLabel) : nil, contextsLabel, Self.nonEmpty(contextLabel)].compactMap { $0 }
        return labels.isEmpty ? nil : labels.joined(separator: " · ")
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
            return nil
        }
        return trimmed
    }
}

/// Core's relative-day words (#1455); weekdays are short names, Sunday first.
struct MindwtrWidgetUpcomingDays: Decodable {
    let today: String
    let tomorrow: String
    let weekdays: [String]
    let dayFirst: Bool
}

// Core's formatRelativeDayLabel at render time, so a cached row rolls over at
// local midnight and follows a timezone change.
enum MindwtrWidgetUpcomingProjection {
    static func label(
        date value: String?, prefix: String?, days: MindwtrWidgetUpcomingDays, now: Date,
        calendar: Calendar = .current, locale: Locale = .current
    ) -> String? {
        guard let value, let prefix, days.weekdays.count == 7,
              let date = parsedDate(value, calendar: calendar) else { return nil }
        var gregorian = Calendar(identifier: .gregorian)
        gregorian.timeZone = calendar.timeZone
        guard let ahead = gregorian.dateComponents(
            [.day], from: gregorian.startOfDay(for: now), to: gregorian.startOfDay(for: date)
        ).day else { return nil }
        let parts = gregorian.dateComponents([.month, .day, .weekday], from: date)
        let day: String
        switch ahead {
        case 0: day = days.today
        case 1: day = days.tomorrow
        case 2...6: day = days.weekdays[(parts.weekday ?? 1) - 1]
        default:
            let month = parts.month ?? 0, dayOfMonth = parts.day ?? 0
            day = days.dayFirst ? "\(dayOfMonth)/\(month)" : "\(month)/\(dayOfMonth)"
        }
        guard value.contains("T") else { return "\(prefix) \(day)" }
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.timeZone = calendar.timeZone
        formatter.dateStyle = .none
        formatter.timeStyle = .short
        return "\(prefix) \(day) \(formatter.string(from: date))"
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
