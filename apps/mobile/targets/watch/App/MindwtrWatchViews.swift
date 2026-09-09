import SwiftUI

enum MindwtrWatchTab: Hashable {
    case capture
    case focus
    case pomodoro
}

struct MindwtrWatchRootView: View {
    @EnvironmentObject private var model: MindwtrWatchConnectivityModel
    @Environment(\.scenePhase) private var scenePhase
    @State private var selection: MindwtrWatchTab = .capture

    var body: some View {
        TabView(selection: $selection) {
            MindwtrCaptureView()
                .tag(MindwtrWatchTab.capture)
            MindwtrFocusView()
                .tag(MindwtrWatchTab.focus)
            MindwtrPomodoroView()
                .tag(MindwtrWatchTab.pomodoro)
        }
        .tabViewStyle(.verticalPage)
        .onAppear {
            model.activate()
            if MindwtrWatchSnapshotStore.consumeCaptureRequest() { selection = .capture }
        }
        .onOpenURL { url in
            switch url.host {
            case "focus": selection = .focus
            case "pomodoro": selection = .pomodoro
            default: selection = .capture
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .mindwtrWatchOpenCapture)) { _ in
            selection = .capture
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { model.replayPendingOutbox() }
        }
    }
}

private struct MindwtrCaptureView: View {
    @EnvironmentObject private var model: MindwtrWatchConnectivityModel
    @StateObject private var audioRecorder = MindwtrWatchAudioRecorder()

    var body: some View {
        ScrollView {
            VStack(spacing: 10) {
                Image(systemName: "drop.fill")
                    .font(.title2)
                    .foregroundStyle(.cyan)
                    .accessibilityHidden(true)
                Text("Capture")
                    .font(.headline)

                Button {
                    audioRecorder.toggle(using: model)
                } label: {
                    Label(
                        audioRecorder.isRecording
                            ? "Send recording"
                            : audioRecorder.hasPendingRecording ? "Retry recording" : "Speak to Capture",
                        systemImage: audioRecorder.isRecording
                            ? "stop.circle.fill"
                            : audioRecorder.hasPendingRecording ? "arrow.clockwise" : "mic.fill"
                    )
                }
                .buttonStyle(.borderedProminent)
                .tint(audioRecorder.isRecording ? .red : .cyan)

                TextFieldLink(prompt: Text("What’s on your mind?")) {
                    Label("Type", systemImage: "keyboard")
                } onSubmit: { model.capture(text: $0) }
                .buttonStyle(.bordered)

                if model.rejectedCaptureDraft != nil {
                    TextField(
                        "Edit capture",
                        text: Binding(
                            get: { model.rejectedCaptureDraft ?? "" },
                            set: { model.rejectedCaptureDraft = $0 }
                        )
                    )
                    .privacySensitive()
                    Button("Resend capture") {
                        model.capture(text: model.rejectedCaptureDraft ?? "")
                    }
                    .font(.caption)
                }

                if let message = audioRecorder.errorMessage ?? model.statusMessage {
                    Text(message)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
            }
            .padding(.horizontal, 6)
        }
        .containerBackground(.black.gradient, for: .tabView)
        .accessibilityElement(children: .contain)
    }
}

private struct MindwtrFocusView: View {
    @EnvironmentObject private var model: MindwtrWatchConnectivityModel

    var body: some View {
        NavigationStack {
            List {
                if model.snapshot.focus.isEmpty {
                    ContentUnavailableView(
                        "Focus is clear",
                        systemImage: "checkmark.circle",
                        description: Text("Choose Focus tasks on your iPhone.")
                    )
                } else {
                    ForEach(model.snapshot.focus) { task in
                        NavigationLink(value: task) {
                            Text(task.title)
                                .lineLimit(2)
                                .privacySensitive()
                        }
                    }
                }
            }
            .navigationTitle("Focus")
            .navigationDestination(for: MindwtrWatchFocusTask.self) { task in
                MindwtrFocusTaskView(task: task)
            }
        }
    }
}

private struct MindwtrFocusTaskView: View {
    @EnvironmentObject private var model: MindwtrWatchConnectivityModel
    @Environment(\.dismiss) private var dismiss
    let task: MindwtrWatchFocusTask

    var body: some View {
        ScrollView {
            VStack(spacing: 10) {
                Text(task.title)
                    .font(.headline)
                    .multilineTextAlignment(.center)
                    .privacySensitive()
                Button {
                    model.complete(task: task)
                    dismiss()
                } label: {
                    Label("Complete", systemImage: "checkmark.circle.fill")
                }
                .buttonStyle(.borderedProminent)
                .tint(.green)
                Button {
                    model.deferUntilTomorrow(task: task)
                    dismiss()
                } label: {
                    Label("Tomorrow", systemImage: "sunrise.fill")
                }
            }
        }
        .navigationTitle("Task")
    }
}

private struct MindwtrPomodoroView: View {
    @EnvironmentObject private var model: MindwtrWatchConnectivityModel

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            let timer = model.snapshot.pomodoro
            let remaining = timer.remaining(at: context.date)
            ScrollView {
                VStack(spacing: 8) {
                    Text(timer.phase == .focus ? "Focus" : "Break")
                        .font(.headline)
                    Text(duration: remaining)
                        .font(.system(.title2, design: .rounded, weight: .semibold))
                        .monospacedDigit()
                    if let title = timer.taskTitle, !title.isEmpty {
                        Text(title)
                            .font(.caption)
                            .lineLimit(2)
                            .multilineTextAlignment(.center)
                            .privacySensitive()
                    }
                    Button {
                        model.sendPomodoro(
                            action: timer.isRunning ? .pause : .start,
                            taskId: timer.taskId
                        )
                    } label: {
                        Label(timer.isRunning ? "Pause" : "Start", systemImage: timer.isRunning ? "pause.fill" : "play.fill")
                    }
                    .buttonStyle(.borderedProminent)
                    Button {
                        model.sendPomodoro(action: .reset, taskId: timer.taskId)
                    } label: {
                        Label("Reset", systemImage: "arrow.counterclockwise")
                    }
                    .font(.caption)
                }
                .padding(.horizontal, 6)
            }
            .onChange(of: remaining) { _, _ in model.handleTimerTick(at: context.date) }
        }
        .containerBackground(.black.gradient, for: .tabView)
    }
}

private extension Text {
    init(duration seconds: Int) {
        let safeSeconds = max(0, seconds)
        self.init(String(format: "%02d:%02d", safeSeconds / 60, safeSeconds % 60))
    }
}
