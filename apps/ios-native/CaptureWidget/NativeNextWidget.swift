import Foundation
import SwiftUI
import WidgetKit

private struct NativeNextWidgetEntry: TimelineEntry {
    let date: Date
    let record: NativeWidgetNextCache.Record?
    /// nil means unavailable: keep display, but never offer actions from an unreadable queue.
    let pendingActions: [NativeWidgetPendingAction]?
}

private struct NativeNextWidgetProvider: TimelineProvider {
    func placeholder(in context: Context) -> NativeNextWidgetEntry { NativeNextWidgetEntry(date: Date(), record: nil, pendingActions: nil) }

    func getSnapshot(in context: Context, completion: @escaping (NativeNextWidgetEntry) -> Void) {
        completion(entry())
    }

    private func entry() -> NativeNextWidgetEntry {
        let now = Date()
        return NativeNextWidgetEntry(date: now, record: try? NativeWidgetNextCache.live()?.read(nowMs: now.timeIntervalSince1970 * 1_000),
                                     pendingActions: try? NativeWidgetActionStore.live().pendingActions())
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<NativeNextWidgetEntry>) -> Void) {
        let current = entry()
        guard let record = current.record else {
            completion(Timeline(entries: [current], policy: .never)); return
        }
        let expiration = Date(timeIntervalSince1970: record.expiresAtMs / 1_000)
        let dates = NativeWidgetActionProjection.timelineDates(pendingActions: current.pendingActions ?? [], now: current.date)
        let entries = dates.filter { $0 < expiration }.map {
            NativeNextWidgetEntry(date: $0, record: record, pendingActions: current.pendingActions)
        } + [NativeNextWidgetEntry(date: expiration, record: nil, pendingActions: current.pendingActions)]
        completion(Timeline(entries: entries, policy: .after(expiration)))
    }
}

private struct NativeNextWidgetView: View {
    let entry: NativeNextWidgetEntry
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    private let openApp = URL(string: "mindwtr-native-dev://")!

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let record = entry.record, record.available(at: entry.date.timeIntervalSince1970 * 1_000) {
                HStack {
                    Text(verbatim: record.snapshot.title).font(.headline).lineLimit(1)
                        .accessibilityIdentifier("native-next-widget-title")
                    Spacer(minLength: 4)
                    Text(verbatim: String(record.snapshot.totalCount - hiddenCount(record))).font(.subheadline).foregroundStyle(.secondary)
                }
                if visibleIndices(record).isEmpty {
                    Text(verbatim: record.snapshot.emptyMessage).font(.subheadline).foregroundStyle(.secondary).lineLimit(3)
                    Spacer(minLength: 0)
                } else {
                    ForEach(Array(visibleIndices(record).prefix(dynamicTypeSize.isAccessibilitySize ? 2 : 3)), id: \.self) { index in
                        let item = record.snapshot.items[index]
                        HStack(spacing: 6) {
                            action(record, index: index)
                            if let url = NativeWidgetTaskLink.url(identifier: record.identifiers[index]) {
                                Link(destination: url) { row(item) }
                                    .accessibilityElement(children: .ignore)
                                    .accessibilityLabel(Text(verbatim: [item.title, item.contextLabel, item.dueLabel].compactMap { $0 }.joined(separator: ", ")))
                                    .accessibilityIdentifier("native-next-widget-task-" + item.id)
                            }
                        }
                    }
                    Spacer(minLength: 0)
                }
            } else {
                Text("Next Actions").font(.headline).lineLimit(1)
                    .accessibilityIdentifier("native-next-widget-title")
                Link(destination: openApp) {
                    Text("Open Mindwtr to refresh").font(.subheadline).lineLimit(3)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
                }
                .accessibilityIdentifier("native-next-widget-unavailable")
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .containerBackground(for: .widget) { Rectangle().fill(.background) }
    }

    private func identity(_ record: NativeWidgetNextCache.Record, index: Int) -> NativeWidgetActionIdentity {
        NativeWidgetActionIdentity(identifier: record.identifiers[index], token: record.actions?.tokens[index])
    }

    private func visibleIndices(_ record: NativeWidgetNextCache.Record) -> [Int] {
        record.snapshot.items.indices.filter {
            !NativeWidgetActionProjection.isHidden(identity(record, index: $0), by: entry.pendingActions ?? [], at: entry.date)
        }
    }

    private func hiddenCount(_ record: NativeWidgetNextCache.Record) -> Int {
        record.snapshot.items.count - visibleIndices(record).count
    }

    @ViewBuilder
    private func action(_ record: NativeWidgetNextCache.Record, index: Int) -> some View {
        if let actions = record.actions, let pending = entry.pendingActions, let token = actions.tokens[index] {
            let item = record.snapshot.items[index]
            if let queued = NativeWidgetActionProjection.pendingAction(for: identity(record, index: index), in: pending, at: entry.date) {
                Button(intent: NativeUndoWidgetTaskIntent(actionID: queued.id)) {
                    Image(systemName: "checkmark.circle.fill").frame(minWidth: 36, minHeight: 36)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text(verbatim: actions.undoLabel + ": " + item.title))
                .accessibilityIdentifier("native-next-widget-undo-" + queued.id)
            } else {
                Button(intent: NativeCompleteWidgetTaskIntent(identifier: record.identifiers[index], completionToken: token)) {
                    Image(systemName: "circle").frame(minWidth: 36, minHeight: 36)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text(verbatim: actions.completeLabel + ": " + item.title))
                .accessibilityIdentifier("native-next-widget-complete-" + item.id)
            }
        }
    }

    private func row(_ item: NativeWidgetNextSnapshot.Item) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(verbatim: item.title).font(.subheadline.weight(.medium)).foregroundStyle(.primary).lineLimit(1)
            if item.contextLabel != nil || item.dueLabel != nil {
                HStack(spacing: 4) {
                    if let context = item.contextLabel { Text(verbatim: context).foregroundStyle(.secondary).lineLimit(1) }
                    Spacer(minLength: 2)
                    if let due = item.dueLabel { Text(verbatim: due).foregroundStyle(dueColor(item.dueTone)).lineLimit(1).layoutPriority(1) }
                }
                .font(.caption)
            }
        }
        .frame(maxWidth: .infinity, minHeight: 36, alignment: .leading)
        .contentShape(Rectangle())
    }

    private func dueColor(_ tone: NativeWidgetNextSnapshot.DueTone) -> Color {
        switch tone {
        case .overdue: return .red
        case .today: return .accentColor
        case .normal: return .secondary
        }
    }
}

struct MindwtrNativeNextWidget: Widget {
    let kind = NativeWidgetNextCache.kind
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: NativeNextWidgetProvider()) { entry in NativeNextWidgetView(entry: entry) }
            .configurationDisplayName("Next Actions")
            .description("Next Actions")
            .supportedFamilies([.systemMedium])
    }
}
