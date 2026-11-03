import AppIntents
import SwiftUI
import WidgetKit

private let mindwtrCaptureLockWidgetKind = "MindwtrCaptureLockWidget"
private let mindwtrCaptureControlKind = "MindwtrCaptureControl"


struct MindwtrCaptureLockWidget: Widget {
    let kind: String = mindwtrCaptureLockWidgetKind

    private var families: [WidgetFamily] {
        if #available(iOSApplicationExtension 16.0, *) {
            return [.accessoryRectangular, .accessoryInline, .accessoryCircular]
        }
        return []
    }

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: MindwtrTasksWidgetProvider()) { entry in
            MindwtrCaptureLockWidgetEntryView(entry: entry)
        }
        .configurationDisplayName("Add Task")
        .description("Open quick capture")
        .supportedFamilies(families)
    }
}

private struct MindwtrCaptureLockWidgetEntryView: View {
    let entry: MindwtrTasksWidgetEntry

    var body: some View {
        if #available(iOSApplicationExtension 16.0, *) {
            MindwtrCaptureLockView(entry: entry)
        } else {
            EmptyView()
        }
    }
}


@available(iOSApplicationExtension 16.0, *)
private struct MindwtrCaptureLockView: View {
    let entry: MindwtrTasksWidgetEntry
    @Environment(\.widgetFamily) private var widgetFamily

    var body: some View {
        content
            .widgetURL(URL(string: entry.payload.quickCaptureUri) ?? URL(fileURLWithPath: "/"))
            .mindwtrCaptureLockWidgetBackground()
    }

    @ViewBuilder
    private var content: some View {
        switch widgetFamily {
        case .accessoryInline:
            Label {
                Text(entry.payload.captureLabel)
            } icon: {
                Image(systemName: "plus")
            }

        case .accessoryCircular:
            ZStack {
                AccessoryWidgetBackground()
                Image(systemName: "plus")
                    .font(.system(size: 20, weight: .semibold))
            }

        default:
            HStack(spacing: 6) {
                Image(systemName: "plus.circle.fill")
                    .font(.system(size: 18, weight: .semibold))
                Text(entry.payload.captureLabel)
                    .font(.system(size: 14, weight: .semibold))
                    .lineLimit(2)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        }
    }
}


@available(iOSApplicationExtension 18.0, iOS 18.0, *)
struct MindwtrCaptureControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: mindwtrCaptureControlKind) {
            ControlWidgetButton(action: MindwtrOpenQuickCaptureIntent()) {
                Label("Add Task", systemImage: "square.and.pencil")
            }
        }
        .displayName("Add Task")
        .description("Open Mindwtr quick capture")
    }
}


@available(iOSApplicationExtension 18.0, iOS 18.0, *)
struct MindwtrOpenQuickCaptureIntent: AppIntent {
    static var title: LocalizedStringResource { "Add Task" }
    static var description: IntentDescription { IntentDescription("Opens Mindwtr quick capture.") }

#if compiler(>=6.0)
    @available(iOS 26.0, *)
    static var supportedModes: IntentModes {
        .foreground(.immediate)
    }
#endif

    @available(*, deprecated, message: "Use supportedModes with newer App Intents SDKs.")
    static var openAppWhenRun: Bool {
        true
    }

    @MainActor
    func perform() async throws -> some IntentResult {
        .result()
    }
}

private extension View {
    @ViewBuilder
    func mindwtrCaptureLockWidgetBackground() -> some View {
        if #available(iOSApplicationExtension 17.0, *) {
            self.containerBackground(for: .widget) { Color.clear }
        } else {
            self
        }
    }
}
