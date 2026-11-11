import SwiftUI

struct MoreMenuSheet: View {
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @ObservedObject var model: CoreModel
    let palette: AppPalette

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .bottom) {
                Button { model.closeMore() } label: {
                    Color.black.opacity(0.36).contentShape(Rectangle())
                }
                .buttonStyle(.plain).ignoresSafeArea(edges: .top).disabled(model.busy || model.retryNeeded)
                .accessibilityLabel(model.label("common.close")).accessibilityIdentifier("menu-dismiss")
                VStack(spacing: 0) {
                    Capsule().fill(palette.border).frame(width: 44, height: 5).padding(.bottom, 18).accessibilityHidden(true)
                    ViewThatFits(in: .vertical) {
                        content.fixedSize(horizontal: false, vertical: true)
                        ScrollView { content }
                    }
                }
                .padding(.top, 10).padding(.horizontal, 18).padding(.bottom, 16)
                .frame(maxWidth: 860, maxHeight: geometry.size.height * 0.82, alignment: .bottom)
                .fixedSize(horizontal: false, vertical: true)
                .background(palette.card, in: RoundedRectangle(cornerRadius: 24))
                .overlay(RoundedRectangle(cornerRadius: 24).stroke(palette.border, lineWidth: 0.5))
                .background(alignment: .bottom) { palette.card.frame(height: 24) }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
            .accessibilityElement(children: .contain)
            .accessibilityAction(.escape) { model.closeMore() }
        }
    }

    private var content: some View {
        VStack(spacing: 0) {
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 4), count: dynamicTypeSize.isAccessibilitySize ? 2 : 4), spacing: 4) {
                let utilities = model.moreMenu.objects("utilities")
                ForEach(utilities.indices, id: \.self) { index in compactItem(utilities[index]) }
            }
            let saved = model.moreMenu.object("savedSearches").objects("items")
            if !saved.isEmpty {
                Text(model.moreMenu.text("savedSearchesTitle").uppercased()).rnFont(12, .heavy)
                    .foregroundStyle(palette.secondary).frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 18).padding(.bottom, 8).accessibilityAddTraits(.isHeader)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 10) {
                        ForEach(saved.indices, id: \.self) { index in compactItem(saved[index]).frame(width: dynamicTypeSize.isAccessibilitySize ? 180 : 76) }
                        if saved.count < model.moreMenu.object("savedSearches").number("total") {
                            Button(model.label("common.more")) { Task { await model.loadMoreSavedSearchMenu() } }
                                .rnFont(12, .semibold).frame(minWidth: 44, minHeight: 58)
                                .disabled(model.busy || model.retryNeeded)
                                .accessibilityIdentifier("menu-saved-search-more")
                        }
                    }
                }
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("menu-saved-search-scroll")
            }
            palette.border.frame(height: 0.5).padding(.vertical, 12)
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 10), count: dynamicTypeSize.isAccessibilitySize ? 1 : 3), spacing: 10) {
                let primary = model.moreMenu.objects("primary")
                ForEach(primary.indices, id: \.self) { index in tile(primary[index]) }
            }
            if model.error != nil { FailureBanner(model: model, palette: palette) }
        }
        .padding(.bottom, 8)
    }

    private func compactItem(_ item: CoreObject) -> some View {
        let isHistory = item.text("id") == "history" && item.text("route") == "/history"
        let isTrash = item.text("id") == "trash" && item.text("route") == "/trash"
        let isBoard = item.text("id") == "board" && item.text("route") == "/board"
        let isSettings = item.text("id") == "settings" && item.text("route") == "/settings"
        let isSavedSearch = item.text("route").hasPrefix("/saved-search/")
        let supported = isHistory || isTrash || isBoard || isSettings || isSavedSearch
        return Button {
            if isHistory { Task { await model.openHistory() } }
            else if isTrash { Task { await model.openTrash() } }
            else if isBoard { Task { await model.openBoard() } }
            else if isSettings { Task { await model.openSettings() } }
            else if isSavedSearch { Task { await model.openSavedSearch(item) } }
        } label: {
            VStack(spacing: 4) {
                Image(systemName: item.text("icon")).font(.system(size: 18))
                    .foregroundStyle(palette.einkSafe(Color(hex: item.text("iconColor")))).opacity(supported ? 1 : 0.64).accessibilityHidden(true)
                Text(item.text("displayLabel")).rnFont(10, .bold).foregroundStyle(palette.secondary)
                    .multilineTextAlignment(.center).frame(minHeight: 16)
            }
            .padding(.horizontal, 2).padding(.vertical, 4).frame(maxWidth: .infinity, minHeight: 58).contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(!supported || model.busy || model.retryNeeded).opacity(supported ? 1 : 0.55)
        .accessibilityLabel(item.text("label")).accessibilityIdentifier("menu-" + item.text("id"))
    }

    private func tile(_ item: CoreObject) -> some View {
        let supported = ["projects", "waiting", "someday", "reference", "contexts", "review", "calendar", "board"].contains(item.text("id"))
        let enabled = supported && !model.busy && !model.retryNeeded
        return Button {
            Task {
                if item.text("id") == "contexts" { await model.openContexts() }
                else if item.text("id") == "waiting" { await model.openWaiting() }
                else if item.text("id") == "someday" { await model.openSomeday() }
                else if item.text("id") == "reference" { await model.openReference() }
                else if item.text("id") == "projects" { await model.openProjects() }
                else if item.text("id") == "review" { await model.openReview() }
                else if item.text("id") == "calendar" { await model.openCalendar() }
                else if item.text("id") == "board" { await model.openBoard() }
            }
        } label: {
            VStack(spacing: 8) {
                Image(systemName: item.text("icon")).font(.system(size: 24))
                    .foregroundStyle(palette.einkSafe(Color(hex: item.text("iconColor")))).frame(width: 44, height: 44)
                    .background(palette.filter, in: RoundedRectangle(cornerRadius: 8)).accessibilityHidden(true)
                Text(item.text("displayLabel")).rnFont(12, .bold).foregroundStyle(palette.text).multilineTextAlignment(.center)
            }
            .padding(.horizontal, 8).padding(.vertical, 12).frame(maxWidth: .infinity, minHeight: 104)
            .background(palette.card, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(palette.border, lineWidth: 1)).contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(!enabled).opacity(supported ? 1 : 0.55)
        .accessibilityLabel(item.text("label")).accessibilityIdentifier("menu-" + item.text("id"))
    }
}
