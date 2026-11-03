import SwiftUI

struct MindSweepSheet: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @FocusState private var inputFocused: Bool

    private var guide: CoreObject { model.mindSweepGuide }
    private var labels: CoreObject { guide.object("text") }
    private var groups: [CoreObject] { guide.objects("groups") }
    private var group: CoreObject { model.mindSweepCurrentGroup }
    private var enabled: Bool { model.mindSweepControlsEnabled }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Text(labels.text("title")).rnFont(20, .bold)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityAddTraits(.isHeader)
                Button { model.closeMindSweep() } label: {
                    Text(labels.text("close")).rnFont(15, .semibold)
                        .foregroundStyle(palette.tint)
                        .frame(minWidth: 44, minHeight: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(!enabled)
                .accessibilityIdentifier("mind-sweep-close")
            }
            .padding(.horizontal, 20).padding(.top, 8).padding(.bottom, 12)
            .background(palette.bg)
            .overlay(alignment: .bottom) { palette.border.frame(height: 0.5) }

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if model.mindSweepStep == -1 { intro }
                    else if model.mindSweepStep >= groups.count { summary }
                    else { groupContent }
                    if model.retryNeeded || model.error != nil {
                        FailureBanner(model: model, palette: palette)
                    }
                }
                .frame(maxWidth: 640, alignment: .leading)
                .frame(maxWidth: .infinity)
                .padding(20)
            }
            .scrollDismissesKeyboard(.interactively)
            .accessibilityIdentifier("mind-sweep-scroll")
        }
        .background(palette.bg.ignoresSafeArea())
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isModal)
        .accessibilityAction(.escape) { model.closeMindSweep() }
    }

    private var intro: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(labels.text("intro")).rnFont(15).foregroundStyle(palette.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Text(labels.text("scopeLabel")).rnFont(15, .semibold)
            AppChipFlow {
                let scopes = guide.objects("scopes")
                ForEach(scopes.indices, id: \.self) { index in
                    let scope = scopes[index]
                    let selected = guide.text("scope") == scope.text("value")
                    Button { Task { await model.setMindSweepScope(scope.text("value")) } } label: {
                        Text(scope.text("label")).rnFont(14, .semibold)
                            .foregroundStyle(selected ? palette.onTint : palette.text)
                            .padding(.horizontal, 14).frame(minHeight: 44)
                            .background(selected ? palette.tint : palette.card, in: Capsule())
                            .overlay(Capsule().stroke(selected ? palette.tint : palette.border, lineWidth: 1))
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).disabled(!enabled)
                    .accessibilityAddTraits(selected ? .isSelected : [])
                    .accessibilityIdentifier("mind-sweep-scope-" + scope.text("value"))
                }
            }
            if let error = model.mindSweepGuideError {
                Text(error).rnFont(13).foregroundStyle(palette.danger)
                Button(model.label("common.retry")) { Task { await model.retryMindSweepGuide() } }
                    .rnFont(15, .semibold).frame(minHeight: 44).disabled(!enabled)
            }
            primaryButton(labels.text("start"), id: "mind-sweep-start", enabled: enabled && model.mindSweepGuideError == nil) {
                model.startMindSweep()
            }
        }
    }

    private var groupContent: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Text(group.text("title")).rnFont(20, .bold)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityAddTraits(.isHeader)
                    .accessibilityIdentifier("mind-sweep-group-title")
                Text(progress).rnFont(13).foregroundStyle(palette.secondary)
                    .accessibilityIdentifier("mind-sweep-progress")
            }
            let prompts = group["prompts"] as? [String] ?? []
            ForEach(prompts.indices, id: \.self) { index in
                Text("• " + prompts[index]).rnFont(14).foregroundStyle(palette.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("mind-sweep-prompt-" + group.text("id") + "-" + String(index))
            }
            if dynamicTypeSize.isAccessibilitySize {
                VStack(spacing: 10) { input; addButton }
            } else {
                HStack(spacing: 10) { input; addButton }
            }
            if model.mindSweepAddFailed {
                Text(labels.text("addFailed")).rnFont(13).foregroundStyle(palette.danger)
                    .accessibilityIdentifier("mind-sweep-add-failed")
            }
            let captured = model.mindSweepCaptured[group.text("id")] ?? []
            if !captured.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text(labels.text("groupCaptured")).rnFont(13, .semibold).foregroundStyle(palette.secondary)
                    ForEach(captured.indices, id: \.self) { index in
                        Text("• " + captured[index]).rnFont(14).lineLimit(1)
                            .accessibilityIdentifier("mind-sweep-captured-" + group.text("id") + "-" + String(index))
                    }
                }
                .padding(14).frame(maxWidth: .infinity, alignment: .leading)
                .background(palette.card, in: RoundedRectangle(cornerRadius: 12))
            }
            HStack(spacing: 12) {
                Button { model.backMindSweep() } label: {
                    Text(labels.text("back")).rnFont(15, .semibold)
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .background(palette.card, in: RoundedRectangle(cornerRadius: 10))
                        .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.border, lineWidth: 1))
                }
                .buttonStyle(.plain).disabled(!enabled || model.mindSweepStep == 0)
                .accessibilityIdentifier("mind-sweep-back")
                primaryButton(labels.text("next"), id: "mind-sweep-next", enabled: enabled) {
                    model.nextMindSweep()
                }
            }
        }
    }

    private var input: some View {
        TextField(labels.text("inputPlaceholder"), text: Binding(
            get: { model.mindSweepDraft },
            set: { if inputFocused { model.setMindSweepDraft($0) } }))
            .rnFont(15).focused($inputFocused)
            .submitLabel(.done).onSubmit {
                Task {
                    await model.addMindSweep()

                    if model.mindSweepControlsEnabled { inputFocused = true }
                }
            }
            .padding(12).frame(maxWidth: .infinity, minHeight: 44)
            .background(palette.card, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(palette.border, lineWidth: 1))


            .disabled(model.retryNeeded)
            .contentShape(Rectangle()).onTapGesture { if enabled { inputFocused = true } }
            .accessibilityLabel(labels.text("inputPlaceholder"))
            .accessibilityIdentifier("mind-sweep-input")
    }

    private var addButton: some View {
        primaryButton(labels.text("add"), id: "mind-sweep-add", enabled: model.mindSweepCanAdd,
                      fillWidth: dynamicTypeSize.isAccessibilitySize) {
            Task { await model.addMindSweep() }
        }
    }

    private var summary: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(labels.text("summaryTitle")).rnFont(20, .bold)
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("mind-sweep-summary")
            Text(model.mindSweepCapturedCount > 0 ? summaryCount : labels.text("summaryEmpty"))
                .rnFont(15).foregroundStyle(palette.secondary)
                .accessibilityIdentifier("mind-sweep-summary-count")
            if model.mindSweepCapturedCount > 0 {
                Text(labels.text("summaryHint")).rnFont(15).foregroundStyle(palette.secondary)
            }
            primaryButton(labels.text("finish"), id: "mind-sweep-finish", enabled: enabled) {
                model.closeMindSweep()
            }
        }
    }

    private var progress: String {
        labels.text("progressTemplate")
            .replacingOccurrences(of: "{{current}}", with: String(model.mindSweepStep + 1))
            .replacingOccurrences(of: "{{total}}", with: String(groups.count))
    }

    private var summaryCount: String {
        labels.text("summaryCountTemplate")
            .replacingOccurrences(of: "{{count}}", with: String(model.mindSweepCapturedCount))
    }

    private func primaryButton(_ title: String, id: String, enabled: Bool,
                               fillWidth: Bool = true, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).rnFont(15, .semibold).foregroundStyle(palette.onTint)
                .frame(maxWidth: fillWidth ? .infinity : nil, minHeight: 44)
                .padding(.horizontal, 16)
                .background(palette.tint, in: RoundedRectangle(cornerRadius: 10))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(!enabled)
        .accessibilityIdentifier(id)
    }
}
