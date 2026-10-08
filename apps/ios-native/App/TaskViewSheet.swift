import SwiftUI
import UIKit
import LinkPresentation
import UniformTypeIdentifiers
import QuickLook
import PhotosUI

private struct TaskDraftDirection: ViewModifier {
    let direction: LayoutDirection

    @ViewBuilder func body(content: Content) -> some View {
        let view = content.multilineTextAlignment(.leading).environment(\.layoutDirection, direction)
        if #available(iOS 26.0, *) {
            view.multilineTextAlignment(strategy: .layoutBased)
                .writingDirection(strategy: .layoutBased)
        } else {
            view
        }
    }
}

/// Core owns field layout, draft edits, preview formatting and acknowledged saves.
struct TaskViewSheet: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    @State private var editing = false
    @State private var discardConfirm = false
    @State private var fileImporterID: UUID?
    @State private var ownedMenuPromptVisible = false
    @State private var sectionExpanded: [String: Bool] = [:]
    @State private var sectionTaskID = ""
    @State private var datePickerID = ""
    @State private var datePickerValue = Date.distantPast
    @State private var monthlyCustom: CoreObject?
    @State private var waitingAssignment: String?
    @State private var backdatedCompletion: TaskBackdatedCompletionDraft?
    @State private var checklistReordering = false
    @FocusState private var focusedChecklistIndex: Int?
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    private var value: CoreObject { model.taskView }
    private var strings: CoreObject { model.strings }
    private var busy: Bool { model.busy }
    private var error: String? { model.taskError }
    private var readOnly: Bool { model.taskEditor.flag("readOnly") }
    private var operationFrozen: Bool { busy || model.retryNeeded || model.taskChecklistReadPending || model.taskPersonCreateOwed || model.taskAttachmentOpening || model.taskReferenceOpening || model.taskSharePayload != nil || model.taskFileOpenPresentation != nil || model.taskAttachmentWorking || model.taskFileImporterPresented }
    private var attachmentRecoveryFrozen: Bool {
        model.taskAttachmentState == .interrupted || model.taskAttachmentState == .savedCleanup
            || model.taskAttachmentState == .blocked
    }
    private var ownedCloseDecision: Bool {
        model.taskAttachmentState == .active || model.taskAttachmentState == .interrupted
            || model.taskAttachmentState == .blocked
    }
    private var ownedMenuSettled: Bool {
        model.taskOwnedMenuAction != nil
            && (model.taskAttachmentState == .none || model.taskAttachmentState == .discardedCleanup)
    }
    private var frozen: Bool { operationFrozen || attachmentRecoveryFrozen || model.taskOwnedMenuAction != nil }

    private var rows: [CoreObject] { value.objects("rows") }
    private var modalPresented: Bool {
        !model.taskDestinationKind.isEmpty || monthlyCustom != nil || waitingAssignment != nil
            || backdatedCompletion != nil || model.taskLinkSheetActive || model.taskFileImporterPresented
            || model.taskFileOpenPresentation != nil
            || ownedMenuPromptVisible
    }

    var body: some View {
        let pickerID = fileImporterID
        let fileOpenID = model.taskFileOpenPresentation?.id
        ZStack {
            taskContent
                .accessibilityElement(children: modalPresented ? .ignore : .contain)
                .accessibilityHidden(modalPresented)
            if !model.taskDestinationKind.isEmpty {
                TaskDestinationPicker(model: model, palette: palette, beforeAction: endEditingBeforeAction)
            }
            if let custom = monthlyCustom {
                TaskMonthlyCustomDialog(model: model, palette: palette, initial: custom,
                    beforeAction: endEditingBeforeAction, close: { monthlyCustom = nil })
            }
            if let initial = waitingAssignment {
                TaskWaitingAssignmentDialog(model: model, palette: palette, initial: initial,
                    taskID: model.taskEditor.text("id"), session: model.taskEditorSession,
                    beforeAction: endEditingBeforeAction, close: { waitingAssignment = nil })
            }
            if let initial = backdatedCompletion {
                TaskBackdatedCompletionDialog(model: model, palette: palette, initial: initial,
                    close: { backdatedCompletion = nil })
            }
            if model.taskLinkSheetActive { taskLinkDialog }
        }
        .sheet(item: Binding(get: { model.taskSharePayload }, set: { if $0 == nil { model.dismissTaskShare() } })) { payload in
            TaskActivitySheet(payload: payload)
        }
        .sheet(item: Binding(
            get: { model.taskFileOpenPresentation },
            set: { presentation in
                if presentation == nil, let fileOpenID { model.dismissTaskFileOpen(presentationID: fileOpenID) }
            })) { presentation in
                Group {
                    if presentation.kind == .file {
                        AttachmentFileActivitySheet(presentation: presentation)
                    } else if presentation.kind == .audio {
                        TaskAttachmentAudioSheet(model: model, palette: palette, presentationID: presentation.id)
                    } else {
                        NavigationStack {
                            AttachmentFileQuickLookSheet(presentation: presentation)
                                .toolbar {
                                    ToolbarItem(placement: .confirmationAction) {
                                        Button(strings.text("common.done")) {
                                            model.dismissTaskFileOpen(presentationID: presentation.id)
                                        }
                                        .accessibilityIdentifier("task-attachment-preview-done")
                                    }
                                }
                        }
                    }
                }
                .id(presentation.id)
                .onDisappear { model.dismissTaskFileOpen(presentationID: presentation.id) }
            }
        .sheet(item: Binding(
            get: {
                guard let pickerID, pickerID == model.taskFileImporterID, model.taskFileImporterPresented,
                      let kind = model.taskFileImporterKind else { return nil }
                return TaskAttachmentPickerClaim(id: pickerID, kind: kind)
            },
            set: { (claim: TaskAttachmentPickerClaim?) in
                if claim == nil { model.setTaskFileImporterPresented(false, pickerID: pickerID) }
            })) { claim in
                Group {
                    switch claim.kind {
                    case .file:
                        NativeDocumentPicker(pickerID: claim.id) { result, capturedID in
                            Task { await model.completeTaskFileImport(result, pickerID: capturedID) }
                        }
                    case .photo:
                        NativePhotoPicker(pickerID: claim.id) { result, capturedID in
                            Task { await model.completeTaskPhotoImport(result, pickerID: capturedID) }
                        }
                    }
                }
                .id(claim.id)
                .interactiveDismissDisabled()
            }
        .alert(ownedMenuTitle, isPresented: $ownedMenuPromptVisible, presenting: model.taskOwnedMenuAction) { _ in
            Button(strings.text(ownedMenuSettled ? "settings.attachmentsCleanupPendingDeletesConfirmAction" : "common.save")) {
                endEditingBeforeAction()
                Task { await model.resolveTaskOwnedMenuAction(.save) }
            }
            .disabled(operationFrozen || attachmentRecoveryFrozen || model.taskPersonCreateNeedsReview)
            .accessibilityIdentifier("task-owned-action-save")
            if !ownedMenuSettled {
                Button(strings.text("common.discard"), role: .destructive) {
                    endEditingBeforeAction()
                    Task { await model.resolveTaskOwnedMenuAction(.discard) }
                }
                .disabled(busy || model.taskAttachmentWorking || model.taskAttachmentState == .savedCleanup)
                .accessibilityIdentifier("task-owned-action-discard")
            }
            Button(strings.text("common.cancel"), role: .cancel) {
                Task { await model.resolveTaskOwnedMenuAction(.cancel) }
            }
            .accessibilityIdentifier("task-owned-action-cancel")
        } message: { _ in
            Text(ownedMenuSettled
                ? "Continue with this task action, or cancel it."
                : "Choose whether to save or discard this draft before continuing. If recovery is needed, the action will wait.")
        }
        .alert(strings.text("common.share"), isPresented: Binding(
            get: { model.taskShareError != nil },
            set: { if !$0 { model.dismissTaskShareError() } })) {
            Button(strings.text("common.ok")) { model.dismissTaskShareError() }
                .accessibilityIdentifier("task-share-error-dismiss")
        } message: {
            Text(model.taskShareError ?? "").accessibilityIdentifier("task-share-error")
        }
        .alert(strings.text("attachments.title"), isPresented: Binding(
            get: { model.taskAttachmentOpenError != nil },
            set: { if !$0 { model.dismissTaskAttachmentOpenError() } })) {
            Button(strings.text("common.ok")) { model.dismissTaskAttachmentOpenError() }
                .accessibilityIdentifier("task-attachment-open-dismiss")
        } message: {
            Text(model.taskAttachmentOpenError ?? "")
                .accessibilityIdentifier("task-attachment-open-error")
        }
    }

    private var taskContent: some View {
        VStack(spacing: 0) {
            HStack {
                Button {
                    if model.taskDirty || ownedCloseDecision {
                        model.preserveTaskTokenInputForTransientModal()
                        _ = UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder),
                            to: nil, from: nil, for: nil)
                        discardConfirm = true
                    } else {
                        endEditingBeforeAction()
                        model.closeTask()
                    }
                } label: {
                    AppIcon(name: "x", size: 22).frame(width: 44, height: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled((ownedCloseDecision
                    ? busy || model.taskAttachmentOpening || model.taskAttachmentWorking || model.taskFileImporterPresented || modalPresented
                    : frozen) || model.taskScheduleUpdating)
                .accessibilityLabel(strings.text("common.close")).accessibilityIdentifier("task-view-close")
                Spacer()
                if !readOnly && !model.taskEditor.isEmpty {
                    Menu {
                        if model.taskEditor.flag("canSkipOccurrence") {
                            Button(strings.text("task.skipOccurrence")) {
                                endEditingBeforeAction()
                                Task { await model.saveTask(intent: .skip) }
                            }.accessibilityIdentifier("task-skip-occurrence")
                        }
                        if model.taskEditor.flag("canCancel") {
                            Button(model.taskEditor.text("cancelLabel"), role: .destructive) {
                                endEditingBeforeAction()
                                Task { await model.saveTask(intent: .cancel) }
                            }.accessibilityIdentifier("task-cancel")
                        }
                        if model.taskEditor.object("draft").text("status") == "reference" {
                            Button(strings.text("reference.convertToAction")) {
                                endEditingBeforeAction()
                                Task { _ = await model.editTaskStatus("next") }
                            }
                            .disabled(!model.taskStatusEditable("next"))
                            .accessibilityIdentifier("task-reference-action-menu")
                        }
                        Button(strings.text("taskEdit.duplicateTask")) {
                            endEditingBeforeAction()
                            Task { await model.duplicateTask() }
                        }.accessibilityIdentifier("task-duplicate")
                        Button(strings.text("task.createProjectFromTask")) {
                            endEditingBeforeAction()
                            Task { await model.promoteTaskToProject() }
                        }.accessibilityIdentifier("task-promote")
                        Button(strings.text("common.share")) {
                            endEditingBeforeAction()
                            Task { await model.shareTask() }
                        }.accessibilityIdentifier("task-share")
                        Button(strings.text("common.delete"), role: .destructive) {
                            endEditingBeforeAction()
                            Task { await model.deleteTask() }
                        }.accessibilityIdentifier("task-delete")
                    } label: {
                        Image(systemName: "ellipsis").frame(width: 44, height: 44).contentShape(Rectangle())
                    }
                    .disabled(frozen || modalPresented || model.taskScheduleUpdating || model.taskPersonCreateNeedsReview)
                    .accessibilityLabel(strings.text("common.more")).accessibilityIdentifier("task-more")
                    Button {
                        endEditingBeforeAction()
                        Task { await model.saveTask() }
                    } label: {
                        Text(strings.text("common.save")).rnFont(18, .bold).frame(minWidth: 44, minHeight: 44)
                    }
                    .buttonStyle(.plain).disabled(frozen || model.taskPersonCreateNeedsReview || model.taskLinkSheetActive).accessibilityIdentifier("task-editor-save")
                }
            }
            .foregroundStyle(palette.tint).padding(.horizontal, 16).padding(.vertical, 8)
            Divider().overlay(palette.border)
            if !readOnly && !model.taskEditor.isEmpty {
                Group {
                    if dynamicTypeSize.isAccessibilitySize {
                        VStack(spacing: 0) {
                            modeButton(edit: true, title: strings.text("markdown.edit"), symbol: "pencil")
                            modeButton(edit: false, title: strings.text("markdown.preview"), symbol: "eye")
                        }
                    } else {
                        HStack(spacing: 0) {
                            modeButton(edit: true, title: strings.text("markdown.edit"), symbol: "pencil")
                            modeButton(edit: false, title: strings.text("markdown.preview"), symbol: "eye")
                        }
                    }
                }
                .background(palette.filter, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(palette.border, lineWidth: 1))
                .padding(.horizontal, 16).padding(.vertical, 10)
                Divider().overlay(palette.border)
            }
            if model.taskRecoveryProtected {
                Text("Draft saved on this device")
                    .rnFont(13).foregroundStyle(palette.secondary)
                    .frame(maxWidth: .infinity, minHeight: 24)
                    .accessibilityIdentifier("task-recovery-protected")
            }

            ScrollViewReader { reader in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 16) {
                        TaskAttachmentRecoveryStatus(model: model, palette: palette)
                            .id("task-attachment-recovery-status")
                        if model.taskOwnedMenuAction != nil {
                            VStack(alignment: .leading, spacing: 8) {
                                Text(ownedMenuTitle + " is waiting for your decision or recovery.")
                                    .rnFont(14).foregroundStyle(palette.secondary)
                                Button("Review action") { ownedMenuPromptVisible = true }
                                    .frame(minWidth: 44, minHeight: 44)
                                    .disabled(busy || model.taskAttachmentWorking)
                            }
                        }
                        if !value.text("readOnlyHint").isEmpty {
                            Text(value.text("readOnlyHint")).rnFont(13).foregroundStyle(palette.secondary)
                                .accessibilityIdentifier("task-view-readonly-hint")
                        }
                        if editing && !readOnly {
                            editorFields
                        } else {
                            ForEach(rows.indices, id: \.self) { index in row(rows[index]) }
                        }
                        if busy {
                            ProgressView(strings.text("common.loading")).tint(palette.tint)
                                .frame(maxWidth: .infinity, minHeight: 44)
                                .accessibilityIdentifier("task-view-loading")
                        }
                        if let error {
                            VStack(alignment: .leading, spacing: 8) {
                                Text(error).rnFont(14).foregroundStyle(palette.danger)
                                    .textSelection(.enabled)
                                    .accessibilityIdentifier("task-view-error")
                                retryButton
                                DiagnosticsFailureAction(model: model, palette: palette)
                            }
                            .id("task-view-error")
                        }
                        if let protectionError = model.taskRecoveryCheckpointError {
                            VStack(alignment: .leading, spacing: 8) {
                                Text("This draft has not been saved for recovery: " + protectionError)
                                    .rnFont(14).foregroundStyle(palette.danger)
                                    .accessibilityIdentifier("task-recovery-checkpoint-error")
                                Button(strings.text("common.retry")) {
                                    Task { await model.retryTaskDraftCheckpoint() }
                                }
                                .frame(minWidth: 44, minHeight: 44)
                                .accessibilityIdentifier("task-recovery-checkpoint-retry")
                            }
                            .id("task-recovery-checkpoint-error")
                        } else if rows.isEmpty && !busy {
                            Text(strings.text("common.notSet")).rnFont(14).foregroundStyle(palette.secondary)
                            retryButton
                        }
                    }
                    .padding(20)
                }
                .id(editing)
                .onChange(of: focusedChecklistIndex) { _ in scrollChecklistFocus(reader) }
                .onChange(of: error) { message in
                    guard message != nil else { return }
                    DispatchQueue.main.async { reader.scrollTo("task-view-error", anchor: .top) }
                }
                .onChange(of: model.taskAttachmentError) { message in
                    guard message != nil else { return }
                    DispatchQueue.main.async { reader.scrollTo("task-attachment-recovery-status", anchor: .top) }
                }
                .onChange(of: model.taskRecoveryCheckpointError) { message in
                    guard message != nil else { return }
                    DispatchQueue.main.async { reader.scrollTo("task-recovery-checkpoint-error", anchor: .top) }
                }
                .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardDidShowNotification)) { _ in
                    scrollChecklistFocus(reader)
                }
                .accessibilityIdentifier("task-editor-scroll")
            }
        }
        .foregroundStyle(palette.text).background(palette.card)
        .tint(palette.tint)
        .interactiveDismissDisabled(frozen || model.taskDirty || ownedCloseDecision || modalPresented)
        .alert(ownedCloseDecision ? "Finish this draft?" : strings.text("taskEdit.discardChanges"), isPresented: $discardConfirm) {
            if model.taskAttachmentState == .active {
                Button(strings.text("common.save")) {
                    endEditingBeforeAction()
                    Task { await model.saveTask() }
                }
                .disabled(operationFrozen || readOnly || model.taskPersonCreateNeedsReview)
                .accessibilityIdentifier("task-editor-save-close")
            }
            Button(strings.text("common.discard"), role: .destructive) {
                endEditingBeforeAction()
                if ownedCloseDecision { Task { await model.discardTaskRecoveryDraft(close: true) } }
                else { model.discardTask() }
            }
                .accessibilityIdentifier("task-editor-discard")
            if model.taskRecoveryAvailable {
                Button("Keep for later") {
                    Task { await model.keepTaskRecoveryForLater() }
                }
                .accessibilityIdentifier("task-editor-keep-for-later")
            }
            Button(strings.text("common.cancel"), role: .cancel) {}
                .accessibilityIdentifier("task-editor-keep-editing")
        } message: {
            Text(model.taskAttachmentState == .active
                ? "Save this draft, discard it, or keep it on this device for later."
                : ownedCloseDecision
                    ? "Discard this draft or keep it on this device for later. Recovery must finish before editing can continue."
                    : strings.text("taskEdit.discardChangesDesc"))
        }
        .onAppear {
            editing = model.taskInitialTab == "task"
            ownedMenuPromptVisible = model.taskOwnedMenuAction != nil
            initializeSections()
        }
        .onChange(of: model.taskInitialTab) { tab in editing = tab == "task" }
        .onChange(of: model.taskEditor.text("id")) { _ in
            cancelFileImporter()
            waitingAssignment = nil; backdatedCompletion = nil; initializeSections()
        }
        .onChange(of: model.taskEditorSession) { _ in
            cancelFileImporter()
            waitingAssignment = nil; backdatedCompletion = nil
        }
        .onChange(of: model.taskOwnedMenuAction) { action in ownedMenuPromptVisible = action != nil }
        .onDisappear { cancelFileImporter(); backdatedCompletion = nil }
        .onChange(of: model.taskChecklistFocusIndex) { index in focusedChecklistIndex = index }
    }

    private var ownedMenuTitle: String {
        switch model.taskOwnedMenuAction {
        case .delete: return strings.text("common.delete")
        case .duplicate: return strings.text("taskEdit.duplicateTask")
        case .promote: return strings.text("task.createProjectFromTask")
        case nil: return strings.text("common.more")
        }
    }

    private func cancelFileImporter() {
        model.cancelTaskFileImport()
        fileImporterID = nil
    }

    private func scrollChecklistFocus(_ reader: ScrollViewProxy) {
        guard let index = focusedChecklistIndex else { return }
        // iOS 17 applies the keyboard inset after its notification. Scrolling
        // in that callback clamps to the old viewport and can hide the new row.
        DispatchQueue.main.async {
            guard focusedChecklistIndex == index, model.taskChecklistFocusIndex == index,
                  editing, !readOnly, !checklistReordering,
                  model.taskChecklistField.objects("items").contains(where: { $0.number("index") == index }) else { return }
            reader.scrollTo("task-checklist-row-\(index)", anchor: .center)
        }
    }

    private func modeButton(edit: Bool, title: String, symbol: String) -> some View {
        Button {
            endEditingBeforeAction()
            editing = edit
            model.setTaskInitialTab(edit ? "task" : "view")
            if !edit { datePickerID = "" }
            if !edit { Task { await model.readTaskView() } }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: symbol).accessibilityHidden(true)
                Text(title).rnFont(14, .semibold).fixedSize(horizontal: false, vertical: true)
            }
            .padding(.vertical, dynamicTypeSize.isAccessibilitySize ? 8 : 0)
            .frame(maxWidth: .infinity, minHeight: 44)
            .foregroundStyle(editing == edit ? palette.onTint : palette.text)
            .background(editing == edit ? palette.tint : .clear, in: RoundedRectangle(cornerRadius: 12))
        }
        .buttonStyle(.plain).disabled(frozen)
        .accessibilityAddTraits(editing == edit ? .isSelected : [])
        .accessibilityIdentifier(edit ? "task-mode-edit" : "task-mode-view")
    }

    private var editorFields: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 8) {
                label(strings.text("taskEdit.titleLabel"))
                TextField(strings.text("taskEdit.titleLabel"), text: Binding(
                    get: { model.taskTitleDraft }, set: { model.setTaskTitleDraft($0) }), axis: .vertical)
                    .rnFont(16).lineLimit(2...6).padding(12)
                    .modifier(TaskDraftDirection(direction: model.taskEditorDraftDirection == "rtl"
                        ? .rightToLeft : .leftToRight))
                    .background(palette.input, in: RoundedRectangle(cornerRadius: 10))
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.border, lineWidth: 1))
                    .accessibilityIdentifier("task-editor-title")
                    .disabled(model.taskScheduleUpdating)
            }
            if model.taskEditor.object("draft").text("status") == "reference" {
                Button {
                    guard model.taskStatusEditable("next") else { return }
                    endEditingBeforeAction()
                    Task { _ = await model.editTaskStatus("next") }
                } label: {
                    Text(strings.text("reference.convertToAction")).rnFont(14, .semibold)
                        .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain).foregroundStyle(palette.tint)
                .disabled(!model.taskStatusEditable("next"))
                .accessibilityIdentifier("task-reference-convert-to-action")
            }
            let sections = model.taskEditor.object("layout").objects("sections")
            ForEach(sections.indices, id: \.self) { index in editorSection(sections[index]) }
        }
        .disabled(frozen)
        .task(id: [model.taskEditor.text("id"), String(model.taskEditorSession),
                   model.taskTitleDraft, model.taskNoteDraft, model.currentLanguage]) {
            await model.refreshTaskEditorDraftDirection()
        }
    }

    private func initializeSections() {
        let id = model.taskEditor.text("id")
        guard !id.isEmpty, sectionTaskID != id else { return }
        sectionTaskID = id
        datePickerID = ""
        sectionExpanded = [:]
        for section in model.taskEditor.object("layout").objects("sections") {
            sectionExpanded[section.text("id")] = section.flag("open")
        }
    }

    @ViewBuilder private func editorSection(_ section: CoreObject) -> some View {
        let fields = (section["fields"] as? [String] ?? []).filter { field in
            ["description", "location", "assignedTo", "priority", "energyLevel", "timeEstimate", "contexts", "tags", "startTime", "dueDate", "reviewAt", "recurrence", "checklist", "attachments"].contains(field)
                || (section.text("id") == "basic" && field == "status" && model.taskEditor.object("layout").flag("showStatusField"))
                || (section.text("id") == "basic" && field == model.taskDestination.object("destination").text("fieldId"))
                || (section.text("id") == "basic" && field == "section" && model.taskDestination.object("section").flag("visible"))
        }
        if !fields.isEmpty {
            let id = section.text("id")
            let open = sectionExpanded[id] ?? section.flag("open")
            VStack(alignment: .leading, spacing: 16) {
                if !section.text("titleKey").isEmpty {
                    Button {
                        endEditingBeforeAction()
                        sectionExpanded[id] = !open
                    } label: {
                        HStack(spacing: 8) {
                            AppIcon(name: "chevron", size: 16).rotationEffect(.degrees(open ? 0 : -90))
                                .foregroundStyle(palette.secondary)
                            Text(strings.text(section.text("titleKey")).uppercased()).rnFont(12, .bold).tracking(0.6)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            if section.number("filledCount") > 0 {
                                Text(String(section.number("filledCount"))).rnFont(12, .semibold).foregroundStyle(palette.onTint)
                                    .padding(.horizontal, 8).padding(.vertical, 2).background(palette.tint, in: Capsule())
                            }
                        }
                        .frame(minHeight: 44).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).disabled(frozen)
                    .accessibilityLabel(strings.text(section.text("titleKey")))
                    .accessibilityValue(strings.text(open ? "markdown.collapse" : "markdown.expand"))
                    .accessibilityIdentifier("task-editor-section-" + id)
                    .padding(.top, 8).overlay(alignment: .top) { palette.border.frame(height: 1) }
                }
                if section.text("titleKey").isEmpty || open {
                    ForEach(fields, id: \.self) { field in editorField(field) }
                }
            }
        }
    }

    @ViewBuilder private func editorField(_ field: String) -> some View {
        if field == "status" {
            VStack(alignment: .leading, spacing: 8) {
                label(strings.text("taskEdit.statusLabel"))
                AppChipFlow {
                    ForEach(model.taskEditor.object("options")["statuses"] as? [String] ?? [], id: \.self) { status in
                        let selected = model.taskEditor.object("draft").text("status") == status
                        Button {
                            guard model.taskStatusEditable(status) else { return }
                            if status == "waiting" && !selected {
                                let current = model.taskTokenInputs["assignedTo"] ?? model.taskEditor.object("draft").text("assignedTo")
                                model.preserveTaskTokenInputForTransientModal()
                                _ = UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
                                waitingAssignment = current
                            } else {
                                endEditingBeforeAction()
                                Task { _ = await model.editTaskStatus(status) }
                            }
                        } label: {
                            Text(strings.text("status." + status)).rnFont(14)
                                .foregroundStyle(selected ? palette.onTint : palette.secondary)
                                .padding(.horizontal, 12).padding(.vertical, 10).frame(minWidth: 44, minHeight: 44)
                                .background(selected ? palette.tint : palette.filter, in: RoundedRectangle(cornerRadius: 16))
                                .overlay(RoundedRectangle(cornerRadius: 16).stroke(selected ? palette.tint : palette.border, lineWidth: 1))
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).disabled(frozen)
                        .accessibilityLabel(strings.text("taskEdit.statusLabel") + ": " + strings.text("status." + status))
                        .accessibilityAddTraits(selected ? .isSelected : [])
                        .accessibilityIdentifier("task-editor-status-" + status)
                    }
                }
                if (model.taskEditor.object("options")["statuses"] as? [String] ?? []).contains("done") {
                    Button {
                        openTaskBackdatedCompletion()
                    } label: {
                        Text(strings.text("task.completedAtPromptTitle")).rnFont(14, .semibold)
                            .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).foregroundStyle(palette.tint)
                    .disabled(!model.taskStatusEditable("done"))
                    .accessibilityIdentifier("task-editor-backdate")
                }
            }
        } else if field == "description" {
            VStack(alignment: .leading, spacing: 8) {
                label(strings.text("taskEdit.descriptionLabel"))
                TextEditor(text: Binding(get: { model.taskNoteDraft }, set: { model.setTaskNoteDraft($0) }))
                    .rnFont(16).scrollContentBackground(.hidden).frame(minHeight: 220)
                    .modifier(TaskDraftDirection(direction: model.taskEditorDraftDirection == "rtl"
                        ? .rightToLeft : .leftToRight))
                    .padding(8).background(palette.input, in: RoundedRectangle(cornerRadius: 10))
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.border, lineWidth: 1))
                    .accessibilityLabel(strings.text("taskEdit.descriptionLabel"))
                    .accessibilityIdentifier("task-editor-note")
                    .disabled(model.taskScheduleUpdating)
            }
        } else if field == "location" {
            VStack(alignment: .leading, spacing: 8) {
                label(strings.text("taskEdit.locationLabel"))
                TextField(strings.text("taskEdit.locationPlaceholder"), text: Binding(
                    get: { model.taskLocationDraft }, set: { model.setTaskLocationDraft($0) }))
                    .rnFont(16).padding(12).frame(minHeight: 44)
                    .submitLabel(.done).onSubmit(endEditingBeforeAction)
                    .background(palette.input, in: RoundedRectangle(cornerRadius: 10))
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.border, lineWidth: 1))
                    .accessibilityLabel(strings.text("taskEdit.locationLabel"))
                    .accessibilityHint(strings.text("taskEdit.locationPlaceholder"))
                    .accessibilityIdentifier("task-editor-location")
                    .disabled(model.taskScheduleUpdating)
            }
        } else if ["startTime", "dueDate", "reviewAt"].contains(field) {
            TaskScheduleField(model: model, palette: palette, field: field,
                pickerID: $datePickerID, pickerValue: $datePickerValue, beforeAction: endEditingBeforeAction)
        } else if field == "recurrence" {
            TaskRecurrenceField(model: model, palette: palette, pickerID: $datePickerID,
                pickerValue: $datePickerValue, beforeAction: endEditingBeforeAction,
                openCustom: { monthlyCustom = $0 })
        } else if field == "checklist" {
            checklistEditor
        } else if field == "attachments" {
            attachmentEditor
        } else if field == "contexts" || field == "tags" || field == "assignedTo" {
            TaskTokenField(model: model, palette: palette, field: field, beforeAction: endEditingBeforeAction)
                .disabled(model.taskScheduleUpdating)
        } else if field == "project" || field == "area" {
            destinationControl
        } else if field == "section" {
            projectSectionControl
        } else {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 6) {
                    metadataGlyph(field == "priority" ? "flag" : field == "energyLevel" ? "charging" : "hourglass", size: 16)
                    Text(fieldLabel(field).uppercased()).rnFont(14)
                }
                .foregroundStyle(palette.secondary).accessibilityAddTraits(.isHeader)
                metadataOptions(field)
                if field == "timeEstimate" && estimate.flag("customSelected") {
                    TextField("2h30", text: Binding(
                        get: { model.taskEstimateInput }, set: { model.setTaskEstimateInput($0) }))
                        .rnFont(16).textInputAutocapitalization(.never).autocorrectionDisabled().submitLabel(.done)
                        .padding(12).frame(minHeight: 44).background(palette.input, in: RoundedRectangle(cornerRadius: 10))
                        .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.border, lineWidth: 1))
                        .onSubmit {
                            endEditingBeforeAction()
                            Task { await model.commitTaskEstimateInput() }
                        }
                        .accessibilityLabel(fieldLabel(field) + ": " + estimate.text("customLabel"))
                        .accessibilityIdentifier("task-editor-timeEstimate-input")
                        .disabled(model.taskScheduleUpdating)
                }
                if field == "timeEstimate" && model.taskEditor.object("fields").object("timeSpent").flag("enabled") {
                    HStack(spacing: 6) {
                        metadataGlyph("hourglass", size: 16)
                        Text(strings.text("taskEdit.timeSpentLabel").uppercased()).rnFont(14)
                    }
                    .foregroundStyle(palette.secondary).accessibilityAddTraits(.isHeader)
                    TextField(strings.text("taskEdit.timeSpentPlaceholder"), text: Binding(
                        get: { model.taskTimeSpentInput }, set: { model.setTaskTimeSpentInput($0) }))
                        .rnFont(16).keyboardType(.numberPad).submitLabel(.done)
                        .padding(12).frame(minHeight: 44)
                        .background(palette.input, in: RoundedRectangle(cornerRadius: 10))
                        .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.border, lineWidth: 1))
                        .onSubmit {
                            endEditingBeforeAction()
                            Task { await model.commitTaskTimeSpentInput() }
                        }
                        .accessibilityLabel(strings.text("taskEdit.timeSpentLabel"))
                        .accessibilityIdentifier("task-editor-timeSpent-input")
                        .disabled(model.taskScheduleUpdating)
                }
            }
        }
    }

    private func openTaskBackdatedCompletion() {
        guard model.taskStatusEditable("done") else { return }
        let start = model.taskEditor.object("backdatedCompletionStart")
        let initialValue = start["initialValue"] as? String
        let date = initialValue.flatMap(TaskDatePickerComponents.instant) ?? Date()
        let draft = TaskBackdatedCompletionDraft(
            taskID: model.taskEditor.text("id"), session: model.taskEditorSession,
            date: date, instant: initialValue ?? TaskDatePickerComponents.instantString(date),
            minutesText: model.taskBackdatedCompletionMinutesSeed,
            showMinutes: model.taskEditor.object("fields").object("timeSpent").flag("enabled"))
        model.preserveTaskTokenInputForTransientModal()
        _ = UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        backdatedCompletion = draft
    }

    private var checklistEditor: some View {
        let field = model.taskChecklistField
        let labels = field.object("labels")
        let items = field.objects("items")
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                label(field.text("label"))
                Spacer(minLength: 4)
                if field.flag("canReorder") {
                    Button {
                        endEditingBeforeAction()
                        checklistReordering.toggle()
                    } label: {
                        Text(labels.text(checklistReordering ? "done" : "reorder"))
                            .rnFont(14, .semibold).frame(minWidth: 44, minHeight: 44)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).foregroundStyle(palette.tint).disabled(frozen)
                    .accessibilityIdentifier("task-checklist-reorder")
                }
            }
            ForEach(items.indices, id: \.self) { offset in
                let item = items[offset]
                if checklistReordering {
                    checklistOrderRow(item)
                } else {
                    checklistEditRow(item, placeholder: labels.text("placeholder"), bullets: field.flag("bullets"))
                }
            }
            if !checklistReordering, field.flag("canAdd") {
                Button {
                    endEditingBeforeAction()
                    Task { await model.editTaskChecklist(["kind": "add"]) }
                } label: {
                    Text(labels.text("add")).rnFont(14, .semibold)
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain).foregroundStyle(palette.tint).disabled(frozen)
                .accessibilityIdentifier("task-checklist-add")
            }
            if field.flag("canReset") {
                Button {
                    endEditingBeforeAction()
                    Task { await model.resetTaskChecklist() }
                } label: {
                    Text(labels.text("reset")).rnFont(14)
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain).foregroundStyle(palette.tint).disabled(frozen)
                .accessibilityIdentifier("task-checklist-reset")
            }
        }
        .onChange(of: model.taskEditor.text("id")) { _ in checklistReordering = false }
    }

    private func checklistEditRow(_ item: CoreObject, placeholder: String, bullets: Bool) -> some View {
        let index = item.number("index")
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 8))
            : AnyLayout(HStackLayout(alignment: .center, spacing: 8))
        return layout {
            if bullets {
                Text("•").rnFont(18).foregroundStyle(palette.secondary)
                    .frame(width: 44, height: 44).accessibilityHidden(true)
            } else {
                Button {
                    endEditingBeforeAction()
                    Task { await model.editTaskChecklist(["kind": "toggle", "index": index]) }
                } label: {
                    NativeMarkdownChecklistMarker(bullet: false, completed: item.flag("completed"), palette: palette)
                        .frame(width: 44, height: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(frozen)
                .accessibilityLabel(item.text("checkboxLabel"))
                .accessibilityValue(strings.text(item.flag("completed") ? "common.done" : "status.active"))
                .accessibilityIdentifier("task-checklist-toggle-\(index)")
            }
            TextField(placeholder, text: Binding(
                get: { model.taskChecklistInputs[index] ?? item.text("title") },
                set: { model.setTaskChecklistInput(index, text: $0) }))
                .rnFont(16).padding(.horizontal, 10).frame(minHeight: 44)
                .background(palette.input, in: RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.border, lineWidth: 1))
                .focused($focusedChecklistIndex, equals: index)
                .submitLabel(.next)
                .onSubmit { Task { await model.editTaskChecklist(["kind": "insertAfter", "index": index]) } }
                .accessibilityLabel(item.text("inputLabel"))
                .accessibilityIdentifier("task-checklist-input-\(index)")
                .disabled(frozen)
            Button {
                endEditingBeforeAction()
                Task { await model.editTaskChecklist(["kind": "remove", "index": index]) }
            } label: {
                AppIcon(name: "x", size: 16).frame(width: 44, height: 44).contentShape(Rectangle())
            }
            .buttonStyle(.plain).foregroundStyle(palette.secondary).disabled(frozen)
            .accessibilityLabel(strings.text("common.remove"))
            .accessibilityIdentifier("task-checklist-remove-\(index)")
        }
        .id("task-checklist-row-\(index)")
    }

    private func checklistOrderRow(_ item: CoreObject) -> some View {
        let index = item.number("index")
        return HStack(spacing: 8) {
            Text(item.text("orderTitle")).rnFont(14)
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            Button {
                Task { await model.editTaskChecklist(["kind": "move", "from": index, "to": index - 1]) }
            } label: {
                Image(systemName: "arrow.up").frame(width: 44, height: 44).contentShape(Rectangle())
            }
            .buttonStyle(.plain).disabled(frozen || !item.flag("canMoveUp"))
            .accessibilityLabel(item.text("moveUpLabel"))
            .accessibilityIdentifier("task-checklist-up-\(index)")
            Button {
                Task { await model.editTaskChecklist(["kind": "move", "from": index, "to": index + 1]) }
            } label: {
                Image(systemName: "arrow.down").frame(width: 44, height: 44).contentShape(Rectangle())
            }
            .buttonStyle(.plain).disabled(frozen || !item.flag("canMoveDown"))
            .accessibilityLabel(item.text("moveDownLabel"))
            .accessibilityIdentifier("task-checklist-down-\(index)")
        }
        .foregroundStyle(palette.tint)
    }

    private var destinationControl: some View {
        let destination = model.taskDestination.object("destination")
        return Button {
            endEditingBeforeAction()
            Task { await model.openTaskDestination("destination") }
        } label: {
            Group {
                if dynamicTypeSize.isAccessibilitySize {
                    VStack(alignment: .leading, spacing: 8) {
                        destinationLabel(destination.text("label"))
                        Text(destination.text("value")).rnFont(14, .bold).foregroundStyle(palette.tint)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                } else {
                    HStack(spacing: 12) {
                        destinationLabel(destination.text("label"))
                        Text(destination.text("value")).rnFont(14, .bold).foregroundStyle(palette.tint)
                            .multilineTextAlignment(.trailing).frame(maxWidth: .infinity, alignment: .trailing)
                    }
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 10).frame(minHeight: 44)
            .background(palette.filter, in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.border, lineWidth: 1)).contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(frozen || model.taskDestination.flag("readOnly"))
        .accessibilityLabel(destination.text("label")).accessibilityValue(destination.text("value"))
        .accessibilityIdentifier("task-editor-destination")
    }

    private func destinationLabel(_ text: String) -> some View {
        HStack(spacing: 6) {
            AppIcon(name: "folder", size: 14)
            Text(text.uppercased()).rnFont(13, .bold)
        }
        .foregroundStyle(palette.secondary)
    }

    private var projectSectionControl: some View {
        let section = model.taskDestination.object("section")
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "square.3.layers.3d").font(.system(size: 16)).accessibilityHidden(true)
                Text(section.text("label").uppercased()).rnFont(14)
            }
            .foregroundStyle(palette.secondary).accessibilityAddTraits(.isHeader)
            HStack(spacing: 8) {
                Button {
                    endEditingBeforeAction()
                    Task { await model.openTaskDestination("section") }
                } label: {
                    Text(section.text("value")).rnFont(14).frame(maxWidth: .infinity, alignment: .leading)
                        .padding(12).frame(minHeight: 44).background(palette.input, in: RoundedRectangle(cornerRadius: 10))
                        .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.border, lineWidth: 1)).contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(frozen || model.taskDestination.flag("readOnly"))
                .accessibilityLabel(section.text("label")).accessibilityValue(section.text("value"))
                .accessibilityIdentifier("task-editor-project-section")
                if !model.taskEditor.object("draft").text("sectionId").isEmpty {
                    Button {
                        endEditingBeforeAction()
                        Task { await model.clearTaskSection() }
                    } label: {
                        AppIcon(name: "x", size: 14).foregroundStyle(palette.secondary).frame(width: 44, height: 44)
                            .background(palette.filter, in: RoundedRectangle(cornerRadius: 10))
                            .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.border, lineWidth: 1)).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).disabled(frozen || model.taskDestination.flag("readOnly"))
                    .accessibilityLabel(strings.text("common.clear")).accessibilityIdentifier("task-editor-project-section-clear")
                }
            }
        }
    }

    private var estimate: CoreObject { model.taskEditor.object("fields").object("timeEstimate") }

    private func fieldLabel(_ field: String) -> String {
        strings.text(field == "priority" ? "taskEdit.priorityLabel" : field == "energyLevel" ? "taskEdit.energyLevel" : "taskEdit.timeEstimateLabel")
    }

    @ViewBuilder private func metadataOptions(_ field: String) -> some View {
        let options = model.taskEditor.object("options")
        AppChipFlow {
            if field == "timeEstimate" {
                let entries = options.objects("timeEstimates")
                ForEach(entries.indices, id: \.self) { index in
                    let option = entries[index]
                    metadataChip(field, value: option.text("value"), title: option.text("label"))
                }
                metadataChip(field, value: estimate.text("customValue"), title: estimate.text("customLabel"), custom: true)
            } else {
                metadataChip(field, value: "", title: strings.text("common.none"))
                let entries = options[field == "priority" ? "priorities" : "energyLevels"] as? [String] ?? []
                ForEach(entries, id: \.self) { value in
                    metadataChip(field, value: value, title: strings.text((field == "priority" ? "priority." : "energyLevel.") + value))
                }
            }
        }
    }

    private func metadataChip(_ field: String, value: String, title: String, custom: Bool = false) -> some View {
        let selected = custom ? estimate.flag("customSelected") : model.taskEditor.object("draft").text(field) == value
        let foreground = selected ? palette.onTint : palette.secondary
        return Button {
            endEditingBeforeAction()
            Task { await model.editTaskMetadata(field, value: value) }
        } label: {
            HStack(spacing: 6) {
                if value.isEmpty {
                    metadataGlyph("none", size: 16)
                } else {
                    if field == "priority" {
                        metadataGlyph("flag", size: 12)
                            .foregroundStyle(Color(hex: model.theme.object("priority").text(value)))
                    } else if field == "energyLevel" {
                        metadataGlyph(value, size: 14)
                    }
                    Text(title).rnFont(14).multilineTextAlignment(.center)
                }
            }
            .foregroundStyle(foreground).padding(.horizontal, 12).padding(.vertical, 10).frame(minWidth: 44, minHeight: 44)
            .background(selected ? palette.tint : palette.filter, in: RoundedRectangle(cornerRadius: 16))
            .overlay(RoundedRectangle(cornerRadius: 16).stroke(selected ? palette.tint : palette.border, lineWidth: 1))
            .contentShape(RoundedRectangle(cornerRadius: 16))
        }
        .buttonStyle(.plain).disabled(frozen)
        .accessibilityLabel(title).accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier("task-editor-" + field + "-" + (custom ? "custom" : value.isEmpty ? "none" : value))
    }

    private func metadataGlyph(_ kind: String, size: CGFloat) -> some View {
        // Lucide field glyphs from the RN dependency; App/Lucide-LICENSE.
        Path { path in
            switch kind {
            case "none":
                path.addEllipse(in: CGRect(x: 2, y: 2, width: 20, height: 20))
                path.move(to: CGPoint(x: 9, y: 15)); path.addLine(to: CGPoint(x: 15, y: 9))
            case "flag":
                path.move(to: CGPoint(x: 4, y: 22)); path.addLine(to: CGPoint(x: 4, y: 4))
                path.addQuadCurve(to: CGPoint(x: 4.4, y: 3.2), control: CGPoint(x: 4, y: 3.5))
                path.addQuadCurve(to: CGPoint(x: 8, y: 2), control: CGPoint(x: 6, y: 2))
                path.addCurve(to: CGPoint(x: 15.333, y: 4), control1: CGPoint(x: 11, y: 2), control2: CGPoint(x: 13, y: 4))
                path.addQuadCurve(to: CGPoint(x: 18.4, y: 3.2), control: CGPoint(x: 17.333, y: 4))
                path.addQuadCurve(to: CGPoint(x: 20, y: 4), control: CGPoint(x: 20, y: 2.4))
                path.addLine(to: CGPoint(x: 20, y: 14))
                path.addQuadCurve(to: CGPoint(x: 19.6, y: 14.8), control: CGPoint(x: 20, y: 14.5))
                path.addQuadCurve(to: CGPoint(x: 16, y: 16), control: CGPoint(x: 18, y: 16))
                path.addCurve(to: CGPoint(x: 8, y: 14), control1: CGPoint(x: 13, y: 16), control2: CGPoint(x: 11, y: 14))
                path.addQuadCurve(to: CGPoint(x: 4, y: 15.528), control: CGPoint(x: 5.5, y: 14))
            case "hourglass":
                for y in [2.0, 22.0] {
                    path.move(to: CGPoint(x: 5, y: y)); path.addLine(to: CGPoint(x: 19, y: y))
                }
                path.move(to: CGPoint(x: 7, y: 2)); path.addLine(to: CGPoint(x: 7, y: 6.172))
                path.addQuadCurve(to: CGPoint(x: 7.586, y: 7.586), control: CGPoint(x: 7, y: 7))
                path.addLine(to: CGPoint(x: 16.414, y: 16.414))
                path.addQuadCurve(to: CGPoint(x: 17, y: 17.828), control: CGPoint(x: 17, y: 17))
                path.addLine(to: CGPoint(x: 17, y: 22))
                path.move(to: CGPoint(x: 17, y: 2)); path.addLine(to: CGPoint(x: 17, y: 6.172))
                path.addQuadCurve(to: CGPoint(x: 16.414, y: 7.586), control: CGPoint(x: 17, y: 7))
                path.addLine(to: CGPoint(x: 7.586, y: 16.414))
                path.addQuadCurve(to: CGPoint(x: 7, y: 17.828), control: CGPoint(x: 7, y: 17))
                path.addLine(to: CGPoint(x: 7, y: 22))
            default:
                path.move(to: CGPoint(x: 22, y: 14)); path.addLine(to: CGPoint(x: 22, y: 10))
                if kind == "charging" {
                    path.move(to: CGPoint(x: 11, y: 7)); path.addLine(to: CGPoint(x: 8, y: 12))
                    path.addLine(to: CGPoint(x: 12, y: 12)); path.addLine(to: CGPoint(x: 9, y: 17))
                    path.move(to: CGPoint(x: 14.856, y: 6)); path.addLine(to: CGPoint(x: 16, y: 6))
                    path.addQuadCurve(to: CGPoint(x: 18, y: 8), control: CGPoint(x: 18, y: 6))
                    path.addLine(to: CGPoint(x: 18, y: 16))
                    path.addQuadCurve(to: CGPoint(x: 16, y: 18), control: CGPoint(x: 18, y: 18))
                    path.addLine(to: CGPoint(x: 13.065, y: 18))
                    path.move(to: CGPoint(x: 5.14, y: 18)); path.addLine(to: CGPoint(x: 4, y: 18))
                    path.addQuadCurve(to: CGPoint(x: 2, y: 16), control: CGPoint(x: 2, y: 18))
                    path.addLine(to: CGPoint(x: 2, y: 8))
                    path.addQuadCurve(to: CGPoint(x: 4, y: 6), control: CGPoint(x: 2, y: 6))
                    path.addLine(to: CGPoint(x: 6.936, y: 6))
                } else {
                    path.addRoundedRect(in: CGRect(x: 2, y: 6, width: 16, height: 12), cornerSize: CGSize(width: 2, height: 2))
                    let bars = kind == "low" ? [6.0] : kind == "high" ? [6.0, 10.0, 14.0] : [6.0, 10.0]
                    for x in bars { path.move(to: CGPoint(x: x, y: 10)); path.addLine(to: CGPoint(x: x, y: 14)) }
                }
            }
        }
        .stroke(style: StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
        .frame(width: 24, height: 24).scaleEffect(size / 24).frame(width: size, height: size).accessibilityHidden(true)
    }

    private var retryButton: some View {
        Button {
            endEditingBeforeAction()
            Task {
                if model.retryNeeded { await model.retry() }
                else if model.taskChecklistReadPending { await model.retryTaskChecklistRead() }
                else if model.taskSchedulePending { await model.retryTaskSchedule() }
                else { await model.readTaskView() }
            }
        } label: {
            Text(strings.text("common.retry")).rnFont(14, .semibold)
                .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
        }
        .buttonStyle(.plain).foregroundStyle(palette.tint).disabled(busy)
        .accessibilityIdentifier("task-view-retry")
    }

    private func endEditingBeforeAction() {
        // Resign synchronously in the input action, before SwiftUI removes or
        // disables a focused UITextView. Letting `.disabled(frozen)` resign it
        // during layout can re-enter UIKit keyboard updates on iOS 27.
        // The checklist binding receives its final synchronous editing callback
        // here, before the action's Task sets busy and freezes checklist input.
        _ = UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        model.commitTaskRelativeInput()
        model.commitTaskRecurrenceInputs()
        NSLog("Native iOS editor requested input dismissal releaseCheck=v1.3.3/native-ios-editor-input-end")
    }

    @ViewBuilder private func row(_ item: CoreObject) -> some View {
        let sourceID = value.text("id"), revision = value.text("revision")
        switch item.text("type") {
        case "title", "status", "field":
            let content = VStack(alignment: .leading, spacing: 6) {
                label(item.text("label"))
                if item.text("type") == "title" {
                    Text(item.text("value")).rnFont(17, .bold)
                        .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("task-view-task-title")
                } else {
                    Text(item.text("value")).rnFont(14, .semibold)
                        .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading).padding(12)
            .background(palette.input, in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.border, lineWidth: 1))
            .accessibilityElement(children: .combine)
            if item.text("field") == "project" && !item.object("project").text("id").isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    if model.taskReferenceSection == "project" { referenceError }
                    Button {
                        Task { await model.openTaskViewReference(sourceID: sourceID, revision: revision, position: ["field": "project"]) }
                    } label: { content.frame(minHeight: 44).contentShape(Rectangle()) }
                    .buttonStyle(.plain).disabled(!model.taskReferenceEnabled || modalPresented || discardConfirm)
                    .accessibilityLabel(item.text("label") + ": " + item.text("value"))
                    .accessibilityIdentifier("task-view-project-open")
                }
            } else { content }
        case "tokens":
            VStack(alignment: .leading, spacing: 8) {
                label(item.text("label"))
                if model.taskReferenceSection == item.text("field") { referenceError }
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 8) { pills(item.objects("items"), field: item.text("field"), fieldLabel: item.text("label")) }
                    VStack(alignment: .leading, spacing: 8) { pills(item.objects("items"), field: item.text("field"), fieldLabel: item.text("label")) }
                }
            }
        case "description":
            VStack(alignment: .leading, spacing: 8) {
                label(item.text("label"))
                if model.taskReferenceSection == "description" { referenceError }
                let sourceID = value.text("id"), sourceRevision = value.text("revision")
                NativeMarkdownContent(blocks: item.objects("blocks"), labels: value.object("markdownLabels"),
                                      strings: strings, palette: palette,
                                      onReference: model.taskReferenceEnabled && !modalPresented && !discardConfirm ? { block, item, inline in
                    var position: CoreObject = ["blockIndex": block, "inlineIndex": inline]
                    if let item { position["itemIndex"] = item }
                    Task { await model.openTaskViewReference(sourceID: sourceID, revision: sourceRevision, position: position) }
                } : nil)
                .frame(maxWidth: .infinity, alignment: .leading).padding(12)
                .background(palette.input, in: RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.border, lineWidth: 1))
            }
        case "checklist":
            VStack(alignment: .leading, spacing: 6) {
                label(item.text("label"))
                if model.taskReferenceSection == "checklist" { referenceError }
                let entries = item.objects("items")
                ForEach(entries.indices, id: \.self) { index in
                    checklistEntry(entries[index], bullets: item.flag("bullets"), tappable: item.flag("tappable"))
                }
                if entries.count < item.number("total") {
                    Button {
                        endEditingBeforeAction()
                        Task { await model.readTaskView(more: true) }
                    } label: {
                        Text(strings.text("common.more")).rnFont(14, .semibold)
                            .frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).foregroundStyle(palette.tint).disabled(frozen)
                    .accessibilityIdentifier("task-view-more")
                }
                if !item.object("add").isEmpty {
                    let add = item.object("add")
                    TextField(add.text("placeholder"), text: Binding(
                        get: { model.taskChecklistAppendInput }, set: { model.setTaskChecklistAppendInput($0) }))
                        .rnFont(16).padding(12).frame(minHeight: 44)
                        .background(palette.input, in: RoundedRectangle(cornerRadius: 10))
                        .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.border, lineWidth: 1))
                        .submitLabel(.done)
                        .onSubmit { Task { await model.appendTaskChecklist() } }
                        .accessibilityLabel(add.text("label"))
                        .accessibilityIdentifier("task-view-checklist-append")
                        .disabled(frozen)
                }
            }
        case "attachments":
            VStack(alignment: .leading, spacing: 8) {
                label(item.text("label"))
                let entries = item.objects("items")
                ForEach(entries.indices, id: \.self) { index in
                    let entry = entries[index]
                    if ["link", "file"].contains(entry.text("kind")) {
                        Button {
                            endEditingBeforeAction()
                            Task { await model.openTaskAttachment(entry.text("id")) }
                        } label: { attachmentPreviewContent(entry) }
                            .buttonStyle(.plain).foregroundStyle(palette.tint)
                            .disabled(frozen || entry.flag("disabled"))
                            .accessibilityLabel(entry.text("title"))
                            .accessibilityIdentifier("task-view-attachment-open-" + entry.text("id"))
                    } else {
                        attachmentPreviewContent(entry)
                            .accessibilityElement(children: .combine)
                    }
                }
            }
        default:
            EmptyView()
        }
    }

    private func label(_ text: String) -> some View {
        Text(text).rnFont(12, .semibold).foregroundStyle(palette.secondary)
            .accessibilityAddTraits(.isHeader)
    }

    private func attachmentPreviewContent(_ entry: CoreObject) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: entry.flag("image") ? "photo" : "paperclip")
                .foregroundStyle(palette.secondary).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 6) {
                Text(entry.text("title")).rnFont(14, .semibold)
                if !entry.text("note").isEmpty {
                    Text(entry.text("note")).rnFont(12).foregroundStyle(palette.secondary)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .padding(12)
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(palette.border, lineWidth: 1))
        .contentShape(Rectangle())
    }

    private var attachmentEditor: some View {
        VStack(alignment: .leading, spacing: 10) {
            label(strings.text("attachments.title"))
            ForEach(model.taskAttachmentRows.indices, id: \.self) { index in
                let entry = model.taskAttachmentRows[index]
                HStack(spacing: 8) {
                    Image(systemName: entry.text("kind") == "link" ? "link" : "paperclip")
                        .foregroundStyle(palette.secondary).accessibilityHidden(true)
                    if ["link", "file"].contains(entry.text("kind")) {
                        Button {
                            endEditingBeforeAction()
                            Task { await model.openTaskAttachment(entry.text("id")) }
                        } label: {
                            Text(entry.text("title")).rnFont(14)
                                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).foregroundStyle(palette.tint)
                        .disabled(frozen || entry.flag("disabled"))
                        .accessibilityLabel(entry.text("title"))
                        .accessibilityIdentifier("task-attachment-open-" + entry.text("id"))
                    } else {
                        Text(entry.text("title")).rnFont(14).frame(maxWidth: .infinity, alignment: .leading)
                    }
                    if entry.text("kind") == "file", entry.flag("canDownload") {
                        if model.taskAttachmentDownloadingID == entry.text("id") {
                            HStack(spacing: 6) {
                                ProgressView()
                                Text(strings.text("common.loading")).rnFont(13)
                            }
                            .frame(minWidth: 44, minHeight: 44)
                            .accessibilityElement(children: .ignore)
                            .accessibilityLabel(strings.text("common.loading"))
                            .accessibilityIdentifier("task-attachment-downloading-" + entry.text("id"))
                        } else {
                            Button {
                                endEditingBeforeAction()
                                model.downloadTaskAttachment(entry.text("id"))
                            } label: {
                                Text(strings.text("attachments.download")).rnFont(13, .semibold)
                                    .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                            }
                            .buttonStyle(.plain).foregroundStyle(palette.tint)
                            .disabled(frozen || !model.canDownloadTaskAttachment(entry.text("id")))
                            .accessibilityLabel(strings.text("attachments.download") + " " + entry.text("title"))
                            .accessibilityIdentifier("task-attachment-download-" + entry.text("id"))
                        }
                    }
                    if entry.text("kind") == "link" {
                        Button {
                            endEditingBeforeAction()
                            model.openTaskLinkSheet(entry.text("id"))
                        } label: {
                            Image(systemName: "pencil").frame(width: 44, height: 44).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .disabled(frozen || !model.taskAttachmentListChangesAllowed || entry.flag("disabled"))
                        .accessibilityLabel(strings.text("common.edit") + " " + entry.text("title"))
                        .accessibilityIdentifier("task-attachment-edit-" + entry.text("id"))
                        Button {
                            endEditingBeforeAction()
                            Task { await model.removeTaskLink(entry.text("id")) }
                        } label: {
                            Image(systemName: "trash").frame(width: 44, height: 44).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).foregroundStyle(palette.danger)
                        .disabled(frozen || !model.taskAttachmentListChangesAllowed || entry.flag("disabled"))
                        .accessibilityLabel(strings.text("attachments.remove") + " " + entry.text("title"))
                        .accessibilityIdentifier("task-attachment-remove-" + entry.text("id"))
                    } else if entry.text("kind") == "file" {
                        Button {
                            endEditingBeforeAction()
                            Task { await model.removeTaskFile(entry.text("id")) }
                        } label: {
                            Image(systemName: "trash").frame(width: 44, height: 44).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).foregroundStyle(palette.danger)
                        .disabled(frozen || !model.canRemoveTaskFile || entry.flag("disabled"))
                        .accessibilityLabel(strings.text("attachments.remove") + " " + entry.text("title"))
                        .accessibilityIdentifier("task-attachment-remove-" + entry.text("id"))
                    }
                }
                .frame(minHeight: 44).padding(.leading, 12)
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(palette.border, lineWidth: 1))
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("task-attachment-row-" + entry.text("id"))
            }
            if model.taskAttachmentChangesNeedSettlement {
                Text(strings.text("attachments.finishDraftBeforeChanges"))
                    .rnFont(13).foregroundStyle(palette.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("task-attachment-settlement-hint")
            }
            Button {
                endEditingBeforeAction()
                model.openTaskLinkSheet()
            } label: {
                Label(strings.text("attachments.addLink"), systemImage: "link")
                    .rnFont(14, .semibold).frame(minWidth: 44, minHeight: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain).foregroundStyle(palette.tint)
            .disabled(frozen || !model.taskAttachmentListChangesAllowed)
            .accessibilityIdentifier("task-attachment-add-link")
            Button {
                endEditingBeforeAction()
                Task {
                    guard let id = await model.prepareTaskFileImport(), id == model.taskFileImporterID else { return }
                    fileImporterID = id
                }
            } label: {
                Label(strings.text("attachments.addFile"), systemImage: "paperclip")
                    .rnFont(14, .semibold).frame(minWidth: 44, minHeight: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain).foregroundStyle(palette.tint)
            .disabled(frozen || !model.canAddTaskFile)
            .accessibilityIdentifier("task-attachment-add-file")
            Button {
                endEditingBeforeAction()
                Task {
                    guard let id = await model.prepareTaskPhotoImport(), id == model.taskFileImporterID else { return }
                    fileImporterID = id
                }
            } label: {
                Label(strings.text("attachments.addPhoto"), systemImage: "photo")
                    .rnFont(14, .semibold).frame(minWidth: 44, minHeight: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain).foregroundStyle(palette.tint)
            .disabled(frozen || !model.canAddTaskFile)
            .accessibilityIdentifier("task-attachment-add-photo")
        }
    }

    private var taskLinkDialog: some View {
        ZStack {
            Color.black.opacity(0.45).ignoresSafeArea()
            VStack(alignment: .leading, spacing: 12) {
                Text(strings.text("attachments.addLink")).rnFont(18, .bold)
                ZStack(alignment: .topLeading) {
                    TextEditor(text: Binding(get: { model.taskLinkSheet.text("text") },
                                             set: { model.setTaskLinkText($0) }))
                        .rnFont(16).scrollContentBackground(.hidden)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .frame(minHeight: 130).padding(8)
                        .accessibilityLabel(strings.text("attachments.linkPlaceholder"))
                        .accessibilityHint(strings.text("attachments.linkBatchHint"))
                        .accessibilityIdentifier("task-attachment-link-input")
                    if model.taskLinkSheet.text("text").isEmpty {
                        Text(strings.text("attachments.linkPlaceholder"))
                            .rnFont(16).foregroundStyle(palette.secondary)
                            .padding(.horizontal, 13).padding(.vertical, 15)
                            .allowsHitTesting(false).accessibilityHidden(true)
                    }
                }
                .background(palette.input, in: RoundedRectangle(cornerRadius: 10))
                Text(strings.text("attachments.linkBatchHint")).rnFont(13).foregroundStyle(palette.secondary)
                if model.taskLinkSheetProtected {
                    Text("Draft saved on this device").rnFont(13).foregroundStyle(palette.secondary)
                        .accessibilityIdentifier("task-attachment-link-protected")
                }
                if model.taskRecoveryCheckpointError != nil {
                    HStack {
                        Text("This link draft has not been saved for recovery.")
                            .rnFont(13).foregroundStyle(palette.danger)
                        Button(strings.text("common.retry")) {
                            Task { await model.retryTaskDraftCheckpoint() }
                        }
                        .frame(minWidth: 44, minHeight: 44)
                    }
                    .accessibilityIdentifier("task-attachment-link-checkpoint-error")
                }
                if let error = model.taskLinkSheetError {
                    Text(error).rnFont(13).foregroundStyle(palette.danger)
                        .accessibilityIdentifier("task-attachment-link-error")
                }
                HStack {
                    Button(strings.text("common.cancel")) { model.cancelTaskLinkSheet() }
                        .frame(minWidth: 44, minHeight: 44)
                        .accessibilityIdentifier("task-attachment-link-cancel")
                    Spacer()
                    Button(strings.text("common.save")) { Task { await model.submitTaskLinkSheet() } }
                        .frame(minWidth: 44, minHeight: 44)
                        .disabled(model.taskLinkSubmitting || model.taskLinkSheet.text("text").isEmpty)
                        .accessibilityIdentifier("task-attachment-link-save")
                }
                .buttonStyle(.plain).foregroundStyle(palette.tint)
            }
            .foregroundStyle(palette.text)
            .padding(20).frame(maxWidth: 500)
            .background(palette.card, in: RoundedRectangle(cornerRadius: 18))
            .padding(20)
        }
        .accessibilityElement(children: .contain)
    }

    @ViewBuilder private func pills(_ items: [CoreObject], field: String, fieldLabel: String) -> some View {
        let sourceID = value.text("id"), revision = value.text("revision")
        ForEach(items.indices, id: \.self) { index in
            Button {
                Task { await model.openTaskViewReference(sourceID: sourceID, revision: revision,
                                                        position: ["field": field, "tokenIndex": index]) }
            } label: {
                Text(items[index].text("value")).rnFont(12, .semibold)
                    .padding(.horizontal, 10).padding(.vertical, 6).frame(minWidth: 44, minHeight: 44)
                    .background(palette.input, in: RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(palette.border, lineWidth: 1))
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain).disabled(!model.taskReferenceEnabled || modalPresented || discardConfirm)
            .accessibilityLabel(fieldLabel + ": " + items[index].text("value"))
            .accessibilityIdentifier("task-view-\(field)-\(index)")
        }
    }

    @ViewBuilder private var referenceError: some View {
        if let message = model.taskReferenceError {
            Text(message).rnFont(13).foregroundStyle(palette.danger)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("task-reference-error")
            if !model.taskDirty {
                Button { Task { await model.retryTaskViewReference() } } label: {
                    Text(strings.text("common.retry")).rnFont(14, .semibold)
                        .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(!model.taskReferenceEnabled)
                .accessibilityIdentifier("task-reference-retry")
            }
        }
    }

    @ViewBuilder private func checklistEntry(_ entry: CoreObject, bullets: Bool, tappable: Bool) -> some View {
        let runs = entry.objects("inline")
        let hasLinks = runs.contains { $0.text("type") == "link" }
        let sourceID = value.text("id"), revision = value.text("revision"), index = entry.number("index")
        let toggle = {
            endEditingBeforeAction()
            Task { await model.editTaskChecklist(["kind": "toggle", "index": index], refreshPreview: true) }
        }
        let marker = NativeMarkdownChecklistMarker(bullet: bullets, completed: entry.flag("completed"), palette: palette)
        let content = HStack(alignment: .top, spacing: 8) {
            if hasLinks && tappable && !bullets {
                Button { toggle() } label: {
                    marker.frame(width: 44, height: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(frozen)
                .accessibilityLabel(entry.text("title"))
                .accessibilityValue(strings.text(entry.flag("completed") ? "common.done" : "status.active"))
                .accessibilityIdentifier("task-view-checklist-toggle-\(index)")
            } else { marker.padding(.top, 2) }
            NativeMarkdownInline(runs: runs, labels: value.object("markdownLabels"), palette: palette, size: 14,
                                 onReference: model.taskReferenceEnabled && !modalPresented && !discardConfirm ? { inline in
                Task { await model.openTaskViewReference(sourceID: sourceID, revision: revision,
                                                        position: ["checklistIndex": index, "inlineIndex": inline]) }
            } : nil)
        }
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .contentShape(Rectangle())
        if tappable && !bullets && !hasLinks {
            Button { toggle() } label: { content }
                .buttonStyle(.plain).disabled(frozen)
                .accessibilityLabel(entry.text("title"))
                .accessibilityValue(strings.text(entry.flag("completed") ? "common.done" : "status.active"))
                .accessibilityIdentifier("task-view-checklist-toggle-\(index)")
        } else if hasLinks || entry.text("accessibilityLabel").isEmpty {
            content.accessibilityElement(children: .contain)
        } else {
            content.accessibilityElement(children: .combine)
                .accessibilityLabel(entry.text("accessibilityLabel"))
        }
    }

}

private struct TaskAttachmentPickerClaim: Identifiable {
    let id: UUID
    let kind: CoreModel.TaskAttachmentPickerKind
}

private struct NativePhotoPicker: UIViewControllerRepresentable {
    let pickerID: UUID
    let completion: (Result<[NSItemProvider], Error>, UUID) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(pickerID: pickerID, completion: completion) }

    func makeUIViewController(context: Context) -> PHPickerViewController {
        var configuration = PHPickerConfiguration()
        configuration.filter = .images
        configuration.selectionLimit = 1
        configuration.preferredAssetRepresentationMode = .current
        let picker = PHPickerViewController(configuration: configuration)
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ picker: PHPickerViewController, context: Context) {}

    final class Coordinator: NSObject, PHPickerViewControllerDelegate {
        let pickerID: UUID
        let completion: (Result<[NSItemProvider], Error>, UUID) -> Void
        private var delivered = false

        init(pickerID: UUID, completion: @escaping (Result<[NSItemProvider], Error>, UUID) -> Void) {
            self.pickerID = pickerID
            self.completion = completion
        }

        func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
            guard !delivered else { return }
            delivered = true
            guard !results.isEmpty else {
                completion(.failure(CocoaError(.userCancelled)), pickerID)
                return
            }
            // Retain the selected provider; its temporary representation is
            // acquired and captured only by the typed native facade.
            completion(.success(results.map(\.itemProvider)), pickerID)
        }
    }
}

struct NativeDocumentPickerClaim: Identifiable {
    let id: UUID
}

struct NativeDocumentPicker: UIViewControllerRepresentable {
    let pickerID: UUID
    let completion: (Result<[URL], Error>, UUID) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(pickerID: pickerID, completion: completion) }

    func makeUIViewController(context: Context) -> UIDocumentPickerViewController {
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.data], asCopy: false)
        picker.allowsMultipleSelection = false
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ picker: UIDocumentPickerViewController, context: Context) {}

    final class Coordinator: NSObject, UIDocumentPickerDelegate {
        let pickerID: UUID
        let completion: (Result<[URL], Error>, UUID) -> Void

        init(pickerID: UUID, completion: @escaping (Result<[URL], Error>, UUID) -> Void) {
            self.pickerID = pickerID
            self.completion = completion
        }

        func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
            completion(.success(urls), pickerID)
        }

        func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
            completion(.failure(CocoaError(.userCancelled)), pickerID)
        }
    }
}

struct NativeMarkdownChecklistMarker: View {
    let bullet: Bool
    let completed: Bool
    let palette: AppPalette

    var body: some View {
        if bullet {
            Text("•").rnFont(18).foregroundStyle(palette.secondary).accessibilityHidden(true)
        } else {
            Image(systemName: completed ? "checkmark.square" : "square")
                .font(.system(size: 18)).foregroundStyle(completed ? palette.tint : palette.secondary)
                .accessibilityHidden(true)
        }
    }
}

struct NativeMarkdownContent: View {
    let blocks: [CoreObject]
    let labels: CoreObject
    let strings: CoreObject
    let palette: AppPalette
    var onReference: ((Int, Int?, Int) -> Void)? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(blocks.indices, id: \.self) { index in block(blocks[index], at: index) }
        }
    }

    private func referenceHandler(_ blockIndex: Int, itemIndex: Int?) -> ((Int) -> Void)? {
        guard let onReference else { return nil }
        return { onReference(blockIndex, itemIndex, $0) }
    }

    @ViewBuilder private func block(_ block: CoreObject, at blockIndex: Int) -> some View {
        switch block.text("type") {
        case "blank":
            Color.clear.frame(height: 12).accessibilityHidden(true)
        case "rule":
            Divider().overlay(palette.border).padding(.vertical, 4).accessibilityHidden(true)
        case "heading":
            NativeMarkdownInline(runs: block.objects("inline"), labels: labels, palette: palette,
                                 size: block.number("level") == 1 ? 16 : block.number("level") == 2 ? 15 : 14,
                                 weight: .bold, onReference: referenceHandler(blockIndex, itemIndex: nil))
                .accessibilityAddTraits(.isHeader)
        case "paragraph":
            NativeMarkdownInline(runs: block.objects("inline"), labels: labels, palette: palette,
                                 onReference: referenceHandler(blockIndex, itemIndex: nil))
        case "code":
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    Spacer()
                    Button {
                        UIPasteboard.general.string = block.text("text")
                    } label: {
                        Image(systemName: "doc.on.doc").font(.system(size: 16))
                            .frame(width: 44, height: 44).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).foregroundStyle(palette.secondary)
                    .accessibilityLabel(labels.text("copyCode"))
                }
                ScrollView(.horizontal) {
                    Text(block.text("text")).font(.system(.footnote, design: .monospaced))
                        .textSelection(.enabled).fixedSize(horizontal: true, vertical: true)
                        .padding(.bottom, 10)
                }
            }
            .padding(.horizontal, 10)
            .background(palette.filter, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(palette.border, lineWidth: 1))
        case "taskList", "bulletList", "orderedList":
            VStack(alignment: .leading, spacing: 4) {
                let items = block.objects("items")
                ForEach(items.indices, id: \.self) { index in
                    let item = items[index]
                    HStack(alignment: .top, spacing: 6) {
                        if block.text("type") == "taskList" {
                            NativeMarkdownChecklistMarker(bullet: false, completed: item.flag("checked"), palette: palette)
                        } else {
                            Text(item.text("marker")).rnFont(13).foregroundStyle(palette.secondary)
                                .fixedSize().accessibilityHidden(true)
                        }
                        NativeMarkdownInline(runs: item.objects("inline"), labels: labels, palette: palette,
                                             onReference: referenceHandler(blockIndex, itemIndex: index))
                            .accessibilityValue(block.text("type") == "taskList" ? strings.text(item.flag("checked") ? "common.done" : "status.active") : "")
                    }
                    // ponytail: indent caps at eight levels; use horizontal scrolling if deeper nesting must stay distinct.
                    .padding(.leading, CGFloat(min(max(0, item.number("depth")), 8)) * 14)
                }
            }
            .padding(.leading, 6)
        default:
            EmptyView()
        }
    }
}

// Validation does not normalize or decode the original external link.
enum NativeMarkdownLinkURL {
    static func externalURL(_ href: String) -> URL? {
        guard let url = URL(string: href),
              ["http", "https", "mailto", "tel", "upnote"].contains(url.scheme?.lowercased() ?? "") else { return nil }
        if url.scheme?.lowercased() == "upnote" {
            guard href.lowercased().hasPrefix("upnote://"), url.absoluteString == href else { return nil }
        }
        return url
    }
    static func originalHref(_ url: URL, runs: [CoreObject]) -> String? {
        runs.first { $0.text("type") == "link" && $0.object("target").text("kind") == "external"
            && externalURL($0.object("target").text("href"))?.absoluteString == url.absoluteString }?.object("target").text("href")
    }
}

private struct NativeExternalLinkDiagnostic: EnvironmentKey { static let defaultValue: ((String, String) -> Void)? = nil }
private struct NativeExternalLinkLabels: EnvironmentKey { static let defaultValue: CoreObject = [:] }
extension EnvironmentValues {
    var nativeExternalLinkDiagnostic: ((String, String) -> Void)? {
        get { self[NativeExternalLinkDiagnostic.self] }
        set { self[NativeExternalLinkDiagnostic.self] = newValue }
    }
    var nativeExternalLinkLabels: CoreObject {
        get { self[NativeExternalLinkLabels.self] }
        set { self[NativeExternalLinkLabels.self] = newValue }
    }
}

@MainActor
enum NativeUpNoteLink {
    static func open(_ original: String, surface: String) async -> Bool {
        guard let url = NativeMarkdownLinkURL.externalURL(original), url.scheme?.lowercased() == "upnote" else { return false }
        let opened = await withCheckedContinuation { continuation in
            UIApplication.shared.open(url, options: [:]) { continuation.resume(returning: $0) }
        }
        NSLog("Native iOS UpNote handoff scope=links releaseCheck=v1.3.4/upnote-links outcome=%@ surface=%@ scheme=upnote", opened ? "opened" : "failed", surface)
        return opened
    }
    static func showFailure(_ original: String, labels: CoreObject) {
        let alert = UIAlertController(title: labels.text("common.error"), message: labels.text("markdown.openLinkFailed"), preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: labels.text("markdown.copyLink"), style: .default) { _ in
            UIPasteboard.general.string = original
        })
        alert.addAction(UIAlertAction(title: labels.text("common.cancel"), style: .cancel))
        let window = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            .filter { $0.activationState == .foregroundActive }.flatMap(\.windows).first { $0.isKeyWindow }
        var presenter = window?.rootViewController
        while let presented = presenter?.presentedViewController { presenter = presented }
        presenter?.present(alert, animated: true)
    }
}

struct NativeMarkdownInline: View {
    let runs: [CoreObject]
    let labels: CoreObject
    let palette: AppPalette
    var size: Double = 13
    var weight: Font.Weight = .regular
    var onReference: ((Int) -> Void)? = nil
    @Environment(\.nativeExternalLinkLabels) private var linkLabels
    @Environment(\.nativeExternalLinkDiagnostic) private var linkDiagnostic

    var body: some View {
        Text(Self.attributedText(runs, labels: labels, palette: palette, referenceLinks: onReference != nil)).rnFont(size, weight).textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .environment(\.openURL, OpenURLAction { url in
                if let onReference, url.scheme == "mindwtr-native-row", url.host == "reference",
                   let index = Int(url.lastPathComponent),
                   url.absoluteString == "mindwtr-native-row://reference/\(index)",
                   runs.indices.contains(index), runs[index].text("type") == "link",
                   ["task", "project"].contains(runs[index].object("target").text("kind")) {
                    onReference(index)
                    return .handled
                }
                if url.scheme?.lowercased() == "upnote",
                   let original = NativeMarkdownLinkURL.originalHref(url, runs: runs) {
                    Task {
                        let opened = await NativeUpNoteLink.open(original, surface: "markdown")
                        linkDiagnostic?(opened ? "opened" : "failed", "markdown")
                        if !opened { NativeUpNoteLink.showFailure(original, labels: linkLabels) }
                    }
                    return .handled
                }
                return ["http", "https", "mailto", "tel"].contains(url.scheme?.lowercased() ?? "")
                    ? .systemAction : .discarded
            })
    }

    static func attributedText(_ runs: [CoreObject], labels: CoreObject, palette: AppPalette, referenceLinks: Bool = false) -> AttributedString {
        var result = AttributedString()
        for (index, run) in runs.enumerated() {
            var text = AttributedString(run.text("text"))
            switch run.text("type") {
            case "bold": text.inlinePresentationIntent = .stronglyEmphasized
            case "italic": text.inlinePresentationIntent = .emphasized
            case "strike": text.swiftUI.strikethroughStyle = Text.LineStyle(pattern: .solid)
            case "code": text.swiftUI.font = .system(.footnote, design: .monospaced)
            case "link":
                let reference = referenceLinks && ["task", "project"].contains(run.object("target").text("kind"))
                    ? URL(string: "mindwtr-native-row://reference/\(index)") : nil
                if let url = externalURL(run) ?? reference {
                    text.link = url
                    text.swiftUI.foregroundColor = palette.tint
                    text.swiftUI.underlineStyle = Text.LineStyle(pattern: .solid)
                }
            case "deletedReference":
                text.swiftUI.strikethroughStyle = Text.LineStyle(pattern: .solid)
                text.swiftUI.foregroundColor = palette.secondary
                result.append(text)
                let key = run.text("entityType") == "project" ? "deletedProject" : "deletedTask"
                var suffix = AttributedString(" (" + labels.text(key) + ")")
                suffix.swiftUI.foregroundColor = palette.secondary
                result.append(suffix)
                continue
            default: break
            }
            result.append(text)
        }
        return result
    }

    private static func externalURL(_ run: CoreObject) -> URL? {
        let target = run.object("target")
        guard run.text("type") == "link", target.text("kind") == "external",
              let url = NativeMarkdownLinkURL.externalURL(target.text("href")) else { return nil }
        return url
    }
}

private struct TaskScheduleField: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    let field: String
    @Binding var pickerID: String
    @Binding var pickerValue: Date
    let beforeAction: () -> Void
    @FocusState private var amountFocused: Bool
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    private var part: CoreObject { model.taskEditor.object("fields").object(field) }
    private var relative: CoreObject { model.taskEditor.object("fields").object("relativeStart") }
    private var prefix: String { "task-date-" + field }
    private var label: String {
        model.label(field == "startTime" ? "taskEdit.startDateLabel" : field == "dueDate" ? "taskEdit.dueDateLabel" : "taskEdit.reviewDateLabel")
    }
    private var symbol: String { field == "reviewAt" ? "calendar.badge.clock" : "calendar" }
    private var pickerMode: String { pickerID == field + ":date" ? "date" : pickerID == field + ":time" ? "time" : "" }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if field == "dueDate" && part.text("value").isEmpty {
                compactDue
            } else {
                heading
                if dynamicTypeSize.isAccessibilitySize {
                    VStack(alignment: .leading, spacing: 8) {
                        dateButton
                        AppChipFlow { dateActions }
                    }
                } else {
                    HStack(spacing: 8) {
                        dateButton
                        dateActions
                    }
                }
            }
            AppChipFlow {
                ForEach(part.objects("quickDates").indices, id: \.self) { index in
                    let choice = part.objects("quickDates")[index]
                    chip(choice.text("label"), selected: choice.flag("selected"), id: prefix + "-quick-" + choice.text("preset")) {
                        pickerID = ""
                        model.editTaskDate(field, action: "quick", preset: choice.text("preset"))
                    }
                }
            }
            let issue = model.taskEditor.object("fields").text("dateIssue")
            if field != "reviewAt" && !issue.isEmpty {
                Text(issue).rnFont(13).foregroundStyle(palette.warning).fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier(prefix + "-issue")
            }
            if field == "startTime" && !relative.isEmpty { relativeControls }
            if !pickerMode.isEmpty { inlinePicker }
        }
    }

    private var heading: some View {
        HStack(spacing: 6) {
            Image(systemName: symbol).font(.system(size: 16)).accessibilityHidden(true)
            Text(label.uppercased()).rnFont(14)
        }
        .foregroundStyle(palette.secondary).accessibilityAddTraits(.isHeader)
    }

    private var dateButton: some View {
        Button { openPicker("date") } label: {
            Text(part.text("label")).rnFont(14).fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading).padding(12).frame(minHeight: 44)
                .background(palette.input, in: RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.border, lineWidth: 1)).contentShape(Rectangle())
        }
        .buttonStyle(.plain).foregroundStyle(palette.text)
        .accessibilityLabel(label).accessibilityValue(part.text("label"))
        .accessibilityIdentifier("task-editor-" + field)
    }

    private var compactDue: some View {
        Button { openPicker("date") } label: {
            Group {
                if dynamicTypeSize.isAccessibilitySize {
                    VStack(alignment: .leading, spacing: 8) {
                        heading
                        Text(part.text("label")).rnFont(14, .bold).foregroundStyle(palette.tint)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    HStack(spacing: 12) {
                        heading
                        Text(part.text("label")).rnFont(14, .bold).foregroundStyle(palette.tint)
                            .frame(maxWidth: .infinity, alignment: .trailing)
                    }
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 10).frame(minHeight: 44)
            .background(palette.filter, in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.border, lineWidth: 1)).contentShape(Rectangle())
        }
        .buttonStyle(.plain).accessibilityLabel(label).accessibilityValue(part.text("label"))
        .accessibilityIdentifier("task-editor-" + field)
    }

    @ViewBuilder private var dateActions: some View {
        if !part.text("value").isEmpty {
            if field != "reviewAt" {
                Button { openPicker("time") } label: {
                    Image(systemName: "clock").font(.system(size: 14)).frame(width: 44, height: 44)
                        .background(palette.filter, in: RoundedRectangle(cornerRadius: 10))
                        .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.border, lineWidth: 1)).contentShape(Rectangle())
                }
                .buttonStyle(.plain).foregroundStyle(palette.secondary)
                .accessibilityLabel(part.flag("hasTime") && !part.text("time").isEmpty
                    ? model.label(field == "startTime" ? "task.aria.startTime" : "task.aria.dueTime") + ": " + part.text("time")
                    : model.label("calendar.changeTime"))
                .accessibilityIdentifier(prefix + "-time")
            }
            if part.flag("hasTime") {
                chip(model.label("taskEdit.dateOnly"), selected: false, id: prefix + "-date-only", compact: true) {
                    pickerID = ""
                    model.editTaskDate(field, action: "dateOnly")
                }
            }
            Button {
                beforeAction()
                pickerID = ""
                model.editTaskDate(field, action: "clear")
            } label: {
                Image(systemName: "calendar.badge.minus").font(.system(size: 14)).frame(width: 44, height: 44)
                    .background(palette.filter, in: RoundedRectangle(cornerRadius: 10))
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.border, lineWidth: 1)).contentShape(Rectangle())
            }
            .buttonStyle(.plain).foregroundStyle(palette.secondary)
            .accessibilityLabel(model.label("common.clear")).accessibilityIdentifier(prefix + "-clear")
        }
    }

    private var relativeControls: some View {
        VStack(alignment: .leading, spacing: 8) {
            AppChipFlow {
                chip(model.label("taskEdit.startModeAbsolute"), selected: !relative.flag("active"), id: "task-start-mode-absolute") {
                    model.setTaskRelativeMode(false)
                }
                chip(model.label("taskEdit.startModeRelative"), selected: relative.flag("active"), id: "task-start-mode-relative") {
                    model.setTaskRelativeMode(true)
                }
            }
            if relative.flag("active") {
                if dynamicTypeSize.isAccessibilitySize {
                    VStack(alignment: .leading, spacing: 8) { amountInput; beforeDue }
                } else {
                    HStack(spacing: 8) { amountInput.frame(width: 74); beforeDue }
                }
                AppChipFlow {
                    ForEach(relative.objects("units").indices, id: \.self) { index in
                        let unit = relative.objects("units")[index]
                        chip(unit.text("label"), selected: model.taskRelativeUnitInput == unit.text("unit"), id: "task-start-relative-unit-" + unit.text("unit")) {
                            model.setTaskRelativeUnit(unit.text("unit"))
                        }
                    }
                }
            }
        }
        .padding(.top, 2)
    }

    private var amountInput: some View {
        TextField(model.label("taskEdit.relativeStartAmount"), text: Binding(
            get: { model.taskRelativeAmountInput }, set: { model.setTaskRelativeAmount($0) }))
            .rnFont(16).keyboardType(.numberPad).focused($amountFocused)
            .onChange(of: amountFocused) { focused in
                if focused { model.beginTaskRelativeInput() }
                else { model.commitTaskRelativeInput() }
            }
            .padding(12).frame(minHeight: 44).background(palette.input, in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.border, lineWidth: 1))
            .contentShape(Rectangle()).onTapGesture {
                model.beginTaskRelativeInput()
                amountFocused = true
            }
            .accessibilityLabel(model.label("taskEdit.relativeStartAmount")).accessibilityIdentifier("task-start-relative-amount")
    }

    private var beforeDue: some View {
        Text(model.label("taskEdit.relativeStartBeforeDue")).rnFont(14).foregroundStyle(palette.text)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func chip(_ text: String, selected: Bool, id: String, compact: Bool = false, action: @escaping () -> Void) -> some View {
        Button { beforeAction(); action() } label: {
            Text(text).rnFont(compact ? 12 : 14).fixedSize(horizontal: false, vertical: true)
                .foregroundStyle(selected ? palette.onTint : palette.secondary)
                .padding(.horizontal, compact ? 10 : 12).padding(.vertical, 10).frame(minWidth: 44, minHeight: 44)
                .background(selected ? palette.tint : palette.filter, in: RoundedRectangle(cornerRadius: compact ? 10 : 16))
                .overlay(RoundedRectangle(cornerRadius: compact ? 10 : 16).stroke(selected ? palette.tint : palette.border, lineWidth: 1))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain).accessibilityAddTraits(selected ? .isSelected : []).accessibilityIdentifier(id)
    }

    private func openPicker(_ mode: String) {
        beforeAction()
        Task {
            guard await model.prepareTaskDatePicker() else { return }
            guard let date = TaskDatePickerComponents.date(part.object("picker")) else { model.reportTaskDatePickerFailure(); return }
            pickerValue = date
            pickerID = field + ":" + mode
        }
    }

    private var inlinePicker: some View {
        VStack(spacing: 0) {
            HStack {
                Spacer()
                Button {
                    beforeAction()
                    Task { if await model.prepareTaskDatePicker() { pickerID = "" } }
                } label: {
                    Text(model.label("common.done")).rnFont(14, .semibold).foregroundStyle(palette.onTint)
                        .padding(.horizontal, 12).frame(minHeight: 44).background(palette.tint, in: RoundedRectangle(cornerRadius: 10))
                }
                .buttonStyle(.plain).accessibilityIdentifier(prefix + "-done")
            }
            DatePicker(label, selection: Binding(get: { pickerValue }, set: { date in
                let mode = pickerMode
                let value = TaskDatePickerComponents.string(date, time: mode == "time")
                let previous = TaskDatePickerComponents.string(pickerValue, time: mode == "time")
                pickerValue = date
                guard value != previous else { return }
                model.setTaskPickedDate(field, mode: mode, value: value)
            }), displayedComponents: pickerMode == "time" ? .hourAndMinute : .date)
                .datePickerStyle(.wheel).labelsHidden().tint(palette.tint)
                .accessibilityLabel(label).accessibilityIdentifier(prefix + "-picker")
        }
        .padding(.top, 8)
    }
}

/// Converts only core's machine picker components. Stored date strings and
/// displayed labels never pass through Foundation formatting here. The wheel
/// itself keeps the platform locale/calendar, as RN's native spinner does.
enum TaskDatePickerComponents {
    private static func formatter(_ format: String, timeZone: TimeZone = .current) -> DateFormatter {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.timeZone = timeZone
        formatter.dateFormat = format
        formatter.isLenient = false
        return formatter
    }

    static func date(_ picker: CoreObject) -> Date? {
        formatter("yyyy-MM-dd HH:mm").date(from: picker.text("date") + " " + picker.text("time"))
    }

    static func string(_ date: Date, time: Bool, timeZone: TimeZone = .current) -> String {
        formatter(time ? "HH:mm" : "yyyy-MM-dd", timeZone: timeZone).string(from: date)
    }

    static func instant(_ value: String) -> Date? {
        let input = value.hasPrefix("+") ? String(value.dropFirst()) : value
        guard let date = instantFormatter().date(from: input), instantString(date) == value else { return nil }
        return date
    }

    static func instantString(_ date: Date) -> String {
        let output = instantFormatter().string(from: date)
        guard let separator = output.dropFirst(output.hasPrefix("-") ? 1 : 0).firstIndex(of: "-"),
              let year = Int(output[..<separator]) else { return output }
        let extended = year < 0 || year > 9_999
        let digits = String(abs(year))
        let padding = String(repeating: "0", count: max(0, (extended ? 6 : 4) - digits.count))
        let sign = year < 0 ? "-" : extended ? "+" : ""
        return sign + padding + digits + String(output[separator...])
    }

    private static func instantFormatter() -> DateFormatter {
        // JS ISO instants use a proleptic Gregorian calendar and astronomical
        // years. Local date/time wheel components keep their existing calendar.
        let codec = formatter("uuuu-MM-dd'T'HH:mm:ss.SSS'Z'", timeZone: TimeZone(secondsFromGMT: 0)!)
        codec.gregorianStartDate = Date(timeIntervalSince1970: -8_640_000_000_000)
        return codec
    }
}

private struct TaskRecurrenceField: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    @Binding var pickerID: String
    @Binding var pickerValue: Date
    let beforeAction: () -> Void
    let openCustom: (CoreObject) -> Void
    @FocusState private var focusedInput: String?
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    private var part: CoreObject { model.taskEditor.object("fields").object("recurrence") }
    private var draft: CoreObject { model.taskEditor.object("draft") }
    private var rule: String { draft.text("recurrence") }
    private var futureHint: String {
        [model.label("recurrence.showFutureInCalendarHint"), part.text("calendarPreviewHint")]
            .filter { !$0.isEmpty }.joined(separator: " ")
    }
    private var unit: String { model.label("recurrence." + (rule == "daily" ? "day" : rule == "weekly" ? "week" : rule == "monthly" ? "month" : "year") + "Unit") }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: "repeat").font(.system(size: 16)).accessibilityHidden(true)
                Text(model.label("taskEdit.recurrenceLabel").uppercased()).rnFont(14)
            }
            .foregroundStyle(palette.secondary).accessibilityAddTraits(.isHeader)
            AppChipFlow {
                let options = model.taskEditor.object("options").objects("recurrences")
                ForEach(options.indices, id: \.self) { index in
                    let option = options[index]
                    chip(model.label(option.text("labelKey")), selected: rule == option.text("value"),
                        id: "rule-" + (option.text("value").isEmpty ? "none" : option.text("value"))) {
                        pickerID = ""
                        model.editTaskRecurrence(["kind": "rule", "rule": option.text("value")])
                    }
                }
            }
            if !rule.isEmpty {
                numericRow("interval", title: model.label("recurrence.repeatEvery"), unit: unit)
                if rule == "weekly" { weekdays }
                if rule == "monthly" { monthlyControls }
                Text(model.label("recurrence.endsLabel")).rnFont(14).foregroundStyle(palette.secondary)
                AppChipFlow {
                    ForEach(["never", "until", "count"], id: \.self) { mode in
                        chip(model.label(mode == "never" ? "recurrence.endsNever" : mode == "until" ? "recurrence.endsOnDate" : "recurrence.endsAfterCount"),
                            selected: part.text("ends") == mode, id: "ends-" + mode) {
                            pickerID = ""
                            model.editTaskRecurrence(["kind": "ends", "ends": mode])
                            if mode == "until" { openUntilPicker() }
                        }
                    }
                }
                if part.text("ends") == "count" {
                    numericRow("count", title: model.label("recurrence.endsAfterCount"), unit: model.label("recurrence.occurrenceUnit"))
                }
                if part.text("ends") == "until" {
                    Button { beforeAction(); openUntilPicker() } label: {
                        Text(part.text("untilLabel")).rnFont(14).fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading).padding(12).frame(minHeight: 44)
                            .background(palette.input, in: RoundedRectangle(cornerRadius: 10))
                            .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.border, lineWidth: 1)).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).accessibilityLabel(model.label("recurrence.endsOnDate"))
                    .accessibilityValue(part.text("untilLabel")).accessibilityIdentifier("task-recurrence-until")
                    if pickerID == "recurrence:until" { untilPicker }
                }
                chip(model.label("recurrence.afterCompletion"), selected: draft.text("recurrenceStrategy") == "fluid", id: "strategy") {
                    model.editTaskRecurrence(["kind": "strategy"])
                }
                Button {
                    beforeAction()
                    model.toggleTaskFutureRecurrence()
                } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(model.label("recurrence.showFutureInCalendar")).rnFont(14, .semibold)
                        Text(futureHint).rnFont(12).foregroundStyle(palette.secondary)
                    }
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(12).frame(minHeight: 44)
                    .background(draft.flag("showFutureRecurrence") ? palette.filter : palette.card, in: RoundedRectangle(cornerRadius: 10))
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(draft.flag("showFutureRecurrence") ? palette.tint : palette.border, lineWidth: 1))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityRepresentation {
                    Toggle(model.label("recurrence.showFutureInCalendar"), isOn: Binding(
                        get: { draft.flag("showFutureRecurrence") }, set: { _ in
                            beforeAction()
                            model.toggleTaskFutureRecurrence()
                        }))
                        .accessibilityHint(futureHint)
                        .accessibilityIdentifier("task-recurrence-show-future")
                }
            }
        }
        .onChange(of: focusedInput) { field in
            if let field { model.beginTaskRecurrenceInput(field) }
            else { model.commitTaskRecurrenceInputs() }
        }
    }

    private var weekdays: some View {
        AppChipFlow {
            let days = part.objects("weekdays")
            ForEach(days.indices, id: \.self) { index in
                let day = days[index]
                chip(day.text("label"), selected: day.flag("selected"), id: "weekday-" + day.text("day")) {
                    model.editTaskRecurrence(["kind": "weekday", "day": day.text("day")])
                }
                .accessibilityLabel(day.text("longLabel"))
            }
        }
    }

    private var monthlyControls: some View {
        let pattern = model.taskEditor.object("layout").object("recurrence").text("monthlyPattern")
        return AppChipFlow {
            chip(model.label("recurrence.monthlyOnDay"), selected: pattern == "date", id: "monthly-day") {
                model.editTaskRecurrence(["kind": "monthlyOnDay"])
            }
            chip(model.label("recurrence.custom"), selected: pattern == "custom", id: "monthly-custom") {
                Task {
                    guard await model.prepareTaskDatePicker() else { return }
                    pickerID = ""
                    openCustom(part.object("monthlyCustom"))
                }
            }
        }
    }

    @ViewBuilder private func numericRow(_ field: String, title: String, unit: String) -> some View {
        if dynamicTypeSize.isAccessibilitySize {
            VStack(alignment: .leading, spacing: 8) {
                if field == "interval" { Text(title).rnFont(14).foregroundStyle(palette.secondary) }
                numericInput(field, title: title, unit: unit)
                Text(unit).rnFont(14).foregroundStyle(palette.secondary)
            }
        } else {
            HStack(spacing: 8) {
                if field == "interval" { Text(title).rnFont(14).foregroundStyle(palette.secondary) }
                numericInput(field, title: title, unit: unit).frame(width: 74)
                Text(unit).rnFont(14).foregroundStyle(palette.secondary).fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func numericInput(_ field: String, title: String, unit: String) -> some View {
        TextField(title, text: Binding(get: { model.taskRecurrenceInputs[field] ?? "" },
            set: { model.setTaskRecurrenceInput(field, text: $0) }))
            .rnFont(16).keyboardType(.numberPad).focused($focusedInput, equals: field)
            .padding(12).frame(minHeight: 44).background(palette.input, in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.border, lineWidth: 1))
            .contentShape(Rectangle()).onTapGesture {
                model.beginTaskRecurrenceInput(field)
                focusedInput = field
            }
            .accessibilityLabel(title).accessibilityHint(unit).accessibilityIdentifier("task-recurrence-" + field)
    }

    private func chip(_ title: String, selected: Bool, id: String, action: @escaping () -> Void) -> some View {
        Button { beforeAction(); action() } label: {
            Text(title).rnFont(14).fixedSize(horizontal: false, vertical: true)
                .foregroundStyle(selected ? palette.onTint : palette.secondary)
                .padding(.horizontal, 12).padding(.vertical, 10).frame(minWidth: 44, minHeight: 44)
                .background(selected ? palette.tint : palette.filter, in: RoundedRectangle(cornerRadius: 16))
                .overlay(RoundedRectangle(cornerRadius: 16).stroke(selected ? palette.tint : palette.border, lineWidth: 1))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain).accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier("task-recurrence-" + id)
    }

    private func openUntilPicker() {
        Task {
            guard await model.prepareTaskDatePicker() else { return }
            guard let date = TaskDatePickerComponents.date(["date": part.text("until"), "time": "12:00"]) else {
                model.reportTaskDatePickerFailure(); return
            }
            pickerValue = date
            pickerID = "recurrence:until"
        }
    }

    private var untilPicker: some View {
        VStack(spacing: 0) {
            HStack {
                Spacer()
                chip(model.label("common.done"), selected: true, id: "until-done") {
                    Task { if await model.prepareTaskDatePicker() { pickerID = "" } }
                }
            }
            DatePicker(model.label("recurrence.endsOnDate"), selection: Binding(get: { pickerValue }, set: { date in
                let value = TaskDatePickerComponents.string(date, time: false)
                let previous = TaskDatePickerComponents.string(pickerValue, time: false)
                pickerValue = date
                guard value != previous else { return }
                model.setTaskRecurrenceUntil(value)
            }), displayedComponents: .date)
                .datePickerStyle(.wheel).labelsHidden().tint(palette.tint)
                .accessibilityLabel(model.label("recurrence.endsOnDate")).accessibilityIdentifier("task-recurrence-until-picker")
        }
    }
}

private struct TaskBackdatedCompletionDraft {
    let taskID: String
    let session: Int
    let date: Date
    let instant: String
    let minutesText: String
    let showMinutes: Bool
}

private struct TaskBackdatedCompletionDialog: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    let initial: TaskBackdatedCompletionDraft
    let close: () -> Void
    @State private var date: Date
    @State private var minutesText: String
    @State private var dateChanged = false
    @State private var confirming = false
    @State private var attempted = false
    private var frozen: Bool { model.busy || model.retryNeeded || confirming }

    init(model: CoreModel, palette: AppPalette, initial: TaskBackdatedCompletionDraft,
         close: @escaping () -> Void) {
        self.model = model
        self.palette = palette
        self.initial = initial
        self.close = close
        _date = State(initialValue: initial.date)
        _minutesText = State(initialValue: initial.minutesText)
    }

    var body: some View {
        GeometryReader { geometry in
            ZStack {
                Color.black.opacity(0.35).ignoresSafeArea().onTapGesture { cancel() }.accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 12) {
                    ScrollView { form }
                    .scrollDismissesKeyboard(.interactively)
                    // Keep this one form mounted as the keyboard changes the
                    // available height; replacing it loses the focused input.
                    .frame(maxHeight: max(120, min(dynamicTypeSize.isAccessibilitySize ? .infinity : 360, geometry.size.height - 132)))
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier("task-backdate-scroll")
                    HStack {
                        Spacer()
                        Button(action: cancel) {
                            Text(model.label("common.cancel"))
                                .frame(minWidth: 48, minHeight: 48).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).foregroundStyle(palette.secondary)
                        .disabled(frozen).accessibilityIdentifier("task-backdate-cancel")
                        Button(action: confirm) {
                            Text(model.label("common.save"))
                                .frame(minWidth: 48, minHeight: 48).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).foregroundStyle(palette.tint)
                        .disabled(frozen).accessibilityIdentifier("task-backdate-confirm")
                    }
                }
                .padding(16).frame(maxWidth: 420)
                .background(palette.card, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(palette.border, lineWidth: 1)).padding(16)
            }
            .foregroundStyle(palette.text).frame(maxWidth: .infinity, maxHeight: .infinity)
            .accessibilityElement(children: .contain).accessibilityAddTraits(.isModal)
            .accessibilityAction(.escape) { cancel() }
        }
    }

    private var form: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(model.label("task.completedAtPromptTitle")).rnFont(18, .bold)
                .accessibilityAddTraits(.isHeader)
            DatePicker(model.label("task.completedAtPromptTitle"), selection: Binding(
                get: { date }, set: { next in
                    guard TaskDatePickerComponents.string(next, time: false) != TaskDatePickerComponents.string(date, time: false)
                        || TaskDatePickerComponents.string(next, time: true) != TaskDatePickerComponents.string(date, time: true) else { return }
                    date = next
                    dateChanged = true
                }), displayedComponents: [.date, .hourAndMinute])
                .datePickerStyle(.wheel).labelsHidden().tint(palette.tint)
                .accessibilityLabel(model.label("task.completedAtPromptTitle"))
                .accessibilityIdentifier("task-backdate-picker").disabled(frozen)
            if initial.showMinutes {
                Text(model.label("taskEdit.timeSpentLabel").uppercased()).rnFont(14)
                    .foregroundStyle(palette.secondary).accessibilityAddTraits(.isHeader)
                TextField(model.label("taskEdit.timeSpentPlaceholder"), text: $minutesText)
                    .rnFont(16).keyboardType(.numberPad).submitLabel(.done)
                    .padding(12).frame(minHeight: 44)
                    .background(palette.input, in: RoundedRectangle(cornerRadius: 10))
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.border, lineWidth: 1))
                    .accessibilityLabel(model.label("taskEdit.timeSpentLabel"))
                    .accessibilityIdentifier("task-backdate-minutes").disabled(frozen)
            }
            if attempted, let error = model.taskError {
                Text(error).rnFont(13).foregroundStyle(palette.danger).textSelection(.enabled)
                    .accessibilityIdentifier("task-backdate-error")
            }
        }
    }

    private func cancel() {
        guard !frozen else { return }
        _ = UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        close()
    }

    private func confirm() {
        guard !frozen else { return }
        _ = UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        confirming = true
        attempted = true
        let instant = dateChanged ? TaskDatePickerComponents.instantString(date) : initial.instant
        let text = initial.showMinutes ? minutesText : nil
        Task {
            if await model.editTaskBackdatedCompletion(instant, timeSpentText: text,
                                                       expectedID: initial.taskID, expectedSession: initial.session) { close() }
            else { confirming = false }
        }
    }
}

private struct TaskWaitingAssignmentDialog: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    let taskID: String
    let session: Int
    let beforeAction: () -> Void
    let close: () -> Void
    @State private var input: String
    @State private var suggestions: [CoreObject] = []
    @State private var readError: String?
    @State private var generation = 0
    @State private var open = true
    @State private var saving = false
    @FocusState private var focused: Bool
    private var frozen: Bool { model.busy || model.retryNeeded || saving }

    init(model: CoreModel, palette: AppPalette, initial: String, taskID: String, session: Int,
         beforeAction: @escaping () -> Void, close: @escaping () -> Void) {
        self.model = model
        self.palette = palette
        self.taskID = taskID
        self.session = session
        self.beforeAction = beforeAction
        self.close = close
        _input = State(initialValue: initial)
    }

    var body: some View {
        GeometryReader { geometry in
            ZStack {
                Color.black.opacity(0.35).ignoresSafeArea().onTapGesture { cancel() }.accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 12) {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 12) {
                            Text(model.label("process.waitingFor")).rnFont(18, .bold).accessibilityAddTraits(.isHeader)
                            Text(model.label("process.waitingForDesc")).rnFont(14).foregroundStyle(palette.secondary)
                            TextField(model.label("taskEdit.assignedToPlaceholder"), text: $input)
                                .rnFont(16).textInputAutocapitalization(.words).autocorrectionDisabled().submitLabel(.done)
                                .focused($focused).onSubmit(confirm)
                                .padding(12).frame(minHeight: 44)
                                .background(palette.input, in: RoundedRectangle(cornerRadius: 10))
                                .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.border, lineWidth: 1))
                                .accessibilityLabel(model.label("process.waitingFor"))
                                .accessibilityHint(model.label("process.waitingForDesc"))
                                .accessibilityIdentifier("task-waiting-assignment-input").disabled(frozen)
                            if !suggestions.isEmpty {
                                ForEach(suggestions.indices, id: \.self) { index in
                                    Button {
                                        input = suggestions[index].text("text")
                                    } label: {
                                        Text(suggestions[index].text("value")).rnFont(14)
                                            .frame(maxWidth: .infinity, alignment: .leading)
                                            .padding(.horizontal, 12).frame(minHeight: 44).contentShape(Rectangle())
                                    }
                                    .buttonStyle(.plain).foregroundStyle(palette.text).disabled(frozen)
                                    .accessibilityIdentifier("task-waiting-suggestion-" + suggestions[index].text("value"))
                                    if index < suggestions.count - 1 { Divider().overlay(palette.border) }
                                }
                            }
                            if let message = readError ?? model.taskError {
                                Text(message).rnFont(13).foregroundStyle(palette.danger).textSelection(.enabled)
                                    .accessibilityIdentifier("task-waiting-error")
                                if readError != nil {
                                    Button(model.label("common.retry")) { readSuggestions() }
                                        .buttonStyle(.plain).foregroundStyle(palette.tint).frame(minWidth: 44, minHeight: 44)
                                        .disabled(frozen).accessibilityIdentifier("task-waiting-retry")
                                }
                            }
                        }
                    }
                    .scrollDismissesKeyboard(.interactively)
                    .frame(maxHeight: geometry.size.height * 0.65)
                    .accessibilityIdentifier("task-waiting-scroll")
                    HStack {
                        Spacer()
                        Button(model.label("common.cancel"), action: cancel)
                            .buttonStyle(.plain).foregroundStyle(palette.secondary).frame(minWidth: 44, minHeight: 44)
                            .disabled(frozen).accessibilityIdentifier("task-waiting-cancel")
                        Button(model.label("common.save"), action: confirm)
                            .buttonStyle(.plain).foregroundStyle(palette.tint).frame(minWidth: 44, minHeight: 44)
                            .disabled(frozen).accessibilityIdentifier("task-waiting-confirm")
                    }
                }
                .padding(16).frame(maxWidth: 420, maxHeight: geometry.size.height * 0.9)
                .background(palette.card, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(palette.border, lineWidth: 1)).padding(16)
            }
            .foregroundStyle(palette.text).frame(maxWidth: .infinity, maxHeight: .infinity)
            .accessibilityElement(children: .contain).accessibilityAddTraits(.isModal)
            .accessibilityAction(.escape) { cancel() }
        }
        .onAppear { readSuggestions() }
        .onChange(of: input) { _ in readSuggestions() }
        .onDisappear { generation += 1; open = false }
    }

    private func readSuggestions() {
        generation += 1
        let requestedGeneration = generation
        let raw = input
        suggestions = []
        readError = nil
        Task {
            do {
                try await Task.sleep(nanoseconds: 150_000_000)
                guard open, generation == requestedGeneration, input == raw else { return }
                let result = try await model.taskWaitingSuggestions(raw, id: taskID, session: session)
                guard open, generation == requestedGeneration, input == raw else { return }
                suggestions = result.objects("matches")
            } catch {
                guard open, generation == requestedGeneration, input == raw, !(error is CancellationError) else { return }
                readError = error.localizedDescription
            }
        }
    }

    private func cancel() {
        guard !frozen else { return }
        _ = UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        generation += 1
        close()
    }

    private func confirm() {
        guard !frozen else { return }
        beforeAction()
        saving = true
        generation += 1
        let value = input
        Task {
            if await model.editTaskStatus("waiting", assignedTo: value,
                                          expectedID: taskID, expectedSession: session) { close() }
            else { saving = false }
        }
    }
}

private struct TaskMonthlyCustomDialog: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    let beforeAction: () -> Void
    let close: () -> Void
    @State private var custom: CoreObject
    @State private var intervalText: String
    private var frozen: Bool { model.busy || model.retryNeeded }
    private var days: [Int] { custom["monthDays"] as? [Int] ?? [] }
    private var weekdays: [CoreObject] { model.taskEditor.object("fields").object("recurrence").objects("weekdays") }

    init(model: CoreModel, palette: AppPalette, initial: CoreObject, beforeAction: @escaping () -> Void, close: @escaping () -> Void) {
        self.model = model
        self.palette = palette
        self.beforeAction = beforeAction
        self.close = close
        _custom = State(initialValue: initial)
        _intervalText = State(initialValue: String(initial.number("interval")))
    }

    var body: some View {
        GeometryReader { geometry in
            ZStack {
                Color.black.opacity(0.35).ignoresSafeArea().onTapGesture { cancel() }.accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 12) {
                    Text(model.label("recurrence.customTitle")).rnFont(18, .bold).accessibilityAddTraits(.isHeader)
                    ScrollView {
                        VStack(alignment: .leading, spacing: 12) {
                            interval
                            Text(model.label("recurrence.onLabel")).rnFont(14).foregroundStyle(palette.secondary)
                            AppChipFlow {
                                choice(monthDaysLabel, selected: custom.text("mode") == "date", id: "mode-date") { custom["mode"] = "date" }
                                choice(model.label("recurrence.lastDay"), selected: custom.text("mode") == "lastDay", id: "mode-lastDay") { custom["mode"] = "lastDay" }
                                choice(nthLabel, selected: custom.text("mode") == "nth", id: "mode-nth") { custom["mode"] = "nth" }
                            }
                            if custom.text("mode") == "date" { monthDays }
                            if custom.text("mode") == "nth" { nthWeekday }
                            if let error = model.taskError {
                                Text(error).rnFont(14).foregroundStyle(palette.danger).textSelection(.enabled)
                                    .accessibilityIdentifier("task-recurrence-custom-error")
                            }
                        }
                    }
                    .scrollDismissesKeyboard(.interactively)
                    AppChipFlow {
                        choice(model.label("common.cancel"), selected: false, id: "cancel") {
                            model.cancelTaskMonthlyCustom()
                            close()
                        }
                        choice(model.label("common.save"), selected: true, id: "apply") {
                            Task { if await model.applyTaskMonthlyCustom(custom, intervalText: intervalText) { close() } }
                        }
                    }
                }
                .padding(16).frame(maxWidth: 420, maxHeight: geometry.size.height * 0.9)
                .background(palette.card, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(palette.border, lineWidth: 1)).padding(16)
            }
            .foregroundStyle(palette.text).frame(maxWidth: .infinity, maxHeight: .infinity)
            .accessibilityElement(children: .contain).accessibilityAddTraits(.isModal)
            .accessibilityAction(.escape) { cancel() }
        }
    }

    private var interval: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(model.label("recurrence.repeatEvery")).rnFont(14).foregroundStyle(palette.secondary)
            TextField(model.label("recurrence.repeatEvery"), text: $intervalText)
                .rnFont(16).keyboardType(.numberPad).padding(12).frame(minHeight: 44)
                .background(palette.input, in: RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.border, lineWidth: 1))
                .accessibilityLabel(model.label("recurrence.repeatEvery")).accessibilityHint(model.label("recurrence.monthUnit"))
                .accessibilityIdentifier("task-recurrence-custom-interval").disabled(frozen)
            Text(model.label("recurrence.monthUnit")).rnFont(14).foregroundStyle(palette.secondary)
        }
    }

    private var monthDays: some View {
        AppChipFlow {
            ForEach(Array(1...31) + [-1], id: \.self) { day in
                choice(day == -1 ? model.label("recurrence.ordinal.last") : String(day), selected: days.contains(day), id: "day-" + String(day)) {
                    custom["monthDays"] = days.contains(day) ? days.filter { $0 != day } : (days + [day]).sorted()
                }
                .accessibilityLabel(day == -1 ? model.label("recurrence.lastDayOfMonth")
                    : model.label("recurrence.onDayOfMonth").replacingOccurrences(of: "{day}", with: String(day)))
            }
        }
    }

    private var nthWeekday: some View {
        VStack(alignment: .leading, spacing: 8) {
            AppChipFlow {
                ForEach(["1", "2", "3", "4", "-1"], id: \.self) { ordinal in
                    choice(ordinalLabel(ordinal), selected: custom.text("ordinal") == ordinal, id: "ordinal-" + ordinal) { custom["ordinal"] = ordinal }
                }
            }
            AppChipFlow {
                ForEach(weekdays.indices, id: \.self) { index in
                    let day = weekdays[index]
                    choice(day.text("label"), selected: custom.text("weekday") == day.text("day"), id: "weekday-" + day.text("day")) {
                        custom["weekday"] = day.text("day")
                    }
                    .accessibilityLabel(day.text("longLabel"))
                }
                choice(model.label("recurrence.weekdayMonFri"), selected: custom.text("weekday") == "WEEKDAY", id: "weekday-WEEKDAY") {
                    custom["weekday"] = "WEEKDAY"
                }
            }
        }
    }

    private func ordinalLabel(_ ordinal: String) -> String {
        model.label("recurrence.ordinal." + (["1": "first", "2": "second", "3": "third", "4": "fourth", "-1": "last"][ordinal] ?? "first"))
    }

    private var nthLabel: String {
        let weekday = custom.text("weekday") == "WEEKDAY" ? model.label("recurrence.weekdayMonFri")
            : weekdays.first(where: { $0.text("day") == custom.text("weekday") })?.text("longLabel") ?? custom.text("weekday")
        return model.label("recurrence.onNthWeekday").replacingOccurrences(of: "{ordinal}", with: ordinalLabel(custom.text("ordinal")))
            .replacingOccurrences(of: "{weekday}", with: weekday)
    }

    private var monthDaysLabel: String {
        let numbered = days.filter { $0 != -1 }.map(String.init).joined(separator: ", ")
        let label = model.label("recurrence.onDayOfMonth").replacingOccurrences(of: "{day}", with: numbered)
        guard days.contains(-1) else { return label }
        return numbered.isEmpty ? model.label("recurrence.lastDay") : label + " + " + model.label("recurrence.lastDay")
    }

    private func choice(_ title: String, selected: Bool, id: String, action: @escaping () -> Void) -> some View {
        Button { beforeAction(); action() } label: {
            Text(title).rnFont(14).fixedSize(horizontal: false, vertical: true)
                .foregroundStyle(selected ? palette.onTint : palette.secondary)
                .padding(.horizontal, 12).padding(.vertical, 10).frame(minWidth: 44, minHeight: 44)
                .background(selected ? palette.tint : palette.filter, in: RoundedRectangle(cornerRadius: 16))
                .overlay(RoundedRectangle(cornerRadius: 16).stroke(selected ? palette.tint : palette.border, lineWidth: 1))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(frozen).accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier("task-recurrence-custom-" + id)
    }

    private func cancel() {
        guard !frozen else { return }
        beforeAction()
        model.cancelTaskMonthlyCustom()
        close()
    }
}

private struct TaskTokenField: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    let field: String
    let beforeAction: () -> Void
    @FocusState private var focused: Bool
    private var label: String { model.strings.text(field == "assignedTo" ? "taskEdit.assignedTo" : "taskEdit." + field + "Label") }
    private var placeholder: String { model.strings.text("taskEdit." + field + "Placeholder") }
    private var current: Bool { model.taskTokenChoicesCurrent(field) }
    private var suggestions: CoreObject { model.taskTokenSuggestions[field] ?? [:] }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Image(systemName: field == "assignedTo" ? "person" : field == "contexts" ? "at" : "tag").font(.system(size: 16)).accessibilityHidden(true)
                Text(label.uppercased()).rnFont(14)
            }
            .foregroundStyle(palette.secondary).accessibilityAddTraits(.isHeader)
            TextField(placeholder, text: Binding(
                get: { model.taskTokenInputs[field] ?? "" },
                set: { model.setTaskTokenInput(field, text: $0) }))
                .rnFont(16).textInputAutocapitalization(field == "assignedTo" ? .words : .never).autocorrectionDisabled().submitLabel(.done)
                .focused($focused)
                .padding(12).frame(minHeight: 44).background(palette.input, in: RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.border, lineWidth: 1))
                .contentShape(Rectangle()).onTapGesture { focused = true }
                .onChange(of: focused) { model.taskTokenFocusChanged(field, focused: $0) }
                .onSubmit {
                    beforeAction()
                    model.commitTaskTokenInput(field)
                }
                .accessibilityLabel(label).accessibilityHint(placeholder)
                .accessibilityIdentifier("task-editor-" + field)
            if current && (!suggestions.objects("matches").isEmpty || field == "assignedTo" && model.taskPersonCreateCanSubmit) {
                let matches = suggestions.objects("matches")
                VStack(spacing: 0) {
                    if field == "assignedTo" && model.taskPersonCreateCanSubmit {
                        let name = (model.taskTokenInputs[field] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                        Button {
                            Task { await model.createTaskPerson() }
                        } label: {
                            Text("+ " + model.label("people.new") + " \"" + name + "\"").rnFont(14, .medium)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, 12).padding(.vertical, 10).frame(minHeight: 44).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).foregroundStyle(palette.tint)
                        .accessibilityLabel(model.label("people.new") + ": " + name)
                        .accessibilityIdentifier("task-assignedTo-create")
                        if !matches.isEmpty { Divider().overlay(palette.border) }
                    }
                    ForEach(matches.indices, id: \.self) { index in
                        Button {
                            model.chooseTaskToken(field, kind: "matches", value: matches[index].text("value"))
                        } label: {
                            Text(matches[index].text("value")).rnFont(14, .medium)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, 12).padding(.vertical, 10).frame(minHeight: 44).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).foregroundStyle(palette.text)
                        .accessibilityIdentifier("task-" + field + "-suggestion-" + matches[index].text("value"))
                        if index < matches.count - 1 { Divider().overlay(palette.border) }
                    }
                }
                .background(palette.card, in: RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.border, lineWidth: 1))
            }
            let quick = suggestions.objects("quick")
            if !quick.isEmpty {
                AppChipFlow {
                    ForEach(quick.indices, id: \.self) { index in
                        let token = quick[index]
                        let selected = token.flag("selected")
                        Button {
                            model.chooseTaskToken(field, kind: "quick", value: token.text("value"))
                        } label: {
                            Text(token.text("value")).rnFont(13, .medium)
                                .foregroundStyle(selected ? palette.onTint : palette.secondary)
                                .padding(.horizontal, 10).padding(.vertical, 10).frame(minWidth: 44, minHeight: 44)
                                .background(selected ? palette.tint : palette.filter, in: RoundedRectangle(cornerRadius: 14))
                                .overlay(RoundedRectangle(cornerRadius: 14).stroke(selected ? palette.tint : palette.border, lineWidth: 1))
                                .contentShape(RoundedRectangle(cornerRadius: 14))
                        }
                        .buttonStyle(.plain).disabled(!current)
                        .accessibilityAddTraits(selected ? .isSelected : [])
                        .accessibilityIdentifier("task-" + field + "-quick-" + token.text("value"))
                    }
                }
                .padding(.top, 2)
            }
            if let error = model.taskTokenErrors[field] {
                Text(error).rnFont(14).foregroundStyle(palette.danger).textSelection(.enabled)
                    .accessibilityIdentifier("task-" + field + "-error")
                Button {
                    beforeAction()
                    model.retryTaskToken(field)
                } label: {
                    Text(model.strings.text("common.retry")).rnFont(14, .semibold)
                        .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain).foregroundStyle(palette.tint).disabled(model.busy || model.retryNeeded)
                .accessibilityIdentifier("task-" + field + "-retry")
            }
            if field == "assignedTo", let error = model.taskPersonCreateReadError {
                Text(error).rnFont(14).foregroundStyle(palette.danger).textSelection(.enabled)
                    .accessibilityIdentifier("task-assignedTo-create-error")
                if model.taskPersonCreateCanRetryRead {
                    Button(model.label("common.retry")) {
                        Task { await model.retryTaskPersonCreateRead() }
                    }
                    .buttonStyle(.plain).foregroundStyle(palette.tint).frame(minWidth: 44, minHeight: 44)
                    .accessibilityIdentifier("task-assignedTo-create-retry")
                }
            }
        }
    }
}

private struct TaskDestinationPicker: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    let beforeAction: () -> Void
    @FocusState private var queryFocused: Bool
    private var section: Bool { model.taskDestinationKind == "section" }
    private var prefix: String { section ? "task-section" : "task-destination" }
    private var field: CoreObject { model.taskDestination.object(section ? "section" : "destination") }
    private var frozen: Bool { model.busy || model.retryNeeded }

    var body: some View {
        GeometryReader { geometry in
            ZStack {
                Color.black.opacity(0.4).ignoresSafeArea().accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 0) {
                    Text(field.text("label")).rnFont(16, .bold).padding(.bottom, 12).accessibilityAddTraits(.isHeader)
                    TextField(model.label("common.search"), text: Binding(
                        get: { model.taskDestinationQuery }, set: { model.setTaskDestinationQuery($0) }))
                        .rnFont(16).textInputAutocapitalization(.never).autocorrectionDisabled().submitLabel(.done)
                        .focused($queryFocused).onSubmit { endInput() }
                        .padding(.horizontal, 12).padding(.vertical, 10).frame(minHeight: 44)
                        .background(palette.input, in: RoundedRectangle(cornerRadius: 10))
                        .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.border, lineWidth: 1))
                        .disabled(frozen).accessibilityLabel(field.text("label"))
                        .accessibilityHint(model.label("common.search")).accessibilityIdentifier(prefix + "-query")
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            if let error = model.taskDestinationError {
                                Text(error).rnFont(13).foregroundStyle(palette.danger).textSelection(.enabled)
                                    .padding(14).accessibilityIdentifier(prefix + "-error")
                                Button {
                                    endInput()
                                    model.retryTaskDestination()
                                } label: {
                                    Text(model.label("common.retry")).rnFont(14, .semibold)
                                        .padding(.horizontal, 14).frame(minHeight: 44).contentShape(Rectangle())
                                }
                                .buttonStyle(.plain).foregroundStyle(palette.tint).disabled(frozen)
                                .accessibilityIdentifier(prefix + "-retry")
                            }
                            if model.taskDestinationCurrent {
                                if section {
                                    ForEach(field.objects("choices").map { TaskDestinationChoice(value: $0, kind: "section") }) { entry in
                                        choice(entry.value, kind: entry.kind, groupLabel: "")
                                    }
                                } else {
                                    ForEach(field.objects("groups").indices, id: \.self) { index in
                                        let group = field.objects("groups")[index]
                                        if !group.text("label").isEmpty {
                                            Text(group.text("label")).rnFont(16, .bold).foregroundStyle(palette.secondary)
                                                .padding(.horizontal, 14).padding(.vertical, 10).accessibilityAddTraits(.isHeader)
                                        }
                                        ForEach(group.objects("choices").map { TaskDestinationChoice(value: $0, kind: group.text("kind")) }) { entry in
                                            choice(entry.value, kind: entry.kind, groupLabel: group.text("label"))
                                        }
                                    }
                                }
                                if !field.text("emptyLabel").isEmpty { noMatches }
                            } else if model.taskDestinationError == nil {
                                ProgressView(model.label("common.loading")).tint(palette.tint)
                                    .frame(maxWidth: .infinity, minHeight: 44).padding(14)
                            }
                        }
                        .padding(.vertical, 4)
                    }
                    .scrollDismissesKeyboard(.interactively)
                    .frame(maxHeight: min(260, geometry.size.height * 0.48))
                    .background(palette.input, in: RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(palette.border, lineWidth: 1)).padding(.top, 12)
                    HStack {
                        Spacer()
                        Button {
                            endInput()
                            model.closeTaskDestination()
                        } label: {
                            Text(model.label("common.cancel")).rnFont(14, .bold).padding(.horizontal, 10).frame(minHeight: 44)
                        }
                        .buttonStyle(.plain).foregroundStyle(palette.secondary).disabled(frozen)
                        .accessibilityIdentifier(prefix + "-close")
                    }
                    .padding(.top, 14)
                }
                .padding(16).frame(maxWidth: 420, maxHeight: geometry.size.height * 0.9)
                .fixedSize(horizontal: false, vertical: true)
                .background(palette.card, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(palette.border, lineWidth: 1)).padding(16)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .foregroundStyle(palette.text)
            .accessibilityElement(children: .contain).accessibilityAddTraits(.isModal)
            .accessibilityAction(.escape) {
                guard !frozen else { return }
                endInput()
                model.closeTaskDestination()
            }
        }
    }

    private func choice(_ value: CoreObject, kind: String, groupLabel: String) -> some View {
        let id = value.text("id")
        return Button {
            endInput()
            Task { await model.selectTaskDestination(kind: kind, id: id) }
        } label: {
            Text(value.text("label")).rnFont(16).frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 14).padding(.vertical, 10).frame(minHeight: 44).contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(!model.taskDestinationActionsEnabled)
        .accessibilityLabel(groupLabel.isEmpty ? value.text("label") : groupLabel + ": " + value.text("label"))
        .accessibilityAddTraits(value.flag("selected") ? .isSelected : [])
        .accessibilityIdentifier(prefix + "-choice-" + (section ? "" : kind + "-") + (id.isEmpty ? "none" : id))
    }

    private var noMatches: some View {
        Text(field.text("emptyLabel")).rnFont(16).foregroundStyle(palette.secondary).padding(14)
            .accessibilityIdentifier(prefix + "-empty")
    }

    private func endInput() {
        beforeAction()
        queryFocused = false
    }
}

private struct TaskDestinationChoice: Identifiable {
    let value: CoreObject
    let kind: String
    // Lazy stacks flatten nested ForEach children; group-local indices collide.
    var id: String { kind + "-" + value.text("id") }
}

private final class TaskActivityItem: NSObject, UIActivityItemSource {
    let payload: TaskSharePayload
    init(_ payload: TaskSharePayload) { self.payload = payload }
    func activityViewControllerLinkMetadata(_ activityViewController: UIActivityViewController) -> LPLinkMetadata? {
        let metadata = LPLinkMetadata()
        metadata.title = payload.title ?? payload.message
        return metadata
    }
    func activityViewControllerPlaceholderItem(_ activityViewController: UIActivityViewController) -> Any { payload.message }
    func activityViewController(_ activityViewController: UIActivityViewController, itemForActivityType activityType: UIActivity.ActivityType?) -> Any? { payload.message }
    func activityViewController(_ activityViewController: UIActivityViewController, subjectForActivityType activityType: UIActivity.ActivityType?) -> String { payload.title ?? "" }
}

private struct TaskActivitySheet: UIViewControllerRepresentable {
    let payload: TaskSharePayload
    func makeUIViewController(context: Context) -> UIActivityViewController {
        let controller = UIActivityViewController(activityItems: [TaskActivityItem(payload)], applicationActivities: nil)
        NSLog("Native iOS Task share sheet opened releaseCheck=v1.3.4/ios-task-share outcome=presented")
        return controller
    }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

struct AttachmentFileActivitySheet: UIViewControllerRepresentable {
    let presentation: AttachmentFileOpenPresentation
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: [presentation.url], applicationActivities: nil)
    }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

private struct TaskAttachmentAudioSheet: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    let presentationID: UUID

    private var playback: TaskAudioPlaybackState? {
        guard model.taskAudioPlayback?.presentationID == presentationID else { return nil }
        return model.taskAudioPlayback
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                Text(playback?.title ?? model.label("quickAdd.audioNoteTitle"))
                    .rnFont(20, .bold).fixedSize(horizontal: false, vertical: true)
                    .multilineTextAlignment(.center).accessibilityAddTraits(.isHeader)
                    .accessibilityIdentifier("task-audio-title")
                Text(playback.map { audioTime($0.elapsed) + " / " + audioTime($0.duration) }
                    ?? model.label("audio.loading"))
                    .rnFont(16).monospacedDigit().foregroundStyle(palette.secondary)
                    .accessibilityIdentifier("task-audio-time")
                Button {
                    model.toggleTaskAudioPlayback(presentationID: presentationID)
                } label: {
                    Text(model.label(playback?.playing == true ? "common.pause" : "common.play"))
                        .rnFont(16, .semibold).frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.bordered).disabled(playback?.canToggle != true)
                .accessibilityIdentifier("task-audio-toggle")
                Button {
                    model.dismissTaskFileOpen(presentationID: presentationID)
                } label: {
                    Text(model.label("common.close"))
                        .rnFont(16, .semibold).frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.bordered).accessibilityIdentifier("task-audio-close")
            }
            .padding(24).frame(maxWidth: .infinity)
        }
        .foregroundStyle(palette.text).background(palette.card).tint(palette.tint)
        .accessibilityElement(children: .contain).accessibilityIdentifier("task-audio-player")
    }

    private func audioTime(_ value: TimeInterval) -> String {
        let seconds = value.isFinite ? Int(min(Double(Int.max / 2), max(0, value))) : 0
        return String(seconds / 60) + ":" + String(format: "%02d", seconds % 60)
    }
}

struct AttachmentFileQuickLookSheet: UIViewControllerRepresentable {
    let presentation: AttachmentFileOpenPresentation

    func makeCoordinator() -> Coordinator { Coordinator(url: presentation.url) }
    func makeUIViewController(context: Context) -> QLPreviewController {
        let controller = QLPreviewController()
        controller.dataSource = context.coordinator
        return controller
    }
    func updateUIViewController(_ controller: QLPreviewController, context: Context) {}

    final class Coordinator: NSObject, QLPreviewControllerDataSource {
        let url: URL
        init(url: URL) { self.url = url }
        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
        func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
            url as NSURL
        }
    }
}
