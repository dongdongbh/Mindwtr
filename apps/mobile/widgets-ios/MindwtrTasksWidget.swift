import AppIntents
import SwiftUI
import WidgetKit

let mindwtrWidgetKind = "MindwtrTasksWidget"
private let mindwtrWidgetAppGroup = "group.tech.dongdongbh.mindwtr"
private let mindwtrWidgetPayloadKey = "mindwtr-ios-widget-payload"
private let mindwtrWidgetPayloadKeySmall = "mindwtr-ios-widget-payload-small"
private let mindwtrWidgetPayloadKeyMedium = "mindwtr-ios-widget-payload-medium"
private let mindwtrWidgetPayloadKeyLarge = "mindwtr-ios-widget-payload-large"
private let mindwtrWidgetPayloadKeyExtraLarge = "mindwtr-ios-widget-payload-extra-large"

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
}

struct MindwtrWidgetSection: Decodable {
    let key: String?
    let title: String
    let detail: String?
    let items: [MindwtrWidgetTaskItem]
}

struct MindwtrWidgetListPayload: Decodable {
    let title: String
    let dateLabel: String?
    let sections: [MindwtrWidgetSection]?
    let items: [MindwtrWidgetTaskItem]?
}

struct MindwtrWidgetSavedFilter: Decodable {
    let id: String
    let name: String
}

struct MindwtrWidgetPalette: Decodable {
    let background: String
    let card: String
    let border: String
    let text: String
    let mutedText: String
    let accent: String
    let onAccent: String
    let warning: String?
    let headerWash: String?
}

extension MindwtrWidgetPalette {
    static let light = MindwtrWidgetPalette(
        background: "#F8FAFC",
        card: "#FFFFFF",
        border: "#CBD5E1",
        text: "#0F172A",
        mutedText: "#475569",
        accent: "#2563EB",
        onAccent: "#FFFFFF",
        warning: "#DC2626",
        headerWash: "#DBEAFE"
    )

    static let dark = MindwtrWidgetPalette(
        background: "#111827",
        card: "#1F2937",
        border: "#374151",
        text: "#F9FAFB",
        mutedText: "#CBD5E1",
        accent: "#2563EB",
        onAccent: "#FFFFFF",
        warning: "#FCA5A5",
        headerWash: "#1E3A5F"
    )
}

struct MindwtrTasksWidgetPayload: Decodable {
    let headerTitle: String
    let subtitle: String
    let dateLabel: String?
    // Optional: payloads written before the field existed may still be cached.
    let focusedCount: Int?
    let items: [MindwtrWidgetTaskItem]
    let sections: [MindwtrWidgetSection]?
    let lists: [String: MindwtrWidgetListPayload]?
    let listTitles: [String: String]?
    let savedFilters: [MindwtrWidgetSavedFilter]?
    let emptyMessage: String
    let captureLabel: String
    let completeLabel: String?
    let undoLabel: String?
    let focusUri: String
    let quickCaptureUri: String
    let themeMode: String?
    let palette: MindwtrWidgetPalette

    static var fallback: MindwtrTasksWidgetPayload {
        MindwtrTasksWidgetPayload(
            headerTitle: "Today's Focus",
            subtitle: "Inbox: 0",
            dateLabel: "Today",
            focusedCount: 0,
            items: [],
            sections: [],
            lists: nil,
            listTitles: nil,
            savedFilters: nil,
            emptyMessage: "No tasks",
            captureLabel: "Quick capture",
            completeLabel: "Complete",
            undoLabel: "Undo",
            focusUri: "mindwtr:///focus",
            quickCaptureUri: "mindwtr:///capture-quick?mode=text",
            themeMode: "system",
            palette: .light
        )
    }

    var resolvedCompleteLabel: String {
        nonEmpty(completeLabel) ?? "Complete"
    }

    var resolvedUndoLabel: String {
        nonEmpty(undoLabel) ?? "Undo"
    }

    func selectingList(_ listId: String) -> MindwtrTasksWidgetPayload {
        let normalizedId = nonEmpty(listId) ?? "focus"
        if let list = lists?[normalizedId] {
            return replacingRoot(
                title: list.title,
                dateLabel: list.dateLabel,
                sections: list.sections ?? [],
                items: list.items ?? []
            )
        }

        if normalizedId != "focus", let title = title(forList: normalizedId) {
            return replacingRoot(title: title, dateLabel: nil, sections: [], items: [])
        }

        return self
    }

    func title(forList listId: String) -> String? {
        nonEmpty(lists?[listId]?.title)
            ?? nonEmpty(listTitles?[listId])
            ?? savedFilters?.first(where: { listId == "filter:\($0.id)" }).flatMap { nonEmpty($0.name) }
    }

    var allTaskItems: [MindwtrWidgetTaskItem] {
        var result = items
        result.append(contentsOf: sections?.flatMap(\.items) ?? [])
        if let lists {
            for list in lists.values {
                result.append(contentsOf: list.items ?? [])
                result.append(contentsOf: list.sections?.flatMap(\.items) ?? [])
            }
        }
        return result
    }

    private func replacingRoot(
        title: String,
        dateLabel: String?,
        sections: [MindwtrWidgetSection],
        items: [MindwtrWidgetTaskItem]
    ) -> MindwtrTasksWidgetPayload {
        MindwtrTasksWidgetPayload(
            headerTitle: nonEmpty(title) ?? headerTitle,
            subtitle: subtitle,
            dateLabel: nonEmpty(dateLabel) ?? self.dateLabel,
            focusedCount: focusedCount,
            items: items,
            sections: sections,
            lists: lists,
            listTitles: listTitles,
            savedFilters: savedFilters,
            emptyMessage: emptyMessage,
            captureLabel: captureLabel,
            completeLabel: completeLabel,
            undoLabel: undoLabel,
            focusUri: focusUri,
            quickCaptureUri: quickCaptureUri,
            themeMode: themeMode,
            palette: palette
        )
    }
}

func nonEmpty(_ value: String?) -> String? {
    guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
        return nil
    }
    return trimmed
}

struct MindwtrTasksWidgetEntry: TimelineEntry {
    let date: Date
    let payload: MindwtrTasksWidgetPayload
    let pendingActions: [MindwtrWidgetPendingAction]
}

struct MindwtrTasksWidgetProvider: TimelineProvider {
    func placeholder(in _: Context) -> MindwtrTasksWidgetEntry {
        MindwtrTasksWidgetEntry(date: Date(), payload: .fallback, pendingActions: [])
    }

    func getSnapshot(in context: Context, completion: @escaping (MindwtrTasksWidgetEntry) -> Void) {
        completion(MindwtrTasksWidgetSnapshotStore.entry(for: context.family))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<MindwtrTasksWidgetEntry>) -> Void) {
        let now = Date()
        let entry = MindwtrTasksWidgetSnapshotStore.entry(for: context.family, date: now)
        let refresh = Calendar.current.date(byAdding: .minute, value: 30, to: now) ?? now.addingTimeInterval(1800)
        completion(Timeline(entries: [entry], policy: .after(refresh)))
    }

}

enum MindwtrTasksWidgetSnapshotStore {
    static func entry(
        for family: WidgetFamily,
        listId: String = "focus",
        date: Date = Date()
    ) -> MindwtrTasksWidgetEntry {
        MindwtrTasksWidgetEntry(
            date: date,
            payload: loadPayload(for: family).selectingList(listId),
            pendingActions: (try? MindwtrWidgetActionStore.appGroupStore().pendingActions()) ?? []
        )
    }

    static func loadPayload(for family: WidgetFamily) -> MindwtrTasksWidgetPayload {
        guard let defaults = UserDefaults(suiteName: mindwtrWidgetAppGroup) else {
            return .fallback
        }

        let payloadKeys = [payloadKey(for: family), mindwtrWidgetPayloadKey]
        for key in payloadKeys {
            guard
                let jsonString = defaults.string(forKey: key),
                let data = jsonString.data(using: .utf8)
            else {
                continue
            }

            do {
                return try JSONDecoder().decode(MindwtrTasksWidgetPayload.self, from: data)
            } catch {
                continue
            }
        }

        return .fallback
    }

    static func currentPayloads() -> [MindwtrTasksWidgetPayload] {
        guard let defaults = UserDefaults(suiteName: mindwtrWidgetAppGroup) else {
            return []
        }

        return payloadKeys.compactMap { key in
            guard
                let jsonString = defaults.string(forKey: key),
                let data = jsonString.data(using: .utf8)
            else {
                return nil
            }
            return try? JSONDecoder().decode(MindwtrTasksWidgetPayload.self, from: data)
        }
    }

    static func contains(taskId: String, completionToken: String) -> Bool {
        guard let taskId = nonEmpty(taskId), let completionToken = nonEmpty(completionToken) else {
            return false
        }
        return currentPayloads().contains { payload in
            payload.allTaskItems.contains { item in
                item.id == taskId && item.completionToken == completionToken
            }
        }
    }

    static var configurationPayload: MindwtrTasksWidgetPayload {
        currentPayloads().first ?? .fallback
    }

    private static let payloadKeys = [
        mindwtrWidgetPayloadKey,
        mindwtrWidgetPayloadKeySmall,
        mindwtrWidgetPayloadKeyMedium,
        mindwtrWidgetPayloadKeyLarge,
        mindwtrWidgetPayloadKeyExtraLarge,
    ]

    private static func payloadKey(for family: WidgetFamily) -> String {
        switch family {
        case .systemSmall:
            return mindwtrWidgetPayloadKeySmall
        case .systemMedium:
            return mindwtrWidgetPayloadKeyMedium
        case .systemLarge:
            return mindwtrWidgetPayloadKeyLarge
        case .systemExtraLarge:
            return mindwtrWidgetPayloadKeyExtraLarge
        default:
            return mindwtrWidgetPayloadKey
        }
    }
}

private struct MindwtrWidgetMetrics {
    let headerSize: CGFloat
    let dateSize: CGFloat
    let sectionSize: CGFloat
    let taskSize: CGFloat
    let detailSize: CGFloat
    let actionSize: CGFloat
    let rowSpacing: CGFloat
    let sectionSpacing: CGFloat
    let padding: CGFloat
    let taskRowVPadding: CGFloat

    var headerHeight: CGFloat {
        max(actionSize, headerSize + dateSize + 2)
    }

    var rowHeight: CGFloat {
        max(actionSize, taskSize + detailSize + 2) + taskRowVPadding * 2 + rowSpacing
    }

    var sectionHeaderHeight: CGFloat {
        sectionSize + sectionSpacing
    }

    func scaled(by scale: CGFloat) -> MindwtrWidgetMetrics {
        MindwtrWidgetMetrics(
            headerSize: headerSize * scale,
            dateSize: dateSize * scale,
            sectionSize: sectionSize * scale,
            taskSize: taskSize * scale,
            detailSize: detailSize * scale,
            actionSize: actionSize * min(scale, 1.2),
            rowSpacing: rowSpacing,
            sectionSpacing: sectionSpacing,
            padding: padding,
            taskRowVPadding: taskRowVPadding
        )
    }

    static func resolve(for family: WidgetFamily) -> MindwtrWidgetMetrics {
        switch family {
        case .systemExtraLarge:
            return MindwtrWidgetMetrics(
                headerSize: 18, dateSize: 12, sectionSize: 12, taskSize: 14,
                detailSize: 11, actionSize: 36, rowSpacing: 3,
                sectionSpacing: 7, padding: 16, taskRowVPadding: 2
            )
        case .systemLarge:
            return MindwtrWidgetMetrics(
                headerSize: 18, dateSize: 12, sectionSize: 12, taskSize: 14,
                detailSize: 11, actionSize: 36, rowSpacing: 3,
                sectionSpacing: 7, padding: 14, taskRowVPadding: 2
            )
        case .systemMedium:
            return MindwtrWidgetMetrics(
                headerSize: 17, dateSize: 11, sectionSize: 11, taskSize: 13,
                detailSize: 10, actionSize: 34, rowSpacing: 2,
                sectionSpacing: 6, padding: 14, taskRowVPadding: 1
            )
        default:
            return MindwtrWidgetMetrics(
                headerSize: 15, dateSize: 10, sectionSize: 10, taskSize: 12,
                detailSize: 9, actionSize: 32, rowSpacing: 1,
                sectionSpacing: 5, padding: 12, taskRowVPadding: 0
            )
        }
    }
}

private struct MindwtrVisibleWidgetSection: Identifiable {
    let id: String
    let title: String?
    let detail: String?
    let items: [MindwtrWidgetTaskItem]
}

private struct MindwtrTasksWidgetView: View {
    let entry: MindwtrTasksWidgetEntry
    @Environment(\.widgetFamily) private var widgetFamily
    @Environment(\.colorScheme) private var colorScheme
    @ScaledMetric(relativeTo: .body) private var typeScale: CGFloat = 1

    var body: some View {
        let payload = entry.payload
        let palette = resolvePalette(payload)
        let metrics = MindwtrWidgetMetrics.resolve(for: widgetFamily).scaled(by: typeScale)
        let columnCount = widgetFamily == .systemExtraLarge ? 2 : 1
        GeometryReader { geometry in
            let hasSourceTasks = !sourceSections(for: payload).isEmpty
            let columns = resolveVisibleColumns(
                payload: payload,
                availableHeight: geometry.size.height,
                metrics: metrics,
                columns: columnCount
            )
            VStack(alignment: .leading, spacing: metrics.sectionSpacing) {
                HStack(alignment: .center, spacing: 8) {
                    if widgetFamily == .systemSmall {
                        widgetHeader(payload: payload, palette: palette, metrics: metrics)
                    } else {
                        Link(destination: safeMindwtrURL(payload.focusUri)) {
                            widgetHeader(payload: payload, palette: palette, metrics: metrics)
                        }
                    }

                    Spacer(minLength: 4)

                    if widgetFamily != .systemSmall {
                        Link(destination: safeMindwtrURL(payload.quickCaptureUri)) {
                            Image(systemName: "plus")
                                .font(.system(size: metrics.taskSize, weight: .bold))
                                .foregroundColor(hexColor(palette.onAccent))
                                .frame(width: metrics.actionSize, height: metrics.actionSize)
                                .background(hexColor(palette.accent))
                                .clipShape(Circle())
                        }
                        .accessibilityLabel(Text(payload.captureLabel))
                    }
                }

                if !hasSourceTasks {
                    if widgetFamily == .systemSmall {
                        Text(payload.emptyMessage)
                            .font(.system(size: metrics.taskSize))
                            .foregroundColor(hexColor(palette.mutedText))
                            .lineLimit(2)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    } else {
                        Link(destination: safeMindwtrURL(payload.focusUri)) {
                            Text(payload.emptyMessage)
                                .font(.system(size: metrics.taskSize))
                                .foregroundColor(hexColor(palette.mutedText))
                                .lineLimit(2)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                } else if !columns.allSatisfy(\.isEmpty), columnCount == 2 {
                    HStack(alignment: .top, spacing: metrics.padding) {
                        widgetColumn(columns[0], payload: payload, palette: palette, metrics: metrics)
                        widgetColumn(columns[1], payload: payload, palette: palette, metrics: metrics)
                    }
                } else if !columns[0].isEmpty {
                    widgetColumn(columns[0], payload: payload, palette: palette, metrics: metrics)
                }

                Spacer(minLength: 0)
            }
            .padding(metrics.padding)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .mindwtrSmallWidgetURL(widgetFamily == .systemSmall ? safeMindwtrURL(payload.focusUri) : nil)
            .mindwtrWidgetBackground(hexColor(palette.background))
        }
    }

    private func widgetHeader(
        payload: MindwtrTasksWidgetPayload,
        palette: MindwtrWidgetPalette,
        metrics: MindwtrWidgetMetrics
    ) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(payload.headerTitle)
                .font(.system(size: metrics.headerSize, weight: .semibold))
                .foregroundColor(hexColor(palette.text))
                .lineLimit(1)
            Text(nonEmpty(payload.dateLabel) ?? payload.subtitle)
                .font(.system(size: metrics.dateSize, weight: .medium))
                .foregroundColor(hexColor(palette.mutedText))
                .lineLimit(1)
        }
    }

    @ViewBuilder
    private func widgetColumn(
        _ sections: [MindwtrVisibleWidgetSection],
        payload: MindwtrTasksWidgetPayload,
        palette: MindwtrWidgetPalette,
        metrics: MindwtrWidgetMetrics
    ) -> some View {
        VStack(alignment: .leading, spacing: metrics.sectionSpacing) {
            ForEach(sections) { section in
                VStack(alignment: .leading, spacing: metrics.rowSpacing) {
                    if let title = section.title {
                        HStack(alignment: .firstTextBaseline, spacing: 5) {
                            Text(title)
                                .font(.system(size: metrics.sectionSize, weight: .semibold))
                                .foregroundColor(hexColor(palette.text))
                                .lineLimit(1)
                            Spacer(minLength: 2)
                            if let detail = nonEmpty(section.detail) {
                                Text(detail)
                                    .font(.system(size: metrics.detailSize, weight: .medium))
                                    .foregroundColor(hexColor(palette.mutedText))
                                    .lineLimit(1)
                            }
                        }
                    }

                    ForEach(section.items, id: \.id) { item in
                        MindwtrWidgetTaskRow(
                            item: item,
                            pendingAction: pendingAction(for: item.id),
                            payload: payload,
                            palette: palette,
                            metrics: metrics,
                            linksTaskDirectly: widgetFamily != .systemSmall
                        )
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
    }

    private func pendingAction(for taskId: String) -> MindwtrWidgetPendingAction? {
        entry.pendingActions.last(where: { $0.taskId == taskId })
    }

    private func sourceSections(for payload: MindwtrTasksWidgetPayload) -> [MindwtrWidgetSection] {
        if let sections = payload.sections, !sections.isEmpty {
            return sections
        }
        guard !payload.items.isEmpty else { return [] }
        return [MindwtrWidgetSection(key: nil, title: "", detail: nil, items: payload.items)]
    }

    private func resolveVisibleColumns(
        payload: MindwtrTasksWidgetPayload,
        availableHeight: CGFloat,
        metrics: MindwtrWidgetMetrics,
        columns columnCount: Int
    ) -> [[MindwtrVisibleWidgetSection]] {
        var columns = Array(repeating: [MindwtrVisibleWidgetSection](), count: max(1, columnCount))
        var columnIndex = 0
        var remainingHeight = max(
            0,
            availableHeight - metrics.padding * 2 - metrics.headerHeight - metrics.sectionSpacing
        )
        let columnHeight = remainingHeight
        var remainingTaskBudget = familyTaskCap

        for (sectionIndex, section) in sourceSections(for: payload).enumerated() {
            var itemIndex = 0
            let sectionTitle = nonEmpty(section.title)
            while itemIndex < section.items.count, columnIndex < columns.count, remainingTaskBudget > 0 {
                let headerCost = sectionTitle == nil ? 0 : metrics.sectionHeaderHeight
                let fittingRows = max(0, Int(floor((remainingHeight - headerCost) / metrics.rowHeight)))
                if fittingRows <= 0 {
                    columnIndex += 1
                    remainingHeight = columnHeight
                    continue
                }

                let take = min(fittingRows, section.items.count - itemIndex, remainingTaskBudget)
                guard take > 0 else { break }
                let items = Array(section.items[itemIndex ..< itemIndex + take])
                columns[columnIndex].append(
                    MindwtrVisibleWidgetSection(
                        id: "\(section.key ?? "section-\(sectionIndex)")-\(columnIndex)-\(itemIndex)",
                        title: sectionTitle,
                        detail: section.detail,
                        items: items
                    )
                )
                itemIndex += take
                remainingTaskBudget -= take
                remainingHeight -= headerCost + CGFloat(take) * metrics.rowHeight + metrics.sectionSpacing

                if itemIndex < section.items.count {
                    columnIndex += 1
                    remainingHeight = columnHeight
                }
            }
            if remainingTaskBudget == 0 || columnIndex >= columns.count { break }
        }

        return columns
    }

    private var familyTaskCap: Int {
        switch widgetFamily {
        case .systemExtraLarge:
            return 24
        case .systemLarge:
            return 12
        case .systemMedium:
            return 5
        default:
            return 3
        }
    }

    // The payload's palette is already the resolved preset/theme colors (built by
    // apps/mobile/lib/widget-data.ts); Swift's job is to decode it, not to
    // re-classify it. Only 'system' (or a blank/legacy payload) needs Swift's
    // own colorScheme, since the JS side can't observe it ahead of render.
    private func resolvePalette(_ payload: MindwtrTasksWidgetPayload) -> MindwtrWidgetPalette {
        let mode = (payload.themeMode ?? "system")
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()

        if mode.isEmpty || mode == "system" {
            return colorScheme == .dark ? .dark : .light
        }

        return payload.palette
    }
}

private struct MindwtrWidgetTaskRow: View {
    let item: MindwtrWidgetTaskItem
    let pendingAction: MindwtrWidgetPendingAction?
    let payload: MindwtrTasksWidgetPayload
    let palette: MindwtrWidgetPalette
    let metrics: MindwtrWidgetMetrics
    let linksTaskDirectly: Bool

    var body: some View {
        HStack(alignment: .center, spacing: 7) {
            MindwtrWidgetTaskAction(
                item: item,
                pendingAction: pendingAction,
                completeLabel: payload.resolvedCompleteLabel,
                undoLabel: payload.resolvedUndoLabel,
                color: item.priorityColor ?? palette.mutedText,
                size: metrics.actionSize
            )

            if linksTaskDirectly {
                Link(destination: safeMindwtrURL(item.openUri ?? payload.focusUri)) {
                    rowText
                }
                .mindwtrPendingAccessibilityValue(
                    pendingAction == nil ? nil : payload.resolvedCompleteLabel
                )
            } else {
                rowText
                    .mindwtrPendingAccessibilityValue(
                        pendingAction == nil ? nil : payload.resolvedCompleteLabel
                    )
            }
        }
        .padding(.vertical, metrics.taskRowVPadding)
    }

    private var rowText: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(item.title)
                .font(.system(size: metrics.taskSize, weight: .medium))
                .foregroundColor(hexColor(palette.text))
                .strikethrough(pendingAction != nil)
                .lineLimit(1)
                .truncationMode(.tail)

            HStack(spacing: 4) {
                if let contextLabel = nonEmpty(item.contextLabel) {
                    if let identityColor = item.identityColor {
                        Circle()
                            .fill(hexColor(identityColor))
                            .frame(width: 5, height: 5)
                            .accessibilityHidden(true)
                    }
                    Text(contextLabel)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }

                Spacer(minLength: 2)

                if let dueLabel = nonEmpty(item.dueLabel) {
                    Text(dueLabel)
                        .foregroundColor(dueColor)
                        .lineLimit(1)
                }
            }
            .font(.system(size: metrics.detailSize, weight: .medium))
            .foregroundColor(hexColor(palette.mutedText))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }

    private var dueColor: Color {
        switch item.dueTone {
        case "overdue":
            return hexColor(palette.warning ?? palette.accent)
        case "today":
            return hexColor(palette.accent)
        default:
            return hexColor(palette.mutedText)
        }
    }
}

private struct MindwtrWidgetTaskAction: View {
    let item: MindwtrWidgetTaskItem
    let pendingAction: MindwtrWidgetPendingAction?
    let completeLabel: String
    let undoLabel: String
    let color: String
    let size: CGFloat

    @ViewBuilder
    var body: some View {
        if let pendingAction, !pendingAction.claimed {
            if #available(iOSApplicationExtension 17.0, iOS 17.0, *) {
                Button(intent: MindwtrUndoWidgetTaskIntent(actionId: pendingAction.id)) {
                    marker(completed: true)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text("\(undoLabel): \(item.title)"))
            } else {
                marker(completed: true)
                    .accessibilityHidden(true)
            }
        } else if pendingAction != nil {
            marker(completed: true)
                .accessibilityHidden(true)
        } else if let completionToken = nonEmpty(item.completionToken), !item.id.isEmpty {
            if #available(iOSApplicationExtension 17.0, iOS 17.0, *) {
                Button(intent: MindwtrCompleteWidgetTaskIntent(taskId: item.id, completionToken: completionToken)) {
                    marker(completed: false)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text("\(completeLabel): \(item.title)"))
            } else {
                marker(completed: false)
                    .accessibilityHidden(true)
            }
        } else {
            marker(completed: false)
                .accessibilityHidden(true)
        }
    }

    private func marker(completed: Bool) -> some View {
        Image(systemName: completed ? "checkmark.circle.fill" : "circle")
            .font(.system(size: min(20, size * 0.68), weight: .semibold))
            .foregroundColor(hexColor(color))
            .frame(width: size, height: size)
            .contentShape(Rectangle())
    }
}

private extension View {
    @ViewBuilder
    func mindwtrPendingAccessibilityValue(_ value: String?) -> some View {
        if let value {
            self.accessibilityValue(Text(value))
        } else {
            self
        }
    }

    @ViewBuilder
    func mindwtrSmallWidgetURL(_ url: URL?) -> some View {
        if let url {
            self.widgetURL(url)
        } else {
            self
        }
    }

    @ViewBuilder
    func mindwtrWidgetBackground(_ color: Color) -> some View {
        if #available(iOSApplicationExtension 17.0, iOS 17.0, *) {
            self.containerBackground(for: .widget) { color }
        } else {
            self.background(color)
        }
    }
}

func safeMindwtrURL(_ rawValue: String) -> URL {
    guard
        let url = URL(string: rawValue),
        url.scheme?.lowercased() == "mindwtr"
    else {
        return URL(string: MindwtrTasksWidgetPayload.fallback.focusUri)!
    }
    return url
}

func hexColor(_ hex: String) -> Color {
    let cleaned = hex.trimmingCharacters(in: CharacterSet.alphanumerics.inverted)
    var int: UInt64 = 0
    Scanner(string: cleaned).scanHexInt64(&int)

    let r: UInt64
    let g: UInt64
    let b: UInt64
    let a: UInt64

    switch cleaned.count {
    case 3:
        (r, g, b, a) = ((int >> 8) * 17, (int >> 4 & 0xF) * 17, (int & 0xF) * 17, 255)
    case 4:
        (r, g, b, a) = ((int >> 12) * 17, (int >> 8 & 0xF) * 17, (int >> 4 & 0xF) * 17, (int & 0xF) * 17)
    case 6:
        (r, g, b, a) = (int >> 16, int >> 8 & 0xFF, int & 0xFF, 255)
    case 8:
        // Supports CSS-style #RRGGBBAA payload values.
        (r, g, b, a) = (int >> 24, int >> 16 & 0xFF, int >> 8 & 0xFF, int & 0xFF)
    default:
        (r, g, b, a) = (15, 23, 42, 255)
    }

    return Color(
        .sRGB,
        red: Double(r) / 255,
        green: Double(g) / 255,
        blue: Double(b) / 255,
        opacity: Double(a) / 255
    )
}

@available(iOSApplicationExtension 17.0, iOS 17.0, *)
struct MindwtrTasksWidget: Widget {
    let kind: String = mindwtrWidgetKind

    var body: some WidgetConfiguration {
        AppIntentConfiguration(
            kind: kind,
            intent: MindwtrTasksWidgetConfigurationIntent.self,
            provider: MindwtrTasksWidgetAppIntentProvider()
        ) { entry in
            MindwtrTasksWidgetView(entry: entry)
        }
        .configurationDisplayName("Mindwtr")
        .description("Focus tasks and quick capture")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .systemExtraLarge])
    }
}

struct MindwtrLegacyTasksWidget: Widget {
    // Preserve installed widgets when upgrading from the static configuration.
    let kind: String = mindwtrWidgetKind

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: MindwtrTasksWidgetProvider()) { entry in
            MindwtrTasksWidgetView(entry: entry)
        }
        .configurationDisplayName("Mindwtr")
        .description("Focus tasks and quick capture")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .systemExtraLarge])
    }
}
