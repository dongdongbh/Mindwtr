import SwiftUI
import UIKit
import MindwtrNativeCore

struct SettingsScreen: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @FocusState private var gtdTimeFocused: Bool
    @FocusState private var renameFocused: Bool
    @FocusState private var taxonomyNameFocused: Bool
    @State private var taxonomyDeleteConfirmPresented = false
    @State private var taxonomyDeleteConfirmAnswered = false
    @FocusState private var areaNameFocused: Bool
    private enum PersonEditorField: Hashable { case name, note, reference }
    @FocusState private var personEditorFocused: PersonEditorField?
    @State private var deleteConfirmPresented = false
    @State private var deleteConfirmAnswered = false
    @State private var personDeleteConfirmPresented = false
    @State private var personDeleteConfirmAnswered = false
    @State private var areaDeleteConfirmPresented = false
    @State private var areaDeleteConfirmAnswered = false

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Button {
                    renameFocused = false
                    if model.settingsDataPresented { model.closeDiagnostics(owner: model.settingsDiagnosticsOwner) }
                    else if model.settingsGtdPresented { Task { await model.closeGtdSettings(); gtdTimeFocused = false } }
                    else if model.settingsGeneralPresented { model.closeGeneralSettings() }
                    else if model.settingsManagePresented { model.closeManageSettings() }
                    else { Task { await model.closeSettings() } }
                } label: {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 18, weight: .semibold))
                        .frame(width: 44, height: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(!model.settingsDataPresented && (model.busy || model.retryNeeded || model.somedaySectionRenamePending
                          || model.somedaySectionRenameAwaitingRefresh
                          || model.somedaySectionDeletePending || model.somedaySectionDeleteAwaitingRefresh
                          || model.somedaySectionOrderActive || model.unassignedAreaColorActive
                          || (model.settingsGtdPresented ? model.gtdWorkflowPending : model.generalPreferenceActive) || model.settingsTaxonomyActive || model.settingsPersonDeleteActive || model.settingsAreaDeleteActive || model.settingsAreaEditActive
                          || model.settingsPersonCreatePresented || model.settingsPersonEditPresented))
                .accessibilityLabel(model.label("common.back"))
                .accessibilityIdentifier(model.settingsDataPresented ? "diagnostics-back" : model.settingsGtdArchivePresented ? "gtd-archive-back" : model.settingsGtdTaskEditorPresented ? "gtd-taskEditor-back" : model.settingsGtdCapturePresented ? "gtd-capture-back" : model.settingsGtdInboxPresented ? "gtd-inbox-back" : model.settingsGtdReviewPresented ? "gtd-review-back" : model.settingsGtdPresented ? "gtd-back" : model.settingsGeneralPresented ? "general-back" : model.settingsManagePresented ? "manage-back" : "settings-back")
                Text(model.settingsDataPresented ? model.dataSettings.text("title") : model.settingsGtdArchivePresented ? (model.gtdArchive.text("title").isEmpty ? model.label("settings.autoArchive") : model.gtdArchive.text("title")) : model.settingsGtdTaskEditorPresented ? model.gtdTaskEditor.text("title") : model.settingsGtdCapturePresented ? (model.gtdCapture.text("title").isEmpty ? model.label("settings.captureSettings") : model.gtdCapture.text("title")) : model.settingsGtdInboxPresented ? (model.gtdInbox.text("title").isEmpty ? model.label("settings.inboxProcessing") : model.gtdInbox.text("title")) : model.settingsGtdReviewPresented ? (model.gtdReview.text("title").isEmpty ? model.label("settings.reviewSettings") : model.gtdReview.text("title")) : model.settingsGtdPresented ? (model.gtdWorkflow.text("title").isEmpty ? model.label("settings.gtd") : model.gtdWorkflow.text("title")) : model.settingsGeneralPresented ? (model.generalSettings.text("title").isEmpty ? model.label("settings.general") : model.generalSettings.text("title")) : model.settingsManagePresented ? model.manageSettings.text("title") : model.settingsMenu.text("title"))
                    .rnFont(20, .bold).foregroundStyle(palette.text)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityAddTraits(.isHeader)
            }
            .padding(.horizontal, 12).padding(.vertical, 5)
            .background(palette.card)
            if model.settingsDataPresented {
                DiagnosticsCard(model: model, palette: palette, owner: model.settingsDiagnosticsOwner)
            }
            else if model.settingsGtdArchivePresented { gtdArchiveContent }
            else if model.settingsGtdTaskEditorPresented { gtdTaskEditorContent }
            else if model.settingsGtdCapturePresented { gtdCaptureContent }
            else if model.settingsGtdInboxPresented { gtdInboxContent }
            else if model.settingsGtdReviewPresented { gtdReviewContent }
            else if model.settingsGtdPresented { gtdContent }
            else if model.settingsGeneralPresented { generalContent }
            else if model.settingsManagePresented { manageContent }
            else { menuContent }
        }
        .background(palette.bg)
        .alert(model.somedaySectionDeleteOptions.object("text").text("title"),
               isPresented: $deleteConfirmPresented) {
            Button(model.somedaySectionDeleteOptions.object("text").text("cancelLabel"), role: .cancel) {
                deleteConfirmAnswered = true
                model.cancelSomedaySectionDelete()
            }
            .accessibilityIdentifier("manage-someday-delete-cancel")
            Button(model.somedaySectionDeleteOptions.object("text").text("confirmLabel"), role: .destructive) {
                deleteConfirmAnswered = true
                Task { await model.confirmSomedaySectionDelete() }
            }
            .accessibilityIdentifier("manage-someday-delete-confirm")
        } message: {
            Text(model.somedaySectionDeleteOptions.object("text").text("message"))
        }
        .onChange(of: deleteConfirmPresented) { presented in
            guard !presented else { return }
            // A system dismissal may publish before its destructive Button action.
            // Defer implicit-cancel cleanup so that action can retain frozen Options.
            DispatchQueue.main.async {
                if !deleteConfirmAnswered && !deleteConfirmPresented { model.cancelSomedaySectionDelete() }
            }
        }
        .alert(model.settingsAreaDeleteOptions.object("text").text("title"),
               isPresented: $areaDeleteConfirmPresented) {
            Button(model.settingsAreaDeleteOptions.object("text").text("cancelLabel"), role: .cancel) {
                areaDeleteConfirmAnswered = true
                model.cancelSettingsAreaDelete()
            }
            .accessibilityIdentifier("manage-area-delete-cancel")
            Button(model.settingsAreaDeleteOptions.object("text").text("confirmLabel"), role: .destructive) {
                areaDeleteConfirmAnswered = true
                Task { await model.confirmSettingsAreaDelete() }
            }
            .accessibilityIdentifier("manage-area-delete-confirm")
        } message: {
            Text(model.settingsAreaDeleteOptions.object("text").text("message"))
        }
        .onChange(of: areaDeleteConfirmPresented) { presented in
            guard !presented else { return }
            DispatchQueue.main.async {
                if !areaDeleteConfirmAnswered && !areaDeleteConfirmPresented { model.cancelSettingsAreaDelete() }
            }
        }
        .alert(model.settingsTaxonomyOptions.object("confirmation").text("title"),
               isPresented: $taxonomyDeleteConfirmPresented) {
            Button(model.settingsTaxonomyOptions.object("confirmation").text("cancelLabel"), role: .cancel) {
                taxonomyDeleteConfirmAnswered = true
                model.cancelSettingsTaxonomy()
            }
            .accessibilityIdentifier("manage-taxonomy-delete-cancel")
            Button(model.settingsTaxonomyOptions.object("confirmation").text("confirmLabel"), role: .destructive) {
                taxonomyDeleteConfirmAnswered = true
                Task { await model.saveSettingsTaxonomy() }
            }
            .accessibilityIdentifier("manage-taxonomy-delete-confirm")
        } message: {
            Text(model.settingsTaxonomyOptions.object("confirmation").text("message"))
        }
        .onChange(of: taxonomyDeleteConfirmPresented) { presented in
            guard !presented else { return }
            DispatchQueue.main.async {
                if !taxonomyDeleteConfirmAnswered && !taxonomyDeleteConfirmPresented { model.cancelSettingsTaxonomy() }
            }
        }
        .alert(model.settingsPersonDeleteOptions.object("confirm").text("title"),
               isPresented: $personDeleteConfirmPresented) {
            Button(model.settingsPersonDeleteOptions.object("confirm").text("cancelLabel"), role: .cancel) {
                personDeleteConfirmAnswered = true
                model.cancelSettingsPersonDelete()
            }
            .accessibilityIdentifier("manage-person-delete-cancel")
            Button(model.settingsPersonDeleteOptions.object("confirm").text("confirmLabel"), role: .destructive) {
                personDeleteConfirmAnswered = true
                Task { await model.confirmSettingsPersonDelete() }
            }
            .accessibilityIdentifier("manage-person-delete-confirm")
        } message: {
            Text(model.settingsPersonDeleteOptions.object("confirm").text("message"))
        }
        .onChange(of: personDeleteConfirmPresented) { presented in
            guard !presented else { return }
            DispatchQueue.main.async {
                if !personDeleteConfirmAnswered && !personDeleteConfirmPresented { model.cancelSettingsPersonDelete() }
            }
        }
        .sheet(isPresented: Binding(
            get: { !model.unassignedAreaColorOptions.isEmpty },
            set: { if !$0 && !model.appLock.concealed { model.cancelUnassignedAreaColor() } }
        )) { unassignedAreaColorSheet }
        .sheet(isPresented: Binding(
            get: { model.settingsAreaCreatePresented },
            set: { if !$0 && !model.appLock.concealed { model.cancelSettingsAreaCreate() } }
        )) { newAreaSheet }
        .sheet(isPresented: Binding(
            get: { model.settingsPersonCreatePresented },
            set: { if !$0 && !model.appLock.concealed { model.cancelSettingsPersonCreate() } }
        )) { personEditorSheet(editing: false) }
        .sheet(isPresented: Binding(
            get: { model.settingsPersonEditPresented },
            set: { if !$0 && !model.appLock.concealed { model.cancelSettingsPersonEdit() } }
        )) { personEditorSheet(editing: true) }
        .sheet(isPresented: Binding(
            get: { model.settingsTaxonomyPresented },
            set: { if !$0 && !model.appLock.concealed { model.cancelSettingsTaxonomy() } }
        )) { taxonomyEditorSheet }
        .sheet(isPresented: Binding(
            get: { model.settingsAreaEditActive },
            set: { if !$0 && !model.appLock.concealed { model.cancelSettingsAreaEdit() } }
        )) { areaEditSheet }
        .sheet(isPresented: Binding(
            get: { model.generalPreferencePicker != nil },
            set: { if !$0 && !model.appLock.concealed { model.closeGeneralPreferencePicker() } }
        )) { generalPreferenceSheet }
        .sheet(isPresented: Binding(
            get: { model.gtdCaptureAreaPicker },
            set: { if !$0 && !model.appLock.concealed { model.closeGtdCaptureAreaPicker() } }
        )) { gtdCaptureAreaSheet }
        .sheet(isPresented: Binding(
            get: { model.gtdTaskEditorFieldId != nil },
            set: { if !$0 && !model.appLock.concealed { model.closeGtdTaskEditorField() } }
        )) { gtdTaskEditorFieldSheet }
        .accessibilityAction(.escape) {
            if model.settingsDataPresented { model.closeDiagnostics(owner: model.settingsDiagnosticsOwner) }
            else if model.settingsGtdPresented { Task { await model.closeGtdSettings(); gtdTimeFocused = false } }
            else if model.settingsGeneralPresented { model.closeGeneralSettings() }
            else if model.settingsManagePresented { model.closeManageSettings() }
            else { Task { await model.closeSettings() } }
        }
    }

    private var gtdContent: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text(model.gtdWorkflow.text("description")).rnFont(13).foregroundStyle(palette.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                VStack(alignment: .leading, spacing: 12) {
                    generalSettingLabel(model.gtdWorkflow.object("features"), description: "description")
                    palette.border.frame(height: 0.5)
                    Toggle(isOn: .constant(model.gtdWorkflow.object("pomodoro").flag("value"))) {
                        generalSettingLabel(model.gtdWorkflow.object("pomodoro"), description: "description")
                    }.disabled(true).opacity(0.55).accessibilityIdentifier("gtd-pomodoro")
                    if model.gtdWorkflow["pomodoroSettings"] is CoreObject { gtdNavigationRow("pomodoroSettings") }
                }.padding(14).background(palette.card, in: RoundedRectangle(cornerRadius: 12))
                VStack(alignment: .leading, spacing: 0) {
                    VStack(alignment: .leading, spacing: 10) {
                        generalSettingLabel(model.gtdWorkflow.object("defaultScheduleTime"), description: "description")
                        TextField(model.gtdWorkflow.object("defaultScheduleTime").text("placeholder"), text: Binding(
                            get: { model.gtdScheduleDraft }, set: { model.setGtdScheduleDraft($0) }))
                            .rnFont(16).keyboardType(.numbersAndPunctuation).submitLabel(.done)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                            .focused($gtdTimeFocused).disabled(!model.gtdWorkflowEnabled)
                            .padding(12).frame(minHeight: 44)
                            .background(palette.bg, in: RoundedRectangle(cornerRadius: 8))
                            .overlay(RoundedRectangle(cornerRadius: 8).stroke(palette.border, lineWidth: 1))
                            .accessibilityLabel(model.gtdWorkflow.object("defaultScheduleTime").text("label"))
                            .accessibilityIdentifier("gtd-defaultScheduleTime")
                            .onSubmit { gtdTimeFocused = false; Task { await model.commitGtdScheduleDraft() } }
                    }.padding(14)
                    ForEach(["focusTaskLimit", "defaultProjectFlowMode"], id: \.self) { field in
                        palette.border.frame(height: 0.5)
                        VStack(alignment: .leading, spacing: 12) {
                            generalSettingLabel(model.gtdWorkflow.object(field), description: "description")
                            let options = model.gtdWorkflow.object(field).objects("options")
                            let columns = dynamicTypeSize.isAccessibilitySize
                                ? (field == "defaultProjectFlowMode" ? [GridItem(.flexible())] : [GridItem(.adaptive(minimum: 140), spacing: 4)])
                                : Array(repeating: GridItem(.flexible(), spacing: 4), count: max(1, options.count))
                            LazyVGrid(columns: columns, spacing: 4) {
                                ForEach(options.indices, id: \.self) { index in
                                    let option = options[index]
                                    Button {
                                        Task { await model.chooseGtdWorkflow(option.object("edit")); gtdTimeFocused = false }
                                    } label: {
                                        Text(option.text("label")).rnFont(14, .semibold)
                                            .foregroundStyle(option.flag("selected") ? palette.tint : palette.secondary)
                                            .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
                                            .frame(maxWidth: .infinity, minHeight: 44).padding(.horizontal, 6)
                                            .background(option.flag("selected") ? palette.filter : Color.clear, in: RoundedRectangle(cornerRadius: 8))
                                    }.buttonStyle(.plain).disabled(!model.gtdWorkflowEnabled)
                                        .accessibilityAddTraits(option.flag("selected") ? .isSelected : [])
                                        .accessibilityIdentifier("gtd-" + field + "-" + (field == "focusTaskLimit" ? String(option.number("value")) : option.text("value")))
                                }
                            }.padding(4).background(palette.bg, in: RoundedRectangle(cornerRadius: 10))
                        }.padding(14)
                        if field == "focusTaskLimit" {
                            palette.border.frame(height: 0.5)
                            gtdToggle(model.gtdWorkflow.object("focusIncludeStartDates")).padding(14)
                        }
                    }
                    gtdNavigationRow("autoArchive")
                }.background(palette.card, in: RoundedRectangle(cornerRadius: 12))
                gtdFeedback
                ForEach([["taskEditor", "capture"], ["review", "inbox"]], id: \.self) { fields in
                    VStack(spacing: 0) {
                        ForEach(fields, id: \.self) { field in gtdNavigationRow(field, divider: field != fields.first) }
                    }.background(palette.card, in: RoundedRectangle(cornerRadius: 12))
                }
            }.padding(16).padding(.bottom, 24)
        }
        .accessibilityIdentifier("gtd-scroll")
        .onChange(of: gtdTimeFocused) { focused in
            if !focused && !model.appLock.concealed { Task { await model.commitGtdScheduleDraft() } }
        }
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button(model.label("common.done")) { gtdTimeFocused = false; Task { await model.commitGtdScheduleDraft() } }
                    .accessibilityIdentifier("gtd-time-done")
            }
        }
    }

    private var gtdArchiveContent: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text(model.gtdArchive.text("description")).rnFont(13).foregroundStyle(palette.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                VStack(spacing: 0) {
                    let options = model.gtdArchive.objects("options")
                    ForEach(options.indices, id: \.self) { index in
                        let option = options[index]
                        Button { Task { await model.chooseGtdWorkflow(option.object("edit")) } } label: {
                            HStack {
                                Text(option.text("label")).rnFont(16).fixedSize(horizontal: false, vertical: true)
                                Spacer()
                                if option.flag("selected") { Image(systemName: "checkmark").accessibilityHidden(true) }
                            }.foregroundStyle(option.flag("selected") ? palette.tint : palette.text)
                                .padding(14).frame(maxWidth: .infinity, minHeight: 48)
                                .contentShape(Rectangle())
                        }.buttonStyle(.plain).disabled(!model.gtdWorkflowEnabled)
                            .accessibilityAddTraits(option.flag("selected") ? .isSelected : [])
                            .accessibilityIdentifier("gtd-autoArchiveDays-" + String(option.number("value")))
                    }
                }.background(palette.card, in: RoundedRectangle(cornerRadius: 12))
                gtdFeedback
            }.padding(16).padding(.bottom, 24)
        }.accessibilityIdentifier("gtd-archive-scroll")
    }

    private var gtdReviewContent: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text(model.gtdReview.text("description")).rnFont(13).foregroundStyle(palette.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                ForEach(["daily", "weekly"], id: \.self) { group in
                    let field = group == "daily" ? "dailyFocusStep" : "weeklyContextStep"
                    let row = model.gtdReview.object(field)
                    VStack(alignment: .leading, spacing: 12) {
                        generalSettingLabel(model.gtdReview.object(group), description: "description")
                        palette.border.frame(height: 0.5)
                        gtdToggle(row)
                    }.padding(14).background(palette.card, in: RoundedRectangle(cornerRadius: 12))
                }
                gtdFeedback
            }.padding(16).padding(.bottom, 24)
        }.accessibilityIdentifier("gtd-review-scroll")
    }

    private var gtdInboxContent: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text(model.gtdInbox.text("description")).rnFont(13).foregroundStyle(palette.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                VStack(spacing: 0) {
                    ForEach(["twoMinute", "projectFirst", "contextStep", "schedule"], id: \.self) { field in
                        if field != "twoMinute" { palette.border.frame(height: 0.5) }
                        gtdToggle(model.gtdInbox.object(field)).padding(14)
                    }
                }.background(palette.card, in: RoundedRectangle(cornerRadius: 12))
                gtdFeedback
            }.padding(16).padding(.bottom, 24)
        }.accessibilityIdentifier("gtd-inbox-scroll")
    }

    private var gtdTaskEditorContent: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                let openMode = model.gtdTaskEditor.object("openMode")
                if !openMode.isEmpty {
                    VStack(alignment: .leading, spacing: 12) {
                        Text(openMode.text("label")).rnFont(16, .semibold).foregroundStyle(palette.text)
                            .accessibilityAddTraits(.isHeader)
                        Text(openMode.text("description")).rnFont(13).foregroundStyle(palette.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                        let options = openMode.objects("options")
                        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 4), count: dynamicTypeSize.isAccessibilitySize ? 1 : 3), spacing: 4) {
                            ForEach(options.indices, id: \.self) { index in
                                let option = options[index]
                                Button { Task { await model.chooseTaskOpenMode(option.object("edit")) } } label: {
                                    Text(option.text("label")).rnFont(14, .semibold)
                                        .foregroundStyle(option.flag("selected") ? palette.tint : palette.secondary)
                                        .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
                                        .frame(maxWidth: .infinity, minHeight: 44).padding(.horizontal, 6)
                                        .background(option.flag("selected") ? palette.filter : Color.clear, in: RoundedRectangle(cornerRadius: 8))
                                }.buttonStyle(.plain).disabled(!model.gtdWorkflowEnabled)
                                    .accessibilityAddTraits(option.flag("selected") ? .isSelected : [])
                                    .accessibilityIdentifier("gtd-taskOpenMode-" + option.text("value"))
                            }
                        }.padding(4).background(palette.bg, in: RoundedRectangle(cornerRadius: 10))
                    }.padding(14).background(palette.card, in: RoundedRectangle(cornerRadius: 12))
                }
                let presets = model.gtdTaskEditor.object("presets")
                if !presets.isEmpty {
                    VStack(alignment: .leading, spacing: 12) {
                        Text(presets.text("label")).rnFont(16, .semibold).foregroundStyle(palette.text)
                            .accessibilityAddTraits(.isHeader)
                        let options = presets.objects("options")
                        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 4), count: dynamicTypeSize.isAccessibilitySize ? 1 : 3), spacing: 4) {
                            ForEach(options.indices, id: \.self) { index in
                                let option = options[index]
                                Button { Task { await model.chooseGtdWorkflow(option.object("edit")) } } label: {
                                    Text(option.text("label")).rnFont(14, .semibold)
                                        .foregroundStyle(option.flag("selected") ? palette.tint : palette.secondary)
                                        .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
                                        .frame(maxWidth: .infinity, minHeight: 44).padding(.horizontal, 6)
                                        .background(option.flag("selected") ? palette.filter : Color.clear, in: RoundedRectangle(cornerRadius: 8))
                                }.buttonStyle(.plain).disabled(!model.gtdWorkflowEnabled)
                                    .accessibilityAddTraits(option.flag("selected") ? .isSelected : [])
                                    .accessibilityIdentifier("gtd-taskEditorPreset-" + option.text("value"))
                            }
                        }.padding(4).background(palette.bg, in: RoundedRectangle(cornerRadius: 10))
                        if !presets.text("custom").isEmpty {
                            Text(presets.text("custom")).rnFont(13).foregroundStyle(palette.secondary)
                                .accessibilityIdentifier("gtd-taskEditorPreset-custom")
                        }
                    }.padding(14).background(palette.card, in: RoundedRectangle(cornerRadius: 12))
                }
                if let message = model.gtdTaskEditorPresetError {
                    Text(message).rnFont(13).foregroundStyle(palette.danger)
                        .accessibilityIdentifier("gtd-taskEditorPreset-error")
                    Button(model.label("common.retry")) { Task { await model.retryGtdWorkflow() } }
                        .disabled(!model.gtdWorkflowEnabled).accessibilityIdentifier("gtd-taskEditorPreset-retry")
                }
                ForEach(model.gtdTaskEditor.objects("groups").indices, id: \.self) { index in
                    let group = model.gtdTaskEditor.objects("groups")[index]
                    VStack(alignment: .leading, spacing: 12) {
                        let expanded = model.gtdTaskEditorExpanded[group.text("id")] ?? true
                        Button { model.toggleGtdTaskEditorGroup(group.text("id")) } label: {
                            let layout = dynamicTypeSize.isAccessibilitySize
                                ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
                                : AnyLayout(HStackLayout(spacing: 8))
                            layout {
                                Text(group.text("title")).rnFont(16, .semibold).foregroundStyle(palette.text)
                                    .fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity, alignment: .leading)
                                HStack(spacing: 8) {
                                    if group["count"] != nil {
                                        Text(String(group.number("count"))).rnFont(13, .semibold).foregroundStyle(palette.tint)
                                            .padding(.horizontal, 8).padding(.vertical, 4).background(palette.filter, in: Capsule())
                                    }
                                    Image(systemName: expanded ? "chevron.up" : "chevron.down")
                                        .foregroundStyle(palette.secondary).accessibilityHidden(true)
                                }
                            }.frame(minHeight: 44).contentShape(Rectangle())
                        }.buttonStyle(.plain).disabled(!model.gtdWorkflowEnabled)
                            .accessibilityLabel(group.text("title") + (group["count"] == nil ? "" : ", " + String(group.number("count"))))
                            .accessibilityValue(model.label(expanded ? "markdown.collapse" : "markdown.expand"))
                            .accessibilityAddTraits(.isHeader)
                            .accessibilityIdentifier("gtd-editor-group-" + group.text("id"))
                        if expanded {
                            if !group.object("defaultOpen").isEmpty { gtdToggle(group.object("defaultOpen")) }
                            ForEach(group.objects("fields").indices, id: \.self) { fieldIndex in
                                let field = group.objects("fields")[fieldIndex]
                                let visibility = field.object("visibility")
                                HStack(spacing: 12) {
                                    Button { Task { await model.chooseGtdWorkflow(visibility.object("edit")) } } label: {
                                        Image(systemName: field.flag("visible") ? "eye" : "eye.slash")
                                            .foregroundStyle(palette.secondary).frame(minWidth: 44, minHeight: 44)
                                            .contentShape(Rectangle())
                                    }.buttonStyle(.plain).disabled(!model.gtdWorkflowEnabled)
                                        .accessibilityLabel(visibility.text("accessibilityLabel"))
                                        .accessibilityValue(field.text("status"))
                                        .accessibilityAddTraits(field.flag("visible") ? .isSelected : [])
                                        .accessibilityIdentifier("gtd-taskEditorFieldVisible-" + field.text("id"))
                                    Button { model.openGtdTaskEditorField(field.text("id")) } label: {
                                        HStack(spacing: 8) {
                                            VStack(alignment: .leading, spacing: 4) {
                                                Text(field.text("label")).rnFont(16).foregroundStyle(palette.text)
                                                Text(field.text("status")).rnFont(13).foregroundStyle(palette.secondary)
                                            }.fixedSize(horizontal: false, vertical: true)
                                            Spacer(minLength: 4)
                                            Image(systemName: "chevron.right").foregroundStyle(palette.secondary).accessibilityHidden(true)
                                        }.frame(minHeight: 44).contentShape(Rectangle())
                                    }.buttonStyle(.plain).disabled(!model.gtdWorkflowEnabled)
                                        .accessibilityIdentifier("gtd-taskEditorField-" + field.text("id"))
                                }
                            }
                        }
                    }.padding(14).background(palette.card, in: RoundedRectangle(cornerRadius: 12))
                }
                let reset = model.gtdTaskEditor.object("reset")
                if !reset.isEmpty {
                    Button { Task { await model.chooseGtdWorkflow(reset.object("edit")) } } label: {
                        Text(reset.text("label")).rnFont(16, .semibold).foregroundStyle(palette.tint)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, minHeight: 48).padding(.horizontal, 12)
                    }.buttonStyle(.plain).background(palette.card, in: RoundedRectangle(cornerRadius: 12))
                        .disabled(!model.gtdWorkflowEnabled).accessibilityIdentifier("gtd-taskEditorReset")
                }
                if model.gtdTaskEditorFieldId == nil { gtdFeedback }
            }.padding(16).padding(.bottom, 24)
        }.accessibilityIdentifier("gtd-taskEditor-scroll")
    }

    private var gtdTaskEditorFieldSheet: some View {
        let field = model.gtdTaskEditorField
        let sheet = field.object("sheet")
        return VStack(spacing: 0) {
            let headerLayout = dynamicTypeSize.isAccessibilitySize
                ? AnyLayout(VStackLayout(alignment: .trailing, spacing: 8))
                : AnyLayout(HStackLayout(spacing: 12))
            headerLayout {
                VStack(alignment: .leading, spacing: 4) {
                    Text(sheet.text("title")).rnFont(20, .bold).foregroundStyle(palette.text)
                        .accessibilityAddTraits(.isHeader)
                    if !sheet.text("section").isEmpty {
                        Text(sheet.text("section")).rnFont(13).foregroundStyle(palette.secondary)
                            .accessibilityIdentifier("gtd-field-current-section")
                    }
                }.frame(maxWidth: .infinity, alignment: .leading)
                Button(sheet.text("doneLabel").isEmpty ? model.label("common.done") : sheet.text("doneLabel")) {
                    model.closeGtdTaskEditorField()
                }.rnFont(15).frame(minWidth: 48, minHeight: 48)
                    .disabled(model.busy || model.retryNeeded || model.gtdWorkflowPending)
                    .accessibilityIdentifier("gtd-field-done")
            }.padding(.horizontal, 16).padding(.top, 20)
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if !sheet.object("visible").isEmpty { gtdToggle(sheet.object("visible")) }
                    let sections = sheet.object("sections")
                    if !sections.isEmpty {
                        Text(sections.text("label")).rnFont(16, .semibold).foregroundStyle(palette.text)
                            .accessibilityAddTraits(.isHeader)
                        ForEach(sections.objects("options").indices, id: \.self) { index in
                            let option = sections.objects("options")[index]
                            Button { Task { await model.chooseGtdWorkflow(option.object("edit")) } } label: {
                                HStack {
                                    Text(option.text("label")).rnFont(16).foregroundStyle(palette.text)
                                        .fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity, alignment: .leading)
                                    if option.flag("selected") { Image(systemName: "checkmark").foregroundStyle(palette.tint) }
                                }.padding(14).frame(minHeight: 48).contentShape(Rectangle())
                            }.buttonStyle(.plain).background(palette.card, in: RoundedRectangle(cornerRadius: 12))
                                .disabled(!model.gtdWorkflowEnabled)
                                .accessibilityAddTraits(option.flag("selected") ? .isSelected : [])
                                .accessibilityIdentifier("gtd-field-section-" + option.text("value"))
                        }
                    }
                    let order = sheet.object("order")
                    if !order.isEmpty {
                        Text(order.text("label")).rnFont(16, .semibold).foregroundStyle(palette.text)
                            .accessibilityAddTraits(.isHeader)
                        let layout = dynamicTypeSize.isAccessibilitySize
                            ? AnyLayout(VStackLayout(spacing: 8))
                            : AnyLayout(HStackLayout(spacing: 8))
                        layout {
                            ForEach(["moveUp", "moveDown"], id: \.self) { direction in
                                let move = order.object(direction)
                                Button {
                                    var edit = move.object("edit")
                                    edit["field"] = field.text("id")
                                    Task { await model.chooseGtdWorkflow(edit) }
                                } label: {
                                    Label(move.text("label"), systemImage: direction == "moveUp" ? "arrow.up" : "arrow.down")
                                        .rnFont(16).fixedSize(horizontal: false, vertical: true)
                                        .frame(maxWidth: .infinity, minHeight: 48).padding(.horizontal, 12)
                                }.buttonStyle(.plain).background(palette.card, in: RoundedRectangle(cornerRadius: 12))
                                    .disabled(!model.gtdWorkflowEnabled || move.flag("disabled") || move.object("edit").isEmpty)
                                    .accessibilityIdentifier("gtd-field-" + direction)
                            }
                        }
                    }
                    gtdFeedback
                }.padding(16)
            }.accessibilityIdentifier("gtd-field-scroll")
        }.background(palette.bg)
            .presentationDetents([.large]).presentationDragIndicator(.visible)
            .interactiveDismissDisabled(model.busy || model.retryNeeded || model.gtdWorkflowPending)
            .accessibilityAction(.escape) { model.closeGtdTaskEditorField() }
    }

    private var gtdCaptureContent: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                let row = model.gtdCapture.object("defaultArea")
                VStack(alignment: .leading, spacing: 12) {
                    generalSettingLabel(row, description: "description")
                    Button { model.openGtdCaptureAreaPicker() } label: {
                        HStack {
                            Text(row.text("value")).rnFont(16).foregroundStyle(palette.text)
                                .fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity, alignment: .leading)
                            Image(systemName: "chevron.right").foregroundStyle(palette.secondary).accessibilityHidden(true)
                        }.padding(12).frame(minHeight: 48).contentShape(Rectangle())
                    }.buttonStyle(.plain).background(palette.bg, in: RoundedRectangle(cornerRadius: 10))
                        .disabled(!model.gtdWorkflowEnabled)
                        .accessibilityLabel(row.text("accessibilityLabel"))
                        .accessibilityIdentifier("gtd-default-area")
                }.padding(14).background(palette.card, in: RoundedRectangle(cornerRadius: 12))
                VStack(spacing: 0) {
                    ForEach(["quickAddAutoClean", "naturalLanguageDates"], id: \.self) { field in
                        if field != "quickAddAutoClean" { palette.border.frame(height: 0.5) }
                        gtdToggle(model.gtdCapture.object(field)).padding(14)
                    }
                }.background(palette.card, in: RoundedRectangle(cornerRadius: 12))
                if !model.gtdCaptureAreaPicker { gtdFeedback }
            }.padding(16).padding(.bottom, 24)
        }.accessibilityIdentifier("gtd-capture-scroll")
    }

    private var gtdCaptureAreaSheet: some View {
        VStack(spacing: 12) {
            HStack {
                Text(model.gtdCapture.object("defaultArea").text("pickerTitle")).rnFont(20, .bold).foregroundStyle(palette.text)
                    .accessibilityAddTraits(.isHeader).frame(maxWidth: .infinity, alignment: .leading)
                Button { model.closeGtdCaptureAreaPicker() } label: {
                    Text(model.label("common.cancel")).rnFont(15).frame(minWidth: 48, minHeight: 48).contentShape(Rectangle())
                }.buttonStyle(.plain).disabled(model.busy || model.retryNeeded || model.gtdWorkflowPending)
                    .accessibilityIdentifier("gtd-area-cancel")
            }.padding(.horizontal, 16).padding(.top, 20)
            ScrollView {
                VStack(spacing: 8) {
                    ForEach(model.gtdCaptureAreaOptions.indices, id: \.self) { index in
                        let option = model.gtdCaptureAreaOptions[index]
                        Button { Task { await model.chooseGtdCaptureArea(option.object("edit")) } } label: {
                            HStack {
                                Text(option.text("label")).rnFont(16).foregroundStyle(palette.text)
                                    .fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity, alignment: .leading)
                                if option.flag("selected") { Image(systemName: "checkmark").foregroundStyle(palette.tint).accessibilityHidden(true) }
                            }.padding(14).frame(minHeight: 48).contentShape(Rectangle())
                        }.buttonStyle(.plain).background(palette.card, in: RoundedRectangle(cornerRadius: 12))
                            .disabled(!model.gtdWorkflowEnabled)
                            .accessibilityAddTraits(option.flag("selected") ? .isSelected : [])
                            .accessibilityIdentifier("gtd-area-option-" + option.text("value"))
                    }
                    if model.gtdCaptureAreaOptions.count < model.gtdCaptureAreaTotal {
                        Button(model.label("common.more")) { Task { await model.loadMoreGtdCaptureAreas() } }
                            .rnFont(16).frame(maxWidth: .infinity, minHeight: 48).disabled(!model.gtdWorkflowEnabled)
                            .accessibilityIdentifier("gtd-area-more")
                    }
                    gtdFeedback
                }.padding(.horizontal, 16).padding(.bottom, 24)
            }.accessibilityIdentifier("gtd-area-scroll")
        }.background(palette.bg)
            .presentationDetents([.large]).presentationDragIndicator(.visible)
            .interactiveDismissDisabled(model.busy || model.retryNeeded || model.gtdWorkflowPending)
    }

    private func gtdToggle(_ row: CoreObject) -> some View {
        Toggle(isOn: Binding(get: { row.flag("value") }, set: { _ in
            Task { await model.chooseGtdWorkflow(row.object("edit")) }
        })) { generalSettingLabel(row, description: "description") }
            .disabled(!model.gtdWorkflowEnabled).frame(minHeight: 44)
            .tint(palette.tint)
            .accessibilityIdentifier("gtd-" + row.object("edit").text("type")
                + (row.object("edit").text("type") == "taskEditorSectionOpen" ? "-" + row.object("edit").text("section") : ""))
    }

    @ViewBuilder private var gtdFeedback: some View {
        if let message = model.gtdWorkflowReadError ?? model.gtdWorkflowError {
            Text(message).rnFont(13).foregroundStyle(palette.danger).accessibilityIdentifier("gtd-error")
            if model.gtdWorkflowReadError != nil || model.retryNeeded || model.gtdWorkflowAwaitingRefresh {
                Button(model.label("common.retry")) { Task { await model.retryGtdWorkflow() } }
                    .disabled(model.busy).accessibilityIdentifier("gtd-retry")
            }
        }
    }


    private func gtdNavigationRow(_ field: String, divider: Bool = true) -> some View {
        let row = model.gtdWorkflow.object(field)
        return VStack(spacing: 0) {
            if divider { palette.border.frame(height: 0.5) }
            Button {
                if ["review", "inbox", "capture", "taskEditor", "autoArchive"].contains(field) { Task { await model.openGtdSubpage(field); gtdTimeFocused = false } }
            } label: {
                HStack {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(row.text("title")).rnFont(15).foregroundStyle(palette.text)
                        Text(row.text("description")).rnFont(12).foregroundStyle(palette.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }.frame(maxWidth: .infinity, alignment: .leading)
                    Image(systemName: "chevron.right").foregroundStyle(palette.secondary).accessibilityHidden(true)
                }.padding(14).frame(minHeight: 48)
            }.buttonStyle(.plain).disabled(!["review", "inbox", "capture", "taskEditor", "autoArchive"].contains(field) || !model.gtdWorkflowEnabled)
                .opacity(["review", "inbox", "capture", "taskEditor", "autoArchive"].contains(field) ? 1 : 0.55).accessibilityIdentifier("gtd-" + field)
        }
    }

    private var generalContent: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                let appearance = model.generalSettings.object("appearance")
                let privacy = model.generalSettings.object("privacy")
                let regional = model.generalSettings.object("regional")
                Text(appearance.text("title")).rnFont(13, .semibold).foregroundStyle(palette.secondary)
                    .accessibilityAddTraits(.isHeader)
                VStack(spacing: 0) {
                    generalSettingRow(appearance.object("theme"), type: "theme", enabled: true)
                    palette.border.frame(height: 0.5)
                    Toggle(isOn: Binding(
                        get: { appearance.object("showTaskAge")["value"] as? Bool ?? false },
                        set: { value in Task { await model.saveGeneralPreference(["type": "showTaskAge", "value": value]) } }
                    )) {
                        generalSettingLabel(appearance.object("showTaskAge"), description: "description")
                    }
                    .tint(palette.tint).padding(14).frame(minHeight: 48)
                    .disabled(!model.generalPreferenceEnabled)
                    .accessibilityIdentifier("general-show-task-age")
                    palette.border.frame(height: 0.5)
                    generalSettingRow(appearance.object("quickAccess"), type: "quickAccessView", enabled: true)
                }
                .background(palette.card, in: RoundedRectangle(cornerRadius: 12))
                Text(privacy.text("title")).rnFont(13, .semibold).foregroundStyle(palette.secondary)
                    .accessibilityAddTraits(.isHeader)
                Toggle(isOn: Binding(get: { model.appLockRow.flag("value") },
                                     set: { value in Task { await model.saveAppLock(value) } })) {
                    generalSettingLabel(model.appLockRow.isEmpty ? privacy.object("appLock") : model.appLockRow, description: "description")
                }
                .tint(palette.tint).padding(14).disabled(!model.appLockCanChange)
                .background(palette.card, in: RoundedRectangle(cornerRadius: 12))
                .accessibilityIdentifier("general-app-lock")
                if let failure = model.appLockError {
                    Text(failure).rnFont(13).foregroundStyle(palette.danger)
                        .accessibilityIdentifier("general-app-lock-error")
                    if model.retryNeeded || model.appLockAwaitingRefresh {
                        Button(model.label("common.retry")) { Task { await model.retryAppLockRead() } }
                            .disabled(model.busy).accessibilityIdentifier("general-app-lock-retry")
                    }
                }
                generalSettingRow(model.generalSettings.object("language"), type: "language", enabled: true)
                    .background(palette.card, in: RoundedRectangle(cornerRadius: 12))
                VStack(spacing: 0) {
                    Button { model.toggleGeneralRegional() } label: {
                        HStack(spacing: 12) {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(regional.text("label")).rnFont(15).foregroundStyle(palette.text)
                                Text(regional.text("summary")).rnFont(12).foregroundStyle(palette.secondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }.frame(maxWidth: .infinity, alignment: .leading)
                            Image(systemName: model.generalRegionalOpen ? "chevron.up" : "chevron.down")
                                .foregroundStyle(palette.secondary).accessibilityHidden(true)
                        }.padding(14).frame(minHeight: 48).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).disabled(!model.generalPreferenceEnabled)
                    .accessibilityValue(model.generalRegionalOpen ? "expanded" : "collapsed")
                    .accessibilityIdentifier("general-regional-toggle")
                    if model.generalRegionalOpen {
                        ForEach(["weekStart", "dateFormat", "calendarSystem", "timeFormat"], id: \.self) { type in
                            if let row = regional[type] as? CoreObject {
                                palette.border.frame(height: 0.5)
                                generalSettingRow(row, type: type, enabled: true)
                            }
                        }
                    }
                }
                .background(palette.card, in: RoundedRectangle(cornerRadius: 12))
                if model.generalPreferencePicker == nil { generalPreferenceFailure }
            }
            .padding(16)
        }
        .accessibilityIdentifier("general-scroll")
    }

    private func generalSettingLabel(_ row: CoreObject, description: String = "value") -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(row.text("label")).rnFont(15).foregroundStyle(palette.text)
            if !row.text(description).isEmpty {
                Text(row.text(description)).rnFont(12).foregroundStyle(palette.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }

    private func generalSettingRow(_ row: CoreObject, type: String, enabled: Bool) -> some View {
        Button { model.openGeneralPreferencePicker(type) } label: {
            HStack(spacing: 12) {
                generalSettingLabel(row)
                Image(systemName: "chevron.down").foregroundStyle(palette.secondary).accessibilityHidden(true)
            }.padding(14).frame(minHeight: 48).contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(!enabled || !model.generalPreferenceEnabled)
        .opacity(enabled ? 1 : 0.55)
        .accessibilityIdentifier("general-" + type)
    }

    @ViewBuilder private var generalPreferenceFailure: some View {
        if let failure = model.generalPreferenceReadError ?? model.generalPreferenceError {
            VStack(alignment: .leading, spacing: 8) {
                Text(failure).rnFont(14).foregroundStyle(palette.danger)
                    .fixedSize(horizontal: false, vertical: true).accessibilityIdentifier("general-error")
                if model.retryNeeded || model.generalPreferenceReadError != nil {
                    Button { Task { await model.retryGeneralPreference() } } label: {
                        Text(model.label("common.retry")).rnFont(15, .semibold)
                            .frame(maxWidth: .infinity, minHeight: 48).contentShape(Rectangle())
                    }
                        .background(palette.card, in: RoundedRectangle(cornerRadius: 12))
                        .disabled(model.busy).accessibilityIdentifier("general-retry")
                }
            }
        }
    }

    private var generalPreferenceSheet: some View {
        let type = model.generalPreferencePicker ?? ""
        let picker = ["quickAccessView", "theme"].contains(type)
            ? model.generalSettings.object("appearance").object(type == "theme" ? "theme" : "quickAccess")
            : type == "language" ? model.generalSettings.object("language") : model.generalSettings.object("regional").object(type)
        let groups = picker["groups"] as? [[CoreObject]] ?? [picker["options"] as? [CoreObject] ?? []]
        return VStack(spacing: 12) {
            HStack {
                Text(picker.text("pickerTitle")).rnFont(20, .bold).foregroundStyle(palette.text)
                    .accessibilityAddTraits(.isHeader).frame(maxWidth: .infinity, alignment: .leading)
                Button { model.closeGeneralPreferencePicker() } label: {
                    Text(model.label("common.cancel")).rnFont(15)
                        .frame(minWidth: 48, minHeight: 48).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                    .disabled(model.busy || model.retryNeeded || model.generalPreferenceActive)
                    .accessibilityIdentifier("general-picker-cancel")
            }.padding(.horizontal, 16).padding(.top, 20)
            ScrollView {
                VStack(spacing: 8) {
                    ForEach(groups.indices, id: \.self) { group in
                        if group > 0 { palette.border.frame(height: 1).padding(.vertical, 4).accessibilityHidden(true) }
                        ForEach(groups[group].indices, id: \.self) { index in
                            generalPreferenceOption(groups[group][index])
                        }
                    }
                    generalPreferenceFailure
                }.padding(.horizontal, 16).padding(.bottom, 24)
            }
        }
        .background(palette.bg)
        .presentationDetents(dynamicTypeSize.isAccessibilitySize || model.generalPreferenceActive ? [.large] : [.medium, .large])
        .presentationDragIndicator(.visible)
        .interactiveDismissDisabled(model.busy || model.retryNeeded || model.generalPreferenceActive)
    }

    private func generalPreferenceOption(_ option: CoreObject) -> some View {
        Button { Task { await model.saveGeneralPreference(option.object("edit")) } } label: {
            HStack {
                if !option.text("icon").isEmpty {
                    Image(systemName: settingsSymbol(option.text("icon")))
                        .font(.system(size: 20)).foregroundStyle(palette.secondary).frame(width: 24).accessibilityHidden(true)
                }
                Text(option.text("label")).rnFont(16).foregroundStyle(palette.text)
                    .fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity, alignment: .leading)
                if option["selected"] as? Bool == true {
                    Image(systemName: "checkmark").foregroundStyle(palette.tint).accessibilityHidden(true)
                }
            }.padding(14).frame(minHeight: 48).contentShape(Rectangle())
        }
        .buttonStyle(.plain).background(palette.card, in: RoundedRectangle(cornerRadius: 12))
        .disabled(!model.generalPreferenceEnabled)
        .accessibilityAddTraits(option["selected"] as? Bool == true ? .isSelected : [])
        .accessibilityIdentifier("general-option-" + option.text("value"))
    }

    private var menuContent: some View {
        ScrollView {
            VStack(spacing: 16) {
                TextField(model.settingsMenu.text("searchPlaceholder"), text: Binding(
                    get: { model.settingsSearch }, set: { model.setSettingsSearch($0) }))
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .rnFont(15).padding(.horizontal, 12).frame(minHeight: 44)
                    .background(palette.card, in: RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(palette.border, lineWidth: 1))
                    .accessibilityLabel(model.settingsMenu.text("searchPlaceholder"))
                    .accessibilityIdentifier("settings-search")
                if let groups = model.settingsMenu["groups"] as? [[CoreObject]] {
                    ForEach(groups.indices, id: \.self) { groupIndex in
                        VStack(spacing: 0) {
                            ForEach(groups[groupIndex].indices, id: \.self) { rowIndex in
                                let row = groups[groupIndex][rowIndex]
                                Button {
                                    if row.text("id") == "manage" { Task { await model.openManageSettings() } }
                                    else if row.text("id") == "general" { Task { await model.openGeneralSettings() } }
                                    else if row.text("id") == "data" { Task { await model.openDataSettings() } }
                                    else if row.text("id") == "gtd" { Task { await model.openGtdSettings() } }
                                } label: {
                                    HStack(spacing: 12) {
                                        Image(systemName: settingsSymbol(row.text("icon")))
                                            .font(.system(size: 20)).foregroundStyle(palette.tint)
                                            .frame(width: 32).accessibilityHidden(true)
                                        VStack(alignment: .leading, spacing: 3) {
                                            Text(row.text("title")).rnFont(15, .semibold).foregroundStyle(palette.text)
                                            if !row.text("description").isEmpty {
                                                Text(row.text("description")).rnFont(12)
                                                    .foregroundStyle(palette.secondary)
                                                    .fixedSize(horizontal: false, vertical: true)
                                            }
                                        }
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                        Image(systemName: "chevron.right").font(.system(size: 12))
                                            .foregroundStyle(palette.secondary).accessibilityHidden(true)
                                    }
                                    .padding(.horizontal, 14).frame(minHeight: 60).contentShape(Rectangle())
                                }
                                .buttonStyle(.plain).disabled(!["manage", "general", "gtd", "data"].contains(row.text("id")) || model.busy || model.retryNeeded)
                                .opacity(["manage", "general", "gtd", "data"].contains(row.text("id")) ? 1 : 0.55)
                                .accessibilityLabel(row.text("accessibilityLabel").isEmpty ? row.text("title") : row.text("accessibilityLabel"))
                                .accessibilityIdentifier("settings-" + row.text("id"))
                                if rowIndex < groups[groupIndex].count - 1 { palette.border.frame(height: 0.5) }
                            }
                        }
                        .background(palette.card, in: RoundedRectangle(cornerRadius: 12))
                    }
                }
                if !model.settingsMenu.text("noMatches").isEmpty {
                    Text(model.settingsMenu.text("noMatches")).rnFont(14).foregroundStyle(palette.secondary)
                        .frame(maxWidth: .infinity).padding(20).accessibilityIdentifier("settings-no-matches")
                }
                if let failure = model.settingsReadError ?? (!model.settingsManagePresented ? model.manageReadError : nil) {
                    errorBlock(failure, id: "settings-read-error") { Task { await model.retryManageSettingsRead() } }
                }
                if model.busy { ProgressView().padding(12) }
            }
            .padding(16)
        }
        .accessibilityIdentifier("settings-scroll")
    }

    private var manageContent: some View {
        ScrollViewReader { scroll in
            ScrollView {
                LazyVStack(spacing: 16) {
                    if let failure = model.managePersonReferenceError {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(failure).rnFont(13).foregroundStyle(palette.danger)
                                .accessibilityIdentifier("manage-person-reference-error")
                            Button { model.dismissManagedPersonReferenceError() } label: {
                                Text(model.label("common.close")).rnFont(14, .semibold)
                                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(Rectangle())
                            }
                            .buttonStyle(.plain).disabled(model.busy || model.retryNeeded)
                            .accessibilityIdentifier("manage-person-reference-error-close")
                        }
                    }
                    if let failure = model.unassignedAreaColorError, model.unassignedAreaColorOptions.isEmpty {
                        errorBlock(failure, id: "manage-unassigned-color-error",
                                   retryID: "manage-unassigned-color-retry") {
                            Task { await model.retryUnassignedAreaColor() }
                        }
                    } else if model.settingsTaxonomyActive && model.settingsTaxonomyAction == "delete",
                              let failure = model.settingsTaxonomyError ?? model.settingsTaxonomyReadError {
                        VStack(alignment: .leading, spacing: 4) {
                            errorBlock(failure, id: "manage-taxonomy-delete-error", retryID: "manage-taxonomy-delete-retry") {
                                Task {
                                    await model.retrySettingsTaxonomy()
                                    presentTaxonomyDeleteConfirmationIfReady()
                                }
                            }
                            if model.settingsTaxonomyCanCancel {
                                Button(model.label("common.cancel")) { model.cancelSettingsTaxonomy() }
                                    .frame(minHeight: 44).accessibilityIdentifier("manage-taxonomy-delete-cancel")
                            }
                        }
                    } else if let failure = model.settingsPersonDeleteError {
                        VStack(alignment: .leading, spacing: 4) {
                            errorBlock(failure, id: "manage-person-delete-error", retryID: "manage-person-delete-retry") {
                                Task {
                                    await model.retrySettingsPersonDelete()
                                    presentPersonDeleteConfirmationIfReady()
                                }
                            }
                            if model.settingsPersonDeleteCanCancel {
                                Button(model.label("common.cancel")) { model.cancelSettingsPersonDelete() }
                                    .frame(minHeight: 44).accessibilityIdentifier("manage-person-delete-cancel")
                            }
                        }
                    } else if let failure = model.settingsAreaDeleteError {
                        VStack(alignment: .leading, spacing: 4) {
                            errorBlock(failure, id: "manage-area-delete-error", retryID: "manage-area-delete-retry") {
                                Task {
                                    await model.retrySettingsAreaDelete()
                                    presentAreaDeleteConfirmationIfReady()
                                }
                            }
                            if model.settingsAreaDeleteCanCancel {
                                Button(model.label("common.cancel")) { model.cancelSettingsAreaDelete() }
                                    .frame(minHeight: 44).accessibilityIdentifier("manage-area-delete-error-cancel")
                            }
                        }
                    } else if let failure = model.somedaySectionOrderError {
                        errorBlock(failure, id: "manage-someday-order-error",
                                   retryID: "manage-someday-order-retry") {
                            Task { await model.retrySomedaySectionOrder() }
                        }
                    } else if let failure = model.somedaySectionDeleteError {
                        errorBlock(failure, id: "manage-someday-delete-error",
                                   retryID: "manage-someday-delete-retry") {
                            Task {
                                await model.retrySomedaySectionDelete()
                                presentSomedayDeleteConfirmationIfReady()
                            }
                        }
                    } else if let failure = model.somedaySectionRenameError ?? model.manageReadError {
                        errorBlock(failure, id: "manage-someday-error") {
                            Task {
                                if model.somedaySectionRenameIndex != nil || model.somedaySectionRenameReadPending {
                                    await model.retrySomedaySectionRename()
                                }
                                else { await model.retryManageSettingsRead() }
                            }
                        }
                    }
                    ForEach(model.manageSettings.objects("sections").indices, id: \.self) { index in
                        let section = model.manageSettings.objects("sections")[index]
                        let someday = section.text("key") == "somedaySections"
                        let areas = section.text("key") == "areas"
                        let inventory = ["people", "contexts", "tags"].contains(section.text("key"))
                        VStack(spacing: 1) {
                            Button { Task { await model.toggleManageSection(section.text("key")) } } label: {
                                HStack(spacing: 10) {
                                    Image(systemName: section.flag("open") ? "chevron.down" : "chevron.right")
                                        .font(.system(size: 14)).foregroundStyle(palette.secondary).accessibilityHidden(true)
                                    Text(section.text("title")).rnFont(15, .semibold)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                    Text(String(section.number("count"))).rnFont(13).foregroundStyle(palette.secondary)
                                }
                                .foregroundStyle(palette.text).padding(.horizontal, 16)
                                .frame(minHeight: 52).contentShape(Rectangle())
                            }
                            .buttonStyle(.plain).disabled(!(someday || areas || inventory)
                                                          || (inventory && !model.manageInventoryActionsEnabled)
                                                          || model.busy || model.retryNeeded || model.manageReadError != nil
                                                          || model.somedaySectionRenameIndex != nil
                                                          || model.somedaySectionRenameReadPending
                                                          || model.somedaySectionDeleteActive
                                                          || model.somedaySectionOrderActive
                                                          || model.unassignedAreaColorActive
                                                          || model.generalPreferenceActive || model.settingsTaxonomyActive || model.settingsPersonDeleteActive || model.settingsAreaDeleteActive || model.settingsAreaEditActive)
                            .opacity((someday || areas || inventory) ? 1 : 0.55)
                            .accessibilityValue(section.flag("open") ? "expanded" : "collapsed")
                            .accessibilityIdentifier("manage-section-toggle-" + (someday ? "someday-sections" : section.text("key")))
                            if inventory && section.flag("open") {
                                inventoryContent(section.text("key"))
                            }
                            if areas && section.flag("open") {
                                unassignedAreaRow
                                if model.managedAreasTotal == 0,
                                   let empty = model.manageSettings.object("areas")["empty"] as? String {
                                    Text(empty).rnFont(14).foregroundStyle(palette.secondary)
                                        .frame(maxWidth: .infinity, alignment: .leading).padding(16)
                                }
                                ForEach(model.managedAreas.indices, id: \.self) { rowIndex in
                                    areaRow(model.managedAreas[rowIndex], index: rowIndex)
                                }
                                if model.managedAreas.count < model.managedAreasTotal {
                                    Button(model.label("common.more")) {
                                        Task { await model.loadMoreManagedAreas() }
                                    }
                                    .frame(maxWidth: .infinity, minHeight: 44)
                                    .disabled(model.busy || model.retryNeeded || model.manageReadError != nil
                                              || model.unassignedAreaColorActive
                                              || model.somedaySectionRenameIndex != nil
                                              || model.somedaySectionDeleteActive || model.somedaySectionOrderActive
                                              || model.generalPreferenceActive || model.settingsTaxonomyActive || model.settingsPersonDeleteActive || model.settingsAreaDeleteActive || model.settingsAreaEditActive)
                                    .accessibilityIdentifier("manage-areas-more")
                                }
                                newAreaRow
                            }
                            if someday && section.flag("open") {
                                if model.managedSomedayTotal == 0 {
                                    Text(model.manageSettings.object("somedaySections").text("emptyHint"))
                                        .rnFont(14).foregroundStyle(palette.secondary)
                                        .frame(maxWidth: .infinity, alignment: .leading).padding(16)
                                } else {
                                    ForEach(model.managedSomedaySections.indices, id: \.self) { rowIndex in
                                        somedayRow(index: rowIndex)
                                    }
                                    if model.managedSomedaySections.count < model.managedSomedayTotal {
                                        Button(model.label("common.more")) {
                                            Task { await model.loadMoreManagedSomedaySections() }
                                        }
                                        .frame(maxWidth: .infinity, minHeight: 44)
                                        .disabled(model.busy || model.retryNeeded || model.manageReadError != nil
                                                  || model.somedaySectionRenameIndex != nil
                                                  || model.somedaySectionDeleteActive
                                                  || model.somedaySectionOrderActive
                                                  || model.unassignedAreaColorActive
                                                  || model.generalPreferenceActive || model.settingsTaxonomyActive || model.settingsPersonDeleteActive || model.settingsAreaDeleteActive || model.settingsAreaEditActive)
                                        .accessibilityIdentifier("manage-someday-more")
                                    }
                                }
                            }
                        }
                        .background(palette.card, in: RoundedRectangle(cornerRadius: 12))
                        .id(section.text("key"))
                        .onChange(of: section.flag("open")) { open in
                            // Settle the scroll position after a large list shrinks to its heading.
                            if !open { scroll.scrollTo(section.text("key"), anchor: .top) }
                        }
                    }
                    if model.busy { ProgressView().padding(12) }
                }
                .padding(16)
            }
            .accessibilityIdentifier("manage-someday-scroll")
        }
        .disabled(model.settingsTaxonomyActive || model.settingsPersonCreatePresented || model.settingsPersonEditPresented)
    }

    private func inventoryContent(_ key: String) -> some View {
        let rows = model.managedInventoryRows[key] ?? []
        return Group {
            if model.managedInventoryTotal(key) == 0,
               let empty = model.manageSettings.object(key)["empty"] as? String {
                Text(empty).rnFont(14).foregroundStyle(palette.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(16)
                    .accessibilityIdentifier("manage-\(key)-empty")
            }
            ForEach(rows.indices, id: \.self) { index in
                if key == "people" { personRow(rows[index], index: index) }
                else { inventoryValueRow(rows[index], key: key, index: index) }
            }
            if rows.count < model.managedInventoryTotal(key) {
                Button { Task { await model.loadMoreManagedInventory(key) } } label: {
                    Text(model.label("common.more")).frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle())
                }
                .disabled(!model.manageInventoryActionsEnabled)
                .accessibilityIdentifier("manage-\(key)-more")
            }
            if key == "people" {
                let newPerson = model.manageSettings.object("people").object("newPerson")
                HStack(spacing: 12) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(newPerson.text("label")).rnFont(15, .semibold).foregroundStyle(palette.text)
                        Text(newPerson.text("hint")).rnFont(12).foregroundStyle(palette.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    Button { Task { await model.openSettingsPersonCreate() } } label: {
                        Image(systemName: "plus").font(.system(size: 18))
                            .frame(width: 44, height: 44).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).disabled(!model.manageInventoryActionsEnabled)
                    .accessibilityLabel(newPerson.text("addLabel"))
                    .accessibilityIdentifier("manage-person-create-open")
                }
                .padding(.horizontal, 12).padding(.vertical, 8).frame(minHeight: 56)
            }
        }
    }

    private func personRow(_ row: CoreObject, index: Int) -> some View {
        let copy = model.manageSettings.object("people").object("text")
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .trailing, spacing: 4))
            : AnyLayout(HStackLayout(spacing: 8))
        return layout {
            HStack(spacing: 12) {
                Text(row.text("initial")).rnFont(14, .bold).foregroundStyle(palette.text)
                    .frame(width: 34, height: 34)
                    .background(palette.bg, in: Circle())
                    .overlay(Circle().stroke(palette.border, lineWidth: 1)).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 3) {
                    Text(row.text("name")).rnFont(15).foregroundStyle(palette.text)
                        .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1)
                        .accessibilityIdentifier("manage-person-name-\(index)")
                    if let detail = row["detail"] as? String, !detail.isEmpty {
                        Text(detail).rnFont(12).foregroundStyle(palette.secondary)
                            .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            HStack(spacing: 4) {
                Button { Task { await model.openManagedPersonSearch(index: index) } } label: {
                    Text(row.text("countLabel")).rnFont(13).foregroundStyle(palette.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.horizontal, 4).frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(!model.manageInventoryActionsEnabled)
                .accessibilityLabel(row.text("countAccessibilityLabel"))
                .accessibilityHint(copy.text("countHint"))
                .accessibilityIdentifier("manage-person-review-\(index)")
                if let reference = row["referenceLink"] as? String, !reference.isEmpty {
                    Button { Task { await model.openManagedPersonReference(index: index) } } label: {
                        Image(systemName: "arrow.up.right.square").font(.system(size: 18))
                            .foregroundStyle(palette.secondary).frame(width: 44, height: 44).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).disabled(!model.manageInventoryActionsEnabled)
                    .accessibilityLabel(copy.text("openReference"))
                    .accessibilityIdentifier("manage-person-reference-\(index)")
                }
                Button { Task { await model.openSettingsPersonEdit(index: index) } } label: {
                    Image(systemName: "pencil").font(.system(size: 18))
                        .foregroundStyle(palette.secondary).frame(width: 44, height: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(!model.manageInventoryActionsEnabled)
                .accessibilityLabel(copy.text("editLabel"))
                .accessibilityIdentifier("manage-person-edit-\(index)")
                Button {
                    Task {
                        await model.openSettingsPersonDelete(index: index)
                        presentPersonDeleteConfirmationIfReady()
                    }
                } label: {
                    Image(systemName: "trash").font(.system(size: 18))
                        .foregroundStyle(palette.danger).frame(width: 44, height: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(!model.manageInventoryActionsEnabled)
                .accessibilityLabel(copy.text("deleteLabel"))
                .accessibilityIdentifier("manage-person-delete-\(index)")
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 8).frame(minHeight: 56)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(row.text("name"))
        .accessibilityIdentifier("manage-person-row-\(index)")
    }

    private func inventoryValueRow(_ row: CoreObject, key: String, index: Int) -> some View {
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .trailing, spacing: 4))
            : AnyLayout(HStackLayout(spacing: 8))
        return layout {
            Text(row.text("value")).rnFont(15).foregroundStyle(palette.text)
                .frame(maxWidth: .infinity, alignment: .leading)
                .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1)
            HStack(spacing: 4) {
                Button {
                    Task { await model.openSettingsTaxonomy(kind: key == "contexts" ? "context" : "tag", index: index, deleting: false) }
                } label: {
                    Image(systemName: "pencil").font(.system(size: 18)).foregroundStyle(palette.secondary)
                        .frame(width: 44, height: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(!model.manageInventoryActionsEnabled)
                .accessibilityLabel("\(model.label("common.edit")): \(row.text("value"))")
                .accessibilityIdentifier("manage-\(key == "contexts" ? "context" : "tag")-edit-\(index)")
                Button {
                    Task {
                        await model.openSettingsTaxonomy(kind: key == "contexts" ? "context" : "tag", index: index, deleting: true)
                        presentTaxonomyDeleteConfirmationIfReady()
                    }
                } label: {
                    Image(systemName: "trash").font(.system(size: 18)).foregroundStyle(palette.danger)
                        .frame(width: 44, height: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(!model.manageInventoryActionsEnabled)
                .accessibilityLabel("\(model.label("common.delete")): \(row.text("value"))")
                .accessibilityIdentifier("manage-\(key == "contexts" ? "context" : "tag")-delete-\(index)")
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 8).frame(minHeight: 52)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(row.text("value"))
        .accessibilityIdentifier("manage-\(key == "contexts" ? "context" : "tag")-row-\(index)")
    }


    private var unassignedAreaRow: some View {
        let row = model.manageSettings.object("areas").object("unassigned")
        return HStack(spacing: 12) {
            RoundedRectangle(cornerRadius: 6).fill(Color(hex: row.text("color")))
                .frame(width: 24, height: 24).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(row.text("label")).rnFont(15, .semibold).foregroundStyle(palette.text)
                Text(row.text("description")).rnFont(12).foregroundStyle(palette.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Button { Task { await model.openUnassignedAreaColor() } } label: {
                Image(systemName: "pencil").font(.system(size: 18))
                    .foregroundStyle(palette.secondary).frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(model.busy || model.retryNeeded || model.manageReadError != nil
                      || model.unassignedAreaColorActive || model.somedaySectionRenameIndex != nil
                      || model.somedaySectionDeleteActive || model.somedaySectionOrderActive
                      || model.generalPreferenceActive || model.settingsTaxonomyActive || model.settingsPersonDeleteActive || model.settingsAreaDeleteActive || model.settingsAreaEditActive)
            .accessibilityLabel(model.label("common.edit") + ": " + row.text("label"))
            .accessibilityIdentifier("manage-unassigned-color")
        }
        .padding(.horizontal, 12).frame(minHeight: 56)
    }

    private func areaRow(_ row: CoreObject, index: Int) -> some View {
        HStack(spacing: 12) {
            RoundedRectangle(cornerRadius: 6).fill(Color(hex: row.text("color")))
                .frame(width: 24, height: 24).accessibilityHidden(true)
            Text(row.text("name")).rnFont(15).foregroundStyle(palette.text)
                .frame(maxWidth: .infinity, alignment: .leading)
                .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1)
                .accessibilityIdentifier("manage-area-name-\(index)")
            Button { Task { await model.openSettingsAreaEdit(index: index) } } label: {
                Image(systemName: "pencil").font(.system(size: 18)).foregroundStyle(palette.secondary)
                    .frame(width: 44, height: 44).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(model.busy || model.retryNeeded || model.manageReadError != nil
                      || model.generalPreferenceActive || model.settingsTaxonomyActive || model.settingsPersonDeleteActive || model.settingsAreaDeleteActive || model.settingsAreaCreatePresented
                      || model.settingsAreaEditActive || model.unassignedAreaColorActive
                      || model.somedaySectionDeleteActive || model.somedaySectionOrderActive
                      || model.somedaySectionRenameIndex != nil)
            .accessibilityLabel(model.label("common.edit") + ": " + row.text("name"))
            .accessibilityIdentifier("manage-area-edit-\(index)")
            Button {
                Task {
                    await model.openSettingsAreaDelete(index: index)
                    presentAreaDeleteConfirmationIfReady()
                }
            } label: {
                Image(systemName: "trash").font(.system(size: 18)).foregroundStyle(palette.danger)
                    .frame(width: 44, height: 44).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(model.busy || model.retryNeeded || model.manageReadError != nil
                      || model.generalPreferenceActive || model.settingsTaxonomyActive || model.settingsPersonDeleteActive || model.settingsAreaDeleteActive || model.settingsAreaEditActive || model.settingsAreaCreatePresented
                      || model.unassignedAreaColorActive || model.somedaySectionDeleteActive
                      || model.somedaySectionOrderActive || model.somedaySectionRenameIndex != nil)
            .accessibilityLabel(model.label("common.delete") + ": " + row.text("name"))
            .accessibilityIdentifier("manage-area-delete-\(index)")
        }
        .padding(.horizontal, 12).frame(minHeight: 52)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("manage-area-row-\(index)")
    }

    private var newAreaRow: some View {
        let row = model.manageSettings.object("areas").object("newArea")
        return HStack(spacing: 12) {
            RoundedRectangle(cornerRadius: 6).fill(Color(hex: row.text("color")))
                .frame(width: 24, height: 24).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(row.text("label")).rnFont(15, .semibold).foregroundStyle(palette.text)
                Text(row.text("hint")).rnFont(12).foregroundStyle(palette.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Button(row.text("addLabel")) { Task { await model.openSettingsAreaCreate() } }
                .disabled(model.busy || model.retryNeeded || model.manageReadError != nil
                          || model.settingsAreaCreatePresented || model.unassignedAreaColorActive
                          || model.somedaySectionRenameIndex != nil || model.somedaySectionDeleteActive
                          || model.somedaySectionOrderActive || model.generalPreferenceActive || model.settingsTaxonomyActive || model.settingsPersonDeleteActive || model.settingsAreaDeleteActive || model.settingsAreaEditActive)
                .frame(minWidth: 86, minHeight: 44)
                .accessibilityLabel(row.text("label"))
                .accessibilityIdentifier("manage-area-add")
        }
        .padding(.horizontal, 12).frame(minHeight: 56)
    }

    private func endPersonEditing() {
        personEditorFocused = nil
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    }

    private var taxonomyEditorSheet: some View {
        let copy = model.settingsTaxonomyOptions.object("text").isEmpty
            ? model.manageSettings.object("editor").object("text").object(model.settingsTaxonomyKind ?? "context")
            : model.settingsTaxonomyOptions.object("text")
        return NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    TextField(copy.text("namePlaceholder"), text: Binding(
                        get: { model.settingsTaxonomyName }, set: { model.setSettingsTaxonomyName($0) }))
                        .focused($taxonomyNameFocused).submitLabel(.done)
                        .onSubmit { taxonomyNameFocused = false }
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .rnFont(16).padding(.horizontal, 12).frame(minHeight: 48)
                        .background(palette.input, in: RoundedRectangle(cornerRadius: 10))
                        .disabled(!model.settingsTaxonomyInputEnabled)
                        .accessibilityLabel(copy.text("namePlaceholder"))
                        .accessibilityIdentifier("manage-taxonomy-name")
                    if let failure = model.settingsTaxonomyError ?? model.settingsTaxonomyReadError {
                        errorBlock(failure, id: "manage-taxonomy-error", retryID: "manage-taxonomy-retry") {
                            taxonomyNameFocused = false
                            Task { await model.retrySettingsTaxonomy() }
                        }
                    }
                    HStack(spacing: 12) {
                        Button {
                            taxonomyNameFocused = false
                            model.cancelSettingsTaxonomy()
                        } label: {
                            Text(copy.text("cancelLabel")).frame(maxWidth: .infinity, minHeight: 48).contentShape(Rectangle())
                        }
                        .disabled(!model.settingsTaxonomyCanCancel)
                        .accessibilityIdentifier("manage-taxonomy-cancel")
                        Button {
                            taxonomyNameFocused = false
                            Task { await model.saveSettingsTaxonomy() }
                        } label: {
                            Text(copy.text("saveLabel")).foregroundStyle(palette.onTint)
                                .frame(maxWidth: .infinity, minHeight: 48).contentShape(Rectangle())
                        }
                        .buttonStyle(.borderedProminent).tint(palette.tint)
                        .disabled(!model.settingsTaxonomyCanSave)
                        .accessibilityIdentifier("manage-taxonomy-save")
                    }
                }.padding(20)
            }
            .accessibilityIdentifier("manage-taxonomy-scroll")
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle(copy.text("title"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button(model.label("common.done")) { taxonomyNameFocused = false }
                        .frame(minHeight: 44).accessibilityIdentifier("manage-taxonomy-keyboard-done")
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .interactiveDismissDisabled(!model.settingsTaxonomyCanCancel)
    }

    private func presentTaxonomyDeleteConfirmationIfReady() {
        guard model.settingsTaxonomyCanConfirm else { return }
        taxonomyDeleteConfirmAnswered = false
        taxonomyDeleteConfirmPresented = true
    }

    private func personEditorSheet(editing: Bool) -> some View {
        let prefix = editing ? "manage-person-edit-" : "manage-person-create-"
        let inputEnabled = editing ? model.settingsPersonEditInputEnabled : model.settingsPersonCreateInputEnabled
        let canCancel = editing ? model.settingsPersonEditCanCancel : model.settingsPersonCreateCanCancel
        let canSave = editing ? model.settingsPersonEditCanSave : model.settingsPersonCreateCanSave
        let failure = editing ? (model.settingsPersonEditError ?? model.settingsPersonEditReadError)
            : (model.settingsPersonCreateError ?? model.settingsPersonCreateReadError)
        let copy = model.manageSettings.object("editor").object("text").object(editing ? "person" : "newPerson")
        let fields = copy.object("personFields")
        return NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    TextField(copy.text("namePlaceholder"), text: Binding(
                        get: { editing ? model.settingsPersonEditName : model.settingsPersonCreateName },
                        set: { if editing { model.setSettingsPersonEditName($0) } else { model.setSettingsPersonCreateName($0) } }))
                        .focused($personEditorFocused, equals: .name).submitLabel(.done)
                        .onSubmit { endPersonEditing() }
                        .rnFont(16).padding(.horizontal, 12).frame(minHeight: 48)
                        .background(palette.input, in: RoundedRectangle(cornerRadius: 10))
                        .disabled(!inputEnabled)
                        .accessibilityLabel(copy.text("namePlaceholder"))
                        .accessibilityIdentifier(prefix + "name")
                    ZStack(alignment: .topLeading) {
                        if (editing ? model.settingsPersonEditNote : model.settingsPersonCreateNote).isEmpty {
                            Text(fields.text("notePlaceholder")).rnFont(16).foregroundStyle(palette.secondary)
                                .padding(.top, 8).padding(.leading, 5).accessibilityHidden(true)
                        }
                        TextEditor(text: Binding(
                            get: { editing ? model.settingsPersonEditNote : model.settingsPersonCreateNote },
                        set: { if editing { model.setSettingsPersonEditNote($0) } else { model.setSettingsPersonCreateNote($0) } }))
                            .focused($personEditorFocused, equals: .note)
                            .rnFont(16).scrollContentBackground(.hidden).frame(minHeight: 140)
                            .disabled(!inputEnabled)
                            .accessibilityLabel(fields.text("notePlaceholder"))
                            .accessibilityIdentifier(prefix + "note")
                    }
                    .padding(8).background(palette.input, in: RoundedRectangle(cornerRadius: 10))
                    TextField(fields.text("referencePlaceholder"), text: Binding(
                        get: { editing ? model.settingsPersonEditReference : model.settingsPersonCreateReference },
                        set: { if editing { model.setSettingsPersonEditReference($0) } else { model.setSettingsPersonCreateReference($0) } }))
                        .focused($personEditorFocused, equals: .reference).submitLabel(.done)
                        .onSubmit { endPersonEditing() }
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .rnFont(16).padding(.horizontal, 12).frame(minHeight: 48)
                        .background(palette.input, in: RoundedRectangle(cornerRadius: 10))
                        .disabled(!inputEnabled)
                        .accessibilityLabel(fields.text("referencePlaceholder"))
                        .accessibilityIdentifier(prefix + "reference")
                    if let failure {
                        errorBlock(failure, id: prefix + "error", retryID: prefix + "retry") {
                            endPersonEditing()
                            Task {
                                if model.retryNeeded { await model.retry() }
                                else if editing { await model.retrySettingsPersonEditRead() }
                                else { await model.retrySettingsPersonCreateRead() }
                            }
                        }
                    }
                    HStack(spacing: 12) {
                        Button {
                            endPersonEditing()
                            if editing { model.cancelSettingsPersonEdit() } else { model.cancelSettingsPersonCreate() }
                        } label: {
                            Text(copy.text("cancelLabel"))
                                .frame(maxWidth: .infinity, minHeight: 48).contentShape(Rectangle())
                        }
                        .disabled(!canCancel)
                        .accessibilityIdentifier(prefix + "cancel")
                        Button {
                            endPersonEditing()
                            Task {
                                if editing { await model.saveSettingsPersonEdit() }
                                else { await model.saveSettingsPersonCreate() }
                            }
                        } label: {
                            Text(copy.text("saveLabel")).foregroundStyle(palette.onTint)
                                .frame(maxWidth: .infinity, minHeight: 48).contentShape(Rectangle())
                        }
                        .buttonStyle(.borderedProminent).tint(palette.tint)
                        .disabled(!canSave)
                        .accessibilityIdentifier(prefix + "save")
                    }
                }
                .padding(20)
            }
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle(copy.text("title"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button(model.label("common.done")) { endPersonEditing() }
                        .frame(minHeight: 44)
                        .accessibilityIdentifier(prefix + "keyboard-done")
                }
            }
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .interactiveDismissDisabled(!canCancel)
    }

    private var newAreaSheet: some View {
        let copy = model.manageSettings.object("editor").object("text").object("newArea")
        let colors = model.manageSettings.object("editor").objects("colors")
        return NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    TextField(copy.text("namePlaceholder"), text: Binding(
                        get: { model.areaCreateName }, set: { model.setAreaCreateName($0) }))
                        .focused($areaNameFocused).submitLabel(.done)
                        .onSubmit { areaNameFocused = false }
                        .rnFont(16).padding(.horizontal, 12).frame(minHeight: 48)
                        .background(palette.input, in: RoundedRectangle(cornerRadius: 10))
                        .disabled(!model.settingsAreaCreateInputEnabled)
                        .accessibilityLabel(copy.text("namePlaceholder"))
                        .accessibilityIdentifier("manage-area-create-name")
                    if model.areaCreateNameTaken {
                        Text(copy.text("nameTaken")).rnFont(13).foregroundStyle(palette.danger)
                            .accessibilityIdentifier("manage-area-create-name-taken")
                    }
                    Text(copy.text("changeColor")).rnFont(14, .semibold)
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 52), spacing: 12)], spacing: 12) {
                        ForEach(colors.indices, id: \.self) { index in
                            let choice = colors[index]
                            let selected = model.areaCreateColor == choice.text("color")
                            Button { model.selectAreaCreateColor(choice.text("color")) } label: {
                                RoundedRectangle(cornerRadius: 8)
                                    .fill(Color(hex: choice.text("color")))
                                    .frame(minWidth: 48, minHeight: 48)
                                    .overlay {
                                        if selected {
                                            Image(systemName: "checkmark").font(.system(size: 17, weight: .bold))
                                                .foregroundStyle(.white)
                                        }
                                    }
                            }
                            .buttonStyle(.plain).disabled(!model.settingsAreaCreateInputEnabled)
                            .accessibilityLabel(copy.text("changeColor") + ": " + choice.text("color"))
                            .accessibilityAddTraits(selected ? .isSelected : [])
                            .accessibilityIdentifier("manage-area-create-color-\(index)")
                        }
                    }
                    if let failure = model.areaCreateError ?? model.areaCreateReadError {
                        errorBlock(failure, id: "manage-area-create-error", retryID: "manage-area-create-retry") {
                            Task {
                                if model.retryNeeded { await model.retry() }
                                else { await model.retrySettingsAreaCreateRead() }
                            }
                        }
                    }
                    HStack(spacing: 12) {
                        Button { areaNameFocused = false; model.cancelSettingsAreaCreate() } label: {
                            Text(copy.text("cancelLabel"))
                                .frame(maxWidth: .infinity, minHeight: 48).contentShape(Rectangle())
                        }
                        .disabled(!model.settingsAreaCreateCanCancel)
                        .accessibilityIdentifier("manage-area-create-cancel")
                        Button { areaNameFocused = false; Task { await model.addArea() } } label: {
                            Text(copy.text("saveLabel"))
                                .foregroundStyle(palette.onTint)
                                .frame(maxWidth: .infinity, minHeight: 48).contentShape(Rectangle())
                        }
                        .buttonStyle(.borderedProminent).tint(palette.tint)
                        .disabled(!model.settingsAreaCreateCanSave)
                        .accessibilityIdentifier("manage-area-create-save")
                    }
                }
                .padding(20)
            }
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle(copy.text("title"))
            .navigationBarTitleDisplayMode(.inline)
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .interactiveDismissDisabled(!model.settingsAreaCreateCanCancel)
    }

    private var areaEditSheet: some View {
        let copy = model.manageSettings.object("editor").object("text").object("area")
        let colors = model.manageSettings.object("editor").objects("colors")
        let custom = model.settingsAreaEditColor
        return NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    TextField(copy.text("namePlaceholder"), text: Binding(
                        get: { model.areaRenameDraft }, set: { model.setAreaRenameDraft($0) }))
                        .focused($areaNameFocused).submitLabel(.done)
                        .onSubmit { areaNameFocused = false }
                        .rnFont(16).padding(.horizontal, 12).frame(minHeight: 48)
                        .background(palette.input, in: RoundedRectangle(cornerRadius: 10))
                        .disabled(!model.settingsAreaEditInputEnabled)
                        .accessibilityLabel(copy.text("namePlaceholder"))
                        .accessibilityIdentifier("manage-area-edit-name")
                    Text(copy.text("changeColor")).rnFont(14, .semibold)
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 52), spacing: 12)], spacing: 12) {
                        ForEach(colors.indices, id: \.self) { index in
                            let choice = colors[index]
                            let selected = model.settingsAreaEditColor == choice.text("color")
                            Button { model.setSettingsAreaEditColor(choice.text("color")) } label: {
                                RoundedRectangle(cornerRadius: 8)
                                    .fill(Color(hex: choice.text("color")))
                                    .frame(minWidth: 48, minHeight: 48)
                                    .overlay {
                                        if selected {
                                            Image(systemName: "checkmark").font(.system(size: 17, weight: .bold))
                                                .foregroundStyle(.white)
                                        }
                                    }
                            }
                            .buttonStyle(.plain).disabled(!model.settingsAreaEditInputEnabled)
                            .accessibilityLabel(copy.text("changeColor") + ": " + choice.text("color"))
                            .accessibilityAddTraits(selected ? .isSelected : [])
                            .accessibilityIdentifier("manage-area-edit-color-option-\(index)")
                        }
                        if !custom.isEmpty && !colors.contains(where: { $0.text("color") == custom }) {
                            RoundedRectangle(cornerRadius: 8).fill(Color(hex: custom))
                                .frame(minWidth: 48, minHeight: 48)
                                .overlay {
                                    Image(systemName: "checkmark").font(.system(size: 17, weight: .bold))
                                        .foregroundStyle(.white)
                                }
                                .accessibilityLabel(copy.text("changeColor") + ": " + custom)
                                .accessibilityAddTraits(.isSelected)
                        }
                    }
                    if let failure = model.areaRenameError ?? model.areaRenameReadError {
                        errorBlock(failure, id: "manage-area-edit-error", retryID: "manage-area-edit-retry") {
                            Task { await model.retrySettingsAreaEdit() }
                        }
                    }
                    HStack(spacing: 12) {
                        Button { areaNameFocused = false; model.cancelSettingsAreaEdit() } label: {
                            Text(copy.text("cancelLabel"))
                                .frame(maxWidth: .infinity, minHeight: 48).contentShape(Rectangle())
                        }
                        .disabled(!model.settingsAreaEditCanCancel)
                        .accessibilityIdentifier("manage-area-edit-cancel")
                        Button { areaNameFocused = false; Task { await model.saveSettingsAreaEdit() } } label: {
                            Text(copy.text("saveLabel"))
                                .foregroundStyle(palette.onTint)
                                .frame(maxWidth: .infinity, minHeight: 48).contentShape(Rectangle())
                        }
                        .buttonStyle(.borderedProminent).tint(palette.tint)
                        .disabled(!model.settingsAreaEditCanSave)
                        .accessibilityIdentifier("manage-area-edit-save")
                    }
                }
                .padding(20)
            }
            .accessibilityIdentifier("manage-area-edit-scroll")
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle(copy.text("title"))
            .navigationBarTitleDisplayMode(.inline)
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .interactiveDismissDisabled(!model.settingsAreaEditCanCancel)
    }

    private var unassignedAreaColorSheet: some View {
        let editor = model.manageSettings.object("editor")
        let copy = editor.object("text").object("unassignedArea")
        let colors = editor.objects("colors")
        return NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 52), spacing: 12)], spacing: 12) {
                        ForEach(colors.indices, id: \.self) { index in
                            let choice = colors[index]
                            let selected = model.unassignedAreaColorDraft == choice.text("color")
                            Button { model.selectUnassignedAreaColor(choice.text("color")) } label: {
                                RoundedRectangle(cornerRadius: 8)
                                    .fill(Color(hex: choice.text("color")))
                                    .frame(minWidth: 48, minHeight: 48)
                                    .overlay {
                                        if selected {
                                            Image(systemName: "checkmark").font(.system(size: 17, weight: .bold))
                                                .foregroundStyle(.white)
                                        }
                                    }
                            }
                            .buttonStyle(.plain).disabled(!model.unassignedAreaColorCanSave)
                            .accessibilityLabel(choice.text("label"))
                            .accessibilityAddTraits(selected ? .isSelected : [])
                            .accessibilityIdentifier("manage-unassigned-color-option-\(index)")
                        }
                    }
                    if let failure = model.unassignedAreaColorError {
                        errorBlock(failure, id: "manage-unassigned-color-error",
                                   retryID: "manage-unassigned-color-retry") {
                            Task { await model.retryUnassignedAreaColor() }
                        }
                    }
                    HStack(spacing: 12) {
                        Button { model.cancelUnassignedAreaColor() } label: {
                            Text(copy.text("cancelLabel"))
                                .frame(maxWidth: .infinity, minHeight: 48).contentShape(Rectangle())
                        }
                            .disabled(model.busy || model.retryNeeded || model.unassignedAreaColorAwaitingRefresh)
                            .accessibilityIdentifier("manage-unassigned-color-cancel")
                        Button { Task { await model.saveUnassignedAreaColor() } } label: {
                            Text(copy.text("saveLabel"))
                                .foregroundStyle(palette.onTint)
                                .frame(maxWidth: .infinity, minHeight: 48).contentShape(Rectangle())
                        }
                            .buttonStyle(.borderedProminent)
                            .tint(palette.tint)
                            .disabled(!model.unassignedAreaColorCanSave)
                            .accessibilityIdentifier("manage-unassigned-color-save")
                    }
                }
                .padding(20)
            }
            .navigationTitle(copy.text("title"))
            .navigationBarTitleDisplayMode(.inline)
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .interactiveDismissDisabled(model.busy || model.retryNeeded || model.unassignedAreaColorAwaitingRefresh)
    }

    private func somedayRow(index: Int) -> some View {
        let row = model.managedSomedaySections[index]
        let editing = model.somedaySectionRenameIndex == index
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .trailing, spacing: 4))
            : AnyLayout(HStackLayout(spacing: 8))
        return Group {
            if editing {
                HStack(spacing: 8) {
                    TextField(model.somedaySectionRenameOptions.object("text").text("nameLabel"), text: Binding(
                        get: { model.somedaySectionRenameTitle }, set: { model.setSomedaySectionRenameTitle($0) }))
                        .focused($renameFocused).submitLabel(.done)
                        .onSubmit { Task { await model.saveSomedaySectionRename() } }
                        .rnFont(15).padding(.horizontal, 10).frame(minHeight: 44)
                        .background(palette.input, in: RoundedRectangle(cornerRadius: 8))
                        .contentShape(Rectangle())
                        .onTapGesture { renameFocused = true }
                        .disabled(!model.somedaySectionRenameInputEnabled)
                        .accessibilityLabel(model.somedaySectionRenameOptions.object("text").text("nameLabel"))
                        .accessibilityIdentifier("manage-someday-name")
                    Button { renameFocused = false; model.cancelSomedaySectionRename() } label: {
                        Text(model.label("common.cancel")).rnFont(13).frame(minHeight: 44)
                            .padding(.horizontal, 4).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).disabled(model.busy || model.retryNeeded
                                                  || model.somedaySectionRenamePending || model.somedaySectionRenameAwaitingRefresh)
                    .accessibilityIdentifier("manage-someday-cancel")
                    Button { renameFocused = false; Task { await model.saveSomedaySectionRename() } } label: {
                        Image(systemName: "checkmark").font(.system(size: 18, weight: .semibold))
                            .frame(width: 44, height: 44).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).disabled(!model.somedaySectionRenameCanSave)
                    .opacity(model.somedaySectionRenameCanSave ? 1 : 0.45)
                    .accessibilityLabel(model.somedaySectionRenameOptions.object("text").text("saveLabel"))
                    .accessibilityIdentifier("manage-someday-save")
                }
            } else {
                layout {
                    Text(row.text("title")).rnFont(15).foregroundStyle(palette.text)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1)
                        .accessibilityIdentifier("manage-someday-title-\(index)")
                    HStack(spacing: 8) {
                        orderButton(row: row, index: index, offset: -1)
                        orderButton(row: row, index: index, offset: 1)
                        Button { Task { await model.openSomedaySectionRename(index: index); renameFocused = true } } label: {
                            Image(systemName: "pencil").font(.system(size: 18))
                                .foregroundStyle(palette.secondary).frame(width: 44, height: 44).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).disabled(model.busy || model.retryNeeded || model.manageReadError != nil
                                                      || model.somedaySectionRenameReadPending || model.somedaySectionRenameIndex != nil
                                                      || model.somedaySectionDeleteActive || model.somedaySectionOrderActive)
                        .accessibilityLabel(row.text("renameLabel"))
                        .accessibilityIdentifier("manage-someday-rename-\(index)")
                        Button {
                            Task {
                                await model.openSomedaySectionDelete(index: index)
                                presentSomedayDeleteConfirmationIfReady()
                            }
                        } label: {
                            Image(systemName: "trash").font(.system(size: 18))
                                .foregroundStyle(palette.danger).frame(width: 44, height: 44)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).disabled(model.busy || model.retryNeeded || model.manageReadError != nil
                                                      || model.somedaySectionRenameReadPending || model.somedaySectionRenameIndex != nil
                                                      || model.somedaySectionDeleteActive || model.somedaySectionOrderActive)
                        .accessibilityLabel(row.text("deleteLabel"))
                        .accessibilityIdentifier("manage-someday-delete-\(index)")
                    }
                }
            }
        }
        .padding(.horizontal, 12).frame(minHeight: 52)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(row.text("title"))
        .accessibilityIdentifier("manage-someday-row-\(index)")
    }

    private func orderButton(row: CoreObject, index: Int, offset: Int) -> some View {
        let up = offset == -1
        let control = row.object(up ? "moveUp" : "moveDown")
        let disabled = control.flag("disabled") || model.busy || model.retryNeeded
            || model.manageReadError != nil || model.somedaySectionRenameReadPending
            || model.somedaySectionRenameIndex != nil || model.somedaySectionDeleteActive
            || model.somedaySectionOrderActive
        return Button { Task { await model.moveManagedSomedaySection(index: index, offset: offset) } } label: {
            Image(systemName: up ? "chevron.up" : "chevron.down")
                .font(.system(size: 18)).foregroundStyle(palette.secondary)
                .frame(width: 44, height: 44).contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(disabled).opacity(disabled ? 0.45 : 1)
        .accessibilityLabel(control.text("label"))
        .accessibilityIdentifier("manage-someday-\(up ? "up" : "down")-\(index)")
    }

    private func presentSomedayDeleteConfirmationIfReady() {
        guard model.somedaySectionDeleteCanConfirm else { return }
        deleteConfirmAnswered = false
        deleteConfirmPresented = true
    }

    private func presentPersonDeleteConfirmationIfReady() {
        guard model.settingsPersonDeleteCanConfirm else { return }
        personDeleteConfirmAnswered = false
        personDeleteConfirmPresented = true
    }

    private func presentAreaDeleteConfirmationIfReady() {
        guard model.settingsAreaDeleteCanConfirm else { return }
        areaDeleteConfirmAnswered = false
        areaDeleteConfirmPresented = true
    }

    private func errorBlock(_ failure: String, id: String,
                            retryID: String = "manage-someday-retry", retry: @escaping () -> Void) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(failure).rnFont(13).foregroundStyle(palette.danger).textSelection(.enabled)
                .accessibilityIdentifier(id)
            Button(action: retry) {
                Text(model.label("common.retry")).rnFont(14, .semibold)
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(Rectangle())
            }
            .buttonStyle(.plain).disabled(model.busy)
            .accessibilityIdentifier(retryID)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func settingsSymbol(_ name: String) -> String {
        switch name {
        case "Monitor": return "display"
        case "ListChecks": return "checklist"
        case "Layers": return "square.3.layers.3d"
        case "Bell": return "bell"
        case "RefreshCw": return "arrow.clockwise"
        case "Database": return "externaldrive"
        case "Settings2": return "slider.horizontal.3"
        case "Info": return "info.circle"
        case "Sparkles": return "sparkles"
        case "CalendarDays": return "calendar"
        case "phone-portrait-outline": return "iphone"
        case "contrast-outline": return "circle.lefthalf.filled"
        case "sunny-outline": return "sun.max"
        case "moon-outline": return "moon"
        case "color-palette-outline": return "paintpalette"
        case "document-text-outline": return "doc.text"
        case "snow-outline": return "snowflake"
        case "cafe-outline": return "cup.and.saucer"
        case "wine-outline": return "wineglass"
        case "book-outline": return "book"
        default: return "gearshape"
        }
    }
}

/// One shared card for Settings and the locally owned pending-task sheet.
struct DiagnosticsCard: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    let owner: UUID
    @State private var backupOpen = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if owner == model.settingsDiagnosticsOwner {
                    let backup = model.dataSettings.object("backup")
                    Button { backupOpen.toggle() } label: {
                        HStack {
                            Text(backup.text("title")).rnFont(18, .bold)
                            Spacer()
                            Image(systemName: backupOpen ? "chevron.down" : "chevron.forward")
                                .foregroundStyle(palette.secondary).accessibilityHidden(true)
                        }.frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle())
                    }
                    .accessibilityIdentifier("backup-disclosure")
                    if backupOpen {
                        Button { Task { await model.exportDataBackup() } } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(backup.text("exportLabel")).rnFont(15, .semibold)
                                Text(backup.text("description")).rnFont(13).foregroundStyle(palette.secondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }.multilineTextAlignment(.leading)
                                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        }
                        .disabled(!model.backupExportEnabled)
                        .accessibilityIdentifier("data-transfer-export")
                        Button { Task { await model.exportDataBackup(format: .csv) } } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(backup.text("csvLabel")).rnFont(15, .semibold)
                                Text(backup.text("csvDescription")).rnFont(13).foregroundStyle(palette.secondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }.multilineTextAlignment(.leading)
                                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        }
                        .disabled(!model.backupExportEnabled)
                        .accessibilityIdentifier("data-transfer-export-csv")
                        Button { Task { await model.exportDataBackup(format: .tasknotes) } } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(backup.text("tasknotesLabel")).rnFont(15, .semibold)
                                Text(backup.text("tasknotesDescription")).rnFont(13).foregroundStyle(palette.secondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }.multilineTextAlignment(.leading)
                                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        }
                        .disabled(!model.backupExportEnabled)
                        .accessibilityIdentifier("data-transfer-export-tasknotes")
                        if model.backupExportBusy { ProgressView().accessibilityIdentifier("backup-export-progress") }
                        if let failure = model.backupExportError {
                            Text(failure).rnFont(14).foregroundStyle(palette.danger)
                                .accessibilityIdentifier("backup-export-error")
                        }
                    }
                }
                Text(model.diagnosticsLabels.text("title")).rnFont(18, .bold)
                    .accessibilityAddTraits(.isHeader).accessibilityIdentifier("diagnostics-title")
                let logging = model.diagnosticsLabels.object("debugLogging")
                Toggle(isOn: Binding(get: { logging.flag("value") }, set: { value in
                    Task { await model.setDiagnosticsDebugLogging(value) }
                })) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(logging.text("label")).rnFont(15, .semibold)
                        Text(logging.text("description")).rnFont(13).foregroundStyle(palette.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .disabled(!model.diagnosticsToggleEnabled || owner != model.settingsDiagnosticsOwner)
                .accessibilityIdentifier("diagnostics-debug-logging")
                if let share = model.diagnosticsLabels["shareLog"] as? CoreObject {
                    Button { Task { await model.shareDiagnostics(owner: owner) } } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(share.text("label")).rnFont(15, .semibold)
                            Text(share.text("description")).rnFont(13).foregroundStyle(palette.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(Rectangle())
                    }
                    .disabled(!model.diagnosticsFileActionsEnabled(owner: owner))
                    .accessibilityIdentifier("diagnostics-share")
                }
                if let clear = model.diagnosticsLabels["clearLog"] as? CoreObject {
                    Button { Task { await model.clearDiagnostics(owner: owner) } } label: {
                        Text(clear.text("label")).rnFont(15, .semibold)
                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(Rectangle())
                    }
                    .disabled(!model.diagnosticsFileActionsEnabled(owner: owner))
                    .accessibilityIdentifier("diagnostics-clear")
                }
                if let message = model.diagnosticsMessage {
                    Text(message).rnFont(14).fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("diagnostics-message").accessibilityAddTraits(.updatesFrequently)
                }
                if let failure = model.diagnosticsReadError {
                    Text(failure).rnFont(13).foregroundStyle(palette.danger)
                        .accessibilityIdentifier("diagnostics-read-error")
                    if owner == model.settingsDiagnosticsOwner {
                        Button(model.label("common.retry")) { Task { await model.retryDataSettingsRead() } }
                            .disabled(model.busy).frame(minHeight: 44).accessibilityIdentifier("diagnostics-retry")
                    }
                }
                #if DEBUG && targetEnvironment(simulator)
                if !model.backupExportTestState.isEmpty {
                    Text(model.backupExportTestState).font(.caption)
                        .accessibilityIdentifier("backup-export-test-state")
                }
                if !model.diagnosticsShareTestState.isEmpty {
                    Text(model.diagnosticsShareTestState).font(.caption)
                        .accessibilityIdentifier("diagnostics-test-share-state")
                }
                #endif
                if model.diagnosticsFileBusy { ProgressView().accessibilityIdentifier("diagnostics-file-progress") }
            }
            .foregroundStyle(palette.text).padding(16)
        }
        .background(palette.bg).accessibilityIdentifier("diagnostics-scroll")
        .sheet(item: Binding(get: {
            guard let payload = model.diagnosticsShare, payload.owner == owner,
                  model.diagnosticsCurrent(owner: owner, session: payload.id) else { return nil }
            return payload
        }, set: { (_: DiagnosticsSharePayload?) in model.dismissDiagnosticsShare(owner: owner) })) { payload in
            DiagnosticsActivitySheet(url: payload.url)
        }
        .sheet(item: Binding(get: { owner == model.settingsDiagnosticsOwner ? model.backupShare : nil },
                             set: { (_: NativeBackupExport?) in model.dismissBackupShare() })) { payload in
            DiagnosticsActivitySheet(url: payload.url)
        }
    }
}

private struct DiagnosticsActivitySheet: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: [url], applicationActivities: nil)
    }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
