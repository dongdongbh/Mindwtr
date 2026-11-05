import AppIntents
import Foundation
import SwiftUI
import WidgetKit

private struct NativeCaptureWidgetEntry: TimelineEntry {
    let date: Date
}

private struct NativeCaptureWidgetProvider: TimelineProvider {
    func placeholder(in context: Context) -> NativeCaptureWidgetEntry {
        NativeCaptureWidgetEntry(date: Date())
    }

    func getSnapshot(in context: Context, completion: @escaping (NativeCaptureWidgetEntry) -> Void) {
        completion(NativeCaptureWidgetEntry(date: Date()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<NativeCaptureWidgetEntry>) -> Void) {
        completion(Timeline(entries: [NativeCaptureWidgetEntry(date: Date())], policy: .never))
    }
}

private struct NativeCaptureWidgetView: View {
    @Environment(\.widgetFamily) private var family

    var body: some View {
        Button(intent: MindwtrOpenQuickCaptureIntent()) {
            Group {
                if family == .accessoryCircular {
                    ZStack {
                        AccessoryWidgetBackground()
                        Image(systemName: "plus").font(.title2)
                    }
                } else {
                    VStack(spacing: 12) {
                        Image(systemName: "plus.circle.fill")
                            .font(.system(size: 36, weight: .semibold))
                            .widgetAccentable()
                        Text("Add Task")
                            .font(.headline)
                            .multilineTextAlignment(.center)
                    }
                    .padding(8)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text("Add Task"))
        .accessibilityIdentifier("native-capture-widget-open")
        .containerBackground(for: .widget) {
            if family == .systemSmall { Rectangle().fill(.background) }
            else { Color.clear }
        }
    }
}

struct MindwtrNativeCaptureWidget: Widget {
    let kind = "MindwtrNativeCaptureWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: NativeCaptureWidgetProvider()) { _ in
            NativeCaptureWidgetView()
        }
        .configurationDisplayName("Add Task")
        .description("Quick capture")
        .supportedFamilies([.systemSmall, .accessoryCircular])
    }
}

@main
struct MindwtrNativeCaptureWidgets: WidgetBundle {
    var body: some Widget {
        MindwtrNativeCaptureWidget()
        MindwtrNativeNextWidget()
    }
}
