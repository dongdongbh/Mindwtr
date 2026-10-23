import SwiftUI
import UIKit
import Combine

// MARK: Board drag geometry and claim (Foundation-only seam)
struct BoardDragRowFrame: Equatable {
    let status: String
    let id: String
    let frame: CGRect
}

struct BoardDragColumnFrame: Equatable {
    let status: String
    let frame: CGRect
}

struct BoardDragMeasurements: Equatable {
    var viewports: [CGRect] = []
    var columns: [BoardDragColumnFrame] = []
    var rows: [BoardDragRowFrame] = []

    func geometry(for capture: BoardOrderDragCapture) -> BoardDragGeometry? {
        let areas = columns.filter { $0.status == capture.status }
        guard viewports.count == 1, areas.count == 1 else { return nil }
        return BoardDragGeometry(viewport: viewports[0], area: areas[0].frame,
                                 rows: rows.filter { $0.status == capture.status })
    }

    func moveTarget(at point: CGPoint, status: String, capture: BoardOrderDragCapture) -> BoardDropTarget? {
        guard ["inbox", "next", "waiting", "someday", "done"].contains(capture.status),
              status != capture.status,
              (status == "done" ? capture.completionAllowed : capture.moveAllowed && ["inbox", "next", "waiting", "someday"].contains(status)),
              point.x.isFinite, point.y.isFinite, viewports.count == 1,
              geometry(for: capture)?.canBegin(capture) == true else { return nil }
        let areas = columns.filter { $0.status == status }
        guard areas.count == 1, BoardDragGeometry.valid(viewports[0]), BoardDragGeometry.valid(areas[0].frame),
              CGRect(origin: .zero, size: areas[0].frame.size).contains(point),
              viewports[0].contains(CGPoint(x: areas[0].frame.minX + point.x, y: areas[0].frame.minY + point.y)) else { return nil }
        return status == "done" ? .complete : .move(status: status)
    }
}

struct BoardDropPosition: Equatable {
    let afterID: String?
    let y: CGFloat
}

enum BoardDropTarget: Equatable {
    case order(BoardDropPosition)
    case move(status: String)
    case complete
}

struct BoardDragGeometry: Equatable {
    let viewport: CGRect
    let area: CGRect
    let rows: [BoardDragRowFrame]

    static func valid(_ frame: CGRect) -> Bool {
        [frame.minX, frame.minY, frame.width, frame.height, frame.maxX, frame.maxY].allSatisfy { $0.isFinite }
            && frame.size.width > 0 && frame.size.height > 0
    }

    private func visibleRows(_ capture: BoardOrderDragCapture) -> [BoardDragRowFrame]? {
        guard Self.valid(viewport), Self.valid(area),
              Set(capture.ids).count == capture.ids.count, rows.count == capture.ids.count,
              Set(rows.map(\.id)).count == rows.count, Set(rows.map(\.id)) == Set(capture.ids),
              rows.allSatisfy({ $0.status == capture.status && Self.valid($0.frame)
                  && CGRect(origin: .zero, size: area.size).contains($0.frame) }) else { return nil }
        let ordered = rows.sorted { $0.frame.minY < $1.frame.minY }
        guard ordered.map(\.id) == capture.ids else { return nil }
        for pair in zip(ordered, ordered.dropFirst()) {
            guard pair.0.frame.maxY <= pair.1.frame.minY else { return nil }
        }
        let visible = ordered.filter {
            viewport.contains($0.frame.offsetBy(dx: area.minX, dy: area.minY))
        }
        guard visible.contains(where: { $0.id == capture.taskID }) else { return nil }
        return visible
    }

    func canBegin(_ capture: BoardOrderDragCapture) -> Bool {
        guard let visible = visibleRows(capture) else { return false }
        return visible.count > 1 || capture.moveAllowed || capture.completionAllowed
    }

    func position(at point: CGPoint, capture: BoardOrderDragCapture) -> BoardDropPosition? {
        guard point.x.isFinite, point.y.isFinite, let visible = visibleRows(capture), visible.count > 1,
              let first = visible.first, let last = visible.last,
              point.y >= first.frame.minY, point.y <= last.frame.maxY,
              visible.allSatisfy({ point.x >= $0.frame.minX && point.x <= $0.frame.maxX }) else { return nil }
        let others = visible.filter { $0.id != capture.taskID }
        guard !others.isEmpty else { return nil }
        if let preceding = others.last(where: { point.y > $0.frame.midY }) {
            return BoardDropPosition(afterID: preceding.id, y: preceding.frame.maxY)
        }
        let remaining = capture.ids.filter { $0 != capture.taskID }
        guard capture.headID == capture.ids.first, capture.headID != nil,
              others.first?.id == remaining.first,
              let head = rows.first(where: { $0.id == capture.headID }) else { return nil }
        return BoardDropPosition(afterID: nil, y: head.frame.minY)
    }
}

struct BoardDropClaim: Equatable {
    let nonce: String
    let epoch: UUID
    let point: CGPoint
    let status: String
    let target: BoardDropTarget
}

struct BoardDragState {
    private(set) var epoch = UUID()
    private(set) var capture: BoardOrderDragCapture?
    private(set) var measurements: BoardDragMeasurements?
    private(set) var claim: BoardDropClaim?
    var geometry: BoardDragGeometry? { capture.flatMap { measurements?.geometry(for: $0) } }

    static func acceptsProviderTypes(_ providers: [[String]], type: String) -> Bool { providers == [[type]] }

    mutating func invalidate() {
        epoch = UUID(); capture = nil; measurements = nil; claim = nil
    }

    mutating func begin(_ capture: BoardOrderDragCapture, measurements: BoardDragMeasurements) {
        invalidate(); self.capture = capture; self.measurements = measurements
    }

    func reusableCapture(matching candidate: BoardOrderDragCapture, measurements: BoardDragMeasurements) -> BoardOrderDragCapture? {
        guard claim == nil, let capture, self.measurements == measurements,
              capture.hostID == candidate.hostID, capture.moveAllowed == candidate.moveAllowed,
              capture.completionAllowed == candidate.completionAllowed, capture.generation == candidate.generation,
              capture.taskID.utf8.elementsEqual(candidate.taskID.utf8),
              capture.status.utf8.elementsEqual(candidate.status.utf8),
              capture.displayedJSON.utf8.elementsEqual(candidate.displayedJSON.utf8),
              capture.columnJSON.utf8.elementsEqual(candidate.columnJSON.utf8),
              capture.filtersJSON.utf8.elementsEqual(candidate.filtersJSON.utf8),
              capture.ids.count == candidate.ids.count,
              zip(capture.ids, candidate.ids).allSatisfy({ $0.0.utf8.elementsEqual($0.1.utf8) }),
              capture.headID.map({ Array($0.utf8) }) == candidate.headID.map({ Array($0.utf8) }) else { return nil }
        return capture
    }

    private func resolve(at point: CGPoint, status: String) -> BoardDropTarget? {
        guard let capture else { return nil }
        if capture.status == status { return geometry?.position(at: point, capture: capture).map(BoardDropTarget.order) }
        return measurements?.moveTarget(at: point, status: status, capture: capture)
    }

    func target(at point: CGPoint, status: String) -> BoardDropTarget? {
        guard claim == nil else { return nil }
        return resolve(at: point, status: status)
    }

    mutating func claim(at point: CGPoint, status: String) -> BoardDropClaim? {
        guard let target = target(at: point, status: status), let capture else { return nil }
        let value = BoardDropClaim(nonce: capture.nonce, epoch: epoch, point: point, status: status, target: target)
        claim = value
        return value
    }

    func validatesLoad(_ value: BoardDropClaim, data: Data, current: BoardDragMeasurements) -> Bool {
        matches(value) && data.count == 36 && data == Data(value.nonce.utf8)
            && measurements == current && resolve(at: value.point, status: value.status) == value.target
    }

    func matches(_ value: BoardDropClaim) -> Bool {
        claim == value && epoch == value.epoch && capture?.nonce == value.nonce
    }

    mutating func retire(_ value: BoardDropClaim) {
        if matches(value) { invalidate() }
    }

    mutating func consume(_ value: BoardDropClaim, data: Data) -> Bool {
        guard matches(value), data.count == 36, String(data: data, encoding: .utf8) == value.nonce else { return false }
        invalidate()
        return true
    }
}
// MARK: End Board drag geometry and claim

// Nonobservable, diagnostic-only slots; callbacks retain their original attempt.
final class BoardDragDiagnostics {
    enum Stage: String, CaseIterable { case begin, cancel, validate, hover, drop, load }
    final class Attempt {
        private var emitted = Set<Stage>()
        func take(_ stage: Stage) -> Bool { emitted.insert(stage).inserted }
    }
    private(set) var attempt: Attempt?
    func begin() { attempt = Attempt() }
}

/// RN Board stacks full-width columns in a single vertical scroll.
struct BoardScreen: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    @FocusState private var searchFocused: Bool
    @Environment(\.scenePhase) private var scenePhase
    @State private var trackingAnchor = false
    @State private var drag = BoardDragState()
    @State private var dragMeasurements = BoardDragMeasurements()
    @State private var dropIndicator: BoardDropTarget?
    @State private var dragDiagnostics = BoardDragDiagnostics()
    private static let dragType = "tech.dongdongbh.mindwtr.board-order-drag"
    private var bar: CoreObject { model.boardView.object("bar") }

    var body: some View {
        VStack(spacing: 0) {
            filterBar
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        Color.clear.frame(height: 0).id("board-top")
                        BoardReadFailure(model: model, palette: palette)
                        let columns = model.boardView.objects("columns")
                        ForEach(columns.indices, id: \.self) { index in column(columns[index]) }
                        if model.boardLoading || model.busy {
                            ProgressView().frame(maxWidth: .infinity).padding(12)
                                .accessibilityLabel(model.label("common.loading"))
                        }
                    }
                    .padding(16)
                }
                .coordinateSpace(name: "board-scroll")
                .accessibilityIdentifier("board-scroll")
                .scrollDismissesKeyboard(.interactively)
                .background {
                    GeometryReader { geometry in
                        Color.clear.preference(key: BoardDragFrames.self,
                            value: BoardDragMeasurements(viewports: [geometry.frame(in: .global)]))
                    }
                }
                .refreshable { endInput(); await model.refresh() }
                .onPreferenceChange(BoardRowFrames.self) { frames in
                    guard trackingAnchor, model.boardCurrent, !model.busy, !model.boardFiltersPresented,
                          !model.taskPresented, !model.areaPickerPresented else { return }
                    // Retain the first fully visible row/header. Rebuilding a
                    // fresh revision restores this ID instead of an old pixel offset.
                    if let first = frames.filter({ $0.value.minY >= 0 }).min(by: { $0.value.minY < $1.value.minY }) {
                        model.boardScrollAnchor = first.key
                    }
                }
                .task(id: model.boardCurrent) {
                    trackingAnchor = false
                    guard model.boardCurrent else { return }
                    let anchor = model.boardScrollAnchor
                    await Task.yield()
                    guard !Task.isCancelled else { return }
                    proxy.scrollTo(anchor, anchor: .top)
                    await Task.yield()
                    guard !Task.isCancelled else { return }
                    trackingAnchor = true
                }
                .onChange(of: model.boardScrollGeneration) { _ in proxy.scrollTo("board-top", anchor: .top) }
            }
        }
        .onChange(of: model.boardFiltersPresented) { if $0 { endInput() } }
        .onChange(of: model.areaPickerPresented) { if $0 { endInput() } }
        .onPreferenceChange(BoardDragFrames.self) { value in
            if dragMeasurements != value {
                let reason = geometryCancellationReason(value)
                dragMeasurements = value; cancelDrag(reason: reason)
            }
        }
        .onReceive(dragInvalidations) { cancelDrag(reason: "model") }
        .onChange(of: scenePhase) { if $0 != .active { cancelDrag(reason: "scene") } }
        .onDisappear { trackingAnchor = false; cancelDrag(reason: "disappear") }
    }

    private var filterBar: some View {
        VStack(spacing: 8) {
            HStack(spacing: 4) {
                TextField(bar.text("searchPlaceholder"), text: Binding(
                    get: { model.boardSearchText }, set: { model.setBoardSearch($0) }))
                    .rnFont(14).focused($searchFocused).textInputAutocapitalization(.never).autocorrectionDisabled()
                    .submitLabel(.search).onSubmit { endInput() }
                    .padding(.horizontal, 12).frame(minHeight: 44)
                    .accessibilityLabel(bar.text("searchPlaceholder")).accessibilityIdentifier("board-search")
                    .disabled(model.retryNeeded || model.boardActionPending)
                    .contentShape(Rectangle()).onTapGesture {
                        if !model.retryNeeded && !model.boardActionPending { searchFocused = true }
                    }
                if !model.boardSearchText.isEmpty {
                    Button { model.setBoardSearch("") } label: {
                        AppIcon(name: "x", size: 16).frame(width: 44, height: 44).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).disabled(model.retryNeeded || model.boardActionPending)
                    .accessibilityLabel(bar.text("clearLabel")).accessibilityIdentifier("board-search-clear")
                }
            }
            .background(palette.input, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(bar.flag("searchActive") ? palette.tint : palette.border, lineWidth: 1))
            HStack(spacing: 8) {
                Spacer(minLength: 0)
                if bar.flag("active") {
                    BoardButton(title: bar.text("clearLabel"), palette: palette, enabled: model.boardControlsEnabled,
                                id: "board-clear") { endInput(); model.editBoardFilters(["type": "clear"]) }
                }
                BoardButton(title: bar.text("filterLabel"), icon: "sliders", selected: bar.flag("active"),
                            palette: palette, enabled: model.boardControlsEnabled, id: "board-filter-open") {
                    endInput(); model.presentBoardFilters(true)
                }
            }
        }
        .padding(12).background(palette.card)
        .overlay(alignment: .bottom) { palette.border.frame(height: 1) }
    }

    private func column(_ column: CoreObject) -> some View {
        let status = column.text("status")
        let color = tone(column.text("tone"))
        return VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Text(column.text("label")).rnFont(15, .semibold).frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityAddTraits(.isHeader).accessibilityIdentifier("board-column-" + status)
                Text(String(column.number("count"))).rnFont(12, .semibold)
                    .padding(.horizontal, 8).padding(.vertical, 2)
                    .background(palette.filter, in: Capsule()).overlay(Capsule().stroke(color, lineWidth: 1))
                    .accessibilityIdentifier("board-count-" + status)
            }
            .padding(12).overlay(alignment: .bottom) { palette.border.frame(height: 1) }
            .id("board-column-" + status).background(anchor("board-column-" + status))
            VStack(alignment: .leading, spacing: 10) {
                let cards = column.objects("cards")
                ForEach(cards.indices, id: \.self) { index in card(cards[index], column: column) }
                if cards.count < column.number("count") {
                    BoardButton(title: model.label("common.more"), palette: palette, enabled: model.boardActionsEnabled,
                                id: "board-more-" + status) { endInput(); model.loadMoreBoard("cards", status: status) }
                        .frame(maxWidth: .infinity)
                }
                if !column.text("empty").isEmpty {
                    Text(column.text("empty")).rnFont(13).foregroundStyle(palette.secondary)
                        .frame(maxWidth: .infinity).padding(.vertical, 16)
                }
            }.padding(10)
                .contentShape(Rectangle())
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("board-drop-" + status)
                .background((dropIndicator == .move(status: status) || status == "done" && dropIndicator == .complete)
                    ? palette.tint.opacity(0.12) : Color.clear)
                .coordinateSpace(name: "board-drag-" + status)
                .background {
                    GeometryReader { geometry in
                        Color.clear.preference(key: BoardDragFrames.self, value: BoardDragMeasurements(
                            columns: [BoardDragColumnFrame(status: status, frame: geometry.frame(in: .global))]))
                    }
                }
                .overlay(alignment: .topLeading) {
                    if drag.capture?.status == status, case .order(let indicator)? = dropIndicator {
                        Rectangle().fill(palette.tint).frame(height: 2).offset(y: indicator.y)
                            .allowsHitTesting(false).accessibilityHidden(true)
                    }
                }
                .onDrop(of: [Self.dragType], delegate: BoardCardDropDelegate(
                    type: Self.dragType, active: { acceptsDrag(status: status) },
                    validated: { conforms, active in
                        traceDrag(.validate, reason: !active ? dragAdmissionReason(status: status)
                            : conforms ? "ready" : "provider-types")
                    },
                    target: { dragTarget($0, status: status) },
                    hover: { dropIndicator = $0 },
                    updated: { traceDrag(.hover, reason: $0 ? "ready" : "position-rejected") },
                    perform: { performDrop($0, status: status) }))
        }
        .background(palette.card, in: RoundedRectangle(cornerRadius: 12))
        .overlay(alignment: .top) { color.frame(height: 4).clipShape(RoundedRectangle(cornerRadius: 2)) }
    }

    private func card(_ item: CoreObject, column: CoreObject) -> some View {
        let row = item.object("row")
        let card = item.object("card")
        let id = row.text("id")
        let swipes = model.boardView.object("cardActions").object("swipes")
        let moveTo = model.boardView.object("cardActions").object("moveTo")
        let complete = model.boardView.object("cardActions").object("complete")
        let filters = model.boardView.object("filters")
        let orderActions = model.boardOrderActions(item, column: column, filters: filters)
        let actionCard = SwipeActionCard(
            palette: palette, enabled: model.boardActionsEnabled, id: "board-task-" + id,
            leftLabel: model.boardSwipeAction("left") == nil ? "" : swipes.object("left").text("label"),
            rightLabel: model.boardSwipeAction("right") == nil ? "" : swipes.object("right").text("label"),
            leftSystemImage: "doc.on.doc",
            open: { endInput(); Task { await model.openTask(id) } },
            swipe: { side in endInput(); Task { await model.performBoardSwipe(side, taskID: id) } },
            moveLabel: moveTo.text("label"), moveDestinations: model.boardMoveDestinations(item),
            move: { status in endInput(); Task { await model.moveBoardCard(item, status: status) } },
            completeLabel: model.boardCardCanComplete(item) ? complete.text("label") : "",
            complete: { endInput(); Task { await model.completeBoardCard(item) } },
            orderActions: orderActions,
            order: { direction in
                endInput(); Task { await model.orderBoardCard(item, column: column, filters: filters, direction: direction) }
            },
            content: VStack(alignment: .leading, spacing: 8) {
                Text(row.text("title")).rnFont(14, .medium).lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if card.flag("showMetaRow") {
                    AppChipFlow {
                        if !card.text("projectTitle").isEmpty {
                            badge(card.text("projectTitle"), icon: "folder",
                                  color: card.text("projectColor").isEmpty ? palette.secondary : Color(hex: card.text("projectColor")))
                        }
                        let tokens = (card["tags"] as? [String] ?? []) + (card["contexts"] as? [String] ?? [])
                        ForEach(tokens.indices, id: \.self) { index in badge(tokens[index]) }
                        if !card.text("timeEstimateLabel").isEmpty { badge(card.text("timeEstimateLabel"), icon: "clock") }
                    }
                }
            }
            .padding(12).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .background(palette.row, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(palette.border, lineWidth: 1)).contentShape(Rectangle())
        )
        return HStack(spacing: 0) {
            actionCard
            dragHandle(item: item, column: column, filters: filters, available: model.boardDragAvailable(item, column: column, filters: filters))
        }
            .frame(maxWidth: .infinity)
            .id("board-task-" + id).background(anchor("board-task-" + id))
            .background {
                GeometryReader { geometry in
                    Color.clear.preference(key: BoardDragFrames.self, value: BoardDragMeasurements(
                        rows: [BoardDragRowFrame(status: column.text("status"), id: id,
                                                frame: geometry.frame(in: .named("board-drag-" + column.text("status"))))]))
                }
            }
    }

    @ViewBuilder private func dragHandle(item: CoreObject, column: CoreObject, filters: CoreObject, available: Bool) -> some View {
        let handle = Image(systemName: "line.3.horizontal")
            .foregroundStyle(palette.secondary)
            .frame(width: 44, height: 44).contentShape(Rectangle())
            .accessibilityLabel(model.label("board.dragTask"))
            .accessibilityIdentifier("board-drag-" + item.object("row").text("id"))
        if available {
            handle.onDrag { makeDragProvider(item: item, column: column, filters: filters) } preview: {
                Image(systemName: "arrow.up.arrow.down").padding(12)
                    .background(palette.card, in: RoundedRectangle(cornerRadius: 8))
            }
        } else { handle.disabled(true) }
    }

    private func makeDragProvider(item: CoreObject, column: CoreObject, filters: CoreObject) -> NSItemProvider {
        // SwiftUI may ask for the same source again; never revoke an admitted load.
        guard drag.claim == nil else { return NSItemProvider() }
        func refuse(_ reason: String) -> NSItemProvider {
            cancelDrag(reason: "new-drag"); dragDiagnostics.begin()
            traceDrag(.begin, reason: reason)
            return NSItemProvider()
        }
        guard scenePhase == .active else { return refuse("scene") }
        guard let candidate = model.captureBoardDrag(item, column: column, filters: filters)
        else { return refuse("admission") }
        guard let geometry = dragMeasurements.geometry(for: candidate)
        else { return refuse("geometry-missing") }
        guard geometry.canBegin(candidate) else { return refuse("geometry-ineligible") }
        let capture: BoardOrderDragCapture
        if let existing = drag.reusableCapture(matching: candidate, measurements: dragMeasurements) {
            capture = existing
        } else {
            cancelDrag(reason: "new-drag"); dragDiagnostics.begin()
            drag.begin(candidate, measurements: dragMeasurements)
            capture = candidate
        }
        let provider = NSItemProvider()
        let bytes = Data(capture.nonce.utf8)
        provider.registerDataRepresentation(forTypeIdentifier: Self.dragType, visibility: .ownProcess) { completion in
            completion(bytes, nil); return nil
        }
        traceDrag(.begin, reason: "ready")
        return provider
    }

    private var dragInvalidations: AnyPublisher<Void, Never> {
        Publishers.MergeMany([
            model.$boardView.dropFirst().map { _ in () }.eraseToAnyPublisher(),
            model.$boardCurrent.filter { !$0 }.map { _ in () }.eraseToAnyPublisher(),
            model.$boardLoading.filter { $0 }.map { _ in () }.eraseToAnyPublisher(),
            model.$busy.filter { $0 }.map { _ in () }.eraseToAnyPublisher(),
            model.$retryNeeded.filter { $0 }.map { _ in () }.eraseToAnyPublisher(),
            model.$ready.filter { !$0 }.map { _ in () }.eraseToAnyPublisher(),
            model.$selectedSurface.filter { $0 != .board }.map { _ in () }.eraseToAnyPublisher(),
            model.$taskPresented.filter { $0 }.map { _ in () }.eraseToAnyPublisher(),
            model.$areaPickerPresented.filter { $0 }.map { _ in () }.eraseToAnyPublisher(),
            model.$boardFiltersPresented.filter { $0 }.map { _ in () }.eraseToAnyPublisher(),
            model.$morePresented.filter { $0 }.map { _ in () }.eraseToAnyPublisher(),
            model.$capturePresented.filter { $0 }.map { _ in () }.eraseToAnyPublisher(),
            NotificationCenter.default.publisher(for: UIApplication.willResignActiveNotification).map { _ in () }.eraseToAnyPublisher(),
        ]).eraseToAnyPublisher()
    }

    private func traceDrag(_ stage: BoardDragDiagnostics.Stage, reason: @autoclosure () -> String,
                           attempt: BoardDragDiagnostics.Attempt? = nil) {
        guard let attempt = attempt ?? dragDiagnostics.attempt, attempt.take(stage) else { return }
        model.logBoardDragStage(stage.rawValue, reason: reason())
    }

    private func geometryCancellationReason(_ next: BoardDragMeasurements) -> String {
        guard let capture = drag.capture, let original = drag.geometry,
              let current = next.geometry(for: capture) else { return "geometry-missing" }
        if current.viewport != original.viewport { return "geometry-viewport" }
        if current.area != original.area { return "geometry-area" }
        if current.rows != original.rows { return "geometry-rows" }
        return "geometry-other"
    }

    private func cancelDrag(reason: String) {
        guard drag.capture != nil || drag.claim != nil || dropIndicator != nil else { return }
        drag.invalidate(); dropIndicator = nil
        traceDrag(.cancel, reason: reason)
    }

    private func dragTarget(_ point: CGPoint, status: String) -> BoardDropTarget? {
        guard acceptsDrag(status: status) else { return nil }
        return drag.target(at: point, status: status)
    }

    private func sourceCurrent(_ capture: BoardOrderDragCapture, status: String) -> Bool {
        if capture.status == status { return model.boardOrderDragIsCurrent(capture) }
        if status == "done" { return model.boardCompletionDragIsCurrent(capture) }
        return model.boardMoveDragIsCurrent(capture, status: status)
    }

    private func acceptsDrag(status: String) -> Bool {
        guard scenePhase == .active, let capture = drag.capture, drag.claim == nil,
              sourceCurrent(capture, status: status), dragMeasurements == drag.measurements else { return false }
        return true
    }

    private func dragAdmissionReason(status: String) -> String {
        guard scenePhase == .active else { return "scene" }
        guard let capture = drag.capture else { return "capture" }
        guard ["inbox", "next", "waiting", "someday", "done"].contains(status) else { return "column" }
        guard drag.claim == nil else { return "claimed" }
        guard sourceCurrent(capture, status: status) else { return "stale" }
        guard dragMeasurements == drag.measurements else { return "geometry" }
        return "ready"
    }

    private func performDrop(_ info: DropInfo, status: String) -> Bool {
        let providers = info.itemProviders(for: [Self.dragType])
        guard BoardDragState.acceptsProviderTypes(providers.map(\.registeredTypeIdentifiers), type: Self.dragType),
              dragTarget(info.location, status: status) != nil,
              let claim = drag.claim(at: info.location, status: status), let capture = drag.capture else {
            traceDrag(.drop, reason: providers.count != 1 ? "provider-count"
                : providers[0].registeredTypeIdentifiers != [Self.dragType] ? "provider-types"
                : !acceptsDrag(status: status) ? dragAdmissionReason(status: status) : "position-or-claim")
            return false
        }
        let diagnosticAttempt = dragDiagnostics.attempt
        dropIndicator = nil
        // The load must begin inside performDrop; only its completion hops to MainActor.
        providers[0].loadDataRepresentation(forTypeIdentifier: Self.dragType) { data, error in
            Task { @MainActor in
                guard error == nil, let data, data.count == 36, drag.matches(claim), scenePhase == .active,
                      dragMeasurements == drag.measurements else {
                    let reason = error != nil ? "error" : data == nil || data?.count != 36 ? "payload"
                        : !drag.matches(claim) ? "claim" : scenePhase != .active ? "scene" : "geometry"
                    drag.retire(claim)
                    traceDrag(.load, reason: reason, attempt: diagnosticAttempt)
                    return
                }
                guard data == Data(claim.nonce.utf8) else {
                    drag.retire(claim)
                    traceDrag(.load, reason: "nonce", attempt: diagnosticAttempt)
                    return
                }
                guard drag.validatesLoad(claim, data: data, current: dragMeasurements), sourceCurrent(capture, status: claim.status) else {
                    drag.retire(claim)
                    traceDrag(.load, reason: "position", attempt: diagnosticAttempt)
                    return
                }
                let submitted: Bool
                switch claim.target {
                case .order(let position):
                    submitted = model.orderBoardCard(capture, afterID: position.afterID) { drag.consume(claim, data: data) }
                case .move(let destination):
                    submitted = model.moveBoardCard(capture, status: destination) { drag.consume(claim, data: data) }
                case .complete:
                    submitted = model.completeBoardCard(capture) { drag.consume(claim, data: data) }
                }
                if submitted { endInput() } else { drag.retire(claim) }
                traceDrag(.load, reason: submitted ? "ready" : "retain-rejected", attempt: diagnosticAttempt)
            }
        }
        traceDrag(.drop, reason: "ready", attempt: diagnosticAttempt)
        return true
    }

    private func badge(_ label: String, icon: String = "", color: Color? = nil) -> some View {
        HStack(spacing: 4) {
            if !icon.isEmpty { Image(systemName: icon).font(.system(size: 12)).accessibilityHidden(true) }
            Text(label).rnFont(11).lineLimit(1)
        }
        .foregroundStyle(palette.secondary).padding(.horizontal, 6).padding(.vertical, 2)
        .background(palette.filter, in: RoundedRectangle(cornerRadius: 4))
        .overlay(RoundedRectangle(cornerRadius: 4).stroke(color ?? palette.border, lineWidth: 1))
    }

    private func tone(_ name: String) -> Color {
        switch name {
        case "tint": return palette.tint
        case "warning": return palette.warning
        case "secondaryText": return palette.secondary
        case "success": return palette.success
        default: return palette.text
        }
    }

    private func anchor(_ id: String) -> some View {
        GeometryReader { geometry in
            Color.clear.preference(key: BoardRowFrames.self, value: [id: geometry.frame(in: .named("board-scroll"))])
        }
    }

    private func endInput() {
        searchFocused = false
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    }
}

/// Observe horizontal drags alongside the Board's vertical ScrollView.
/// Like RN Swipeable, crossing the action threshold closes the panel and acts once.
struct SwipeActionCard<Content: View>: View {
    let palette: AppPalette
    let enabled: Bool
    let id: String
    let leftLabel: String
    let rightLabel: String
    let leftSystemImage: String
    let open: () -> Void
    let swipe: (String) -> Void
    var moveLabel: String = ""
    var moveDestinations: [CoreObject] = []
    var move: (String) -> Void = { _ in }
    var completeLabel: String = ""
    var complete: () -> Void = {}
    var orderActions: [CoreObject] = []
    var order: (String) -> Void = { _ in }
    let content: Content
    @GestureState private var offset: CGFloat = 0

    var body: some View {
        // A Button's touch-up can fire after a short simultaneous drag. Use a
        // distinct tap recognizer, while retaining the button's VoiceOver role.
        content
            .contentShape(Rectangle())
            .onTapGesture { if enabled { open() } }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isButton)
            .accessibilityAction(.default) { if enabled { open() } }
            .disabled(!enabled)
            .accessibilityIdentifier(id)
            .accessibilityActions {
                if !completeLabel.isEmpty { Button(completeLabel) { complete() }.disabled(!enabled) }
                ForEach(orderActions.indices, id: \.self) { index in
                    let action = orderActions[index]
                    Button(action.text("label")) { order(action.text("direction")) }
                        .disabled(!enabled || !action.flag("enabled"))
                }
                if !leftLabel.isEmpty { Button(leftLabel) { swipe("left") }.disabled(!enabled) }
                if !rightLabel.isEmpty { Button(rightLabel) { swipe("right") }.disabled(!enabled) }
                ForEach(moveDestinations.indices, id: \.self) { index in
                    let destination = moveDestinations[index]
                    Button(moveLabel + " " + destination.text("label")) { move(destination.text("status")) }
                        .disabled(!enabled)
                }
            }
            .contextMenu {
                ForEach(orderActions.indices, id: \.self) { index in
                    let action = orderActions[index]
                    Button(action.text("label"), systemImage: action.text("direction") == "up" ? "arrow.up" : "arrow.down") {
                        order(action.text("direction"))
                    }
                    .accessibilityIdentifier("board-order-" + action.text("direction") + "-" + id)
                    .disabled(!enabled || !action.flag("enabled"))
                }
                if !completeLabel.isEmpty {
                    Button(completeLabel, systemImage: "checkmark") { complete() }
                        .accessibilityIdentifier("board-complete-" + id).disabled(!enabled)
                }
                if !leftLabel.isEmpty { Button(leftLabel, systemImage: leftSystemImage) { swipe("left") }.disabled(!enabled) }
                if !rightLabel.isEmpty {
                    Button(rightLabel, systemImage: "trash", role: .destructive) { swipe("right") }.disabled(!enabled)
                }
                if !moveDestinations.isEmpty {
                    Menu(moveLabel) {
                        ForEach(moveDestinations.indices, id: \.self) { index in
                            let destination = moveDestinations[index]
                            Button(destination.text("label")) { move(destination.text("status")) }
                                .accessibilityIdentifier("board-move-" + destination.text("status"))
                                .disabled(!enabled)
                        }
                    }
                    .accessibilityIdentifier("board-move-menu-" + id)
                    .disabled(!enabled)
                }
            }
            .offset(x: offset)
            .background {
                if offset != 0 {
                    HStack(spacing: 0) {
                        if offset > 0 { panel(leftLabel, color: palette.tint) }
                        Spacer(minLength: 0)
                        if offset < 0 { panel(rightLabel, color: palette.danger) }
                    }.accessibilityHidden(true)
                }
            }
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .simultaneousGesture(
            DragGesture(minimumDistance: 20)
                .updating($offset) { value, offset, _ in
                    let delta = value.translation
                    guard enabled, abs(delta.width) > abs(delta.height) * 1.5,
                          !(delta.width > 0 ? leftLabel : rightLabel).isEmpty else { return }
                    offset = max(-112, min(112, delta.width))
                }
                .onEnded { value in
                    let delta = value.translation
                    guard enabled, abs(delta.width) >= 72, abs(delta.width) > abs(delta.height) * 1.5 else { return }
                    let side = delta.width > 0 ? "left" : "right"
                    guard !(side == "left" ? leftLabel : rightLabel).isEmpty else { return }
                    swipe(side)
                },
            including: enabled ? .all : .none
        )
    }

    private func panel(_ label: String, color: Color) -> some View {
        Text(label).rnFont(14, .semibold).multilineTextAlignment(.center)
            .padding(.horizontal, 8).frame(width: 112).frame(maxHeight: .infinity)
            .foregroundStyle(palette.text).background(palette.bg)
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(color, lineWidth: 1))
    }
}

struct BoardFiltersSheet: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    @State private var picker = ""
    @State private var dueExpanded = false
    @FocusState private var pickerSearchFocused: Bool
    private var sheet: CoreObject { model.boardView.object("sheet") }
    private var filters: CoreObject { model.boardView.object("filters") }

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .bottom) {
                Button { dismiss() } label: { Color.black.opacity(0.35).contentShape(Rectangle()) }
                    .buttonStyle(.plain).ignoresSafeArea().accessibilityLabel(model.label("common.close"))
                    .accessibilityIdentifier("board-filter-dismiss")
                VStack(alignment: .leading, spacing: 12) {
                    HStack(spacing: 8) {
                        if !picker.isEmpty {
                            BoardButton(title: model.label("common.back"), palette: palette, id: "board-picker-back") { back() }
                        }
                        Text(model.label(picker.isEmpty ? "filters.label" : picker == "tokens" ? "filters.contexts" : "filters.projects"))
                            .rnFont(16, .bold).frame(maxWidth: .infinity, alignment: .leading)
                            .fixedSize(horizontal: false, vertical: true).accessibilityAddTraits(.isHeader)
                            .accessibilityIdentifier("board-filter-title")
                    }
                    if !picker.isEmpty {
                        pickerSearch
                        BoardReadFailure(model: model, palette: palette)
                    }
                    ScrollView {
                        VStack(alignment: .leading, spacing: 16) {
                            if picker.isEmpty { overview }
                            else { pickerOptions }
                            if picker.isEmpty { BoardReadFailure(model: model, palette: palette) }
                            if model.boardLoading { ProgressView().frame(maxWidth: .infinity) }
                        }.padding(.bottom, 12)
                    }.accessibilityIdentifier("board-filter-scroll").scrollDismissesKeyboard(.interactively)
                    HStack {
                        BoardButton(title: model.label("filters.clear"), palette: palette, enabled: model.boardControlsEnabled,
                                    id: "board-filter-clear") { model.editBoardFilters(["type": "clear"]) }
                        Spacer(minLength: 8)
                        BoardButton(title: model.label("common.done"), palette: palette, id: "board-filter-close") {
                            dismiss()
                        }
                    }
                }
                .padding(16).frame(maxWidth: 860, maxHeight: geometry.size.height * 0.82)
                .background(palette.card, in: RoundedRectangle(cornerRadius: 24))
                .overlay(RoundedRectangle(cornerRadius: 24).stroke(palette.border, lineWidth: 1))
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .accessibilityElement(children: .contain).accessibilityAddTraits(.isModal)
            .accessibilityAction(.escape) {
                if picker.isEmpty { dismiss() } else { back() }
            }
        }
        .onDisappear { pickerSearchFocused = false; model.closeBoardPicker() }
    }

    private func openPicker(_ name: String) {
        model.openBoardPicker(name)
        picker = name
    }

    private func back() {
        pickerSearchFocused = false
        model.closeBoardPicker()
        picker = ""
    }

    private func dismiss() {
        pickerSearchFocused = false
        model.presentBoardFilters(false)
    }

    private var overview: some View {
        VStack(alignment: .leading, spacing: 16) {
            let chips = sheet.object("chips").objects("items") + sheet.objects("additionalChips")
            if !chips.isEmpty {
                Text(model.label("filters.active")).rnFont(12, .semibold).foregroundStyle(palette.secondary)
                AppChipFlow {
                    ForEach(chips.indices, id: \.self) { index in
                        let chip = chips[index]
                        BoardButton(title: chip.text("label"), icon: "x", selected: true, excluded: chip.flag("excluded"),
                                    palette: palette, enabled: model.boardControlsEnabled,
                                    id: "board-filter-chip-" + chip.text("id")) { model.editBoardFilters(chip.object("edit")) }
                            .accessibilityLabel(model.label("filters.remove") + ": " + chip.text("label"))
                    }
                }
                more("chips")
            }
            let due = sheet.object("due")
            Button { dueExpanded.toggle() } label: {
                HStack(spacing: 12) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(due.text("label")).rnFont(15, .medium)
                        Text(due.text("summary")).rnFont(13).foregroundStyle(palette.secondary)
                    }.frame(maxWidth: .infinity, alignment: .leading)
                    Text(dueExpanded ? "−" : "+").rnFont(20)
                }
                .padding(14).frame(minHeight: 60).background(palette.bg, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(palette.border, lineWidth: 1)).contentShape(Rectangle())
            }
            .buttonStyle(.plain).accessibilityLabel(due.text("accessibilityLabel"))
            .accessibilityValue(dueExpanded ? "1" : "0").accessibilityIdentifier("board-filter-due")
            if dueExpanded {
                AppChipFlow {
                    let presets = due.objects("presets")
                    ForEach(presets.indices, id: \.self) { index in
                        let preset = presets[index]
                        BoardButton(title: preset.text("label"), selected: preset.flag("selected"), palette: palette,
                                    enabled: model.boardControlsEnabled, id: "board-due-" + preset.text("preset")) {
                            model.editBoardFilters(["type": "toggleDuePreset", "preset": preset.text("preset")])
                        }
                    }
                }
            }
            BoardButton(title: model.label("filters.contexts"), palette: palette, enabled: model.boardControlsEnabled,
                        id: "board-picker-tokens") { openPicker("tokens") }
            BoardButton(title: model.label("filters.projects"), palette: palette, enabled: model.boardControlsEnabled,
                        id: "board-picker-projects") { openPicker("projects") }
        }
    }

    private var pickerOptions: some View {
        VStack(alignment: .leading, spacing: 0) {
            let options = sheet.object(picker).objects("items")
            if model.boardCurrent && options.isEmpty {
                Text(model.label("search.noResults")).rnFont(14).foregroundStyle(palette.secondary)
                    .padding(.vertical, 28)
                    .accessibilityIdentifier("board-picker-empty")
            }
            Group {
                ForEach(options.indices, id: \.self) { index in
                    let item = options[index]
                    let token = picker == "tokens"
                    let selected = token ? item.text("state") == "included" : item.flag("selected")
                    let excluded = token && item.text("state") == "excluded"
                    let value = item.text(token ? "value" : "id")
                    Button { model.editBoardFilters(["type": token ? "toggleToken" : "toggleProject", "value": value]) } label: {
                        HStack(spacing: 12) {
                            Text(item.text(token ? "value" : "title")).rnFont(14).strikethrough(excluded)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            if selected { Image(systemName: "checkmark").accessibilityHidden(true) }
                            if excluded { Text(model.label("filters.excluded")).rnFont(12, .semibold) }
                        }
                        .foregroundStyle(excluded ? palette.danger : selected ? palette.tint : palette.text)
                        .padding(.horizontal, 4).padding(.vertical, 8).frame(minHeight: 52).contentShape(Rectangle())
                        .overlay(alignment: .bottom) { palette.border.frame(height: 0.5) }
                    }
                    .buttonStyle(.plain).disabled(!model.boardControlsEnabled)
                    .accessibilityAddTraits(selected ? .isSelected : [])
                    .accessibilityValue(excluded ? model.label("filters.excluded") : selected ? "1" : "0")
                    .accessibilityIdentifier("board-filter-" + (token ? "token-" : "project-") + value)
                }
                more(picker)
                if picker == "tokens" {
                    if sheet.flag("showContextMatchMode") { matchMode("context") }
                    if sheet.flag("showTagMatchMode") { matchMode("tag") }
                }
            }.disabled(!model.boardCurrent)
        }
    }

    private var pickerSearch: some View {
        TextField(model.label("common.search"), text: Binding(
            get: { model.boardPickerQuery }, set: { model.setBoardPickerQuery($0) }))
            .rnFont(15).textInputAutocapitalization(.never).autocorrectionDisabled()
            .submitLabel(.search).focused($pickerSearchFocused).onSubmit { pickerSearchFocused = false }
            .padding(.horizontal, 12).frame(minHeight: 44)
            .background(palette.bg, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(palette.border, lineWidth: 1))
            .disabled(model.retryNeeded || model.boardActionPending)
            .accessibilityLabel(model.label("common.search") + " " + model.label(picker == "tokens" ? "filters.contexts" : "filters.projects"))
            .accessibilityIdentifier("board-picker-search")
    }

    @ViewBuilder private func more(_ list: String) -> some View {
        let window = sheet.object(list)
        if window.objects("items").count < window.number("total") {
            BoardButton(title: model.label("common.more"), palette: palette, enabled: model.boardControlsEnabled && model.boardCurrent,
                        id: "board-more-" + list) { model.loadMoreBoard(list) }.frame(maxWidth: .infinity)
        }
    }

    private func matchMode(_ kind: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(model.label(kind == "context" ? "filters.contextMatchMode" : "filters.tagMatchMode"))
                .rnFont(12, .semibold).foregroundStyle(palette.secondary)
            AppChipFlow {
                ForEach(["any", "all"], id: \.self) { mode in
                    BoardButton(title: model.label(mode == "any" ? "filters.matchAny" : "common.all"),
                                selected: filters.text(kind + "MatchMode") == mode, palette: palette,
                                enabled: model.boardControlsEnabled, id: "board-match-" + kind + "-" + mode) {
                        model.editBoardFilters(["type": "setMatchMode", "kind": kind, "value": mode])
                    }
                }
            }
        }.padding(.vertical, 12)
    }
}

private struct BoardReadFailure: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    var body: some View {
        if let error = model.boardError {
            VStack(alignment: .leading, spacing: 8) {
                Text(error).rnFont(13).foregroundStyle(palette.danger).textSelection(.enabled)
                    .accessibilityIdentifier("board-error")
                BoardButton(title: model.label("common.retry"), palette: palette, enabled: !model.busy && !model.retryNeeded,
                            id: "board-retry") { model.retryBoard() }
            }
        }
    }
}

private struct BoardButton: View {
    let title: String
    var icon = ""
    var selected = false
    var excluded = false
    let palette: AppPalette
    var enabled = true
    let id: String
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if !icon.isEmpty { AppIcon(name: icon, size: 14) }
                Text(title).rnFont(13, .semibold).strikethrough(excluded)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .foregroundStyle(excluded ? palette.danger : selected ? palette.onTint : palette.text)
            .padding(.horizontal, 12).padding(.vertical, 6).frame(minHeight: 44)
            .background(selected && !excluded ? palette.tint : palette.filter, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(excluded ? palette.danger : selected ? palette.tint : palette.border, lineWidth: 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(!enabled).accessibilityIdentifier(id)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

private struct BoardCardDropDelegate: DropDelegate {
    let type: String
    let active: () -> Bool
    let validated: (Bool, Bool) -> Void
    let target: (CGPoint) -> BoardDropTarget?
    let hover: (BoardDropTarget?) -> Void
    let updated: (Bool) -> Void
    let perform: (DropInfo) -> Bool

    func validateDrop(info: DropInfo) -> Bool {
        // Item providers are available only during performDrop, not validation.
        let conforms = info.hasItemsConforming(to: [type])
        let admitted = active()
        validated(conforms, admitted)
        return admitted && conforms
    }

    func dropUpdated(info: DropInfo) -> DropProposal? {
        let position = validateDrop(info: info) ? target(info.location) : nil
        hover(position)
        updated(position != nil)
        return DropProposal(operation: position == nil ? .forbidden : .move)
    }

    func dropExited(info: DropInfo) { hover(nil) }
    func performDrop(info: DropInfo) -> Bool { perform(info) }
}

private struct BoardDragFrames: PreferenceKey {
    static var defaultValue = BoardDragMeasurements()
    static func reduce(value: inout BoardDragMeasurements, nextValue: () -> BoardDragMeasurements) {
        let next = nextValue()
        value.viewports += next.viewports; value.columns += next.columns; value.rows += next.rows
    }
}

private struct BoardRowFrames: PreferenceKey {
    static var defaultValue: [String: CGRect] = [:]
    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) {
        value.merge(nextValue(), uniquingKeysWith: { _, next in next })
    }
}
