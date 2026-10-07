import SwiftUI
import UIKit

private struct ProjectDetailDisplayItem: Identifiable {
    let value: CoreObject

    var id: String {
        if value.text("type") == "task" { return "task:" + value.object("row").text("id") }
        return "section:" + value.text("id")
    }
}

struct ProjectsScreen: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    @FocusState private var titleFocused: Bool

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                if model.projectFileAddRecoveryVisible {
                    ProjectFileAddRecoveryPanel(model: model, palette: palette)
                        .padding(16)
                }
                controls
                LazyVStack(alignment: .leading, spacing: 0) {
                    if ["active", "deferred", "archived"].allSatisfy({ model.projects.objects($0).isEmpty }) {
                        Text(model.label("projects.empty")).rnFont(16).foregroundStyle(palette.secondary)
                            .frame(maxWidth: .infinity).padding(48).accessibilityIdentifier("projects-empty")
                    }
                    projectSection("active", title: model.label("projects.activeSection"))
                    projectSection("deferred", title: model.label("projects.deferredSection"))
                    projectSection("archived", title: model.label("projects.closed"))
                    if model.busy { ProgressView().frame(maxWidth: .infinity).padding(12) }
                }
                .padding(.horizontal, 16).padding(.bottom, 16)
            }
        }
        .accessibilityIdentifier("projects-scroll")
        .refreshable { await model.refresh() }
        .sheet(isPresented: Binding(
            get: { model.areaManagerPresented && model.areaManagerProjectID == nil },
            set: { if !$0 && !model.appLock.concealed { model.closeAreaManager() } }
        )) {
            AreaManagerSheet(model: model, palette: palette)
                .presentationDetents([.medium, .large])
                .interactiveDismissDisabled(!model.areaManagerCloseEnabled)
        }
    }

    private var controls: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                TextField(model.label("projects.addPlaceholder"), text: Binding(
                    get: { model.projectCreateTitle },
                    set: { model.setProjectCreateTitle($0) }))
                    .focused($titleFocused).submitLabel(.done).onSubmit { submitProject() }
                    .rnFont(16).padding(.horizontal, 12).frame(minHeight: 46)
                    .background(palette.input, in: RoundedRectangle(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(palette.border, lineWidth: 1))
                    .disabled(model.retryNeeded)
                    .accessibilityLabel(model.label("projects.addPlaceholder"))
                    .accessibilityIdentifier("projects-create-title")
                Button { submitProject() } label: {
                    AppIcon(name: "plus", size: 22).foregroundStyle(palette.onTint)
                        .frame(width: 46, height: 46).background(palette.tint, in: RoundedRectangle(cornerRadius: 8))
                }
                .buttonStyle(.plain).disabled(!model.projectCreateCanSubmit)
                .opacity(model.projectCreateCanSubmit ? 1 : 0.5)
                .accessibilityLabel(model.label("projects.add"))
                .accessibilityIdentifier("projects-create-add")
            }
            if !model.projectCreateTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
               !model.projectCreateOptions.objects("areas").isEmpty {
                let areas = model.projectCreateOptions.objects("areas")
                AppChipFlow {
                    createAreaChip(id: nil, label: model.projectCreateOptions.text("noAreaLabel"), color: nil)
                    ForEach(areas.indices, id: \.self) { index in
                        let area = areas[index]
                        createAreaChip(id: area.text("id"), label: area.text("label"), color: area.text("color"))
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 10).padding(.bottom, 12)
            }
            if let message = model.projectCreateError {
                Text(message).rnFont(13).foregroundStyle(palette.danger).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 8).accessibilityIdentifier("projects-create-error")
                if model.projectCreatePending && model.retryNeeded {
                    Button { Task { await model.retry() } } label: {
                        Text(model.label("common.retry")).rnFont(14, .semibold)
                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).disabled(model.busy).accessibilityIdentifier("projects-create-retry")
                }
            }
            if let message = model.projectCreateReadError {
                Text(message).rnFont(13).foregroundStyle(palette.danger).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 8).accessibilityIdentifier("projects-create-read-error")
                Button { Task { await model.retryProjectCreateRead() } } label: {
                    Text(model.label("common.retry")).rnFont(14, .semibold)
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(model.busy || model.retryNeeded)
                    .accessibilityIdentifier("projects-create-read-retry")
            }
            if let message = model.projectFocusError {
                Text(message).rnFont(13).foregroundStyle(palette.danger).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 8).accessibilityIdentifier("project-focus-error")
                if model.projectFocusPending && model.retryNeeded {
                    Button { Task { await model.retry() } } label: {
                        Text(model.label("common.retry")).rnFont(14, .semibold)
                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).disabled(model.busy).accessibilityIdentifier("project-focus-retry")
                }
            }
            if let message = model.projectFocusReadError {
                Text(message).rnFont(13).foregroundStyle(palette.danger).textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 8).accessibilityIdentifier("project-focus-read-error")
                Button { Task { await model.retryProjectFocusRead() } } label: {
                    Text(model.label("common.retry")).rnFont(14, .semibold)
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(model.busy || model.retryNeeded)
                    .accessibilityIdentifier("project-focus-read-retry")
            }
            if model.error != nil && model.projectCreateError == nil && model.projectCreateReadError == nil
                && model.projectFocusError == nil && model.projectFocusReadError == nil {
                FailureBanner(model: model, palette: palette)
            }
            HStack(spacing: 12) {
                Button {
                    resignProjectCreateInput()
                    model.toggleProjectTagFilter()
                } label: {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(projectTagFilterHeading).rnFont(12, .semibold)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 0)
                        Text(model.label(model.projectTagFilterShown ? "filters.hide" : "filters.show"))
                            .rnFont(12, .semibold).foregroundStyle(palette.secondary)
                    }
                    .frame(minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(!model.projectTagFilterInputEnabled)
                    .accessibilityIdentifier("projects-tag-filter-toggle")
                Button(model.label("areas.manage")) { Task { await model.openAreaManager() } }
                    .rnFont(12, .semibold).padding(.horizontal, 8).frame(minHeight: 44)
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(palette.border, lineWidth: 1))
                    .buttonStyle(.plain).disabled(!model.projectCreateInputEnabled)
                    .accessibilityIdentifier("projects-manage-areas")
            }
            if model.projectTagFilterShown {
                let tags = model.projectTagValues
                AppChipFlow {
                    projectTagChip("__all__", label: model.label("projects.allTags"), id: "projects-tag-filter-all")
                    ForEach(tags.indices, id: \.self) { index in
                        projectTagChip(tags[index], label: tags[index].isEmpty ? model.label("projects.emptyTag") : tags[index],
                                       id: "projects-tag-filter-\(index)")
                    }
                    if model.projectTagHasUntagged {
                        projectTagChip("__none__", label: model.label("projects.noTags"), id: "projects-tag-filter-none")
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 8).padding(.bottom, 12)
            }
        }
        .padding(.horizontal, 16).padding(.top, 16)
        .overlay(alignment: .bottom) { palette.border.frame(height: 1) }
    }

    private func createAreaChip(id: String?, label: String, color: String?) -> some View {
        let selected = model.projectCreateAreaID == id
        return Button { model.selectProjectCreateArea(id) } label: {
            HStack(spacing: 6) {
                if let color, !color.isEmpty {
                    Circle().fill(Color(hex: color)).frame(width: 8, height: 8)
                        .overlay(Circle().stroke(palette.border, lineWidth: 1)).accessibilityHidden(true)
                }
                Text(label).rnFont(14, selected ? .semibold : .regular)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .foregroundStyle(selected ? palette.onTint : palette.text)
            .padding(.horizontal, 12).frame(minHeight: 44)
            .background(selected ? palette.tint : palette.card, in: Capsule())
            .overlay(Capsule().stroke(selected ? palette.tint : palette.border, lineWidth: 1))
        }
        .buttonStyle(.plain).disabled(!model.projectCreateInputEnabled)
        .accessibilityLabel(label).accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier("projects-create-area-" + (id ?? "none"))
    }

    private var projectTagFilterHeading: String {
        let title = model.label("projects.tagFilter")
        if model.projectTagIsSelected("__all__") { return title }
        let selected = model.projectTagIsSelected("__none__") ? model.label("projects.noTags")
            : model.selectedProjectTagFilter.isEmpty ? model.label("projects.emptyTag") : model.selectedProjectTagFilter
        return title + ": " + selected
    }

    private func projectTagChip(_ value: String, label: String, id: String) -> some View {
        let selected = model.projectTagIsSelected(value)
        return Button {
            resignProjectCreateInput()
            Task { await model.selectProjectTagFilter(value) }
        } label: {
            Text(label).rnFont(14, selected ? .semibold : .regular)
                .fixedSize(horizontal: false, vertical: true)
                .foregroundStyle(selected ? palette.onTint : palette.text)
                .padding(.horizontal, 12).frame(minWidth: 44, minHeight: 44)
                .background(selected ? palette.tint : palette.card, in: Capsule())
                .overlay(Capsule().stroke(selected ? palette.tint : palette.border, lineWidth: 1))
        }
        .buttonStyle(.plain).disabled(!model.projectTagFilterInputEnabled)
        .accessibilityLabel(label).accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier(id)
    }

    private func resignProjectCreateInput() {
        titleFocused = false
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    }

    private func submitProject() {
        resignProjectCreateInput()
        guard model.beginProjectCreate() else { return }
        Task { await model.addProject() }
    }

    @ViewBuilder private func projectSection(_ key: String, title: String) -> some View {
        let groups = model.projects.objects(key)
        if !groups.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                if key == "active" {
                    Text(title.uppercased()).rnFont(12, .bold).tracking(0.4).foregroundStyle(palette.secondary)
                        .padding(.top, 8).padding(.bottom, 8).accessibilityAddTraits(.isHeader)
                } else {
                    Button {
                        if model.expandedProjectSections.contains(key) { model.expandedProjectSections.remove(key) }
                        else { model.expandedProjectSections.insert(key) }
                    } label: {
                        HStack {
                            Text(title.uppercased()).rnFont(12, .bold).tracking(0.4)
                            Spacer()
                            AppIcon(name: "chevron", size: 16)
                                .rotationEffect(.degrees(model.expandedProjectSections.contains(key) ? 0 : -90))
                        }
                        .foregroundStyle(palette.secondary).frame(minHeight: 44).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).disabled(model.busy || model.retryNeeded)
                    .padding(.top, 6).overlay(alignment: .top) { palette.border.frame(height: 1) }
                    .accessibilityValue(model.label(model.expandedProjectSections.contains(key) ? "markdown.collapse" : "markdown.expand"))
                    .accessibilityIdentifier("projects-section-" + key)
                }
                if key == "active" || model.expandedProjectSections.contains(key) {
                    ForEach(groups.indices, id: \.self) { index in areaGroup(groups[index], section: key) }
                }
            }
        }
    }

    private func areaGroup(_ group: CoreObject, section: String) -> some View {
        let id = group.text("areaId").isEmpty ? "no-area" : group.text("areaId")
        let collapsed = model.collapsedProjectAreas.contains(id)
        return VStack(spacing: 0) {
            Button {
                if collapsed { model.collapsedProjectAreas.remove(id) }
                else { model.collapsedProjectAreas.insert(id) }
            } label: {
                HStack(spacing: 8) {
                    if !group.text("areaIcon").isEmpty {
                        Text(group.text("areaIcon")).rnFont(14).accessibilityHidden(true)
                    } else if !group.text("areaColor").isEmpty {
                        Circle().fill(Color(hex: group.text("areaColor"))).frame(width: 8, height: 8)
                            .overlay(Circle().stroke(palette.border, lineWidth: 1)).accessibilityHidden(true)
                    }
                    Text((group.text("areaName").isEmpty ? model.label("projects.noArea") : group.text("areaName")).uppercased())
                        .rnFont(12, .bold).tracking(0.4).frame(maxWidth: .infinity, alignment: .leading)
                    AppIcon(name: "chevron", size: 16).rotationEffect(.degrees(collapsed ? -90 : 0))
                }
                .foregroundStyle(palette.secondary).frame(minHeight: 44).contentShape(Rectangle())
            }
            .buttonStyle(.plain).disabled(model.busy || model.retryNeeded)
            .accessibilityValue(model.label(collapsed ? "markdown.expand" : "markdown.collapse"))
            .accessibilityIdentifier("project-area-" + section + "-" + id)
            if !collapsed {
                let rows = group.objects("projects")
                ForEach(rows.indices, id: \.self) { index in projectRow(rows[index]) }
            }
        }
        .padding(.bottom, 12)
    }

    private func projectRow(_ row: CoreObject) -> some View {
        HStack(spacing: 8) {
            Button { Task { await model.openProject(row) } } label: {
                VStack(alignment: .leading, spacing: 4) {
                    Text(row.text("title")).rnFont(16, .medium).foregroundStyle(palette.text)
                    if !row.text("nextActionTitle").isEmpty {
                        Text("↳ " + row.text("nextActionTitle")).rnFont(12).foregroundStyle(palette.secondary)
                    } else if row.flag("focusedWithoutNextAction") {
                        HStack(spacing: 4) {
                            Image(systemName: "exclamationmark.triangle").font(.system(size: 12)).accessibilityHidden(true)
                            Text(model.label("projects.noNextAction")).rnFont(12)
                        }
                        .foregroundStyle(Color(hex: "F59E0B"))
                    } else {
                        Text(row.text("statusLabel")).rnFont(12).foregroundStyle(statusColor(row.text("status")))
                    }
                }
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(Rectangle())
            }
            .buttonStyle(.plain).disabled(model.busy || model.retryNeeded)
            .accessibilityIdentifier("project-open-" + row.text("id"))
            Text(String(row.number("activeTaskCount"))).rnFont(12, .semibold).foregroundStyle(palette.secondary)
                .frame(minWidth: 20).accessibilityLabel(String(row.number("activeTaskCount")) + " " + model.label("common.tasks"))
            Button { Task { await model.setProjectFocus(row) } } label: {
                AppFocusStar(focused: row.flag("isFocused"), disabled: row.flag("focusDisabled"),
                             inactiveColor: palette.secondary, size: 18)
                    .frame(width: 44, height: 44).contentShape(Rectangle())
            }
            .buttonStyle(.plain).disabled(!model.projectFocusInputEnabled || row.flag("focusDisabled"))
            .accessibilityLabel(model.label(row.flag("isFocused") ? "projects.removeFromFocus" : "projects.addToFocus"))
            .accessibilityAddTraits(row.flag("isFocused") ? .isSelected : [])
            .accessibilityIdentifier("project-focus-" + row.text("id"))
        }
        .padding(.horizontal, 12).padding(.vertical, 8).background(palette.card, in: RoundedRectangle(cornerRadius: 8))
        .padding(.bottom, 6)
    }

    private func statusColor(_ status: String) -> Color {
        // RN buildProjectStatusPalette presentation swatches, not task eligibility.
        switch status {
        case "active": return palette.tint
        case "waiting": return Color(hex: "F59E0B")
        case "someday": return Color(hex: "A855F7")
        default: return palette.secondary
        }
    }
}

private struct AreaManagerSheet: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    @FocusState private var nameFocused: Bool
    @FocusState private var renameFocused: Bool

    private var areas: [CoreObject] { model.areaManagerAreas }
    private var colors: [String] { model.areaCreateOptions["colors"] as? [String] ?? [] }
    private var areaColors: [String] { model.areaColorOptions["colors"] as? [String] ?? [] }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Text(model.label("areas.manage")).rnFont(20, .bold)
                    .frame(maxWidth: .infinity, alignment: .leading).accessibilityAddTraits(.isHeader)
                Button { model.closeAreaManager() } label: {
                    Image(systemName: "xmark").font(.system(size: 17, weight: .semibold))
                        .frame(width: 44, height: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(!model.areaManagerCloseEnabled)
                .accessibilityLabel(model.label("common.close"))
                .accessibilityIdentifier("area-manager-close")
            }
            .padding(.horizontal, 20).padding(.vertical, 8)
            .background(palette.card)
            .overlay(alignment: .bottom) { palette.border.frame(height: 1) }
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    HStack(spacing: 12) {
                        Button { submitAreaOrder("sortName") } label: {
                            Text(model.label("projects.sortByName"))
                                .frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle())
                        }
                        .accessibilityIdentifier("area-order-sort-name")
                        Button { submitAreaOrder("sortColor") } label: {
                            Text(model.label("projects.sortByColor"))
                                .frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle())
                        }
                        .accessibilityIdentifier("area-order-sort-color")
                    }
                    .buttonStyle(.plain).rnFont(14, .semibold).foregroundStyle(palette.tint)
                    .disabled(!model.areaOrderInputEnabled || areas.isEmpty)
                    if areas.isEmpty {
                        Text(model.label("projects.noArea")).rnFont(14).foregroundStyle(palette.secondary)
                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    } else {
                        VStack(spacing: 0) {
                            ForEach(areas.indices, id: \.self) { index in
                                let area = areas[index]
                                let canDelete = area.flag("canDelete")
                                let deleteDecisionAvailable = area["canDelete"] is Bool
                                VStack(spacing: 0) {
                                    HStack(spacing: 4) {
                                        Button { model.toggleAreaColorPicker(area.text("id")) } label: {
                                            Circle().fill(area.text("color").isEmpty
                                                ? palette.tint : Color(hex: area.text("color")))
                                                .frame(width: 18, height: 18)
                                                .frame(width: 44, height: 44).contentShape(Rectangle())
                                        }
                                        .buttonStyle(.plain).disabled(!model.areaColorInputEnabled)
                                        .accessibilityLabel("\(model.label("projects.changeColor")): \(area.text("name"))")
                                        .accessibilityIdentifier("area-color-open-" + area.text("id"))
                                        Button {
                                            model.openAreaRename(area.text("id"))
                                        } label: {
                                            Text(area.text("name")).rnFont(15)
                                                .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                                                .contentShape(Rectangle())
                                        }
                                        .buttonStyle(.plain).disabled(!model.areaRenameOpenEnabled)
                                        .accessibilityLabel("\(model.label("common.rename")): \(area.text("name"))")
                                        .accessibilityIdentifier("area-rename-open-" + area.text("id"))
                                        Button { submitAreaOrder("moveUp", areaID: area.text("id")) } label: {
                                            Image(systemName: "arrow.up").font(.system(size: 17, weight: .semibold))
                                                .frame(width: 44, height: 44).contentShape(Rectangle())
                                        }
                                        .buttonStyle(.plain)
                                        .disabled(index == 0 || !model.areaOrderInputEnabled)
                                        .accessibilityLabel("\(model.label("projects.moveUp")): \(area.text("name"))")
                                        .accessibilityIdentifier("area-order-up-" + area.text("id"))
                                        Button { submitAreaDelete(area.text("id")) } label: {
                                            Text(model.label("common.delete")).rnFont(14, .semibold)
                                                .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                                        }
                                        .buttonStyle(.plain)
                                        .foregroundStyle(canDelete ? palette.danger : palette.secondary)
                                        .disabled(!canDelete || !model.areaDeleteInputEnabled)
                                        .accessibilityLabel("\(model.label("common.delete")): \(area.text("name"))")
                                        .accessibilityHint(deleteDecisionAvailable && !canDelete
                                            ? model.label("projects.areaInUse") : "")
                                        .accessibilityIdentifier("area-delete-" + area.text("id"))
                                    }
                                    .frame(minHeight: 44)
                                    if model.areaRenameEditingID == area.text("id") {
                                        areaRenameForm
                                    }
                                    if model.expandedAreaColorID == area.text("id") {
                                        LazyVGrid(columns: [GridItem(.adaptive(minimum: 44), spacing: 10)], spacing: 10) {
                                            Button { submitAreaColor(area.text("id"), color: nil) } label: {
                                                Image(systemName: "slash.circle").font(.system(size: 22))
                                                    .foregroundStyle(palette.secondary)
                                                    .frame(width: 44, height: 44)
                                                    .overlay(Circle().stroke(colorSelected(area, nil) ? palette.tint : palette.border,
                                                                             lineWidth: colorSelected(area, nil) ? 3 : 1))
                                                    .contentShape(Rectangle())
                                            }
                                            .buttonStyle(.plain).disabled(!model.areaColorInputEnabled)
                                            .accessibilityLabel(model.label("projects.colorNone"))
                                            .accessibilityAddTraits(colorSelected(area, nil) ? .isSelected : [])
                                            .accessibilityIdentifier("area-color-" + area.text("id") + "-none")
                                            ForEach(areaColors, id: \.self) { color in
                                                Button { submitAreaColor(area.text("id"), color: color) } label: {
                                                    Circle().fill(Color(hex: color)).frame(width: 34, height: 34)
                                                        .frame(width: 44, height: 44)
                                                        .overlay(Circle().stroke(colorSelected(area, color) ? palette.tint : palette.border,
                                                                                 lineWidth: colorSelected(area, color) ? 3 : 1))
                                                        .contentShape(Rectangle())
                                                }
                                                .buttonStyle(.plain).disabled(!model.areaColorInputEnabled)
                                                .accessibilityLabel(color)
                                                .accessibilityAddTraits(colorSelected(area, color) ? .isSelected : [])
                                                .accessibilityIdentifier("area-color-" + area.text("id") + "-" + color)
                                            }
                                        }
                                        .padding(.bottom, 10)
                                    }
                                }
                                if index < areas.count - 1 { palette.border.frame(height: 1) }
                            }
                        }
                        .padding(.horizontal, 14).background(palette.card, in: RoundedRectangle(cornerRadius: 10))
                        .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.border, lineWidth: 1))
                    }
                    if let editingID = model.areaRenameEditingID,
                       !areas.contains(where: { $0.text("id") == editingID }) {
                        areaRenameForm
                    }
                    if let message = model.areaColorError {
                        Text(message).rnFont(13).foregroundStyle(palette.danger).textSelection(.enabled)
                            .accessibilityIdentifier("area-color-error")
                        if model.areaColorPending && model.retryNeeded {
                            Button { Task { await model.retry() } } label: {
                                Text(model.label("common.retry")).rnFont(14, .semibold)
                                    .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                            }
                            .disabled(model.busy).accessibilityIdentifier("area-color-retry")
                        }
                    }
                    if let message = model.areaColorReadError {
                        Text(message).rnFont(13).foregroundStyle(palette.danger).textSelection(.enabled)
                            .accessibilityIdentifier("area-color-read-error")
                        Button { Task { await model.retryAreaColorRead() } } label: {
                            Text(model.label("common.retry")).rnFont(14, .semibold)
                                .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                        }
                            .disabled(model.busy || model.retryNeeded)
                            .accessibilityIdentifier("area-color-read-retry")
                    }
                    if let message = model.areaOrderError {
                        Text(message).rnFont(13).foregroundStyle(palette.danger).textSelection(.enabled)
                            .accessibilityIdentifier("area-order-error")
                        if model.areaOrderPending && model.retryNeeded {
                            Button { Task { await model.retry() } } label: {
                                Text(model.label("common.retry")).rnFont(14, .semibold)
                                    .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                            }
                            .disabled(model.busy).accessibilityIdentifier("area-order-retry")
                        }
                    }
                    if let message = model.areaOrderReadError {
                        Text(message).rnFont(13).foregroundStyle(palette.danger).textSelection(.enabled)
                            .accessibilityIdentifier("area-order-read-error")
                        Button { Task { await model.retryAreaOrderRead() } } label: {
                            Text(model.label("common.retry")).rnFont(14, .semibold)
                                .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                        }
                        .disabled(model.busy || model.retryNeeded)
                        .accessibilityIdentifier("area-order-read-retry")
                    }
                    if let message = model.areaDeleteError {
                        Text(message).rnFont(13).foregroundStyle(palette.danger).textSelection(.enabled)
                            .accessibilityIdentifier("area-delete-error")
                        if model.areaDeletePending && model.retryNeeded {
                            Button { Task { await model.retry() } } label: {
                                Text(model.label("common.retry")).rnFont(14, .semibold)
                                    .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                            }
                            .disabled(model.busy).accessibilityIdentifier("area-delete-retry")
                        }
                    }
                    if let message = model.areaDeleteReadError {
                        Text(message).rnFont(13).foregroundStyle(palette.danger).textSelection(.enabled)
                            .accessibilityIdentifier("area-delete-read-error")
                        Button { Task { await model.retryAreaDeleteRead() } } label: {
                            Text(model.label("common.retry")).rnFont(14, .semibold)
                                .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                        }
                        .disabled(model.busy || model.retryNeeded)
                        .accessibilityIdentifier("area-delete-read-retry")
                    }
                    if model.areaManagerProjectID != nil {
                        if model.projectAreaCreatedStatusVisible {
                            Text(model.label("projects.areaAvailableSelectToAssign"))
                                .rnFont(14).foregroundStyle(palette.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                                .accessibilityIdentifier("project-area-created-status")
                        }
                        if let message = model.projectAreaError {
                            Text(message).rnFont(13).foregroundStyle(palette.danger)
                                .fixedSize(horizontal: false, vertical: true)
                                .accessibilityIdentifier("project-area-error")
                            Button {
                                Task {
                                    if model.projectAreaPending { await model.retry() }
                                    else { await model.retryProjectAreaRead() }
                                }
                            } label: {
                                Text(model.label("common.retry"))
                                    .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain).disabled(model.busy)
                            .accessibilityIdentifier("project-area-retry")
                        }
                        if model.projectAreaReadError != nil || model.projectAreaNeedsRead {
                            if let message = model.projectAreaReadError {
                                Text(message).rnFont(13).foregroundStyle(palette.danger)
                                    .fixedSize(horizontal: false, vertical: true)
                                    .accessibilityIdentifier("project-area-read-error")
                            }
                            Button { Task { await model.retryProjectAreaRead() } } label: {
                                Text(model.label("common.retry"))
                                    .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain).disabled(model.busy || model.retryNeeded || model.projectAreaPending)
                            .accessibilityIdentifier("project-area-read-retry")
                        }
                    }
                    TextField(model.label("projects.areaLabel"), text: Binding(
                        get: { model.areaCreateName }, set: { model.setAreaCreateName($0) }))
                        .focused($nameFocused).submitLabel(.done)
                        .onSubmit { submitArea() }
                        .rnFont(16).padding(.horizontal, 12).frame(minHeight: 46)
                        .background(palette.input, in: RoundedRectangle(cornerRadius: 8))
                        .overlay(RoundedRectangle(cornerRadius: 8).stroke(palette.border, lineWidth: 1))
                        .disabled(!model.areaCreateInputEnabled)
                        .contentShape(Rectangle()).onTapGesture {
                            if model.areaCreateInputEnabled { nameFocused = true }
                        }
                        .accessibilityLabel(model.label("projects.areaLabel"))
                        .accessibilityIdentifier("area-create-name")
                    if model.areaCreateNameTaken {
                        Text(model.label("areas.nameExists")).rnFont(13).foregroundStyle(palette.danger)
                            .accessibilityIdentifier("area-create-name-taken")
                    }
                    if model.areaCreateNameChecking { ProgressView().accessibilityIdentifier("area-create-name-checking") }
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 44), spacing: 10)], spacing: 10) {
                        ForEach(colors, id: \.self) { color in
                            Button { model.selectAreaCreateColor(color) } label: {
                                Circle().fill(Color(hex: color)).frame(width: 34, height: 34)
                                    .frame(width: 44, height: 44)
                                    .overlay(Circle().stroke(model.areaCreateColor == color ? palette.tint : palette.border,
                                                             lineWidth: model.areaCreateColor == color ? 3 : 1))
                            }
                            .buttonStyle(.plain).disabled(!model.areaCreateInputEnabled)
                            .accessibilityLabel(color)
                            .accessibilityAddTraits(model.areaCreateColor == color ? .isSelected : [])
                            .accessibilityIdentifier("area-create-color-" + color)
                        }
                    }
                    if let message = model.areaCreateError {
                        Text(message).rnFont(13).foregroundStyle(palette.danger).textSelection(.enabled)
                            .accessibilityIdentifier("area-create-error")
                        if model.areaCreatePending && model.retryNeeded {
                            Button { Task { await model.retry() } } label: {
                                Text(model.label("common.retry")).rnFont(14, .semibold)
                                    .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                            }
                                .disabled(model.busy).accessibilityIdentifier("area-create-retry")
                        }
                    }
                    if let message = model.areaCreateReadError {
                        Text(message).rnFont(13).foregroundStyle(palette.danger).textSelection(.enabled)
                            .accessibilityIdentifier("area-create-read-error")
                        Button { Task { await model.retryAreaCreateRead() } } label: {
                            Text(model.label("common.retry")).rnFont(14, .semibold)
                                .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                        }
                            .disabled(model.busy || model.retryNeeded)
                            .accessibilityIdentifier("area-create-read-retry")
                    }
                    if model.busy { ProgressView().frame(maxWidth: .infinity).padding(8) }
                    HStack(spacing: 12) {
                        Button { model.closeAreaManager() } label: {
                            Text(model.label("common.cancel"))
                                .frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle())
                        }
                            .disabled(!model.areaManagerCloseEnabled)
                            .accessibilityIdentifier("area-create-cancel")
                        Button { submitArea() } label: {
                            Text(model.label("common.save"))
                                .frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle())
                        }
                            .disabled(!model.areaCreateCanSubmit)
                            .accessibilityIdentifier("area-create-save")
                    }
                    .buttonStyle(.plain).rnFont(15, .semibold).foregroundStyle(palette.tint)
                }
                .frame(maxWidth: 560, alignment: .leading).frame(maxWidth: .infinity)
                .padding(20)
            }
            .scrollDismissesKeyboard(.interactively)
            .accessibilityIdentifier("area-manager-scroll")
        }
        .background(palette.bg.ignoresSafeArea())
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isModal)
        .accessibilityAction(.escape) { model.closeAreaManager() }
        .onChange(of: model.areaRenameInputEnabled) { renameFocused = $0 }
    }

    private var areaRenameForm: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("\(model.label("common.rename")): \(model.areaRenameOriginalName)").rnFont(14, .semibold)
                .foregroundStyle(palette.secondary)
            TextField(model.label("projects.areaLabel"), text: Binding(
                get: { model.areaRenameDraft },
                set: { model.setAreaRenameDraft($0) }))
                .focused($renameFocused).submitLabel(.done)
                .onSubmit { submitAreaRename() }
                .rnFont(16).padding(.horizontal, 12).frame(minHeight: 48)
                .background(palette.input, in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(palette.border, lineWidth: 1))
                .disabled(!model.areaRenameInputEnabled)
                .contentShape(Rectangle()).onTapGesture {
                    if model.areaRenameInputEnabled { renameFocused = true }
                }
                .accessibilityLabel(model.label("projects.areaLabel"))
                .accessibilityIdentifier("area-rename-name")
            if let message = model.areaRenameError {
                Text(message).rnFont(13).foregroundStyle(palette.danger)
                    .textSelection(.enabled)
                    .accessibilityIdentifier("area-rename-error")
            } else if let message = model.areaRenameReadError {
                Text(message).rnFont(13).foregroundStyle(palette.danger)
                    .textSelection(.enabled)
                    .accessibilityIdentifier("area-rename-error")
            }
            if model.areaRenamePending && model.retryNeeded {
                Button { Task { await model.retry() } } label: {
                    Text(model.label("common.retry")).rnFont(14, .semibold)
                        .frame(maxWidth: .infinity, minHeight: 48).contentShape(Rectangle())
                }
                .buttonStyle(.plain).foregroundStyle(palette.tint)
                .disabled(model.busy).accessibilityIdentifier("area-rename-retry")
            }
            if model.areaRenameReadError != nil && !model.areaRenamePending {
                Button { Task { await model.retryAreaRenameRead() } } label: {
                    Text(model.label("common.retry")).rnFont(14, .semibold)
                        .frame(maxWidth: .infinity, minHeight: 48).contentShape(Rectangle())
                }
                .buttonStyle(.plain).foregroundStyle(palette.tint)
                .disabled(model.busy || model.retryNeeded)
                .accessibilityIdentifier("area-rename-read-retry")
            }
            HStack(spacing: 12) {
                Button { cancelAreaRename() } label: {
                    Text(model.label("common.cancel"))
                        .frame(maxWidth: .infinity, minHeight: 48).contentShape(Rectangle())
                }
                .disabled(!model.areaRenameCanCancel)
                .accessibilityIdentifier("area-rename-cancel")
                Button { submitAreaRename() } label: {
                    Text(model.label("common.save"))
                        .frame(maxWidth: .infinity, minHeight: 48).contentShape(Rectangle())
                }
                .disabled(!model.areaRenameCanSubmit)
                .accessibilityIdentifier("area-rename-save")
            }
            .buttonStyle(.plain).rnFont(15, .semibold).foregroundStyle(palette.tint)
        }
        .padding(12).background(palette.filter, in: RoundedRectangle(cornerRadius: 8))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("area-rename-form")
    }

    private func submitArea() {
        guard model.areaCreateCanSubmit else { return }
        nameFocused = false
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        Task { await model.addArea() }
    }

    private func submitAreaColor(_ id: String, color: String?) {
        guard model.areaColorInputEnabled else { return }
        nameFocused = false
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        Task { await model.changeAreaColor(id, color: color) }
    }

    private func submitAreaRename() {
        guard model.areaRenameCanSubmit else { return }
        renameFocused = false
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        Task { await model.renameArea() }
    }

    private func cancelAreaRename() {
        guard model.areaRenameCanCancel else { return }
        renameFocused = false
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        model.cancelAreaRename()
    }

    private func submitAreaOrder(_ kind: String, areaID: String? = nil) {
        guard model.areaOrderInputEnabled else { return }
        nameFocused = false
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        Task { await model.changeAreaOrder(kind, areaID: areaID) }
    }

    private func submitAreaDelete(_ id: String) {
        guard model.areaDeleteInputEnabled else { return }
        nameFocused = false
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        Task { await model.deleteArea(id) }
    }

    private func colorSelected(_ area: CoreObject, _ color: String?) -> Bool {
        if model.areaColorIntentID == area.text("id") { return model.areaColorIntentColor == color }
        return (area["color"] as? String) == color
    }
}

struct ProjectFileAddRecoveryPanel: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Pending file attachment").rnFont(16, .semibold)
                .foregroundStyle(palette.text).accessibilityAddTraits(.isHeader)
            Text(model.projectFileAddError ?? "An attachment operation needs attention.")
                .rnFont(14).foregroundStyle(palette.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Text("Stopping ends the pending attachment operation. It does not undo an attachment that was already saved.")
                .rnFont(13).foregroundStyle(palette.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if model.busy { ProgressView().frame(minHeight: 44) }
            HStack(spacing: 12) {
                Button { Task { await model.retryProjectFileAdd() } } label: {
                    Text(model.label("common.retry").isEmpty ? "Retry" : model.label("common.retry"))
                        .rnFont(14, .semibold).frame(maxWidth: .infinity, minHeight: 44)
                        .contentShape(Rectangle())
                }
                .foregroundStyle(palette.tint).accessibilityIdentifier("project-file-add-retry")
                Button { Task { await model.stopProjectFileAdd() } } label: {
                    Text("Stop attachment operation").rnFont(14, .semibold)
                        .frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle())
                }
                .foregroundStyle(palette.danger).accessibilityIdentifier("project-file-add-stop")
            }
            .buttonStyle(.plain).disabled(!model.projectFileAddRecoveryEnabled)
        }
        .padding(12).frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.filter, in: RoundedRectangle(cornerRadius: 10))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("project-file-add-recovery")
    }
}

struct ProjectDetailScreen: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    @FocusState private var renameFocused: Bool
    @FocusState private var notesFocused: Bool
    @FocusState private var sectionFocused: Bool
    @FocusState private var filterFocusedField: String?
    @State private var detailsExpanded = false
    @State private var detailsProjectID = ""
    @State private var discardNotesConfirm = false
    @State private var deleteSectionConfirmPresented = false
    @State private var deleteProjectConfirmPresented = false
    @State private var deleteProjectConfirmedID = ""
    @State private var deleteProjectConfirmedRevision = ""
    @State private var cancelProjectConfirmPresented = false
    @State private var cancelProjectConfirmedID = ""
    @State private var cancelProjectConfirmedRevision = ""
    @State private var projectDateDraft = Date()
    @State private var filePickerID: UUID?

    var body: some View {
        let fileOpenID = model.projectFileOpenPresentation?.id
        VStack(spacing: 0) {
            if model.projectFileAddRecoveryVisible {
                ProjectFileAddRecoveryPanel(model: model, palette: palette)
                    .padding(.horizontal, 16).padding(.vertical, 8)
            }
            VStack(spacing: 0) {
                HStack(spacing: 8) {
                    Button { resignProjectNotesInput(); Task { await model.closeProject() } } label: {
                        AppIcon(name: "chevron", size: 24).rotationEffect(.degrees(90)).foregroundStyle(palette.tint)
                            .frame(width: 44, height: 44).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).disabled(model.busy || model.retryNeeded || model.projectRenameEditing
                        || model.projectAttachmentOpening || model.projectFileAddOpening || model.projectFileImporterPresented)
                    .accessibilityLabel(model.label("common.back")).accessibilityIdentifier("project-back")
                    if model.projectRenameEditing {
                        TextField(model.label("taskEdit.titleLabel"), text: Binding(
                            get: { model.projectRenameTitle },
                            set: { model.setProjectRenameTitle($0) }))
                            .focused($renameFocused).submitLabel(.done).onSubmit { submitRename() }
                            .rnFont(18, .bold).foregroundStyle(palette.text)
                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                            .disabled(!model.projectRenameInputEnabled)
                            .accessibilityIdentifier("project-rename-title")
                    } else {
                        Text(model.projectHeader.text("title")).rnFont(18, .bold)
                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                            .accessibilityAddTraits(.isHeader)
                            .accessibilityIdentifier("project-detail-title")
                            .overlay {
                                Button { resignProjectNotesInput(); Task { await model.openProjectRename() } } label: {
                                    Color.clear.frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle())
                                }
                                .buttonStyle(.plain).disabled(!model.projectRenameOpenEnabled)
                                .accessibilityLabel(model.label("taskEdit.titleLabel"))
                                .accessibilityIdentifier("project-rename-open")
                            }
                    }
                    Menu {
                        Button {
                            let id = model.projectHeader.text("id")
                            let revision = model.projectDetail.text("projectRevision")
                            let action = model.projectLifecycleAction
                            Task { await model.changeProjectLifecycle(expectedID: id, expectedRevision: revision, action: action) }
                        } label: {
                            Label(model.label(model.projectLifecycleAction == "complete" ? "projects.complete" : "projects.reactivate"),
                                  systemImage: model.projectLifecycleAction == "complete" ? "archivebox" : "arrow.uturn.backward")
                        }
                        .disabled(!model.projectLifecycleOpenEnabled)
                        .accessibilityHint(model.projectLifecycleAction == "complete" ? model.label("projects.archiveHelp") : "")
                        .accessibilityIdentifier(model.projectLifecycleAction == "complete" ? "project-archive-button" : "project-reactivate-button")
                        if model.projectLifecycleAction == "complete" {
                            Button(role: .destructive) {
                                guard model.projectLifecycleOpenEnabled else { return }
                                cancelProjectConfirmedID = model.projectHeader.text("id")
                                cancelProjectConfirmedRevision = model.projectDetail.text("projectRevision")
                                cancelProjectConfirmPresented = true
                            } label: {
                                Label(model.label("projects.cancel"), systemImage: "xmark.circle")
                            }
                            .disabled(!model.projectLifecycleOpenEnabled)
                            .accessibilityIdentifier("project-cancel-button")
                        }
                        Button {
                            let id = model.projectHeader.text("id")
                            let revision = model.projectDetail.text("projectRevision")
                            Task { await model.duplicateProject(expectedID: id, expectedRevision: revision) }
                        } label: {
                            Label(model.label("projects.duplicate"), systemImage: "square.on.square")
                        }
                        .disabled(!model.projectDuplicateOpenEnabled)
                        .accessibilityIdentifier("project-duplicate-button")
                        Button(role: .destructive) {
                            deleteProjectConfirmedID = model.projectHeader.text("id")
                            deleteProjectConfirmedRevision = model.projectDetail.text("projectRevision")
                            deleteProjectConfirmPresented = true
                        } label: {
                            Label(model.label("common.delete"), systemImage: "trash")
                        }
                        .accessibilityIdentifier("project-delete-button")
                    } label: {
                        Image(systemName: "ellipsis").font(.system(size: 20)).foregroundStyle(palette.secondary)
                            .frame(width: 44, height: 44).background(palette.filter, in: RoundedRectangle(cornerRadius: 10))
                            .overlay(RoundedRectangle(cornerRadius: 10).stroke(palette.border, lineWidth: 1))
                    }
                    .disabled(!model.projectDeleteOpenEnabled)
                    .accessibilityLabel(model.label("projects.actionsLabel"))
                    .accessibilityIdentifier("project-actions-menu")
                }
                if model.projectRenameEditing {
                    HStack(spacing: 12) {
                        Button { submitRename() } label: {
                            Text(model.label("common.save"))
                                .frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle())
                        }
                        .disabled(!model.projectRenameCanSave)
                        .accessibilityIdentifier("project-rename-save")
                        Button {
                            renameFocused = false
                            UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
                            model.cancelProjectRename()
                        } label: {
                            Text(model.label("common.cancel"))
                                .frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle())
                        }
                        .disabled(model.busy || model.retryNeeded || model.projectRenamePending)
                        .accessibilityIdentifier("project-rename-cancel")
                    }
                    .buttonStyle(.plain).rnFont(14, .semibold).foregroundStyle(palette.tint)
                }
                if let error = model.projectRenameError {
                    Text(error).rnFont(13).foregroundStyle(palette.danger).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityIdentifier("project-rename-error")
                    if model.projectRenamePending {
                        Button(model.label("common.retry")) { Task { await model.retry() } }
                            .rnFont(14, .semibold).frame(minHeight: 44)
                            .disabled(model.busy).accessibilityIdentifier("project-rename-retry")
                    }
                }
                if let error = model.projectRenameReadError {
                    Text(error).rnFont(13).foregroundStyle(palette.danger).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityIdentifier("project-rename-read-error")
                    Button(model.label("common.retry")) { Task { await model.retryProjectRenameRead() } }
                        .rnFont(14, .semibold).frame(minHeight: 44)
                        .disabled(model.busy || model.retryNeeded || model.projectRenamePending)
                        .accessibilityIdentifier("project-rename-read-retry")
                }
                if let error = model.projectDeleteError {
                    Text(error).rnFont(13).foregroundStyle(palette.danger).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityIdentifier("project-delete-error")
                    if model.retryNeeded {
                        Button(model.label("common.retry")) { Task { await model.retry() } }
                            .rnFont(14, .semibold).frame(minHeight: 44)
                            .disabled(model.busy).accessibilityIdentifier("project-delete-retry")
                    }
                }
                if let error = model.projectDuplicateError {
                    Text(error).rnFont(13).foregroundStyle(palette.danger).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityIdentifier("project-duplicate-error")
                    if model.retryNeeded {
                        Button(model.label("common.retry")) { Task { await model.retry() } }
                            .rnFont(14, .semibold).frame(minHeight: 44)
                            .disabled(model.busy).accessibilityIdentifier("project-duplicate-retry")
                    }
                }
                if let error = model.projectLifecycleError {
                    Text(error).rnFont(13).foregroundStyle(palette.danger).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityIdentifier("project-lifecycle-error")
                    if model.retryNeeded {
                        Button(model.label("common.retry")) { Task { await model.retry() } }
                            .rnFont(14, .semibold).frame(minHeight: 44)
                            .disabled(model.busy).accessibilityIdentifier("project-lifecycle-retry")
                    }
                }
                if let error = model.projectFlowError {
                    Text(error).rnFont(13).foregroundStyle(palette.danger).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityIdentifier("project-flow-error")
                    if model.projectFlowPending {
                        Button { Task { await model.retry() } } label: {
                            Text(model.label("common.retry")).rnFont(14, .semibold)
                                .frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).disabled(model.busy).accessibilityIdentifier("project-flow-retry")
                    }
                }
                    if let error = model.projectFlowReadError {
                    Text(error).rnFont(13).foregroundStyle(palette.danger).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityIdentifier("project-flow-read-error")
                    Button { Task { await model.retryProjectFlowRead() } } label: {
                        Text(model.label("common.retry")).rnFont(14, .semibold)
                            .frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).disabled(model.busy || model.retryNeeded || model.projectFlowPending)
                        .accessibilityIdentifier("project-flow-read-retry")
                    }
                    if !model.projectTaskSortPresented { projectTaskSortErrors }
                    if model.projectDateField == nil || !model.projectCurrent {
                        projectDateErrorView
                    }
            }
            .padding(.horizontal, 16).padding(.vertical, 8).background(palette.card)
            .overlay(alignment: .bottom) { palette.border.frame(height: 1) }
            if !model.projectDetail.isEmpty {
                HStack {
                    if model.projectTaskOrderPresented {
                        Text(model.projectTaskOrderView.text("label").isEmpty ? model.label("projects.reorderTasks")
                             : model.projectTaskOrderView.text("label")).rnFont(14, .semibold)
                        Spacer(minLength: 0)
                        Button { Task { await model.closeProjectTaskOrder() } } label: {
                            Text(model.label("common.done")).rnFont(14, .semibold)
                                .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                        }
                            .buttonStyle(.plain)
                            .disabled(model.busy || model.retryNeeded || model.projectTaskOrderPending)
                            .accessibilityIdentifier("project-task-order-done")
                    } else {
                    Button { resignProjectNotesInput(); Task { await model.openProjectViewOptions() } } label: {
                        Image(systemName: "ellipsis").font(.system(size: 20))
                            .foregroundStyle(model.projectTaskViewActive ? palette.tint : palette.secondary)
                            .frame(width: 44, height: 44).contentShape(Rectangle())
                            .background(palette.filter, in: RoundedRectangle(cornerRadius: 8))
                            .overlay(RoundedRectangle(cornerRadius: 8).stroke(palette.border, lineWidth: 1))
                    }
                    .buttonStyle(.plain).disabled(!model.projectViewOpenEnabled)
                    .accessibilityLabel(model.label("taskEdit.moreOptions"))
                    .accessibilityAddTraits(model.projectTaskViewActive ? .isSelected : [])
                    .accessibilityIdentifier("project-task-view-options-button")
                    if model.projectDetail.object("filters").flag("hasActive") {
                        Button { resignProjectNotesInput(); Task { await model.openProjectFilters() } } label: {
                            Text(model.projectDetail.text("filterButtonLabel")).rnFont(13, .semibold)
                                .foregroundStyle(palette.tint).padding(.horizontal, 12)
                                .frame(minHeight: 44).contentShape(Rectangle())
                                .background(palette.filter, in: RoundedRectangle(cornerRadius: 8))
                        }
                        .buttonStyle(.plain).disabled(!model.projectViewOpenEnabled)
                        .accessibilityIdentifier("project-filter-button")
                    }
                    Spacer(minLength: 0)
                    }
                }
                .padding(.horizontal, 12).padding(.vertical, 8).background(palette.card)
                .overlay(alignment: .bottom) { palette.border.frame(height: 1) }
                if !model.projectDetail.objects("chips").isEmpty {
                    AppChipFlow {
                        ForEach(model.projectDetail.objects("chips").indices, id: \.self) { index in
                            let chip = model.projectDetail.objects("chips")[index]
                            Button {
                                resignProjectNotesInput()
                                Task { await model.editProjectFilter(chip.object("action").object("filterEdit")) }
                            } label: {
                                HStack(spacing: 4) {
                                    Text(chip.text("label")).rnFont(12, .semibold).strikethrough(chip.flag("excluded"))
                                    AppIcon(name: "x", size: 12)
                                }
                                .foregroundStyle(palette.onTint).padding(.horizontal, 10)
                                .frame(minHeight: 44).background(chip.flag("excluded") ? palette.danger : palette.tint,
                                                                in: RoundedRectangle(cornerRadius: 22))
                                .contentShape(RoundedRectangle(cornerRadius: 22))
                            }
                            .buttonStyle(.plain).disabled(!model.projectFilterActionsEnabled)
                            .accessibilityIdentifier("project-filter-chip-" + chip.text("id"))
                        }
                        Button {
                            resignProjectNotesInput()
                            Task { await model.editProjectFilter(model.projectDetail.object("filters").object("clearEdit")) }
                        } label: {
                            Text(model.label("filters.clear")).rnFont(12, .semibold)
                                .foregroundStyle(palette.tint).padding(.horizontal, 10)
                                .frame(minHeight: 44).contentShape(Capsule())
                        }
                        .buttonStyle(.plain).disabled(!model.projectFilterActionsEnabled)
                        .accessibilityIdentifier("project-filter-clear")
                    }
                    .padding(.horizontal, 12).padding(.bottom, 8).background(palette.card)
                }
            }
            if model.projectTaskOrderPresented {
                projectTaskOrderList
            } else {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 8) {
                    if let error = model.projectError {
                        Text(error).rnFont(13).foregroundStyle(palette.danger).textSelection(.enabled)
                            .accessibilityIdentifier("project-error")
                        Button { Task { await model.refresh() } } label: {
                            Text(model.label("common.retry")).rnFont(14, .semibold)
                                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(Rectangle())
                        }
                            .buttonStyle(.plain).disabled(model.busy || model.retryNeeded)
                            .accessibilityIdentifier("project-retry")
                    }
                    if !model.projectCurrent { statusReadErrorView }
                    // Keep the same Project's layout during its refresh, with stale controls inert.
                    if model.projectCurrent || ((model.busy || model.projectViewReadPending) && !model.projectDetail.isEmpty
                        && model.projectDetail.text("projectId") == model.projectHeader.text("id")) {
                        Group {
                            let metadata = model.projectDetail.object("metadata")
                            if !metadata.isEmpty { detailsPanel(metadata) }
                            let items = model.projectDetail.objects("items")
                            if items.isEmpty {
                                let empty = model.projectDetail.object("empty")
                                VStack(spacing: 8) {
                                    Text(empty.text("message").isEmpty ? model.label("list.noTasks") : empty.text("message"))
                                        .rnFont(16).foregroundStyle(palette.secondary)
                                    if !empty.text("hint").isEmpty {
                                        Text(empty.text("hint")).rnFont(13).foregroundStyle(palette.secondary)
                                    }
                                    if !empty.object("action").object("filterEdit").isEmpty {
                                        Button {
                                            Task { await model.editProjectFilter(empty.object("action").object("filterEdit")) }
                                        } label: {
                                            Text(empty.text("actionLabel")).rnFont(14, .semibold)
                                                .frame(minHeight: 44).contentShape(Rectangle())
                                        }
                                        .buttonStyle(.plain).disabled(!model.projectFilterActionsEnabled)
                                        .accessibilityIdentifier("project-empty-filter-clear")
                                    }
                                }
                                .frame(maxWidth: .infinity).padding(32).accessibilityIdentifier("project-empty")
                            }
                            ForEach(items.map { ProjectDetailDisplayItem(value: $0) }) { entry in
                                let item = entry.value
                                if item.text("type") == "section" {
                                    if item.flag("collapsible") {
                                        Button {
                                            resignProjectNotesInput()
                                            Task { await model.toggleProjectCompletedSection(item.text("id")) }
                                        } label: {
                                            HStack(spacing: 8) {
                                                AppIcon(name: "chevron", size: 16)
                                                    .rotationEffect(.degrees(item.flag("collapsed") ? -90 : 0)).accessibilityHidden(true)
                                                Text(item.text("title")).rnFont(13, .bold)
                                                Text(String(item.number("count"))).rnFont(12, .semibold)
                                                Spacer(minLength: 0)
                                            }
                                            .foregroundStyle(palette.secondary)
                                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(Rectangle())
                                        }
                                        .buttonStyle(.plain).disabled(!model.projectViewOpenEnabled)
                                        .accessibilityLabel(item.text("title") + ", " + String(item.number("count")))
                                        .accessibilityValue(model.label(item.flag("collapsed") ? "markdown.expand" : "markdown.collapse"))
                                        .accessibilityIdentifier("project-completed-toggle")
                                    } else {
                                        HStack(spacing: 8) {
                                            Text(item.text("title")).rnFont(13, .bold)
                                            Text(String(item.number("count"))).rnFont(12, .semibold)
                                        }
                                        .foregroundStyle(item.flag("muted") ? palette.secondary : palette.text)
                                        .padding(.top, 12).padding(.bottom, 4).accessibilityAddTraits(.isHeader)
                                    }
                                } else if item.text("type") == "task" {
                                    TaskCard(row: item.object("row"), model: model, palette: palette,
                                             readOnly: model.projectDetail.flag("readOnly"),
                                             beforeAction: resignProjectNotesInput)
                                }
                            }
                            if items.count < model.projectDetail.number("total") {
                                Button { resignProjectNotesInput(); Task { await model.loadMoreProject() } } label: {
                                    Text(model.label("common.more")).rnFont(13, .semibold)
                                        .padding(.horizontal, 16).frame(minHeight: 44).background(palette.filter, in: Capsule())
                                }
                                .buttonStyle(.plain).disabled(!model.projectActionsEnabled)
                                .frame(maxWidth: .infinity).accessibilityIdentifier("project-more")
                            }
                        }
                        .disabled(!model.projectCurrent)
                        .allowsHitTesting(model.projectCurrent)
                    }
                    if model.busy { ProgressView().frame(maxWidth: .infinity).padding(12) }
                }
                .padding(12)
            }
            .accessibilityIdentifier("project-detail-scroll")
            .refreshable { resignProjectNotesInput(); await model.refresh() }
            .allowsHitTesting(!model.projectRenameEditing)
            }
        }
        .disabled(model.projectAttachmentOpening)
        .accessibilityHidden(model.projectFileOpenPresentation != nil)
        .onChange(of: model.projectRenameEditing) { renameFocused = $0 }
        .onChange(of: model.projectRenameInputEnabled) { if $0 { renameFocused = true } }
        .onChange(of: notesFocused) { if !$0 { Task { await model.flushProjectNotesEdit() } } }
        .onChange(of: model.projectDatePicker.text("date")) { _ in updateProjectDateDraft() }
        .onChange(of: model.projectDatePicker.text("instant")) { _ in updateProjectDateDraft() }
        .task(id: [model.projectHeader.text("id"), model.projectDetail.text("mutationRevision"),
                   model.projectCurrent ? "current" : "stale", detailsExpanded ? "expanded" : "collapsed"]) {
            if detailsExpanded && model.projectCurrent { await model.readProjectAttachments() }
        }
        .task(id: model.projectDetail.text("mutationRevision")) {
            if model.projectDateField != nil && !model.projectDatePending && model.projectCurrent {
                await model.retryProjectDateRead()
            }
            if model.projectAreaPresented && !model.areaManagerPresented
                && !model.projectAreaPending && model.projectCurrent {
                await model.retryProjectAreaRead()
            }
            if model.projectTagsPresented && !model.projectTagsPending && model.projectCurrent {
                await model.retryProjectTagsRead()
            }
        }
        .onAppear { detailsProjectID = model.projectHeader.text("id") }
        .onChange(of: model.projectHeader.text("id")) { id in
            if id != detailsProjectID {
                detailsProjectID = id
                detailsExpanded = false
                notesFocused = false
                discardNotesConfirm = false
                deleteProjectConfirmPresented = false
                cancelProjectConfirmPresented = false
            }
        }
        .onChange(of: model.projectSectionsPresented) {
            if !$0 { deleteSectionConfirmPresented = false }
        }
        .alert(model.label("taskEdit.discardChanges"), isPresented: $discardNotesConfirm) {
            Button(model.label("common.discard"), role: .destructive) {
                Task { await model.discardProjectNotesDraft() }
            }
            .accessibilityIdentifier("project-notes-discard-confirm")
            Button(model.label("common.cancel"), role: .cancel) {}
        } message: { Text(model.label("taskEdit.discardChangesDesc")) }
        .alert(model.label("projects.title"), isPresented: $deleteProjectConfirmPresented) {
            Button(model.label("common.cancel"), role: .cancel) {}
            Button(model.label("common.delete"), role: .destructive) {
                let id = deleteProjectConfirmedID
                let revision = deleteProjectConfirmedRevision
                Task { await model.deleteProject(expectedID: id, expectedRevision: revision) }
            }
            .accessibilityIdentifier("project-delete-confirm")
        } message: { Text(model.label("projects.deleteConfirm")) }
        .alert(model.label("projects.cancelConfirmTitle"), isPresented: $cancelProjectConfirmPresented) {
            Button(model.label("common.cancel"), role: .cancel) {}
            Button(model.label("projects.cancel"), role: .destructive) {
                let id = cancelProjectConfirmedID
                let revision = cancelProjectConfirmedRevision
                Task { await model.changeProjectLifecycle(expectedID: id, expectedRevision: revision, action: "cancel") }
            }
            .accessibilityIdentifier("project-cancel-confirm")
        } message: { Text(model.label("projects.cancelConfirmBody")) }
        .alert(model.label("attachments.title"), isPresented: Binding(
            get: { model.projectAttachmentOpenError != nil },
            set: { if !$0 { model.dismissProjectAttachmentOpenError() } })) {
            Button(model.label("common.ok")) { model.dismissProjectAttachmentOpenError() }
                .accessibilityIdentifier("project-attachment-open-dismiss")
        } message: {
            Text(model.projectAttachmentOpenError ?? "")
                .accessibilityIdentifier("project-attachment-open-error")
        }
        .sheet(item: Binding(
            get: {
                guard let filePickerID, filePickerID == model.projectFileImporterID,
                      model.projectFileImporterPresented else { return nil }
                return NativeDocumentPickerClaim(id: filePickerID)
            },
            set: { (claim: NativeDocumentPickerClaim?) in
                if claim == nil { model.setProjectFileImporterPresented(false, pickerID: filePickerID) }
            })) { claim in
                NativeDocumentPicker(pickerID: claim.id) { result, capturedID in
                    Task { await model.completeProjectFileImport(result, pickerID: capturedID) }
                }
                .id(claim.id)
                .interactiveDismissDisabled()
            }
        .sheet(item: Binding(
            get: { model.projectFileOpenPresentation },
            set: { presentation in
                if presentation == nil, let fileOpenID { model.dismissProjectFileOpen(presentationID: fileOpenID) }
            })) { presentation in
                Group {
                    if presentation.kind == .file {
                        AttachmentFileActivitySheet(presentation: presentation)
                    } else {
                        NavigationStack {
                            AttachmentFileQuickLookSheet(presentation: presentation)
                                .toolbar {
                                    ToolbarItem(placement: .confirmationAction) {
                                        Button(model.label("common.done")) {
                                            model.dismissProjectFileOpen(presentationID: presentation.id)
                                        }
                                        .accessibilityIdentifier("project-attachment-preview-done")
                                    }
                                }
                        }
                    }
                }
                .id(presentation.id)
                .onDisappear { model.dismissProjectFileOpen(presentationID: presentation.id) }
            }
        .sheet(isPresented: Binding(get: { model.projectDateField != nil },
                                    set: { if !$0 && !model.appLock.concealed { model.cancelProjectDate() } })) {
            projectDateSheet
                .presentationDetents(model.retryNeeded ? [.large] : [.medium, .large])
                .interactiveDismissDisabled(model.projectDatePending || model.retryNeeded || model.busy)
        }
        .sheet(isPresented: Binding(get: {
            model.projectViewOptionsPresented || model.projectTaskSortPresented || model.projectFiltersPresented
        }, set: { if !$0 && !model.appLock.concealed {
            filterFocusedField = nil
            model.closeProjectFilters()
            model.closeProjectViewOptions()
            model.closeProjectTaskSort()
        } })) {
            Group {
                if model.projectFiltersPresented { projectFiltersSheet }
                else { projectTaskViewSheet }
            }
            .presentationDetents(model.projectTaskSortPresented || model.projectFiltersPresented ? [.large] : [.medium, .large])
            .interactiveDismissDisabled(model.retryNeeded || model.projectTaskSortPending
                || (!model.projectFiltersPresented && model.busy))
        }
        .sheet(isPresented: Binding(get: { model.projectAreaPresented },
                                    set: { if !$0 && !model.appLock.concealed { model.closeProjectArea() } })) {
            ProjectAreaSelectionSheet(model: model, palette: palette)
                .presentationDetents([.large])
                .interactiveDismissDisabled(!model.projectAreaCloseEnabled)
        }
        .sheet(isPresented: Binding(get: { model.projectTagsPresented },
                                    set: { if !$0 && !model.appLock.concealed { model.closeProjectTags() } })) {
            ProjectTagsSelectionSheet(model: model, palette: palette)
                .presentationDetents([.large])
                .interactiveDismissDisabled(!model.projectTagsCloseEnabled)
        }
        .sheet(isPresented: Binding(get: { model.projectAttachmentLinkPresented },
                                    set: { if !$0 && !model.appLock.concealed { model.cancelProjectAttachmentLinkSheet() } })) {
            ProjectAttachmentLinkSheet(model: model, palette: palette)
                .presentationDetents([.large])
                .interactiveDismissDisabled(model.busy || model.retryNeeded || model.projectAttachmentWritePending)
        }
        .sheet(isPresented: Binding(get: { model.projectSectionsPresented },
                                    set: { if !$0 && !model.appLock.concealed { model.closeProjectSections() } })) {
            projectSectionsSheet
                .presentationDetents([.large])
                .interactiveDismissDisabled(!model.projectSectionCloseEnabled)
                .alert(model.label("projects.sectionsLabel"), isPresented: $deleteSectionConfirmPresented) {
                    Button(model.label("common.cancel"), role: .cancel) {
                        model.cancelProjectSectionDelete()
                    }
                    Button(model.label("common.delete"), role: .destructive) {
                        Task { await model.confirmProjectSectionDelete() }
                    }
                } message: {
                    Text(model.label("projects.deleteSectionConfirm"))
                }
        }
        .accessibilityAction(.escape) { resignProjectNotesInput(); Task { await model.closeProject() } }
    }

    @ViewBuilder
    private var projectDateErrorView: some View {
        if let message = model.projectDateError {
            Text(message).rnFont(13).foregroundStyle(palette.danger)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("project-date-error")
            Button {
                Task {
                    if model.projectDatePending { await model.retry() }
                    else { await model.retryProjectDateRead() }
                }
            } label: {
                Text(model.label("common.retry"))
                    .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain).disabled(model.busy)
            .accessibilityIdentifier("project-date-retry")
        }
        if let message = model.projectDateReadError {
            Text(message).rnFont(13).foregroundStyle(palette.danger)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("project-date-read-error")
            Button { Task { await model.retryProjectDateRead() } } label: {
                Text(model.label("common.retry"))
                    .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain).disabled(model.busy || model.retryNeeded || model.projectDatePending)
            .accessibilityIdentifier("project-date-read-retry")
        }
    }

    private var projectTaskViewSheet: some View {
        VStack(spacing: 16) {
            HStack {
                Text(model.projectTaskSortPresented ? model.projectTaskSortOptions.text("label") : model.label("taskEdit.moreOptions"))
                    .rnFont(18, .semibold).foregroundStyle(palette.text).accessibilityAddTraits(.isHeader)
                Spacer(minLength: 0)
                Button {
                    model.closeProjectViewOptions()
                    model.closeProjectTaskSort()
                } label: {
                    Text(model.label("common.close")).rnFont(14, .semibold)
                        .frame(minWidth: 48, minHeight: 48).contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(model.busy || model.retryNeeded || model.projectTaskSortPending)
                .accessibilityIdentifier(model.projectTaskSortPresented ? "project-sort-close" : "project-view-options-close")
            }
            ScrollView {
                VStack(spacing: 8) {
                    if model.projectTaskSortPresented {
                        projectTaskSortErrors
                        ForEach(model.projectTaskSortOptions.objects("choices").indices, id: \.self) { index in
                            let choice = model.projectTaskSortOptions.objects("choices")[index]
                            Button { Task { await model.setProjectTaskSort(choice.text("id")) } } label: {
                                HStack(spacing: 12) {
                                    Text(choice.text("label")).rnFont(16).fixedSize(horizontal: false, vertical: true)
                                    Spacer(minLength: 0)
                                    if choice.flag("selected") { Image(systemName: "checkmark").accessibilityHidden(true) }
                                }
                                .foregroundStyle(palette.text).padding(.horizontal, 12)
                                .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading).contentShape(Rectangle())
                                .background(choice.flag("selected") ? palette.filter : Color.clear,
                                            in: RoundedRectangle(cornerRadius: 8))
                            }
                            .buttonStyle(.plain).disabled(!model.projectTaskSortInputEnabled)
                            .accessibilityAddTraits(choice.flag("selected") ? .isSelected : [])
                            .accessibilityIdentifier("project-sort-option-" + choice.text("id"))
                        }
                    } else {
                        Button { Task { await model.openProjectFilters() } } label: {
                            HStack(spacing: 12) {
                                Image(systemName: "line.3.horizontal.decrease").accessibilityHidden(true)
                                Text(model.projectDetail.text("filterButtonLabel")).rnFont(16)
                                Spacer(minLength: 0)
                                Image(systemName: "chevron.right").accessibilityHidden(true)
                            }
                            .foregroundStyle(palette.text)
                            .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).disabled(!model.projectViewOpenEnabled)
                        .accessibilityAddTraits(model.projectDetail.object("filters").flag("hasActive") ? .isSelected : [])
                        .accessibilityIdentifier("project-view-filters-option")
                        Button { Task { await model.openProjectTaskSort() } } label: {
                            HStack(spacing: 12) {
                                Image(systemName: "arrow.up.arrow.down").accessibilityHidden(true)
                                VStack(alignment: .leading, spacing: 4) {
                                    Text(model.projectTaskSortOptions.text("label")).rnFont(16)
                                    Text(model.projectTaskSortOptions.objects("choices").first(where: { $0.flag("selected") })?.text("label") ?? "")
                                        .rnFont(13).foregroundStyle(palette.secondary)
                                    if !model.projectTaskSortOptions.flag("canEdit") {
                                        Text(model.label("projects.reactivate")).rnFont(13).foregroundStyle(palette.secondary)
                                    }
                                }.fixedSize(horizontal: false, vertical: true)
                                Spacer(minLength: 0)
                                Image(systemName: "chevron.right").accessibilityHidden(true)
                            }
                            .foregroundStyle(palette.text)
                            .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).disabled(!model.projectTaskSortInputEnabled)
                        .accessibilityAddTraits(model.projectTaskSortOptions.text("effectiveSortBy") != "default" ? .isSelected : [])
                        .accessibilityHint(model.projectTaskSortOptions.flag("canEdit") ? "" : model.label("projects.reactivate"))
                        .accessibilityIdentifier("project-view-sort-option")
                        if !model.projectDetail.flag("readOnly") && model.projectDetail.object("controls").flag("hasReorderTargets") {
                            Button { Task { await model.openProjectTaskOrder() } } label: {
                                HStack(spacing: 12) {
                                    Image(systemName: "line.3.horizontal").accessibilityHidden(true)
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(model.label("projects.reorderTasks")).rnFont(16)
                                        if model.projectTaskSortOptions.text("effectiveSortBy") != "default" {
                                            Text(model.label("projects.reorderNeedsDefaultSort"))
                                                .rnFont(13).foregroundStyle(palette.secondary)
                                        }
                                    }
                                    Spacer(minLength: 0)
                                }
                                .foregroundStyle(palette.text)
                                .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading).contentShape(Rectangle())
                            }
                            .buttonStyle(.plain).disabled(!model.projectTaskOrderOpenEnabled)
                            .accessibilityIdentifier("project-view-order-option")
                        }
                        if model.projectDetail.object("controls").flag("canToggleCompleted") {
                            Button { Task { await model.toggleProjectShowCompleted() } } label: {
                                HStack(spacing: 12) {
                                    Image(systemName: model.projectDetail.object("controls").flag("showCompleted") ? "eye" : "eye.slash")
                                        .accessibilityHidden(true)
                                    Text(model.projectDetail.object("controls").text("label")).rnFont(16)
                                        .fixedSize(horizontal: false, vertical: true)
                                    Spacer(minLength: 0)
                                    if model.projectDetail.object("controls").flag("showCompleted") {
                                        Image(systemName: "checkmark").accessibilityHidden(true)
                                    }
                                }
                                .foregroundStyle(palette.text)
                                .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading).contentShape(Rectangle())
                            }
                            .buttonStyle(.plain).disabled(!model.projectViewOpenEnabled)
                            .accessibilityAddTraits(model.projectDetail.object("controls").flag("showCompleted") ? .isSelected : [])
                            .accessibilityIdentifier("project-view-completed-option")
                        }
                    }
                }
                .padding(.vertical, 8)
            }
            .accessibilityIdentifier(model.projectTaskSortPresented ? "project-sort-scroll" : "project-view-options-scroll")
        }
        .padding(16).background(palette.card).tint(palette.tint)
        .accessibilityElement(children: .contain).accessibilityAddTraits(.isModal)
        .accessibilityIdentifier(model.projectTaskSortPresented ? "project-sort-sheet" : "project-view-options-sheet")
    }

    private var projectTaskOrderList: some View {
        VStack(spacing: 0) {
            if let error = model.projectTaskOrderError {
                Text(error).rnFont(13).foregroundStyle(palette.danger).textSelection(.enabled)
                    .padding(.horizontal, 12).accessibilityIdentifier("project-task-order-error")
                Button {
                    Task {
                        if model.projectTaskOrderPending { await model.retry() }
                        else { await model.retryProjectTaskOrderRead() }
                    }
                } label: {
                    Text(model.label("common.retry")).rnFont(14, .semibold)
                        .frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(model.busy)
                .accessibilityIdentifier("project-task-order-retry")
            }
            if model.busy { ProgressView().padding(12) }
            ProjectTaskOrderTable(model: model, palette: palette)
                .accessibilityIdentifier("project-task-order-list")
        }
        .background(palette.bg)
    }

    private var projectFiltersSheet: some View {
        ListFilterControls(
            data: model.projectDetail, strings: model.strings, palette: palette, prefix: "project",
            enabled: model.projectFilterActionsEnabled, busy: model.busy, frozen: model.retryNeeded,
            error: model.projectFilterError ?? model.projectError,
            searchText: Binding(get: { model.projectFilterSearchText }, set: { model.setProjectFilterText($0) }),
            locationText: Binding(get: { model.projectFilterLocationText }, set: { model.setProjectFilterText($0, location: true) }),
            pickerName: model.projectFilterPickerName, picker: model.projectFilterPicker,
            pickerCurrent: model.projectFilterPickerCurrent, pickerEnabled: model.projectFilterPickerActionsEnabled,
            pickerError: model.projectFilterPickerError,
            pickerQuery: Binding(get: { model.projectFilterPickerQuery }, set: { model.setProjectFilterPickerQuery($0) }),
            onEdit: { edit in Task { await model.editProjectFilter(edit) } },
            onChipAction: { action in Task { await model.editProjectFilter(action.object("filterEdit")) } },
            onArchived: { _ in }, onOpenPicker: model.openProjectFilterPicker, onBack: model.closeProjectFilterPicker,
            onMore: model.loadMoreProjectFilterPicker, onRetry: model.retryProjectFilterRead,
            onRetryPicker: model.retryProjectFilterPicker,
            onClose: { filterFocusedField = nil; model.closeProjectFilters() }, focusedField: $filterFocusedField)
            .padding(16).background(palette.card).tint(palette.tint)
            .accessibilityElement(children: .contain).accessibilityAddTraits(.isModal)
            .accessibilityIdentifier("project-filters-sheet")
    }

    @ViewBuilder private var projectTaskSortErrors: some View {
        if let error = model.projectTaskSortError {
            Text(error).rnFont(13).foregroundStyle(palette.danger).textSelection(.enabled)
                .accessibilityIdentifier("project-sort-error")
            if model.projectTaskSortPending {
                Button { Task { await model.retry() } } label: {
                    Text(model.label("common.retry")).rnFont(14, .semibold)
                        .frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(model.busy).accessibilityIdentifier("project-sort-retry")
            }
        }
        if let error = model.projectTaskSortReadError {
            Text(error).rnFont(13).foregroundStyle(palette.danger).textSelection(.enabled)
                .accessibilityIdentifier("project-sort-read-error")
            Button { Task { await model.retryProjectTaskSortRead() } } label: {
                Text(model.label("common.retry")).rnFont(14, .semibold)
                    .frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle())
            }
            .buttonStyle(.plain).disabled(model.busy || model.retryNeeded || model.projectTaskSortPending)
            .accessibilityIdentifier("project-sort-read-retry")
        }
    }

    private var projectDateSheet: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                let field = model.projectDateField ?? "startDate"
                let label = model.label(field == "reviewAt" ? "projects.reviewAt"
                    : field == "startDate" ? "taskEdit.startDateLabel" : "taskEdit.dueDateLabel")
                Text(label).rnFont(18, .semibold).foregroundStyle(palette.text)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                if !model.projectDatePicker.isEmpty {
                    if field == "reviewAt" {
                        DatePicker(label, selection: $projectDateDraft, displayedComponents: .date)
                            .datePickerStyle(.wheel).labelsHidden().tint(palette.tint)
                            .environment(\.timeZone, model.projectDateOpeningTimeZone ?? .current)
                            .disabled(model.busy || model.projectDatePending || model.retryNeeded)
                            .accessibilityLabel(label).accessibilityIdentifier("project-date-picker")
                    } else {
                        DatePicker(label, selection: $projectDateDraft, displayedComponents: .date)
                            .datePickerStyle(.wheel).labelsHidden().tint(palette.tint)
                            .disabled(model.busy || model.projectDatePending || model.retryNeeded)
                            .accessibilityLabel(label).accessibilityIdentifier("project-date-picker")
                    }
                } else if model.projectDateReadError == nil {
                    ProgressView().frame(maxWidth: .infinity, minHeight: 100)
                }
                projectDateErrorView
                HStack(spacing: 12) {
                    Button { model.cancelProjectDate() } label: {
                        Text(model.label("common.cancel"))
                            .frame(maxWidth: .infinity, minHeight: 48)
                            .contentShape(Rectangle())
                    }
                    .disabled(model.projectDatePending || model.retryNeeded || model.busy)
                    .accessibilityIdentifier("project-date-cancel")
                    Button {
                        if field == "reviewAt" {
                            let selected = projectDateDraft
                            Task { await model.finishProjectReviewDate(selected) }
                        } else {
                            let value = TaskDatePickerComponents.string(projectDateDraft, time: false)
                            Task { await model.changeProjectDate(field, value: value) }
                        }
                    } label: {
                        Text(model.label("common.done"))
                            .frame(maxWidth: .infinity, minHeight: 48)
                            .contentShape(Rectangle())
                    }
                    .disabled(!model.projectDateDoneEnabled)
                    .accessibilityIdentifier("project-date-done")
                }
                .buttonStyle(.plain).rnFont(14, .semibold).foregroundStyle(palette.tint)
            }
            .padding(20).frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(palette.card)
        .accessibilityIdentifier("project-date-sheet")
    }

    private func updateProjectDateDraft() {
        let picker = model.projectDatePicker
        let date = model.projectDateField == "reviewAt"
            ? TaskDatePickerComponents.instant(picker.text("instant"))
            : TaskDatePickerComponents.date(picker)
        if let date { projectDateDraft = date }
    }

    @ViewBuilder
    private var statusReadErrorView: some View {
        ProjectStatusReadError(model: model, palette: palette)
    }

    private func detailsPanel(_ metadata: CoreObject) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    AppIcon(name: "chevron", size: 16).rotationEffect(.degrees(detailsExpanded ? 0 : -90))
                        .foregroundStyle(palette.secondary).accessibilityHidden(true)
                    Text(model.label("taskEdit.details")).rnFont(15, .semibold).foregroundStyle(palette.text)
                }
                if !detailsExpanded {
                    Text(metadata.text("summary")).rnFont(13).foregroundStyle(palette.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("project-details-summary")
                }
            }
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .contentShape(Rectangle())
            .overlay {
                Button {
                    resignProjectNotesInput()
                    Task {
                        if detailsExpanded {
                            guard await model.collapseProjectNotesForDetails() else { return }
                            model.closeProjectStatusSelector()
                        }
                        detailsExpanded.toggle()
                    }
                } label: {
                    Color.clear.frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(model.projectRenameEditing || model.projectStatusPending || model.retryNeeded)
                .accessibilityLabel(model.label("taskEdit.details"))
                .accessibilityValue(model.label(detailsExpanded ? "markdown.collapse" : "markdown.expand"))
                .accessibilityIdentifier("project-details-toggle")
            }
            if detailsExpanded {
                VStack(alignment: .leading, spacing: 16) {
                    ProjectStatusMetadata(model: model, palette: palette, metadata: metadata) {
                        resignProjectNotesInput()
                    }
                    if model.projectDetail.flag("readOnly") {
                        metadataRow("projects.projectTypeLabel", value: metadata.text("typeLabel"), id: "type")
                    } else {
                        metadataRow("projects.projectTypeLabel", value: metadata.text("typeLabel"), id: "type")
                            .padding(.trailing, 32)
                            .frame(minHeight: 44)
                            .padding(8)
                            .background(palette.card, in: RoundedRectangle(cornerRadius: 8))
                            .overlay(RoundedRectangle(cornerRadius: 8).stroke(palette.border, lineWidth: 1))
                            .contentShape(Rectangle())
                            .overlay(alignment: .trailing) {
                                Image(systemName: "arrow.triangle.2.circlepath")
                                    .font(.system(size: 16)).foregroundStyle(palette.tint)
                                    .accessibilityHidden(true)
                            }
                            .overlay {
                                Button { resignProjectNotesInput(); Task { await model.toggleProjectType() } } label: {
                                    Color.clear.frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle())
                                }
                                .buttonStyle(.plain).disabled(!model.projectFlowInputEnabled)
                                .accessibilityLabel(model.label("projects.projectTypeLabel") + ": " + metadata.text("typeLabel"))
                                .accessibilityHint(model.label("projects.projectTypeHelpText"))
                                .accessibilityIdentifier("project-flow-type")
                            }
                    }
                    if !metadata.text("sequentialScopeLabel").isEmpty {
                        metadataRow("projects.sequentialScope", value: metadata.text("sequentialScopeLabel"), id: "sequential-scope")
                        if !model.projectDetail.flag("readOnly") {
                            AppChipFlow {
                                projectScopeChip("project", metadata: metadata)
                                projectScopeChip("section", metadata: metadata)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                    ProjectSectionsMetadata(model: model, palette: palette, metadata: metadata) {
                        resignProjectNotesInput()
                        Task { await model.openProjectSections() }
                    }
                    ProjectAreaMetadata(model: model, palette: palette, metadata: metadata) {
                        resignProjectNotesInput()
                        Task { await model.openProjectArea() }
                    }
                    ProjectTagsMetadata(model: model, palette: palette, metadata: metadata) {
                        resignProjectNotesInput()
                        Task { await model.openProjectTags() }
                    }
                }
                .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                .background(palette.filter, in: RoundedRectangle(cornerRadius: 8))
                projectNotesPanel
                // Bound generic metadata after an observed iOS 17 stack overflow.
                AnyView(projectAttachmentsPanel)
                ProjectDatesMetadata(model: model, palette: palette, metadata: metadata) {
                    resignProjectNotesInput()
                }
            }
        }
        .padding(12).frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.card, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(palette.border, lineWidth: 1))
    }

    private var projectSectionsSheet: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 12) {
                Text(model.label("projects.sectionsLabel"))
                    .rnFont(20, .bold).foregroundStyle(palette.text)
                    .accessibilityAddTraits(.isHeader)
                Spacer(minLength: 8)
                Button {
                    sectionFocused = false
                    UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
                    model.closeProjectSections()
                } label: {
                    Image(systemName: "xmark").font(.system(size: 20)).foregroundStyle(palette.secondary)
                        .frame(width: 48, height: 48).contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(!model.projectSectionCloseEnabled)
                .accessibilityLabel(model.label("common.close"))
                .accessibilityIdentifier("project-sections-close")
            }
            .padding(.horizontal, 16).padding(.vertical, 8)
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if model.projectSectionOptions.flag("canCreate") && !model.projectSectionEditing {
                        Button { model.beginProjectSection() } label: {
                            HStack(spacing: 8) {
                                Image(systemName: "plus").accessibilityHidden(true)
                                Text(model.label("projects.addSection")).rnFont(15, .semibold)
                                Spacer(minLength: 8)
                            }
                            .foregroundStyle(palette.tint)
                            .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).disabled(!model.projectSectionAddEnabled)
                        .accessibilityIdentifier("project-section-add")
                    }
                    if model.projectSectionEditing {
                        TextField(model.label("projects.sectionPlaceholder"), text: Binding(
                            get: { model.projectSectionTitle },
                            set: { model.setProjectSectionTitle($0) }))
                            .focused($sectionFocused).submitLabel(.done)
                            .onSubmit { submitProjectSection() }
                            .rnFont(16).foregroundStyle(palette.text)
                            .padding(12).frame(minHeight: 48)
                            .background(palette.filter, in: RoundedRectangle(cornerRadius: 8))
                            .disabled(!model.projectSectionInputEnabled)
                            .accessibilityIdentifier("project-section-title")
                        HStack(spacing: 12) {
                            Button {
                                sectionFocused = false
                                UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
                                model.cancelProjectSection()
                            } label: {
                                Text(model.label("common.cancel"))
                                    .frame(maxWidth: .infinity, minHeight: 48).contentShape(Rectangle())
                            }
                            .disabled(!model.projectSectionCloseEnabled)
                            .accessibilityIdentifier("project-section-cancel")
                            Button { submitProjectSection() } label: {
                                Text(model.label("common.save"))
                                    .frame(maxWidth: .infinity, minHeight: 48).contentShape(Rectangle())
                            }
                            .disabled(!model.projectSectionCanSave)
                            .accessibilityIdentifier("project-section-save")
                        }
                        .buttonStyle(.plain).rnFont(14, .semibold).foregroundStyle(palette.tint)
                    }
                    if model.projectSectionRows.isEmpty {
                        Text(model.label("common.none")).rnFont(14).foregroundStyle(palette.secondary)
                    } else {
                        ForEach(model.projectSectionRows.indices, id: \.self) { index in
                            let row = model.projectSectionRows[index]
                            VStack(alignment: .leading, spacing: 0) {
                                Text(row.text("title")).rnFont(15).foregroundStyle(palette.text)
                                    .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                                    .accessibilityIdentifier("project-section-row-" + row.text("id"))
                                if model.projectSectionOptions.flag("canCreate") {
                                    HStack(spacing: 8) {
                                        Button { Task { await model.moveProjectSection(row.text("id"), direction: "up") } } label: {
                                            Image(systemName: "chevron.up")
                                                .foregroundStyle(palette.secondary)
                                                .frame(width: 48, height: 48).contentShape(Rectangle())
                                        }
                                        .buttonStyle(.plain).disabled(!model.projectSectionMoveEnabled(row.text("id"), direction: "up"))
                                        .accessibilityLabel(model.label("projects.moveUp") + ": " + row.text("title"))
                                        .accessibilityIdentifier("project-section-up-" + row.text("id"))
                                        Button { Task { await model.moveProjectSection(row.text("id"), direction: "down") } } label: {
                                            Image(systemName: "chevron.down")
                                                .foregroundStyle(palette.secondary)
                                                .frame(width: 48, height: 48).contentShape(Rectangle())
                                        }
                                        .buttonStyle(.plain).disabled(!model.projectSectionMoveEnabled(row.text("id"), direction: "down"))
                                        .accessibilityLabel(model.label("projects.moveDown") + ": " + row.text("title"))
                                        .accessibilityIdentifier("project-section-down-" + row.text("id"))
                                        Spacer(minLength: 0)
                                    }
                                    HStack(spacing: 12) {
                                        Button { Task { await model.beginProjectSectionRename(row.text("id")) } } label: {
                                            Text(model.label("common.edit")).rnFont(14, .semibold)
                                                .foregroundStyle(palette.tint)
                                                .frame(minWidth: 48, minHeight: 48).contentShape(Rectangle())
                                        }
                                        .buttonStyle(.plain).disabled(!model.projectSectionEditEnabled(row.text("id")))
                                        .accessibilityLabel(model.label("common.edit") + " " + row.text("title"))
                                        .accessibilityIdentifier("project-section-edit-" + row.text("id"))
                                        Button {
                                            Task {
                                                if await model.beginProjectSectionDelete(row.text("id")),
                                                   model.projectSectionDeleteConfirmationReady(row.text("id")) {
                                                    deleteSectionConfirmPresented = true
                                                }
                                            }
                                        } label: {
                                            Text(model.label("common.delete")).rnFont(14, .semibold)
                                                .foregroundStyle(palette.danger)
                                                .frame(minWidth: 48, minHeight: 48).contentShape(Rectangle())
                                        }
                                        .buttonStyle(.plain).disabled(!model.projectSectionDeleteEnabled(row.text("id")))
                                        .accessibilityLabel(model.label("common.delete") + " " + row.text("title"))
                                        .accessibilityIdentifier("project-section-delete-" + row.text("id"))
                                        Spacer(minLength: 0)
                                    }
                                }
                            }
                        }
                    }
                    if let message = model.projectSectionError {
                        Text(message).rnFont(13).foregroundStyle(palette.danger)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("project-section-error")
                        if model.projectSectionPending {
                            Button { Task { await model.retry() } } label: {
                                Text(model.label("common.retry"))
                                    .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain).disabled(model.busy)
                            .accessibilityIdentifier("project-section-retry")
                        }
                    }
                    if model.projectSectionReadRetryVisible {
                        if let message = model.projectSectionReadError {
                            Text(message).rnFont(13).foregroundStyle(palette.danger)
                                .fixedSize(horizontal: false, vertical: true)
                                .accessibilityIdentifier("project-section-read-error")
                        }
                        Button { Task { await model.retryProjectSectionRead() } } label: {
                            Text(model.label("common.retry"))
                                .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).disabled(!model.projectSectionCloseEnabled)
                        .accessibilityIdentifier("project-section-read-retry")
                    }
                }
                .padding(16)
            }
            .accessibilityIdentifier("project-sections-scroll")
        }
        .background(palette.card)
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isModal)
        .accessibilityIdentifier("project-sections-sheet")
        .onChange(of: model.projectSectionEditing) { if $0 { sectionFocused = true } }
        .onChange(of: model.projectSectionInputEnabled) { if $0 && model.projectSectionEditing { sectionFocused = true } }
    }

    private func submitProjectSection() {
        guard model.projectSectionCanSave else { return }
        sectionFocused = false
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        Task { await model.saveProjectSection() }
    }

    private var projectAttachmentsPanel: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(model.label("attachments.title")).rnFont(15, .semibold)
                .foregroundStyle(palette.text).accessibilityAddTraits(.isHeader)
            Button {
                resignProjectNotesInput()
                Task {
                    if let id = await model.prepareProjectFileImport(), model.projectFileImporterID == id {
                        filePickerID = id
                    }
                }
            } label: {
                Label(model.label("attachments.addFile"), systemImage: "doc.badge.plus")
                    .rnFont(14, .semibold).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain).foregroundStyle(palette.tint)
            .disabled(!model.projectFileAddOpenEnabled)
            .accessibilityIdentifier("project-attachment-add-file")
            if let message = model.projectFileAddError, !model.projectFileAddPending {
                Text(message).rnFont(13).foregroundStyle(palette.danger)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("project-attachment-add-error")
                Button { Task { await model.retryProjectFileAddRead() } } label: {
                    Text(model.label("common.retry")).rnFont(14, .semibold)
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(model.busy || model.retryNeeded)
                .accessibilityIdentifier("project-attachment-add-read-retry")
            }
            Button {
                model.openProjectAttachmentLinkSheet()
                resignProjectNotesInput()
            } label: {
                Label(model.label("attachments.addLink"), systemImage: "link")
                    .rnFont(14, .semibold).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain).foregroundStyle(palette.tint)
            .disabled(!model.projectAttachmentAddOpenEnabled)
            .accessibilityIdentifier("project-attachment-add-link")
            if let message = model.projectAttachmentWriteError ?? model.projectAttachmentEditReadError {
                Text(message).rnFont(13).foregroundStyle(palette.danger)
                    .fixedSize(horizontal: false, vertical: true)
                if model.projectAttachmentWritePending && model.retryNeeded {
                    Button { Task { await model.retry() } } label: {
                        Text(model.label("common.retry")).rnFont(14, .semibold)
                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).disabled(model.busy)
                    .accessibilityIdentifier("project-attachment-write-retry")
                } else if model.projectAttachmentEditReadError != nil {
                    Button { Task { await model.retryProjectAttachmentEditRead() } } label: {
                        Text(model.label("common.retry")).rnFont(14, .semibold)
                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).disabled(model.busy || model.retryNeeded)
                    .accessibilityIdentifier("project-attachment-edit-retry")
                }
            }
            if model.projectAttachmentScopeCurrent, let error = model.projectAttachmentError {
                Text(error).rnFont(13).foregroundStyle(palette.danger)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("project-attachments-error")
                Button { Task { await model.readProjectAttachments() } } label: {
                    Text(model.label("common.retry")).rnFont(14, .semibold)
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(Rectangle())
                }
                .buttonStyle(.plain).foregroundStyle(palette.tint)
                .disabled(model.busy || model.retryNeeded || model.projectAttachmentLoading)
                .accessibilityIdentifier("project-attachments-retry")
            } else if model.projectAttachmentScopeCurrent && model.projectAttachmentLoading {
                ProgressView().frame(minHeight: 44)
            }
            if model.projectAttachmentsVisible {
                ForEach(model.projectAttachmentRows.indices, id: \.self) { index in
                    let entry = model.projectAttachmentRows[index]
                    VStack(alignment: .leading, spacing: 4) {
                        if ["link", "file"].contains(entry.text("kind")) {
                            Button {
                                resignProjectNotesInput()
                                model.openProjectAttachment(entry.text("id"))
                            } label: {
                                Text(entry.text("title")).rnFont(14)
                                    .fixedSize(horizontal: false, vertical: true)
                                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain).foregroundStyle(palette.tint)
                            .disabled(!model.projectViewOpenEnabled || model.projectAttachmentOpening
                                || model.appLock.concealed || entry.flag("downloading"))
                            .accessibilityLabel(entry.text("title"))
                            .accessibilityIdentifier("project-attachment-open-" + entry.text("id"))
                        } else {
                            Text(entry.text("title")).rnFont(14).foregroundStyle(palette.text)
                                .fixedSize(horizontal: false, vertical: true)
                                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        }
                        if ["link", "file"].contains(entry.text("kind")) {
                            Button {
                                resignProjectNotesInput()
                                if entry.text("kind") == "file" { model.removeProjectAttachmentFile(entry.text("id")) }
                                else { model.removeProjectAttachmentLink(entry.text("id")) }
                            } label: {
                                Text(model.label("attachments.remove")).rnFont(13, .semibold)
                                    .frame(minWidth: 44, minHeight: 44, alignment: .leading)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain).foregroundStyle(palette.danger)
                            .disabled(!model.projectAttachmentRemoveEnabled)
                            .accessibilityIdentifier("project-attachment-remove-" + entry.text("id"))
                        }
                        if entry.text("kind") == "file", entry.flag("canDownload") {
                            Button {
                                resignProjectNotesInput()
                                model.downloadProjectAttachment(entry.text("id"))
                            } label: {
                                Label(model.label("attachments.download"), systemImage: "arrow.down.circle")
                                    .rnFont(13, .semibold)
                                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain).foregroundStyle(palette.tint)
                            .disabled(!model.projectAttachmentDownloadEnabled || entry.flag("downloading"))
                            .accessibilityIdentifier("project-attachment-download-" + entry.text("id"))
                        }
                        if model.projectAttachmentDownloadingID == entry.text("id") {
                            HStack {
                                ProgressView()
                                Text(model.label("common.loading")).rnFont(12).foregroundStyle(palette.secondary)
                            }
                            .accessibilityIdentifier("project-attachment-downloading-" + entry.text("id"))
                        } else if entry.flag("downloading") || entry.flag("missing") {
                            Text(model.label(entry.flag("downloading") ? "common.loading"
                                : "attachments.missing"))
                                .rnFont(12).foregroundStyle(palette.secondary)
                        }
                    }
                    .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(palette.border, lineWidth: 1))
                    .accessibilityElement(children: .contain)
                }
            }
        }
        .padding(12).frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.filter, in: RoundedRectangle(cornerRadius: 8))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("project-attachments")
    }

    private var projectNotesPanel: some View {
        ProjectNotesPanel(model: model, palette: palette, notesFocus: $notesFocused,
                          discardNotesConfirm: $discardNotesConfirm, onResign: resignProjectNotesInput)
    }

    private func metadataRow(_ caption: String, value: String, id: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(model.label(caption)).rnFont(12, .semibold).foregroundStyle(palette.secondary)
            Text(value).rnFont(14).foregroundStyle(palette.text).fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("project-detail-meta-" + id)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func projectScopeChip(_ scope: String, metadata: CoreObject) -> some View {
        let label = model.label(scope == "section" ? "projects.sequentialWithinSections" : "projects.sequentialAcrossSections")
        let selected = metadata.text("sequentialScopeLabel") == label
        return Button { resignProjectNotesInput(); Task { await model.setProjectScope(scope) } } label: {
            Text(label).rnFont(14, selected ? .semibold : .regular)
                .fixedSize(horizontal: false, vertical: true)
                .foregroundStyle(selected ? palette.onTint : palette.text)
                .padding(.horizontal, 12).frame(minHeight: 44)
                .background(selected ? palette.tint : palette.card, in: Capsule())
                .overlay(Capsule().stroke(selected ? palette.tint : palette.border, lineWidth: 1))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(!model.projectFlowInputEnabled)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityHint(model.label("projects.sequentialScopeHelpText"))
        .accessibilityIdentifier("project-flow-scope-" + scope)
    }

    private func submitRename() {
        guard model.projectRenameCanSave else { return }
        renameFocused = false
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        Task { await model.saveProjectRename() }
    }

    private func resignProjectNotesInput() {
        notesFocused = false
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    }
}

// Concrete boundaries keep the Notes view metadata shallow on iOS 17.
private struct ProjectNotesPanel: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    let notesFocus: FocusState<Bool>.Binding
    @Binding var discardNotesConfirm: Bool
    let onResign: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                AppIcon(name: "chevron", size: 16)
                    .rotationEffect(.degrees(model.projectNotesExpanded ? 0 : -90))
                    .foregroundStyle(palette.secondary).accessibilityHidden(true)
                Text(model.label("project.notes")).rnFont(15, .semibold).foregroundStyle(palette.text)
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .contentShape(Rectangle())
            .overlay {
                Button { onResign(); Task { await model.toggleProjectNotes() } } label: {
                    Color.clear.frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(!model.projectActionsEnabled)
                .accessibilityLabel(model.label("project.notes"))
                .accessibilityValue(model.label(model.projectNotesExpanded ? "markdown.collapse" : "markdown.expand"))
                .accessibilityIdentifier("project-notes-toggle")
            }
            if model.projectNotesExpanded {
                if !model.projectDetail.flag("readOnly") {
                    HStack(spacing: 8) {
                        Button {
                            onResign()
                            Task { await model.showProjectNotesEditor() }
                        } label: {
                            Text(model.label("markdown.edit")).rnFont(14, .semibold)
                                .frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(model.projectNotesEditMode ? palette.tint : palette.text)
                        .background(model.projectNotesEditMode ? palette.card : palette.filter,
                                    in: RoundedRectangle(cornerRadius: 8))
                        .disabled(!model.projectActionsEnabled || model.projectNotesEditMode)
                        .accessibilityIdentifier("project-notes-mode-edit")
                        Button {
                            onResign()
                            Task { await model.showProjectNotesPreview() }
                        } label: {
                            Text(model.label("markdown.preview")).rnFont(14, .semibold)
                                .frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(!model.projectNotesEditMode ? palette.tint : palette.text)
                        .background(!model.projectNotesEditMode ? palette.card : palette.filter,
                                    in: RoundedRectangle(cornerRadius: 8))
                        .disabled(!model.projectActionsEnabled || !model.projectNotesEditMode)
                        .accessibilityIdentifier("project-notes-mode-preview")
                    }
                }
                if let message = model.projectNotesEditError {
                    Text(message).rnFont(13).foregroundStyle(palette.danger).textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("project-notes-write-error")
                    if model.projectNotesWritePending {
                        Button { Task { await model.retry() } } label: {
                            Text(model.label("common.retry")).rnFont(14, .semibold)
                                .frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).disabled(model.busy)
                            .accessibilityIdentifier("project-notes-write-retry")
                    }
                }
                if let message = model.projectNotesEditReadError {
                    Text(message).rnFont(13).foregroundStyle(palette.danger).textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("project-notes-edit-read-error")
                    Button { Task { await model.retryProjectNotesEditRead() } } label: {
                        Text(model.label("common.retry")).rnFont(14, .semibold)
                            .frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).disabled(model.busy || model.retryNeeded || model.projectNotesWritePending)
                        .accessibilityIdentifier("project-notes-edit-read-retry")
                } else if model.projectNotesEditError != nil && !model.projectNotesWritePending {
                    Button { Task { await model.retryProjectNotesEditRead() } } label: {
                        Text(model.label("common.retry")).rnFont(14, .semibold)
                            .frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).disabled(model.busy || model.retryNeeded)
                        .accessibilityIdentifier("project-notes-edit-read-retry")
                }
                if model.projectNotesCanDiscard {
                    Button(model.label("common.discard"), role: .destructive) { discardNotesConfirm = true }
                        .rnFont(14, .semibold).frame(minHeight: 44)
                        .accessibilityIdentifier("project-notes-discard")
                }
                if model.projectNotesEditMode {
                    ProjectNotesEditor(model: model, palette: palette, notesFocus: notesFocus)
                } else {
                    ProjectNotesPreview(model: model, palette: palette)
                }
            }
        }
        .padding(12).frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.filter, in: RoundedRectangle(cornerRadius: 8))
        .onAppear { NSLog("Native iOS Project Notes panel rendered releaseCheck=v1.3.4/ios-project-notes-layout outcome=rendered") }
    }
}

private struct ProjectNotesEditor: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    let notesFocus: FocusState<Bool>.Binding

    var body: some View {
        Group {
            if model.projectNotesEditReady {
                ZStack(alignment: .topLeading) {
                    if model.projectNotesDraft.isEmpty {
                        Text(model.label("taskEdit.descriptionPlaceholder"))
                            .rnFont(14).foregroundStyle(palette.secondary).padding(.top, 8).padding(.leading, 5)
                            .accessibilityHidden(true)
                    }
                    TextEditor(text: Binding(get: { model.projectNotesDraft },
                                             set: { model.setProjectNotesDraft($0) }))
                        .focused(notesFocus)
                        .rnFont(15)
                        .scrollContentBackground(.hidden)
                        .frame(minHeight: 160)
                        .disabled(!model.projectNotesEditInputEnabled)
                        .environment(\.layoutDirection,
                            (model.projectNotesDraftDirection.isEmpty ? model.projectNotes.text("direction")
                                : model.projectNotesDraftDirection) == "rtl" ? .rightToLeft : .leftToRight)
                        .task(id: [model.projectHeader.text("id"), model.projectHeader.text("title"),
                                   model.projectNotesDraft, model.projectNotes.text("direction")]) {
                            await model.refreshProjectNotesDraftDirection()
                        }
                        .accessibilityIdentifier("project-notes-input")
                }
                .padding(8).background(palette.card, in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(palette.border, lineWidth: 1))
            } else if model.busy {
                ProgressView().frame(maxWidth: .infinity, minHeight: 44)
            }
        }
    }
}

private struct ProjectNotesPreview: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette

    var body: some View {
        Group {
            if let message = model.projectNotesError {
                Text(message).rnFont(13).foregroundStyle(palette.danger).textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("project-notes-error")
                Button { Task { await model.retryProjectNotes() } } label: {
                    Text(model.label("common.retry")).rnFont(14, .semibold)
                        .frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(!model.projectActionsEnabled)
                .accessibilityIdentifier("project-notes-retry")
            } else if model.projectNotesCurrent {
                let notes = model.projectNotes
                let blocks = notes.objects("blocks")
                if let message = model.projectNotesReferenceError {
                    Text(message).rnFont(13).foregroundStyle(palette.danger)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("project-notes-reference-error")
                    Button { Task { await model.retryProjectNotes() } } label: {
                        Text(model.label("common.retry")).rnFont(14, .semibold)
                            .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).disabled(!model.projectActionsEnabled)
                    .accessibilityIdentifier("project-notes-reference-retry")
                }
                if notes.number("total") == 0 {
                    Text(model.label("common.none")).rnFont(14).foregroundStyle(palette.secondary)
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        .accessibilityIdentifier("project-notes-empty")
                } else {
                    NativeMarkdownContent(blocks: blocks, labels: notes.object("markdownLabels"),
                                          strings: model.strings, palette: palette,
                                          onReference: model.projectNotesReferenceEnabled ? { block, item, inline in
                        Task { await model.openProjectNotesReference(projectID: notes.text("projectId"),
                            revision: notes.text("revision"), blockIndex: block, itemIndex: item, inlineIndex: inline) }
                    } : nil)
                        .environment(\.layoutDirection, notes.text("direction") == "rtl" ? .rightToLeft : .leftToRight)
                        .accessibilityElement(children: .contain)
                        .accessibilityIdentifier("project-notes-content")
                    if blocks.count < notes.number("total") {
                        Button { Task { await model.loadMoreProjectNotes() } } label: {
                            Text(model.label("common.more")).rnFont(14, .semibold)
                                .frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).disabled(!model.projectActionsEnabled)
                        .accessibilityIdentifier("project-notes-more")
                    }
                }
            } else if model.busy {
                ProgressView().frame(maxWidth: .infinity, minHeight: 44)
            }
        }
    }
}

private struct ProjectAttachmentLinkSheet: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette

    var body: some View {
        Group {
            if model.appLock.concealed {
                palette.card.ignoresSafeArea()
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        Text(model.label("attachments.addLink")).rnFont(18, .bold)
                            .foregroundStyle(palette.text).accessibilityAddTraits(.isHeader)
                        ZStack(alignment: .topLeading) {
                            TextEditor(text: Binding(get: { model.projectAttachmentLinkDraft },
                                                     set: { model.setProjectAttachmentLinkDraft($0) }))
                                .rnFont(16).scrollContentBackground(.hidden)
                                .textInputAutocapitalization(.never).autocorrectionDisabled()
                                .frame(minHeight: 130).padding(8)
                                .disabled(!model.projectAttachmentLinkInputEnabled)
                                .accessibilityLabel(model.label("attachments.linkPlaceholder"))
                                .accessibilityHint(model.label("attachments.linkBatchHint"))
                                .accessibilityIdentifier("project-attachment-link-input")
                            if model.projectAttachmentLinkDraft.isEmpty {
                                Text(model.label("attachments.linkPlaceholder"))
                                    .rnFont(16).foregroundStyle(palette.secondary)
                                    .padding(.horizontal, 13).padding(.vertical, 15)
                                    .allowsHitTesting(false).accessibilityHidden(true)
                            }
                        }
                        .background(palette.input, in: RoundedRectangle(cornerRadius: 10))
                        Text(model.label("attachments.linkBatchHint"))
                            .rnFont(13).foregroundStyle(palette.secondary)
                        if let message = model.projectAttachmentLinkError
                            ?? model.projectAttachmentEditReadError
                            ?? (model.projectAttachmentNeedsRead ? "Project links changed. Try again." : nil) {
                            Text(message).rnFont(13).foregroundStyle(palette.danger)
                                .fixedSize(horizontal: false, vertical: true)
                                .accessibilityIdentifier("project-attachment-link-error")
                        }
                        if model.projectAttachmentWritePending && model.retryNeeded {
                            Button { Task { await model.retry() } } label: {
                                Text(model.label("common.retry"))
                                    .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                            }
                                .disabled(model.busy)
                                .accessibilityIdentifier("project-attachment-write-retry")
                        } else if model.projectAttachmentEditReadError != nil || model.projectAttachmentNeedsRead {
                            Button {
                                Task { await model.retryProjectAttachmentEditRead() }
                            } label: {
                                Text(model.label("common.retry"))
                                    .frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                            }
                            .disabled(model.busy || model.retryNeeded)
                            .accessibilityIdentifier("project-attachment-edit-retry")
                        }
                        HStack {
                            Button { model.cancelProjectAttachmentLinkSheet() } label: {
                                Text(model.label("common.cancel"))
                                    .frame(minWidth: 44, minHeight: 44)
                                    .contentShape(Rectangle())
                            }
                                .disabled(model.busy || model.retryNeeded || model.projectAttachmentWritePending)
                                .accessibilityIdentifier("project-attachment-link-cancel")
                            Spacer()
                            Button {
                                UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder),
                                                                to: nil, from: nil, for: nil)
                                Task { await model.saveProjectAttachmentLinks() }
                            } label: {
                                Text(model.label("common.save"))
                                    .frame(minWidth: 44, minHeight: 44)
                                    .contentShape(Rectangle())
                            }
                            .disabled(!model.projectAttachmentLinkCanSave)
                            .accessibilityIdentifier("project-attachment-link-save")
                        }
                        .buttonStyle(.plain).foregroundStyle(palette.tint)
                    }
                    .padding(20).frame(maxWidth: .infinity, alignment: .leading)
                }
                .scrollDismissesKeyboard(.interactively)
                .background(palette.card)
            }
        }
    }
}

// Keep this concrete View boundary: expanding Details exceeded the iOS 17
// main-thread stack while resolving the former nested SwiftUI generic type.
private struct ProjectStatusMetadata: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    let metadata: CoreObject
    let onInteraction: () -> Void

    var body: some View {
        Group {
            if model.projectDetail.flag("readOnly") {
                statusRow
            } else {
                statusRow
                    .padding(.trailing, 32)
                    .frame(minHeight: 44)
                    .padding(8)
                    .background(palette.card, in: RoundedRectangle(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(palette.border, lineWidth: 1))
                    .contentShape(Rectangle())
                    .overlay(alignment: .trailing) {
                        AppIcon(name: "chevron", size: 16)
                            .rotationEffect(.degrees(model.projectStatusOpen ? 0 : -90))
                            .foregroundStyle(palette.secondary).accessibilityHidden(true)
                    }
                    .overlay {
                        Button {
                            onInteraction()
                            Task { await model.openProjectStatus() }
                        } label: {
                            Color.clear.frame(maxWidth: .infinity, minHeight: 44)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).disabled(!model.projectStatusOpenTapEnabled)
                        .accessibilityLabel(model.label("projects.statusLabel") + ": " + metadata.text("statusLabel"))
                        .accessibilityValue(model.label(model.projectStatusOpen ? "markdown.collapse" : "markdown.expand"))
                        .accessibilityIdentifier("project-status-open")
                    }
                if model.projectStatusOpen {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(["active", "waiting", "someday"], id: \.self) { status in
                            Button {
                                onInteraction()
                                Task { await model.changeProjectStatus(status) }
                            } label: {
                                HStack {
                                    Text(model.label("status." + status)).rnFont(14)
                                        .fixedSize(horizontal: false, vertical: true)
                                    Spacer(minLength: 8)
                                    if model.projectStatusSelectedStatus == status {
                                        Image(systemName: "checkmark").accessibilityHidden(true)
                                    }
                                }
                                .foregroundStyle(palette.text)
                                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain).disabled(!model.projectStatusPickTapEnabled)
                            .accessibilityAddTraits(model.projectStatusSelectedStatus == status ? .isSelected : [])
                            .accessibilityIdentifier("project-status-" + status)
                        }
                    }
                    .padding(.horizontal, 8)
                }
                if let message = model.projectStatusError {
                    Text(message).rnFont(13).foregroundStyle(palette.danger)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("project-status-error")
                    Button {
                        Task {
                            if model.projectStatusPending { await model.retry() }
                            else { await model.retryProjectStatusRead() }
                        }
                    } label: {
                        Text(model.label("common.retry"))
                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("project-status-retry")
                }
                ProjectStatusReadError(model: model, palette: palette)
            }
        }
    }

    private var statusRow: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(model.label("projects.statusLabel")).rnFont(12, .semibold).foregroundStyle(palette.secondary)
            Text(metadata.text("statusLabel")).rnFont(14).foregroundStyle(palette.text)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("project-detail-meta-status")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct ProjectStatusReadError: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    var body: some View {
        if let message = model.projectStatusReadError {
            Text(message).rnFont(13).foregroundStyle(palette.danger)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("project-status-read-error")
            Button {
                Task { await model.retryProjectStatusRead() }
            } label: {
                Text(model.label("common.retry"))
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("project-status-read-retry")
        }
    }
}

private struct ProjectSectionsMetadata: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    let metadata: CoreObject
    let onOpen: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            let sections = metadata.objects("sections")
            HStack(spacing: 8) {
                Text(model.label("projects.sectionsLabel"))
                    .rnFont(12, .semibold).foregroundStyle(palette.secondary)
                Spacer(minLength: 8)
                if !model.projectDetail.flag("readOnly") || !sections.isEmpty {
                    Button(action: onOpen) {
                        Text(model.label(sections.isEmpty ? "projects.addSection" : "settings.manage"))
                            .rnFont(14, .semibold).foregroundStyle(palette.tint)
                            .frame(minWidth: 48, minHeight: 48).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).disabled(!model.projectSectionOpenTapEnabled)
                    .accessibilityIdentifier("project-sections-open")
                }
            }
            Text(sections.isEmpty ? model.label("common.none")
                : sections.map { $0.text("title") }.joined(separator: "\n"))
                .rnFont(14).foregroundStyle(palette.text)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("project-detail-meta-sections")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// Keep the three date rows behind concrete View boundaries so expanding Details
// does not resolve their nested SwiftUI types in the parent body on iOS 17.
private struct ProjectDatesMetadata: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    let metadata: CoreObject
    let onResignNotes: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            ProjectDateMetadataRow(model: model, palette: palette, field: "startDate",
                                   value: metadata.text("startDateLabel"),
                                   hasValue: metadata.flag("hasStartDate"), onResignNotes: onResignNotes)
            ProjectDateMetadataRow(model: model, palette: palette, field: "dueDate",
                                   value: metadata.text("dueDateLabel"),
                                   hasValue: metadata.flag("hasDueDate"), onResignNotes: onResignNotes)
            ProjectDateMetadataRow(model: model, palette: palette, field: "reviewAt",
                                   value: metadata.text("reviewDateLabel"),
                                   hasValue: metadata.flag("hasReviewDate"), onResignNotes: onResignNotes)
        }
        .padding(12).frame(maxWidth: .infinity, alignment: .leading)
        .background(palette.filter, in: RoundedRectangle(cornerRadius: 8))
    }
}

private struct ProjectDateMetadataRow: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    let field: String
    let value: String
    let hasValue: Bool
    let onResignNotes: () -> Void

    var body: some View {
        let start = field == "startDate"
        let prefix = start ? "project-start-date" : field == "reviewAt" ? "project-review-date" : "project-due-date"
        let label = model.label(start ? "taskEdit.startDateLabel"
            : field == "reviewAt" ? "projects.reviewAt" : "taskEdit.dueDateLabel")
        return VStack(alignment: .leading, spacing: 6) {
            Text(label).rnFont(12, .semibold).foregroundStyle(palette.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack(alignment: .center, spacing: 8) {
                Button {
                    onResignNotes()
                    Task { await model.openProjectDate(field) }
                } label: {
                    Text(value.isEmpty ? model.label("common.notSet") : value)
                        .rnFont(14).foregroundStyle(palette.text)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                        .padding(.horizontal, 10)
                        .background(palette.card, in: RoundedRectangle(cornerRadius: 8))
                        .overlay(RoundedRectangle(cornerRadius: 8).stroke(palette.border, lineWidth: 1))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(!model.projectDateTapEnabled)
                .accessibilityLabel(label + ": " + (value.isEmpty ? model.label("common.notSet") : value))
                .accessibilityIdentifier(prefix + "-open")
                if hasValue {
                    Button {
                        onResignNotes()
                        Task { await model.changeProjectDate(field, value: nil) }
                    } label: {
                        Image(systemName: "xmark.circle").font(.system(size: 19))
                            .foregroundStyle(palette.secondary)
                            .frame(minWidth: 48, minHeight: 48).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).disabled(!model.projectDateTapEnabled)
                    .accessibilityLabel(model.label("common.clear") + " " + label)
                    .accessibilityIdentifier(prefix + "-clear")
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// Concrete metadata and sheet boundaries keep Details' iOS 17 View type bounded.
private struct ProjectTagsMetadata: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    let metadata: CoreObject
    let onOpen: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text(model.label("taskEdit.tagsLabel"))
                    .rnFont(12, .semibold).foregroundStyle(palette.secondary)
                Spacer(minLength: 8)
                if !model.projectDetail.flag("readOnly") {
                    Button(action: onOpen) {
                        Text(model.label("common.edit"))
                            .rnFont(14, .semibold).foregroundStyle(palette.tint)
                            .frame(minWidth: 48, minHeight: 48).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).disabled(!model.projectTagsOpenEnabled)
                    .accessibilityLabel(model.label("taskEdit.tagsLabel") + ": " + metadata.text("tagsLabel"))
                    .accessibilityIdentifier("project-tags-open")
                }
            }
            Text(metadata.text("tagsLabel"))
                .rnFont(14).foregroundStyle(palette.text)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("project-detail-meta-tags")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct ProjectTagsSelectionSheet: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 12) {
                    Text(model.label("taskEdit.tagsLabel"))
                        .rnFont(20, .bold).foregroundStyle(palette.text)
                        .accessibilityAddTraits(.isHeader)
                    Spacer(minLength: 8)
                    Button { model.closeProjectTags() } label: {
                        Image(systemName: "xmark").font(.system(size: 20))
                            .foregroundStyle(palette.secondary)
                            .frame(width: 48, height: 48).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).disabled(!model.projectTagsCloseEnabled)
                    .accessibilityLabel(model.label("common.close"))
                    .accessibilityIdentifier("project-tags-close")
                }
                if let message = model.projectTagsError {
                    Text(message).rnFont(13).foregroundStyle(palette.danger)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("project-tags-error")
                    if model.projectTagsPending && model.retryNeeded {
                        Button { Task { await model.retry() } } label: {
                            Text(model.label("common.retry"))
                                .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).disabled(model.busy)
                        .accessibilityIdentifier("project-tags-retry")
                    }
                }
                if model.projectTagsReadError != nil || model.projectTagsNeedsRead {
                    if let message = model.projectTagsReadError {
                        Text(message).rnFont(13).foregroundStyle(palette.danger)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Button { Task { await model.retryProjectTagsRead() } } label: {
                        Text(model.label("common.retry"))
                            .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).disabled(model.busy || model.retryNeeded || model.projectTagsPending)
                    .accessibilityIdentifier("project-tags-read-retry")
                }
                if model.projectTagsAddPresented {
                    ProjectTagsAddForm(model: model, palette: palette)
                } else if !model.projectTagsOptions.isEmpty {
                    Button { model.openProjectTagsAdd() } label: {
                        Text(model.label("common.add"))
                            .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                            .padding(.horizontal, 12).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).disabled(!model.projectTagsChoiceEnabled)
                    .accessibilityIdentifier("project-tags-add")
                    let suggestions = model.projectTagsOptions["suggestions"] as? [String] ?? []
                    ForEach(suggestions.indices, id: \.self) { index in
                        Button { Task { await model.toggleProjectTag(index) } } label: {
                            HStack(spacing: 10) {
                                Text(suggestions[index]).rnFont(16).foregroundStyle(palette.text)
                                    .fixedSize(horizontal: false, vertical: true)
                                Spacer(minLength: 8)
                                if model.projectTagsChoiceSelected(index) {
                                    Image(systemName: "checkmark").foregroundStyle(palette.tint)
                                        .accessibilityHidden(true)
                                }
                            }
                            .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                            .padding(.horizontal, 12)
                            .background(palette.filter, in: RoundedRectangle(cornerRadius: 8))
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).disabled(!model.projectTagsChoiceEnabled)
                        .accessibilityLabel(suggestions[index])
                        .accessibilityAddTraits(model.projectTagsChoiceSelected(index) ? .isSelected : [])
                        .accessibilityIdentifier("project-tags-choice-" + String(index))
                    }
                    Button { Task { await model.clearProjectTags() } } label: {
                        Text(model.label("common.clear"))
                            .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                            .padding(.horizontal, 12).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).disabled(!model.projectTagsChoiceEnabled)
                    .accessibilityIdentifier("project-tags-clear")
                } else if model.projectTagsReadError == nil {
                    ProgressView().frame(maxWidth: .infinity, minHeight: 48)
                }
            }
            .padding(20).frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(palette.card)
        .accessibilityIdentifier("project-tags-sheet")
    }
}

private struct ProjectTagsAddForm: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    @FocusState private var nameFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            TextField(model.label("taskEdit.tagsLabel"), text: Binding(
                get: { model.projectTagsDraft }, set: { model.setProjectTagsDraft($0) }))
                .focused($nameFocused).submitLabel(.done)
                .onSubmit { submit() }
                .onChange(of: model.projectTagsAddInputEnabled) {
                    if !$0 {
                        nameFocused = false
                        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder),
                                                        to: nil, from: nil, for: nil)
                    }
                }
                .rnFont(16).padding(.horizontal, 12).frame(minHeight: 48)
                .background(palette.input, in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(palette.border, lineWidth: 1))
                .disabled(!model.projectTagsAddInputEnabled)
                .accessibilityLabel(model.label("taskEdit.tagsLabel"))
                .accessibilityIdentifier("project-tags-create-name")
            HStack(spacing: 12) {
                Button {
                    nameFocused = false
                    UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
                    model.cancelProjectTagsAdd()
                } label: {
                    Text(model.label("common.cancel"))
                        .frame(maxWidth: .infinity, minHeight: 48).contentShape(Rectangle())
                }
                .disabled(model.busy || model.retryNeeded || model.projectTagsPending)
                .accessibilityIdentifier("project-tags-create-cancel")
                Button { submit() } label: {
                    Text(model.label("common.add"))
                        .frame(maxWidth: .infinity, minHeight: 48).contentShape(Rectangle())
                }
                .disabled(!model.projectTagsAddCanSubmit)
                .accessibilityIdentifier("project-tags-create-save")
            }
            .buttonStyle(.plain).rnFont(15, .semibold).foregroundStyle(palette.tint)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("project-tags-create-form")
    }

    private func submit() {
        guard model.projectTagsAddCanSubmit else { return }
        nameFocused = false
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        Task { await model.addProjectTag() }
    }
}

// A concrete boundary keeps the Area control out of Details' iOS 17 opaque View type.
private struct ProjectAreaMetadata: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    let metadata: CoreObject
    let onOpen: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text(model.label("projects.areaLabel"))
                    .rnFont(12, .semibold).foregroundStyle(palette.secondary)
                Spacer(minLength: 8)
                if !model.projectDetail.flag("readOnly") {
                    Button(action: onOpen) {
                        Text(model.label("common.edit"))
                            .rnFont(14, .semibold).foregroundStyle(palette.tint)
                            .frame(minWidth: 48, minHeight: 48).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).disabled(!model.projectAreaOpenEnabled)
                    .accessibilityLabel(model.label("projects.areaLabel") + ": " + metadata.text("areaLabel"))
                    .accessibilityIdentifier("project-area-open")
                }
            }
            Text(metadata.text("areaLabel"))
                .rnFont(14).foregroundStyle(palette.text)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("project-detail-meta-area")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct ProjectAreaSelectionSheet: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette

    var body: some View {
        if model.areaManagerPresented {
            AreaManagerSheet(model: model, palette: palette)
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 12) {
                    Text(model.label("projects.areaLabel"))
                        .rnFont(20, .bold).foregroundStyle(palette.text)
                        .accessibilityAddTraits(.isHeader)
                    Spacer(minLength: 8)
                    Button { model.closeProjectArea() } label: {
                        Image(systemName: "xmark").font(.system(size: 20))
                            .foregroundStyle(palette.secondary)
                            .frame(width: 48, height: 48).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).disabled(!model.projectAreaCloseEnabled)
                    .accessibilityLabel(model.label("common.close"))
                    .accessibilityIdentifier("project-area-close")
                }
                if model.projectAreaCreatePresented {
                    ProjectAreaCreateForm(model: model, palette: palette)
                } else {
                if let message = model.projectAreaError {
                    Text(message).rnFont(13).foregroundStyle(palette.danger)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("project-area-error")
                    Button {
                        Task {
                            if model.projectAreaPending { await model.retry() }
                            else { await model.retryProjectAreaRead() }
                        }
                    } label: {
                        Text(model.label("common.retry"))
                            .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).disabled(model.busy)
                    .accessibilityIdentifier("project-area-retry")
                }
                if model.projectAreaReadError != nil || model.projectAreaNeedsRead {
                    if let message = model.projectAreaReadError {
                        Text(message).rnFont(13).foregroundStyle(palette.danger)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("project-area-read-error")
                    }
                    Button { Task { await model.retryProjectAreaRead() } } label: {
                        Text(model.label("common.retry"))
                            .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).disabled(model.busy || model.retryNeeded || model.projectAreaPending)
                    .accessibilityIdentifier("project-area-read-retry")
                }
                if !model.projectAreaOptions.isEmpty {
                    if model.projectAreaCreatedStatusVisible {
                        Text(model.label("projects.areaAvailableSelectToAssign"))
                            .rnFont(14).foregroundStyle(palette.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                            .accessibilityIdentifier("project-area-created-status")
                    }
                    let noneSelected = model.projectAreaSelectedID == nil
                    areaChoice(model.projectAreaOptions.text("noAreaLabel"), color: nil,
                               selected: noneSelected, identifier: "project-area-none") {
                        Task { await model.chooseProjectArea(nil, name: nil) }
                    }
                    Button { Task { await model.openProjectAreaCreate() } } label: {
                        Label(model.label("common.add") + " " + model.label("projects.areaLabel"),
                              systemImage: "plus")
                            .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                            .padding(.horizontal, 12).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).disabled(!model.projectAreaAddEnabled)
                    .accessibilityIdentifier("project-area-add")
                    Button { Task { await model.openProjectAreaManager() } } label: {
                        Label(model.label("projects.manageAreas"), systemImage: "slider.horizontal.3")
                            .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                            .padding(.horizontal, 12).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).disabled(!model.projectAreaManagerOpenEnabled)
                    .accessibilityIdentifier("project-area-manage")
                    let areas = model.projectAreaOptions.objects("areas")
                    ForEach(areas.indices, id: \.self) { index in
                        let area = areas[index]
                        let id = area.text("id")
                        let name = area.text("label")
                        areaChoice(name, color: area["color"] as? String,
                                   selected: model.projectAreaSelectedID == id,
                                   identifier: "project-area-choice-" + id) {
                            Task { await model.chooseProjectArea(id, name: name) }
                        }
                    }
                } else if model.projectAreaReadError == nil {
                    ProgressView().frame(maxWidth: .infinity, minHeight: 48)
                }
                }
                }
                .padding(20).frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(palette.card)
            .accessibilityIdentifier("project-area-sheet")
        }
    }

    private func areaChoice(_ label: String, color: String?, selected: Bool,
                            identifier: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                if let color, !color.isEmpty {
                    Circle().fill(Color(hex: color)).frame(width: 12, height: 12)
                        .overlay(Circle().stroke(palette.border, lineWidth: 1))
                        .accessibilityHidden(true)
                }
                Text(label).rnFont(16).foregroundStyle(palette.text)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 8)
                if selected {
                    Image(systemName: "checkmark").foregroundStyle(palette.tint)
                        .accessibilityHidden(true)
                }
            }
            .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
            .padding(.horizontal, 12)
            .background(palette.filter, in: RoundedRectangle(cornerRadius: 8))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(!model.projectAreaChoiceEnabled)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityIdentifier(identifier)
    }
}

private struct ProjectAreaCreateForm: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    @FocusState private var nameFocused: Bool

    private var colors: [String] { model.areaCreateOptions["colors"] as? [String] ?? [] }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(model.label("common.add") + " " + model.label("projects.areaLabel"))
                .rnFont(16, .semibold).foregroundStyle(palette.text)
                .accessibilityAddTraits(.isHeader)
            TextField(model.label("projects.areaLabel"), text: Binding(
                get: { model.projectAreaCreateName }, set: { model.setProjectAreaCreateName($0) }))
                .focused($nameFocused).submitLabel(.done)
                .onSubmit { submit() }
                .rnFont(16).padding(.horizontal, 12).frame(minHeight: 48)
                .background(palette.input, in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(palette.border, lineWidth: 1))
                .disabled(!model.projectAreaCreateInputEnabled)
                .contentShape(Rectangle()).onTapGesture {
                    if model.projectAreaCreateInputEnabled { nameFocused = true }
                }
                .accessibilityLabel(model.label("projects.areaLabel"))
                .accessibilityIdentifier("project-area-create-name")
            if model.projectAreaCreateNameTaken {
                Text(model.label("areas.nameExists")).rnFont(13).foregroundStyle(palette.danger)
                    .accessibilityIdentifier("project-area-create-name-taken")
            }
            if model.projectAreaCreateNameChecking {
                ProgressView().accessibilityIdentifier("project-area-create-name-checking")
            }
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 44), spacing: 10)], spacing: 10) {
                ForEach(colors, id: \.self) { color in
                    Button { model.selectProjectAreaCreateColor(color) } label: {
                        Circle().fill(Color(hex: color)).frame(width: 34, height: 34)
                            .frame(width: 44, height: 44)
                            .overlay(Circle().stroke(model.projectAreaCreateColor == color
                                ? palette.tint : palette.border,
                                lineWidth: model.projectAreaCreateColor == color ? 3 : 1))
                    }
                    .buttonStyle(.plain).disabled(!model.projectAreaCreateInputEnabled)
                    .accessibilityLabel(color)
                    .accessibilityAddTraits(model.projectAreaCreateColor == color ? .isSelected : [])
                    .accessibilityIdentifier("project-area-create-color-" + color)
                }
            }
            if let message = model.areaCreateError {
                Text(message).rnFont(13).foregroundStyle(palette.danger)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("project-area-create-error")
                if model.areaCreatePending && model.retryNeeded {
                    Button { Task { await model.retry() } } label: {
                        Text(model.label("common.retry"))
                            .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).disabled(model.busy)
                    .accessibilityIdentifier("project-area-create-retry")
                }
            }
            if let message = model.areaCreateReadError {
                Text(message).rnFont(13).foregroundStyle(palette.danger)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("project-area-create-read-error")
                Button { Task { await model.retryProjectAreaCreateRead() } } label: {
                    Text(model.label("common.retry"))
                        .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain).disabled(model.busy || model.retryNeeded)
                .accessibilityIdentifier("project-area-create-read-retry")
            }
            if model.busy { ProgressView().frame(maxWidth: .infinity, minHeight: 48) }
            HStack(spacing: 12) {
                Button { model.cancelProjectAreaCreate() } label: {
                    Text(model.label("common.cancel"))
                        .frame(maxWidth: .infinity, minHeight: 48).contentShape(Rectangle())
                }
                .disabled(model.busy || model.retryNeeded || model.areaCreatePending)
                .accessibilityIdentifier("project-area-create-cancel")
                Button { submit() } label: {
                    Text(model.label("common.add"))
                        .frame(maxWidth: .infinity, minHeight: 48).contentShape(Rectangle())
                }
                .disabled(!model.projectAreaCreateCanSubmit)
                .accessibilityIdentifier("project-area-create-save")
            }
            .buttonStyle(.plain).rnFont(15, .semibold).foregroundStyle(palette.tint)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("project-area-create-form")
    }

    private func submit() {
        guard model.projectAreaCreateCanSubmit else { return }
        nameFocused = false
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
        Task { await model.addArea() }
    }
}

/// UIKit keeps section headings fixed as drag sources while allowing tasks to cross them.
private struct ProjectTaskOrderTable: UIViewRepresentable {
    @ObservedObject var model: CoreModel
    let palette: AppPalette

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> UITableView {
        let table = UITableView(frame: .zero, style: .plain)
        table.dataSource = context.coordinator
        table.delegate = context.coordinator
        table.separatorStyle = .none
        table.rowHeight = UITableView.automaticDimension
        table.estimatedRowHeight = 90
        table.allowsSelection = false
        table.setEditing(true, animated: false)
        table.accessibilityIdentifier = "project-task-order-list"
        return table
    }

    func updateUIView(_ table: UITableView, context: Context) {
        let coordinator = context.coordinator
        coordinator.parent = self
        table.backgroundColor = UIColor(palette.bg)
        table.isUserInteractionEnabled = model.projectTaskOrderInputEnabled
        // Keep UIKit's drag preview until the durable result or failure is known.
        if !model.busy && (coordinator.revision != model.projectTaskOrderView.text("revision") || coordinator.moving) {
            coordinator.rows = model.projectTaskOrderView.objects("items")
            coordinator.revision = model.projectTaskOrderView.text("revision")
            coordinator.moving = false
            table.reloadData()
        }
    }

    final class Coordinator: NSObject, UITableViewDataSource, UITableViewDelegate {
        var parent: ProjectTaskOrderTable
        var rows: [CoreObject] = []
        var revision = ""
        var moving = false

        init(_ parent: ProjectTaskOrderTable) { self.parent = parent }

        func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { rows.count }

        func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
            let cell = tableView.dequeueReusableCell(withIdentifier: "order") ?? UITableViewCell(style: .default, reuseIdentifier: "order")
            let item = rows[indexPath.row]
            let model = parent.model
            let palette = parent.palette
            cell.backgroundColor = UIColor(palette.bg)
            cell.selectionStyle = .none
            cell.showsReorderControl = item.text("type") == "task"
            cell.contentConfiguration = UIHostingConfiguration {
                Group {
                    if item.text("type") == "section" {
                        Text(item.text("title")).rnFont(13, .bold)
                            .foregroundStyle(item.flag("muted") ? palette.secondary : palette.text)
                            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                            .accessibilityAddTraits(.isHeader)
                            .accessibilityIdentifier("project-task-order-section-" + item.text("id"))
                    } else {
                        TaskCard(row: item.object("row"), model: model, palette: palette)
                            .allowsHitTesting(false)
                            .accessibilityElement(children: .ignore)
                            .accessibilityLabel(item.object("row").text("title"))
                            .accessibilityIdentifier("project-task-order-row-" + item.object("row").text("id"))
                    }
                }
            }.margins(.horizontal, 12).margins(.vertical, 4)
            return cell
        }

        func tableView(_ tableView: UITableView, canMoveRowAt indexPath: IndexPath) -> Bool {
            parent.model.projectTaskOrderInputEnabled && rows[indexPath.row].text("type") == "task"
        }

        func tableView(_ tableView: UITableView, editingStyleForRowAt indexPath: IndexPath) -> UITableViewCell.EditingStyle { .none }
        func tableView(_ tableView: UITableView, shouldIndentWhileEditingRowAt indexPath: IndexPath) -> Bool { false }
        func tableView(_ tableView: UITableView, targetIndexPathForMoveFromRowAt source: IndexPath,
                       toProposedIndexPath proposed: IndexPath) -> IndexPath { proposed }

        func tableView(_ tableView: UITableView, moveRowAt source: IndexPath, to destination: IndexPath) {
            let model = parent.model
            guard model.projectTaskOrderInputEnabled, rows.indices.contains(source.row),
                  rows.indices.contains(destination.row), rows[source.row].text("type") == "task",
                  rows.map(model.projectTaskOrderItemID) == model.projectTaskOrderView.objects("items").map(model.projectTaskOrderItemID) else {
                tableView.reloadData()
                return
            }
            moving = true
            rows.insert(rows.remove(at: source.row), at: destination.row)
            let insertion = destination.row > source.row ? destination.row + 1 : destination.row
            Task { @MainActor in
                await model.moveProjectTask(from: IndexSet(integer: source.row), to: insertion)
                // A rejected/no-op callback may not publish a state change.
                rows = model.projectTaskOrderView.objects("items")
                revision = model.projectTaskOrderView.text("revision")
                moving = false
                tableView.reloadData()
            }
        }
    }
}
