import SwiftUI
import UIKit

struct CaptureSheet: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    @State private var expanded = false
    @State private var showSyntax = false
    private var copy: CoreObject { model.capture.object("text") }

    var body: some View {
        ZStack(alignment: .bottom) {
            if !model.captureLinesConfirmationPresented {
                sheet.accessibilityHidden(model.contextPickerPresented)
            }
            if model.contextPickerPresented {
                Color.black.opacity(0.35).ignoresSafeArea()
                    .onTapGesture { model.closeContextPicker() }
                ContextPicker(model: model, palette: palette)
                    .padding(.horizontal, 20).frame(maxHeight: .infinity)
            }
            if model.captureLinesConfirmationPresented { linesConfirmation }
        }
        .frame(maxHeight: model.contextPickerPresented || model.captureLinesConfirmationPresented ? .infinity : nil, alignment: .bottom)
        .onChange(of: model.draft) { _ in model.textChanged() }
        .onChange(of: model.noteDraft) { _ in model.textChanged() }
        .onChange(of: model.contextQuery) { _ in model.textChanged() }
        .onChange(of: model.captureLinesConfirmationPresented) { presented in
            if presented { UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil) }
        }
    }

    private var linesConfirmation: some View {
        GeometryReader { geometry in
            ZStack(alignment: .bottom) {
                Button { model.requestCaptureClose() } label: {
                    Color.black.opacity(0.35).ignoresSafeArea().contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(model.busy || model.retryNeeded)
                .accessibilityLabel(model.bulkConfirm.text("cancelLabel"))
                .accessibilityIdentifier("capture-lines-backdrop")
                ViewThatFits(in: .vertical) {
                    linesConfirmationContent.fixedSize(horizontal: false, vertical: true)
                    ScrollView { linesConfirmationContent }
                        .accessibilityIdentifier("capture-lines-scroll")
                }
                .padding(20).frame(maxWidth: 520)
                .frame(maxHeight: max(120, geometry.size.height - 40))
                .background(palette.card, in: RoundedRectangle(cornerRadius: 16))
                .overlay(RoundedRectangle(cornerRadius: 16).stroke(palette.border, lineWidth: 1))
                .padding(20).accessibilityElement(children: .contain)
                .accessibilityIdentifier("capture-lines-confirmation")
            }
        }
    }

    private var linesConfirmationContent: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .top, spacing: 12) {
                Text(model.bulkConfirm.text("title")).rnFont(18, .bold).fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader).accessibilityIdentifier("capture-lines-title")
                Spacer(minLength: 0)
                Button { model.requestCaptureClose() } label: {
                    AppIcon(name: "x", size: 18).frame(width: 44, height: 44)
                }
                .buttonStyle(.plain).disabled(model.busy || model.retryNeeded)
                .accessibilityLabel(model.bulkConfirm.text("cancelLabel"))
                .accessibilityIdentifier("capture-lines-close")
            }
            Text(model.bulkConfirm.text("message")).rnFont(14).foregroundStyle(palette.secondary)
                .fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("capture-lines-message")
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 12) { linesConfirmationButtons }
                VStack(spacing: 12) { linesConfirmationButtons }
            }
        }
    }

    @ViewBuilder private var linesConfirmationButtons: some View {
        Button { model.cancelCaptureLinesConfirmation() } label: {
            Text(model.bulkConfirm.text("cancelLabel")).rnFont(14, .semibold)
                .frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(model.busy || model.retryNeeded)
        .accessibilityIdentifier("capture-lines-cancel")
        Button { Task { await model.confirmCaptureLines() } } label: {
            Text(model.bulkConfirm.text("confirmLabel")).rnFont(14, .bold)
                .foregroundStyle(palette.captureForeground).padding(.horizontal, 12)
                .frame(maxWidth: .infinity, minHeight: 44).background(palette.captureBackground, in: RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain).disabled(!model.canConfirmCaptureLines)
        .accessibilityIdentifier("capture-lines-create")
    }

    private var sheet: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 12) {
                Text(copy.text("title")).rnFont(16, .bold).accessibilityAddTraits(.isHeader)
                    .accessibilityIdentifier("capture-title")
                Spacer()
                Button { model.requestCaptureClose() } label: {
                    // RN closeButton: 48x48 hit area with -6pt vertical margins (36pt of layout).
                    AppIcon(name: "x", size: 18).foregroundStyle(palette.secondary).frame(width: 48, height: 48)
                        .contentShape(Rectangle()).padding(.vertical, -6)
                }
                .buttonStyle(.plain).disabled(model.busy || model.retryNeeded)
                .accessibilityLabel(copy.text("close")).accessibilityIdentifier("capture-close")
            }
            .padding(.bottom, 10)

            HStack(spacing: 10) {
                ZStack(alignment: .topLeading) {
                    if model.draft.isEmpty {
                        Text(copy.text("inputLabel")).rnFont(15).foregroundStyle(palette.secondary)
                            .padding(.horizontal, 12).padding(.vertical, 11).allowsHitTesting(false).accessibilityHidden(true)
                    }
                    CaptureTextInput(text: $model.draft, enabled: !model.busy && !model.retryNeeded && !model.captureLinesConfirmationPresented,
                        color: UIColor(palette.text), label: copy.text("inputLabel"), hint: copy.text("inputHint")) {
                        Task { await model.saveCapture() }
                    }
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(minHeight: 44)
                }
                .background(palette.input, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(palette.border, lineWidth: 1))
                // ponytail: no mic until native audio capture exists; RN's recorder button returns with it.
            }

            if !model.capture.objects("preview").isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(model.capture.objects("preview").indices, id: \.self) { index in
                            let entry = model.capture.objects("preview")[index]
                            Text((entry.text("label").isEmpty ? "" : entry.text("label") + ": ") + entry.text("value"))
                                .rnFont(12, .medium).foregroundStyle(entry.text("tone") == "warning" ? palette.warning : palette.secondary)
                                .padding(.horizontal, 8).padding(.vertical, 5)
                                .background(palette.filter, in: Capsule())
                        }
                    }
                }
                .padding(.top, 8).accessibilityIdentifier("capture-preview")
            }

            Text(model.capture.object("area").text("label")).rnFont(12, .bold)
                .padding(.horizontal, 12).frame(minHeight: 40)
                .background(palette.filter, in: Capsule()).overlay(Capsule().stroke(palette.border, lineWidth: 1))
                .accessibilityLabel(model.capture.object("area").text("accessibilityLabel"))
                .accessibilityIdentifier("capture-area")
                .fixedSize(horizontal: false, vertical: true).padding(.top, 10)

            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) { captureControls }
                VStack(alignment: .leading, spacing: 8) { captureControls }
            }
            .padding(.top, 10)

            if expanded {
                ScrollView {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(copy.text("noteLabel")).rnFont(12, .semibold).foregroundStyle(palette.secondary)
                        TextField(copy.text("notePlaceholder"), text: $model.noteDraft, axis: .vertical)
                            .rnFont(15).lineLimit(2...4).padding(12).frame(minHeight: 64)
                            .background(palette.input, in: RoundedRectangle(cornerRadius: 12))
                            .overlay(RoundedRectangle(cornerRadius: 12).stroke(palette.border, lineWidth: 1))
                            .disabled(model.busy || model.retryNeeded).accessibilityLabel(copy.text("noteLabel"))
                            .accessibilityIdentifier("capture-note")
                        Button { showSyntax.toggle() } label: {
                            HStack(spacing: 4) {
                                AppIcon(name: "chevron", size: 14).rotationEffect(.degrees(showSyntax ? 180 : 0))
                                Text(copy.text("syntaxHelp")).rnFont(11, .semibold)
                            }
                            .foregroundStyle(palette.secondary).frame(minHeight: 44)
                        }
                        .buttonStyle(.plain)
                        if showSyntax { Text(copy.text("syntaxHelpText")).rnFont(11, .medium).foregroundStyle(palette.secondary) }
                        ViewThatFits(in: .horizontal) {
                            HStack(spacing: 8) { dateChips }
                            VStack(alignment: .leading, spacing: 8) { dateChips }
                        }
                    }
                }
                .frame(maxHeight: 170).padding(.top, 8)
            }

            if let notice = model.notice {
                Text(notice).rnFont(13).foregroundStyle(palette.danger).padding(.top, 8)
                    .accessibilityIdentifier("capture-notice")
            }
            if model.error != nil { FailureBanner(model: model, palette: palette) }

            HStack(spacing: 8) {
                Toggle(isOn: Binding(get: { model.capture.object("addAnother").flag("value") }, set: { _ in
                    Task { await model.editCapture(model.capture.object("addAnother").object("edit")) }
                })) { Text(copy.text("addAnother")) }
                    .labelsHidden().toggleStyle(.switch).fixedSize()
                    .disabled(model.busy || model.retryNeeded).accessibilityIdentifier("capture-add-another")
                Text(copy.text("addAnother")).rnFont(12, .semibold)
                Spacer(minLength: 0)
            }
            .padding(.top, 8)

            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) {
                    Spacer(minLength: 0)
                    saveButtons
                }
                VStack(alignment: .trailing, spacing: 8) { saveButtons }
                    .frame(maxWidth: .infinity, alignment: .trailing)
            }
            .padding(.top, 8)

#if DEBUG && os(iOS) && targetEnvironment(simulator)
            if model.captureSaveEditFixtureEnabled {
                Text(model.captureSaveEditTestState).rnFont(10).lineLimit(1)
                    .accessibilityIdentifier("capture-save-edit-fixture-state")
                if model.captureLinesFixtureEnabled {
                    Button("Paste fixture") { model.pasteCaptureLinesFixture() }
                        .accessibilityIdentifier("capture-lines-fixture-paste")
                        .rnFont(10).buttonStyle(.bordered).frame(minHeight: 44)
                }
                HStack {
                    Button("Release") { model.releaseCaptureSaveEditFixtureAcknowledgement() }
                        .accessibilityIdentifier("capture-save-edit-fixture-release")
                    Button("New sheet") { model.replaceCaptureSaveEditFixtureSheet() }
                        .accessibilityIdentifier("capture-save-edit-fixture-new-sheet")
                    Button("New host") { model.replaceCaptureSaveEditFixtureHost() }
                        .accessibilityIdentifier("capture-save-edit-fixture-host")
                }
                .rnFont(10).buttonStyle(.bordered).frame(minHeight: 44)
            }
#endif
        }
        .padding(.horizontal, 16).padding(.top, 12).padding(.bottom, 20)
        .background { CaptureCorners().fill(palette.card).ignoresSafeArea(edges: .bottom) }
    }

    @ViewBuilder private var saveButtons: some View {
        Button { Task { await model.saveCapture(openAfterSave: true) } } label: {
            Text(copy.text("saveAndEdit")).rnFont(13, .bold)
                .frame(minWidth: 80, minHeight: 44).padding(.horizontal, 16)
                .overlay(Capsule().stroke(palette.border, lineWidth: 1))
        }
        .buttonStyle(.plain).disabled(!model.canSave)
        .accessibilityIdentifier("capture-save-edit")
        Button { Task { await model.saveCapture() } } label: {
            Text(copy.text("save")).rnFont(13, .bold)
                .foregroundStyle(palette.captureForeground)
                .frame(minWidth: 72, minHeight: 44).padding(.horizontal, 16)
                .background(palette.captureBackground, in: Capsule())
        }
        .buttonStyle(.plain).disabled(!model.canSave)
        .accessibilityIdentifier("capture-save")
    }

    @ViewBuilder private var captureControls: some View {
        Button { model.openContextPicker() } label: {
            HStack(spacing: 6) {
                Text("@").rnFont(17, .medium)
                Text(model.capture.object("contexts").text("label")).rnFont(12, .bold)
            }
            .padding(.horizontal, 12).frame(minHeight: 40)
            .background(palette.filter, in: Capsule()).overlay(Capsule().stroke(palette.border, lineWidth: 1))
        }
        .buttonStyle(.plain).disabled(model.busy || model.retryNeeded)
        .accessibilityLabel(model.capture.object("contexts").text("accessibilityLabel"))
        .accessibilityIdentifier("capture-contexts")
        .onLongPressGesture {
            Task { await model.editCapture(model.capture.object("contexts").object("reset")) }
        }
        Button { Task { await model.editCapture(model.capture.object("focus").object("edit")) } } label: {
            HStack(spacing: 6) {
                AppFocusStar(focused: model.capture.object("focus").flag("selected"),
                             disabled: !model.capture.object("focus").flag("enabled"),
                             inactiveColor: palette.secondary, size: 16)
                Text(model.capture.object("focus").text("label")).rnFont(12, .bold)
            }
            .padding(.horizontal, 12).frame(minHeight: 40)
            .background(palette.filter, in: Capsule()).overlay(Capsule().stroke(palette.border, lineWidth: 1))
        }
        .buttonStyle(.plain).disabled(model.busy || model.retryNeeded || !model.capture.object("focus").flag("enabled"))
        .accessibilityLabel(model.capture.object("focus").text("accessibilityLabel"))
        .accessibilityIdentifier("capture-focus")
        Button { expanded.toggle() } label: {
            HStack(spacing: 8) {
                AppIcon(name: "sliders", size: 16)
                Text(copy.text(expanded ? "hideOptions" : "more")).rnFont(12, .bold)
                AppIcon(name: "chevron", size: 16).rotationEffect(.degrees(expanded ? 180 : 0))
            }
            .padding(.horizontal, 12).frame(minHeight: 40)
            .background(palette.filter, in: Capsule()).overlay(Capsule().stroke(palette.border, lineWidth: 1))
        }
        .buttonStyle(.plain).accessibilityIdentifier("capture-options")
    }

    @ViewBuilder private var dateChips: some View {
        ForEach(model.capture.object("due").objects("quickDates").indices, id: \.self) { index in
            let date = model.capture.object("due").objects("quickDates")[index]
            Button { Task { await model.editCapture(date.object("edit")) } } label: {
                Text(date.text("label")).rnFont(12, .semibold)
                    .foregroundStyle(date.flag("selected") ? palette.tint : palette.secondary)
                    .padding(.horizontal, 10).frame(minHeight: 44)
                    .overlay(Capsule().stroke(date.flag("selected") ? palette.tint : palette.border, lineWidth: 1))
            }
            .buttonStyle(.plain).disabled(model.busy || model.retryNeeded)
        }
    }
}

private struct ContextPicker: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    @FocusState private var focused: Bool
    private var picker: CoreObject { model.capture.object("picker") }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(picker.text("title")).rnFont(14, .bold).accessibilityAddTraits(.isHeader)
                    .accessibilityIdentifier("capture-context-title")
                Spacer()
                Button { model.closeContextPicker() } label: {
                    AppIcon(name: "x", size: 18).frame(width: 44, height: 44)
                }
                .buttonStyle(.plain).disabled(model.busy || model.retryNeeded)
                .accessibilityLabel(model.label("common.close"))
                .accessibilityIdentifier("capture-context-close")
            }
            TextField(picker.text("placeholder"), text: $model.contextQuery)
                .rnFont(14).padding(.horizontal, 10).padding(.vertical, 8)
                .background(palette.input, in: RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.border, lineWidth: 1))
                .focused($focused).textInputAutocapitalization(.never).autocorrectionDisabled()
                .submitLabel(.done).disabled(model.busy || model.retryNeeded)
                .accessibilityLabel(picker.text("placeholder"))
                .accessibilityIdentifier("capture-context-query")
                .onSubmit { addContext() }

            if !picker.object("add").isEmpty {
                Button { addContext() } label: {
                    HStack(spacing: 8) {
                        AppIcon(name: "plus", size: 16)
                        Text(picker.object("add").text("label")).rnFont(14, .semibold)
                    }
                    .foregroundStyle(palette.tint).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .padding(.horizontal, 12)
                }
                .buttonStyle(.plain).disabled(!model.contextPickerReady)
                .accessibilityLabel(picker.object("add").text("accessibilityLabel"))
                .accessibilityIdentifier("capture-context-add")
            }

            if !picker.objects("selected").isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(picker.objects("selected").indices, id: \.self) { index in
                            let item = picker.objects("selected")[index]
                            Button { Task { await model.editCapture(item.object("edit")) } } label: {
                                Text(item.text("label")).rnFont(12, .semibold)
                                    .padding(.horizontal, 10).padding(.vertical, 6)
                                    .background(palette.filter, in: Capsule())
                                    .overlay(Capsule().stroke(palette.border, lineWidth: 1))
                                    .frame(minHeight: 44).contentShape(Rectangle())
                            }
                            .buttonStyle(.plain).disabled(!model.contextPickerReady)
                            .accessibilityLabel(item.text("accessibilityLabel"))
                            .accessibilityIdentifier("capture-context-remove-" + item.text("label"))
                        }
                    }
                }
            }

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    Button {
                        Task { await model.editCapture(picker.object("clear").object("edit"), clearContextQuery: true, closeContextPicker: true) }
                    } label: {
                        Text(picker.object("clear").text("label")).rnFont(14, .semibold)
                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).padding(.horizontal, 12)
                    }
                    .buttonStyle(.plain).disabled(!model.contextPickerReady)
                    .accessibilityIdentifier("capture-context-clear")
                    ForEach(picker.objects("items").indices, id: \.self) { index in
                        let item = picker.objects("items")[index]
                        Button {
                            Task { await model.editCapture(item.object("edit"), clearContextQuery: true) }
                        } label: {
                            HStack {
                                Text(item.text("label")).rnFont(14, .semibold)
                                Spacer()
                                if item.flag("selected") {
                                    Image(systemName: "checkmark").foregroundStyle(palette.tint).accessibilityHidden(true)
                                }
                            }
                            .frame(minHeight: 44).padding(.horizontal, 12)
                            .background(item.flag("selected") ? palette.filter : .clear, in: RoundedRectangle(cornerRadius: 8))
                        }
                        .buttonStyle(.plain).disabled(!model.contextPickerReady)
                        .accessibilityLabel(item.text("accessibilityLabel"))
                        .accessibilityAddTraits(item.flag("selected") ? .isSelected : [])
                        .accessibilityIdentifier("capture-context-option-" + item.text("label"))
                    }
                    if !model.contextPickerReady { ProgressView().frame(maxWidth: .infinity).padding(12) }
                }
                .padding(.vertical, 6)
            }
            .frame(maxHeight: 220)
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.border, lineWidth: 1))
            if let notice = model.notice {
                Text(notice).rnFont(13).foregroundStyle(palette.danger)
                    .accessibilityIdentifier("capture-context-notice")
            }
        }
        .padding(16)
        .background(palette.card, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(palette.border, lineWidth: 1))
        .onAppear { focused = true }
    }

    private func addContext() {
        Task {
            await model.submitContextQuery()
            focused = true
        }
    }
}

private struct CaptureCorners: Shape {
    func path(in rect: CGRect) -> Path {
        Path(UIBezierPath(roundedRect: rect, byRoundingCorners: [.topLeft, .topRight],
                          cornerRadii: CGSize(width: 20, height: 20)).cgPath)
    }
}

// UITextView preserves pasted newlines, while the keyboard's Done key submits just as RN does.
private struct CaptureTextInput: UIViewRepresentable {
    @Binding var text: String
    let enabled: Bool
    let color: UIColor
    let label: String
    let hint: String
    let submit: () -> Void

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.backgroundColor = .clear
        view.returnKeyType = .done
        view.textContainerInset = UIEdgeInsets(top: 10, left: 8, bottom: 10, right: 8)
        view.adjustsFontForContentSizeCategory = true
        view.delegate = context.coordinator
        view.accessibilityIdentifier = "capture-input"
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        DispatchQueue.main.async { view.becomeFirstResponder() }
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
        context.coordinator.parent = self
        if view.text != text { view.text = text }
        view.isEditable = enabled
        view.textColor = color
        view.font = UIFontMetrics(forTextStyle: .body).scaledFont(for: .systemFont(ofSize: 15))
        view.accessibilityLabel = label
        view.accessibilityHint = hint
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: UITextView, context: Context) -> CGSize? {
        guard let width = proposal.width else { return nil }
        let measured = uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
        return CGSize(width: width, height: min(120, max(44, measured.height)))
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }
    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: CaptureTextInput
        init(_ parent: CaptureTextInput) { self.parent = parent }
        func textViewDidChange(_ view: UITextView) { parent.text = view.text }
        func textView(_ view: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
            if text == "\n" { parent.submit(); return false }
            return true
        }
    }
}
