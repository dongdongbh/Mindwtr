import Foundation
import SwiftUI

@MainActor
final class NativeStartupPrompts: ObservableObject {
    @Published private(set) var prompt: CoreObject?
    @Published private(set) var seeding = false
    @Published private(set) var seedError: String?
    @Published private(set) var toast: String?
    private var askedStartup: UUID?
    private var previewing = false
    private var opening = UUID()
    private var recordedShowing: UUID?
    private var toastTask: Task<Void, Never>?

    static let enabled: Bool = {
        let arguments = NativeAppLaunch.arguments
        return arguments.contains("--native-startup-prompts") || !arguments.contains { $0.hasPrefix("--native-") }
    }()

    static let preview: String? = {
        #if DEBUG
        let arguments = NativeAppLaunch.arguments
        guard let position = arguments.firstIndex(of: "--native-startup-prompt-preview"), position + 1 < arguments.count,
              ["onboarding", "donation"].contains(arguments[position + 1]) else { return nil }
        return arguments[position + 1]
        #else
        return nil
        #endif
    }()

    static let donationEnabled: Bool = {
        #if DEBUG
        return false
        #else
        return true
        #endif
    }()

    func begin(_ model: CoreModel, startup: UUID) {
        guard Self.enabled, askedStartup != startup, prompt == nil, model.startupPromptsCanShow else { return }
        askedStartup = startup
        Task { await ask(model, preview: Self.preview) }
    }

    private func ask(_ model: CoreModel, preview: String? = nil) async {
        var input: CoreObject = ["installerSource": "play-store", "donationEnabled": Self.donationEnabled, "deferDelay": true]
        if let preview { input["preview"] = preview }
        let next: CoreObject?
        let delay: Int
        do {
            let reply = try await model.startupPromptRead("beginStartupPrompts", input)
            guard Set(reply.keys).isSubset(of: ["prompt", "notice", "delayMs"]), reply["prompt"] is NSNull || reply["prompt"] is CoreObject,
                  let wait = reply["delayMs"] as? Int, (0...60_000).contains(wait) else { throw CocoaError(.coderReadCorrupt) }
            next = reply["prompt"] as? CoreObject
            delay = wait
        } catch {
            if preview == nil { await model.recordStartupPromptRead("failed") }
            return
        }
        let shown = next.flatMap { ["onboarding", "donation", "announcement"].contains($0.text("id")) ? $0 : nil }
        if shown != nil, delay > 0 { try? await Task.sleep(nanoseconds: UInt64(delay) * 1_000_000) }
        let held = shown != nil && !model.startupPromptsCanShow
        if preview == nil { await model.recordStartupPromptRead(held ? "held" : shown?.text("id") ?? "none") }
        guard let shown, !held, prompt == nil else { return }
        previewing = preview != nil
        seedError = nil
        opening = UUID()
        prompt = shown
    }

    func close(_ model: CoreModel, action: String) {
        guard let open = prompt else { return }
        prompt = nil
        seedError = nil
        if previewing {
            previewing = false
            if open.text("id") != "onboarding" { return }
        }
        Task {
            _ = try? await model.startupPromptRead("startupPromptAction", ["id": open.text("id"), "action": action])
            await ask(model)
        }
    }

    func shown(_ model: CoreModel) {
        guard let open = prompt, open.text("id") == "donation", !previewing, recordedShowing != opening else { return }
        recordedShowing = opening
        Task {
            guard let reply = try? await model.startupPromptRead("startupPromptAction", ["id": "donation", "action": "shown"]),
                  let shownAt = reply["shownAt"] as? String else { return }
            await model.recordSupportPromptShown(shownAt)
        }
    }

    func act(_ model: CoreModel, openLink: (URL) -> Void) {
        guard let open = prompt else { return }
        let action = open.object("announcement").object("action")
        guard !action.isEmpty else { return }
        close(model, action: "act")
        if action.text("type") == "feedback" {
            Task { await model.openStartupPromptSettings("about") }
        } else if let link = URL(string: action.text("url").trimmingCharacters(in: .whitespacesAndNewlines)), link.scheme != nil {
            openLink(link)
        }
    }

    func handoff(_ model: CoreModel, screen: String) {
        guard !seeding else { return }
        close(model, action: "act")
        Task { await model.openStartupPromptSettings(screen) }
    }

    func startFresh(_ model: CoreModel) {
        guard let open = prompt, open.text("id") == "onboarding", !seeding else { return }
        let words = open.object("words")
        seeding = true
        seedError = nil
        Task {
            defer { seeding = false }
            do {
                guard let projectID = try await model.seedStartupGettingStarted(language: open.text("language")) else {
                    seedError = words.text("errorNotCreated")
                    show(words.text("toastNotCreated"))
                    return
                }
                close(model, action: "dismiss")
                await model.openStartupPromptProject(projectID)
                show(words.text("toastReady"))
            } catch {
                seedError = words.text("errorFailed")
                show(words.text("toastFailed"))
            }
        }
    }

    private func show(_ message: String) {
        guard !message.isEmpty else { return }
        toastTask?.cancel()
        toast = message
        toastTask = Task {
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            guard !Task.isCancelled else { return }
            toast = nil
        }
    }
}

struct NativeStartupPromptOverlay: View {
    @ObservedObject var model: CoreModel
    @ObservedObject var prompts: NativeStartupPrompts
    let palette: AppPalette
    @Environment(\.openURL) private var openURL

    var body: some View {
        ZStack {
            if let open = prompts.prompt {
                if open.text("id") == "onboarding" {
                    NativeWelcomeSheet(model: model, prompts: prompts, open: open, palette: palette)
                } else {
                    NativePromptWindow(model: model, prompts: prompts, open: open, palette: palette, openLink: { openURL($0) })
                }
            }
            if let toast = prompts.toast {
                VStack {
                    Spacer()
                    Text(toast).rnFont(15).foregroundStyle(palette.text).fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("startup-prompt-toast")
                        .padding(14).background(palette.card, in: RoundedRectangle(cornerRadius: 12))
                        .overlay(RoundedRectangle(cornerRadius: 12).stroke(palette.border, lineWidth: 1))
                        .padding(16)
                }
                .allowsHitTesting(false)
            }
        }
    }
}

private struct NativePromptWindow: View {
    @ObservedObject var model: CoreModel
    @ObservedObject var prompts: NativeStartupPrompts
    let open: CoreObject
    let palette: AppPalette
    let openLink: (URL) -> Void

    var body: some View {
        GeometryReader { geometry in
            ZStack {
                Color.black.opacity(0.42).ignoresSafeArea()
                    .onTapGesture { prompts.close(model, action: "dismiss") }
                    .accessibilityHidden(true)
                ViewThatFits(in: .vertical) {
                    card(scrolling: false)
                    card(scrolling: true)
                }
                .frame(maxWidth: 460)
                .background(palette.card, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(palette.border, lineWidth: 1))
                .frame(maxHeight: geometry.size.height * 0.82)
                .padding(18)
                .accessibilityElement(children: .contain)
                .accessibilityAddTraits(.isModal)
                .accessibilityIdentifier("startup-prompt")
            }
        }
        .onAppear { prompts.shown(model) }
    }

    private func card(scrolling: Bool) -> some View {
        let announcement = open.object("announcement")
        let action = announcement.object("action")
        let dismissLabel = announcement.text("dismissLabel").isEmpty ? open.text("notNow") : announcement.text("dismissLabel")
        let message = Text(announcement.text("body")).rnFont(14).foregroundStyle(palette.secondary)
            .lineSpacing(4).fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
        return VStack(spacing: 0) {
            HStack(alignment: .top, spacing: 12) {
                AppIcon(name: "megaphone", size: 18).foregroundStyle(palette.tint)
                    .frame(width: 36, height: 36)
                    .background(palette.tint.opacity(24.0 / 255), in: RoundedRectangle(cornerRadius: 10))
                    .padding(.top, 1)
                Text(announcement.text("title")).rnFont(17, .bold).foregroundStyle(palette.text)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityAddTraits(.isHeader)
                Button { prompts.close(model, action: "dismiss") } label: {
                    AppIcon(name: "x", size: 21).foregroundStyle(palette.secondary)
                        .frame(width: 34, height: 34).contentShape(Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(open.text("closeLabel"))
                .accessibilityIdentifier("startup-prompt-close")
            }
            .padding(.horizontal, 16).padding(.vertical, 14)
            Rectangle().fill(palette.border).frame(height: 1)
            if scrolling {
                ScrollView { message }
            } else {
                message
            }
            Rectangle().fill(palette.border).frame(height: 1)
            HStack(spacing: 10) {
                Spacer(minLength: 0)
                Button { prompts.close(model, action: "dismiss") } label: {
                    Text(dismissLabel).rnFont(14, .bold).foregroundStyle(palette.secondary).lineLimit(1)
                        .padding(.horizontal, 14).frame(minWidth: 92, minHeight: 44)
                        .overlay(RoundedRectangle(cornerRadius: 12).stroke(palette.border, lineWidth: 1))
                        .contentShape(RoundedRectangle(cornerRadius: 12))
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("startup-prompt-dismiss")
                if !action.isEmpty {
                    Button { prompts.act(model, openLink: openLink) } label: {
                        HStack(spacing: 7) {
                            AppIcon(name: action.text("type") == "feedback" ? "message-square" : "external-link", size: 16)
                            Text(action.text("label")).rnFont(14, .bold).lineLimit(1)
                        }
                        .foregroundStyle(palette.captureForeground)
                        .padding(.horizontal, 14).frame(minWidth: 126, minHeight: 44)
                        .background(palette.captureBackground, in: RoundedRectangle(cornerRadius: 12))
                        .contentShape(RoundedRectangle(cornerRadius: 12))
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("startup-prompt-action")
                }
            }
            .padding(14)
        }
    }
}

private struct NativeWelcomeSheet: View {
    @ObservedObject var model: CoreModel
    @ObservedObject var prompts: NativeStartupPrompts
    let open: CoreObject
    let palette: AppPalette
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let words = open.object("words")
        let busy = prompts.seeding
        GeometryReader { geometry in
            ZStack {
                Color(red: 2 / 255, green: 6 / 255, blue: 23 / 255).opacity(0.68).ignoresSafeArea()
                    .accessibilityHidden(true)
                ZStack(alignment: .topTrailing) {
                    ViewThatFits(in: .vertical) {
                        content(words: words, busy: busy)
                        ScrollView { content(words: words, busy: busy) }
                    }
                    Button { skip() } label: {
                        AppIcon(name: "x", size: 22).foregroundStyle(palette.secondary)
                            .frame(width: 38, height: 38)
                            .background(palette.card, in: Circle())
                            .contentShape(Circle())
                    }
                    .buttonStyle(.plain)
                    .disabled(busy)
                    .opacity(busy ? 0.45 : 1)
                    .padding(.top, 12).padding(.trailing, 12)
                    .accessibilityLabel(words.text("skip"))
                    .accessibilityIdentifier("welcome-close")
                }
                .frame(maxWidth: .infinity)
                .background(palette.card, in: RoundedRectangle(cornerRadius: 16))
                .overlay(RoundedRectangle(cornerRadius: 16).stroke(palette.border, lineWidth: 1))
                .frame(maxHeight: geometry.size.height * 0.92)
                .padding(.horizontal, 16).padding(.vertical, 20)
                .accessibilityElement(children: .contain)
                .accessibilityAddTraits(.isModal)
                .accessibilityIdentifier("welcome-sheet")
            }
        }
    }

    private func skip() {
        guard !prompts.seeding else { return }
        prompts.close(model, action: "dismiss")
    }

    private func content(words: CoreObject, busy: Bool) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 6) {
                Text(words.text("title")).rnFont(24, .heavy).foregroundStyle(palette.text)
                    .fixedSize(horizontal: false, vertical: true).accessibilityAddTraits(.isHeader)
                Text(words.text("subtitle")).rnFont(15).foregroundStyle(palette.secondary)
                    .lineSpacing(3).fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 20).padding(.vertical, 18).padding(.trailing, 38)
            Rectangle().fill(palette.border).frame(height: 0.5)
            VStack(spacing: 12) {
                option(title: words.text(busy ? "startFreshBusy" : "startFreshTitle"), description: words.text("startFreshDesc"),
                       filled: true, minHeight: 92, disabledOpacity: 0.68, identifier: "welcome-start", icon: "database") {
                    prompts.startFresh(model)
                }
                option(title: words.text("syncTitle"), description: words.text("syncDesc"), filled: false, minHeight: 88,
                       disabledOpacity: 0.58, identifier: "welcome-sync", icon: "refresh-cw") {
                    prompts.handoff(model, screen: "sync")
                }
                option(title: words.text("importTitle"), description: words.text("importDescMobile"), filled: false, minHeight: 88,
                       disabledOpacity: 0.58, identifier: "welcome-import", icon: "download") {
                    prompts.handoff(model, screen: "data")
                }
                if let error = prompts.seedError {
                    Text(error).rnFont(13, .semibold).foregroundStyle(palette.danger)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 12).padding(.vertical, 10)
                        .background(palette.danger.opacity(24.0 / 255), in: RoundedRectangle(cornerRadius: 10))
                        .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.danger, lineWidth: 1))
                        .accessibilityIdentifier("welcome-error")
                }
            }
            .padding(20)
            Rectangle().fill(palette.border).frame(height: 0.5)
            footer(words: words, busy: busy)
        }
    }

    @ViewBuilder
    private func footer(words: CoreObject, busy: Bool) -> some View {
        let skipButton = Button { skip() } label: {
            Text(words.text("skipForNow")).rnFont(15, .heavy).foregroundStyle(busy ? palette.secondary : palette.tint)
                .frame(minHeight: 44)
        }
        .buttonStyle(.plain)
        .disabled(busy)
        .accessibilityIdentifier("welcome-skip")
        let footerText = Text(words.text("footer")).rnFont(13).foregroundStyle(palette.secondary)
            .fixedSize(horizontal: false, vertical: true)
        if typeSize.isAccessibilitySize {
            VStack(alignment: .trailing, spacing: 12) {
                footerText.frame(maxWidth: .infinity, alignment: .leading)
                skipButton
            }
            .padding(.horizontal, 20).padding(.vertical, 16)
        } else {
            HStack(spacing: 12) {
                footerText.frame(maxWidth: .infinity, alignment: .leading)
                skipButton
            }
            .padding(.horizontal, 20).padding(.vertical, 16)
        }
    }

    private func option(title: String, description: String, filled: Bool, minHeight: CGFloat, disabledOpacity: Double,
                        identifier: String, icon: String, action: @escaping () -> Void) -> some View {
        let busy = prompts.seeding
        let foreground = filled ? palette.captureForeground : palette.text
        return Button(action: action) {
            HStack(alignment: .top, spacing: 14) {
                ZStack {
                    if filled && busy {
                        ProgressView().tint(palette.captureForeground)
                    } else {
                        AppIcon(name: icon, size: 22).foregroundStyle(filled ? palette.captureForeground : palette.tint)
                    }
                }
                .frame(width: 48, height: 48)
                .background(filled ? Color.white.opacity(0.16) : palette.tint.opacity(24.0 / 255), in: RoundedRectangle(cornerRadius: 10))
                VStack(alignment: .leading, spacing: 4) {
                    Text(title).rnFont(17, .heavy).foregroundStyle(foreground)
                    Text(description).rnFont(14).foregroundStyle(filled ? palette.captureForeground.opacity(0.84) : palette.secondary)
                        .lineSpacing(3)
                }
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
            }
            .padding(.horizontal, 16).padding(.vertical, 14)
            .frame(maxWidth: .infinity, minHeight: minHeight, alignment: .leading)
            .background(filled ? palette.captureBackground : palette.input, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(filled ? palette.captureBackground : palette.border, lineWidth: 1))
            .contentShape(RoundedRectangle(cornerRadius: 12))
        }
        .buttonStyle(.plain)
        .disabled(busy)
        .opacity(busy ? disabledOpacity : 1)
        .accessibilityIdentifier(identifier)
    }
}
