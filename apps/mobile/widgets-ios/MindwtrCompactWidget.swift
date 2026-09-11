import SwiftUI
import WidgetKit

let mindwtrCompactWidgetKind = "MindwtrCompactWidget"

private struct MindwtrCompactWidgetView: View {
    let entry: MindwtrTasksWidgetEntry
    @Environment(\.widgetFamily) private var widgetFamily
    @Environment(\.colorScheme) private var colorScheme
    @ScaledMetric(relativeTo: .body) private var typeScale: CGFloat = 1

    var body: some View {
        let payload = entry.payload
        let palette = resolvedPalette(payload)
        let metrics = MindwtrCompactMetrics.resolve(for: widgetFamily, typeScale: typeScale)
        GeometryReader { geometry in
            let sourceItems = focusItems(payload)
            let items = Array(sourceItems.prefix(visibleTaskLimit(
                itemCount: sourceItems.count,
                height: geometry.size.height,
                metrics: metrics
            )))

            VStack(alignment: .leading, spacing: metrics.spacing) {
                HStack(alignment: .center, spacing: 8) {
                    if widgetFamily == .systemSmall {
                        compactHeader(payload: payload, palette: palette, metrics: metrics)
                    } else {
                        Link(destination: safeMindwtrURL(payload.focusUri)) {
                            compactHeader(payload: payload, palette: palette, metrics: metrics)
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

                if sourceItems.isEmpty {
                    Text(payload.emptyMessage)
                        .font(.system(size: metrics.taskSize))
                        .foregroundColor(hexColor(palette.mutedText))
                        .lineLimit(2)
                } else if !items.isEmpty {
                    VStack(alignment: .leading, spacing: metrics.rowSpacing) {
                        ForEach(items, id: \.id) { item in
                            if widgetFamily == .systemSmall {
                                compactRow(item, palette: palette, metrics: metrics)
                            } else {
                                Link(destination: safeMindwtrURL(item.openUri ?? payload.focusUri)) {
                                    compactRow(item, palette: palette, metrics: metrics)
                                }
                            }
                        }
                    }
                }

                Spacer(minLength: 0)
            }
            .padding(metrics.padding)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .mindwtrCompactWidgetURL(widgetFamily == .systemSmall ? safeMindwtrURL(payload.focusUri) : nil)
            .mindwtrCompactBackground(hexColor(palette.background))
        }
    }

    private func compactHeader(
        payload: MindwtrTasksWidgetPayload,
        palette: MindwtrWidgetPalette,
        metrics: MindwtrCompactMetrics
    ) -> some View {
        VStack(alignment: .leading, spacing: 1) {
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

    private func focusItems(_ payload: MindwtrTasksWidgetPayload) -> [MindwtrWidgetTaskItem] {
        if let sections = payload.sections, !sections.isEmpty {
            return sections.flatMap(\.items)
        }
        return payload.items
    }

    private func visibleTaskLimit(
        itemCount: Int,
        height: CGFloat,
        metrics: MindwtrCompactMetrics
    ) -> Int {
        guard itemCount > 0 else { return 0 }
        let available = max(0, height - metrics.padding * 2 - metrics.headerHeight - metrics.spacing)
        let fit = max(
            0,
            Int(floor((available + metrics.rowSpacing) / (metrics.rowHeight + metrics.rowSpacing)))
        )
        return min(itemCount, min(familyTaskCap, fit))
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

    private func compactRow(
        _ item: MindwtrWidgetTaskItem,
        palette: MindwtrWidgetPalette,
        metrics: MindwtrCompactMetrics
    ) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 5) {
            Text("•")
                .foregroundColor(hexColor(item.priorityColor ?? palette.mutedText))
                .accessibilityHidden(true)
            Text(item.title)
                .font(.system(size: metrics.taskSize))
                .foregroundColor(hexColor(palette.text))
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(minHeight: metrics.rowHeight)
        .contentShape(Rectangle())
    }

    private func resolvedPalette(_ payload: MindwtrTasksWidgetPayload) -> MindwtrWidgetPalette {
        let mode = (payload.themeMode ?? "system")
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        if mode.isEmpty || mode == "system" {
            return colorScheme == .dark ? .dark : .light
        }
        return payload.palette
    }
}

private struct MindwtrCompactMetrics {
    let headerSize: CGFloat
    let dateSize: CGFloat
    let taskSize: CGFloat
    let actionSize: CGFloat
    let spacing: CGFloat
    let rowSpacing: CGFloat
    let padding: CGFloat

    var headerHeight: CGFloat {
        max(actionSize, headerSize + dateSize + 1)
    }

    var rowHeight: CGFloat {
        taskSize + rowSpacing + 3
    }

    static func resolve(for family: WidgetFamily, typeScale: CGFloat) -> MindwtrCompactMetrics {
        let base: MindwtrCompactMetrics
        switch family {
        case .systemExtraLarge:
            base = MindwtrCompactMetrics(
                headerSize: 16, dateSize: 11, taskSize: 13, actionSize: 28,
                spacing: 6, rowSpacing: 2, padding: 14
            )
        case .systemLarge:
            base = MindwtrCompactMetrics(
                headerSize: 16, dateSize: 11, taskSize: 13, actionSize: 28,
                spacing: 6, rowSpacing: 2, padding: 13
            )
        case .systemMedium:
            base = MindwtrCompactMetrics(
                headerSize: 15, dateSize: 10, taskSize: 12, actionSize: 26,
                spacing: 5, rowSpacing: 1, padding: 12
            )
        default:
            base = MindwtrCompactMetrics(
                headerSize: 14, dateSize: 9, taskSize: 11, actionSize: 24,
                spacing: 4, rowSpacing: 1, padding: 11
            )
        }
        return MindwtrCompactMetrics(
            headerSize: base.headerSize * typeScale,
            dateSize: base.dateSize * typeScale,
            taskSize: base.taskSize * typeScale,
            actionSize: base.actionSize * min(typeScale, 1.2),
            spacing: base.spacing,
            rowSpacing: base.rowSpacing,
            padding: base.padding
        )
    }
}

private extension View {
    @ViewBuilder
    func mindwtrCompactWidgetURL(_ url: URL?) -> some View {
        if let url {
            self.widgetURL(url)
        } else {
            self
        }
    }

    @ViewBuilder
    func mindwtrCompactBackground(_ color: Color) -> some View {
        if #available(iOSApplicationExtension 17.0, *) {
            self.containerBackground(for: .widget) { color }
        } else {
            self.background(color)
        }
    }
}

struct MindwtrCompactWidget: Widget {
    let kind: String = mindwtrCompactWidgetKind

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: MindwtrTasksWidgetProvider()) { entry in
            MindwtrCompactWidgetView(entry: entry)
        }
        .configurationDisplayName("Compact")
        .description("A compact Mindwtr Focus list")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .systemExtraLarge])
    }
}
