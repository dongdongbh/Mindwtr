import SwiftUI

struct CalendarScreen: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var weekOffset: CGFloat = 0
    @State private var measuredWeekdays = CalendarWeekdayMeasurements()
    @FocusState private var queryFocused: Bool
    @ScaledMetric(relativeTo: .body) private var monthCellHeight: CGFloat = 86
    @ScaledMetric(relativeTo: .body) private var weekHeaderHeight: CGFloat = 56
    @ScaledMetric(relativeTo: .body) private var allDayRowHeight: CGFloat = 44
    private var view: CoreObject { model.calendarView }
    private var content: CoreObject { view.object("content") }
    private var text: CoreObject { view.object("text") }
    private var entries: [CoreObject] { view.objects("items") }
    private var days: [CoreObject] { entries.filter { $0.text("type") == "day" } }
    // RN geometry constants only; all time coordinates and overlap percentages come from core.
    private let pixelsPerMinute: CGFloat = 1.4
    private let gutter: CGFloat = 56
    private var hours: [String] { content["hourLabels"] as? [String] ?? [] }
    private var timelineHeight: CGFloat { CGFloat(max(0, hours.count - 1)) * 60 * pixelsPerMinute }
    private var viewportKey: String {
        let state = view.object("state")
        return String(model.calendarViewportGeneration) + ":" + content.text("mode") + ":" +
            state.text("selectedDate") + ":" + state.text("visibleMonth")
    }
    private var initialTimelineOffset: CGFloat {
        // Core wall-clock minutes select the first-entry default, never a saved viewport.
        let minute = (content["nowMinutes"] as? NSNumber)?.doubleValue ?? 0
        return CGFloat(max(0, Int(minute / 60) - 1)) * 60 * pixelsPerMinute
    }
    private func viewportAnchor(_ axis: String) -> Binding<Double?> {
        let key = viewportKey + ":" + axis
        return Binding(get: { model.calendarViewportAnchors[key] }, set: { model.calendarViewportAnchors[key] = $0 })
    }

    var body: some View {
        GeometryReader { geometry in
            if geometry.size.height < 360 || dynamicTypeSize.isAccessibilitySize {
                ScrollView {
                    calendarLayout(contentHeight: max(320, weekHeaderHeight + allDayRowHeight + 4 + 48 + 160))
                }
                .accessibilityIdentifier("calendar-layout-scroll")
            } else {
                calendarLayout(contentHeight: nil)
            }
        }
        .onChange(of: model.calendarItemPresented) { if $0 { queryFocused = false } }
        .onChange(of: model.calendarComposerPresented) { if $0 { queryFocused = false } }
        .onChange(of: model.areaPickerPresented) { if $0 { queryFocused = false } }
    }

    private func calendarLayout(contentHeight: CGFloat?) -> some View {
        VStack(spacing: 0) {
            header
            if let notice = model.calendarNotice {
                Text(notice).rnFont(14).foregroundStyle(palette.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(12)
                    .accessibilityIdentifier("calendar-notice")
            }
            feedStatus
            if let error = model.calendarError {
                VStack(alignment: .leading, spacing: 8) {
                    Text(error).rnFont(14).foregroundStyle(palette.danger).accessibilityIdentifier("calendar-error")
                    CalendarAction(title: model.label("common.retry"), enabled: !model.busy && !model.retryNeeded,
                        palette: palette, id: "calendar-retry") { Task { await model.retryCalendar() } }
                }.padding(12)
            }
            Group {
                if content.text("mode") == "month" { month }
                else if content.text("mode") == "week" { week.id(viewportKey) }
                else if content.text("mode") == "day" { day.id(viewportKey) }
                else if content.text("mode") == "schedule" { schedule }
                else { Spacer() }
            }.frame(height: contentHeight)
            if content.text("mode") == "week" { weekDensity }
            if model.busy { ProgressView().padding(6).accessibilityLabel(model.label("common.loading")) }
        }
    }

    @ViewBuilder
    private var feedStatus: some View {
        let state = view.object("feedState")
        let message = state.text("message")
        if !message.isEmpty && model.calendarError == nil {
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .top, spacing: 8) {
                    if state.text("status") == "loading" {
                        ProgressView().accessibilityIdentifier("calendar-feed-loading")
                    }
                    Text(message).rnFont(14)
                        .foregroundStyle(state.text("status") == "error" ? palette.danger : palette.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("calendar-feed-message")
                }
                if state.text("status") != "loading" {
                    CalendarAction(title: model.label("common.retry"), enabled: model.calendarFeedRetryEnabled,
                        palette: palette, id: "calendar-feed-retry") { Task { await model.retryCalendar() } }
                }
            }.frame(maxWidth: .infinity, alignment: .leading).padding(12)
        }
    }

    private var header: some View {
        VStack(spacing: 8) {
            HStack(alignment: .center, spacing: 8) {
                periodButton("previous", symbol: "chevron.left")
                VStack(spacing: 0) {
                    Text(view.object("header").text("title")).rnFont(17, .bold)
                        .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
                        .accessibilityAddTraits(.isHeader).accessibilityIdentifier("calendar-period-title")
                    CalendarAction(title: view.object("header").object("today").text("label"),
                        enabled: model.calendarActionsEnabled, palette: palette, id: "calendar-today") {
                        navigate(view.object("header").object("today").object("state"))
                    }
                }.frame(maxWidth: .infinity)
                periodButton("next", symbol: "chevron.right")
            }
            AppChipFlow {
                let modes = view.objects("modes")
                ForEach(modes.indices, id: \.self) { index in
                    let mode = modes[index]
                    CalendarAction(title: mode.text("label"), selected: mode.flag("selected"),
                        enabled: model.calendarActionsEnabled, palette: palette, id: "calendar-mode-" + mode.text("mode")) {
                        queryFocused = false
                        Task { await model.selectCalendarMode(mode.text("mode")) }
                    }
                }
            }.frame(maxWidth: .infinity, alignment: .center)
            let completed = view.object("showCompleted")
            CalendarAction(title: completed.text("label"), selected: completed.flag("on"),
                enabled: model.calendarActionsEnabled, palette: palette, id: "calendar-show-completed") {
                queryFocused = false
                Task { await model.setCalendarShowCompleted(!completed.flag("on")) }
            }
            .accessibilityHint(completed.text("hint"))
        }
        .padding(.horizontal, 12).padding(.vertical, 8).background(palette.card)
        .overlay(alignment: .bottom) { palette.border.frame(height: 1) }
    }

    @ViewBuilder private func periodButton(_ direction: String, symbol: String) -> some View {
        let target = view.object("header").object(direction)
        if !target.isEmpty {
            Button { navigate(target.object("state")) } label: {
                Image(systemName: symbol).font(.system(size: 20, weight: .semibold))
                    .frame(width: 44, height: 44).contentShape(Rectangle())
            }
            .buttonStyle(.plain).disabled(!model.calendarActionsEnabled)
            .accessibilityLabel(target.text("label")).accessibilityIdentifier("calendar-" + direction)
        } else { Color.clear.frame(width: 44, height: 44).accessibilityHidden(true) }
    }

    private func navigate(_ state: CoreObject) {
        queryFocused = false
        Task { await model.navigateCalendar(state) }
    }

    private var month: some View {
        GeometryReader { geometry in
            let details = content.object("details")
            let names = content["dayNames"] as? [String] ?? []
            let count = max(1, names.count)
            let measurementIdentity = names.map { Data($0.utf8).base64EncodedString() }.joined(separator: ":") + ":" + String(describing: dynamicTypeSize)
            let intrinsicWidth = measuredWeekdays.identity == measurementIdentity ? measuredWeekdays.maximumWidth : 0
            let columnWidth = max(geometry.size.width / CGFloat(count), max(intrinsicWidth + 8, 44))
            let canvasWidth = columnWidth * CGFloat(count)
            let panelHeight = min(geometry.size.height, max(176, geometry.size.height * (dynamicTypeSize.isAccessibilitySize ? 0.75 : 0.58)))
            ZStack(alignment: .bottom) {
                if canvasWidth > geometry.size.width + 0.5 {
                    CalendarAnchoredScroll(axis: .horizontal, anchor: viewportAnchor("horizontal"),
                        pointsPerUnit: columnWidth,
                        initialOffset: monthColumnOffset(columnWidth: columnWidth, viewportWidth: geometry.size.width, count: count),
                        identifier: "calendar-month-columns", revealColumn: monthSelectedColumn(count: count)) {
                        monthGrid(names: names, columnWidth: columnWidth, canvasWidth: canvasWidth,
                            height: geometry.size.height, panelHeight: details.isEmpty ? 0 : panelHeight,
                            measurementIdentity: measurementIdentity)
                    }
                    .id(viewportKey)
                } else {
                    monthGrid(names: names, columnWidth: columnWidth, canvasWidth: canvasWidth,
                        height: geometry.size.height, panelHeight: details.isEmpty ? 0 : panelHeight,
                        measurementIdentity: measurementIdentity)
                }
                if !details.isEmpty {
                    CalendarEntryList(model: model, palette: palette, entries: entries.filter { $0.text("type") != "day" },
                        empty: details.text("empty"), prefix: "calendar-details") {
                        VStack(spacing: 6) {
                            HStack(alignment: .center) {
                                Text(details.text("title")).rnFont(16, .semibold).fixedSize(horizontal: false, vertical: true)
                                    .frame(maxWidth: .infinity, alignment: .leading).accessibilityAddTraits(.isHeader)
                                    .accessibilityIdentifier("calendar-selected-date")
                                CalendarAction(title: text.text("addTask"), enabled: model.calendarComposerOpeningEnabled,
                                    palette: palette, id: "calendar-add-selected-day") {
                                    Task { await model.openNewCalendarComposer(day: view.object("state").text("selectedDate")) }
                                }
                                Button { navigate(details.object("close")) } label: {
                                    AppIcon(name: "x", size: 20).frame(width: 44, height: 44).contentShape(Rectangle())
                                }
                                .buttonStyle(.plain).disabled(!model.calendarActionsEnabled)
                                .accessibilityLabel(model.label("common.close")).accessibilityIdentifier("calendar-details-close")
                            }
                            queryInput
                        }
                    }
                    .frame(height: panelHeight).background(palette.card, in: RoundedRectangle(cornerRadius: 16))
                    .overlay(RoundedRectangle(cornerRadius: 16).stroke(palette.border, lineWidth: 1))
                    .accessibilityAction(.escape) { navigate(details.object("close")) }
                }
            }
            .onPreferenceChange(CalendarWeekdayWidths.self) { value in
                if value.identity == measurementIdentity { measuredWeekdays = value }
            }
        }
    }

    private func monthColumnOffset(columnWidth: CGFloat, viewportWidth: CGFloat, count: Int) -> CGFloat {
        let index = days.firstIndex { $0.flag("selected") } ?? days.firstIndex { $0.flag("isToday") } ?? 0
        let column = (max(0, content.number("leadingBlanks")) + index) % count
        return max(0, CGFloat(column) * columnWidth - max(0, viewportWidth - columnWidth) / 2)
    }

    private func monthSelectedColumn(count: Int) -> Int? {
        guard let index = days.firstIndex(where: { $0.flag("selected") }) else { return nil }
        return (max(0, content.number("leadingBlanks")) + index) % count
    }

    private func monthGrid(names: [String], columnWidth: CGFloat, canvasWidth: CGFloat, height: CGFloat,
                           panelHeight: CGFloat, measurementIdentity: String) -> some View {
        ScrollView {
            VStack(spacing: 0) {
                HStack(spacing: 0) {
                    ForEach(names.indices, id: \.self) { index in
                        Text(names[index]).rnFont(11, .semibold).foregroundStyle(palette.secondary)
                            .fixedSize(horizontal: true, vertical: true)
                            .background(GeometryReader { geometry in
                                Color.clear.preference(key: CalendarWeekdayWidths.self,
                                    value: CalendarWeekdayMeasurements(identity: measurementIdentity, widths: [index: geometry.size.width]))
                            })
                            .frame(width: columnWidth).frame(minHeight: 30)
                            .accessibilityIdentifier("calendar-weekday-" + String(index))
                    }
                }.background(palette.card)
                LazyVGrid(columns: Array(repeating: GridItem(.fixed(columnWidth), spacing: 0), count: max(1, names.count)), spacing: 0) {
                    ForEach((0..<max(0, content.number("leadingBlanks"))).map { "blank-" + String($0) }, id: \.self) { _ in
                        Color.clear.frame(height: panelHeight == 0 ? monthCellHeight : 48).accessibilityHidden(true)
                    }
                    ForEach(days.map { $0.text("key") }, id: \.self) { key in
                        if let cell = days.first(where: { $0.text("key") == key }) {
                            monthCell(cell, compact: panelHeight > 0)
                        }
                    }
                }.id(panelHeight > 0)
            }.padding(.bottom, panelHeight)
        }
        .frame(width: canvasWidth, height: height)
        .accessibilityIdentifier("calendar-month-grid")
        .refreshable { await model.refresh() }
    }

    private func monthCell(_ cell: CoreObject, compact: Bool) -> some View {
        Button { queryFocused = false; Task { await model.selectCalendarDay(cell.text("key")) } } label: {
            VStack(spacing: 3) {
                Text(cell.text("dayNumber")).rnFont(13, .semibold)
                    .foregroundStyle(cell.flag("isToday") ? palette.onTint : palette.text)
                    .frame(minWidth: 25, minHeight: 25)
                    .background(cell.flag("isToday") ? palette.tint : Color.clear, in: Circle())
                if !compact {
                    let previews = cell.objects("preview")
                    ForEach(previews.indices, id: \.self) { index in
                        CalendarItemLabel(item: previews[index], palette: palette, compact: true, timed: false)
                    }
                    let counts = cell.object("counts")
                    if counts.number("tasks") > 0 || counts.number("events") > 0 {
                        HStack(spacing: 3) {
                            if counts.number("tasks") > 0 { Text(String(counts.number("tasks"))).rnFont(10, .semibold).foregroundStyle(palette.tint) }
                            if counts.number("events") > 0 { Text(String(counts.number("events"))).rnFont(10, .semibold).foregroundStyle(palette.secondary) }
                        }
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 2).padding(.top, 4).frame(maxWidth: .infinity)
            .frame(height: compact ? 48 : max(44, monthCellHeight))
            .background(cell.flag("selected") ? palette.tint.opacity(0.16) : cell.flag("isToday") ? palette.tint.opacity(0.08) : palette.bg)
            .overlay(Rectangle().stroke(palette.border.opacity(0.6), lineWidth: 0.5)).contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(!model.calendarActionsEnabled)
        .accessibilityLabel(cell.text("accessibilityLabel")).accessibilityAddTraits(cell.flag("selected") ? .isSelected : [])
        .accessibilityIdentifier("calendar-day-" + cell.text("key"))
    }

    private var queryInput: some View {
        HStack(spacing: 6) {
            TextField(text.text("schedulePlaceholder"), text: Binding(get: { model.calendarQuery }, set: model.setCalendarQuery))
                .rnFont(14).textInputAutocapitalization(.never).autocorrectionDisabled().focused($queryFocused)
                .accessibilityLabel(text.text("schedulePlaceholder")).accessibilityIdentifier("calendar-query")
                .disabled(model.retryNeeded || model.taskPresented || model.calendarItemPresented)
            if !model.calendarQuery.isEmpty {
                Button { model.setCalendarQuery("") } label: {
                    AppIcon(name: "x", size: 16).frame(width: 44, height: 44).contentShape(Rectangle())
                }.buttonStyle(.plain).disabled(model.retryNeeded).accessibilityLabel(model.label("common.clear"))
                    .accessibilityIdentifier("calendar-query-clear")
            }
        }
        .padding(.horizontal, 10).frame(minHeight: 44).background(palette.filter, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(palette.border, lineWidth: 1))
    }

    private var schedule: some View {
        entryList(entries, empty: content.text("empty"), prefix: "calendar-schedule")
    }

    private func entryList(_ list: [CoreObject], empty: String, prefix: String) -> some View {
        CalendarEntryList(model: model, palette: palette, entries: list, empty: empty, prefix: prefix)
    }

    private var day: some View {
        VStack(spacing: 0) {
            let allDay = entries.filter { $0.text("type") == "item" && $0.text("lane") == "allDay" }
            if !allDay.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text(text.text("allDay")).rnFont(12, .semibold).foregroundStyle(palette.secondary)
                    ScrollView {
                        LazyVStack(spacing: 5) {
                            ForEach(allDay.indices, id: \.self) { index in
                                CalendarItemButton(item: allDay[index].object("item"), model: model, palette: palette)
                            }
                        }
                    }.frame(maxHeight: dynamicTypeSize.isAccessibilitySize ? 180 : 120)
                }.padding(10).background(palette.card)
            }
            CalendarAnchoredScroll(axis: .vertical, anchor: viewportAnchor("vertical"),
                pointsPerUnit: pixelsPerMinute, initialOffset: initialTimelineOffset, identifier: "calendar-day-timeline") {
                VStack(spacing: 12) {
                    GeometryReader { geometry in
                        ZStack(alignment: .topLeading) {
                            hourGutter
                            timelineColumn(dayKey: content.text("dayKey"), width: max(44, geometry.size.width - gutter), today: content["nowMinutes"] is NSNumber)
                                .offset(x: gutter)
                        }
                    }.frame(height: timelineHeight + 22)
                    queryInput.padding(.horizontal, 12)
                    let results = entries.filter { $0.text("type") == "task" }
                    if !results.isEmpty {
                        Text(content.text("searchTitle")).rnFont(13, .semibold).foregroundStyle(palette.secondary)
                        ForEach(results.indices, id: \.self) { index in CalendarCandidate(entry: results[index], model: model, palette: palette) }
                    }
                }
            }
            moreButton
        }
    }

    private var week: some View {
        GeometryReader { geometry in
            let columnWidth = max(entries.contains { $0.text("lane") == "deadlineMarker" } ? 260 : 44, (geometry.size.width - gutter) / CGFloat(max(1, content.number("visibleDays"))))
            let canvasWidth = gutter + columnWidth * CGFloat(days.count)
            let allDayCount = days.map { day in
                entries.filter { $0.text("type") == "item" && $0.text("lane") == "allDay" && $0.text("dayKey") == day.text("key") }.count
            }.max() ?? 0
            let visibleAllDayRows = min(allDayCount, geometry.size.height < 360 || dynamicTypeSize.isAccessibilitySize ? 1 : 2)
            let allDayHeight = CGFloat(visibleAllDayRows) * max(44, allDayRowHeight) + 4
            let initialColumn = days.firstIndex(where: { $0.flag("selected") }) ?? days.firstIndex(where: { $0.flag("isToday") }) ?? 0
            CalendarAnchoredScroll(axis: .horizontal, anchor: viewportAnchor("horizontal"),
                pointsPerUnit: columnWidth, initialOffset: CGFloat(initialColumn) * columnWidth,
                identifier: "calendar-week-columns", onOffset: { weekOffset = $0 }) {
                VStack(spacing: 0) {
                    HStack(spacing: 0) {
                        palette.bg.frame(width: gutter, height: max(44, weekHeaderHeight)).offset(x: weekOffset).zIndex(2)
                        ForEach(days.indices, id: \.self) { index in
                            let day = days[index]
                            Button { navigate(day.object("opens")) } label: {
                                VStack(spacing: 3) {
                                    Text(day.text("weekday")).rnFont(11, .semibold).foregroundStyle(palette.secondary)
                                    Text(day.text("dayNumber")).rnFont(17, .bold)
                                }
                                .frame(width: columnWidth, height: max(44, weekHeaderHeight)).contentShape(Rectangle())
                                .background(day.flag("isToday") ? palette.tint.opacity(0.1) : palette.bg)
                            }
                            .buttonStyle(.plain).disabled(!model.calendarActionsEnabled)
                            .accessibilityLabel(day.text("title")).accessibilityIdentifier("calendar-week-day-" + day.text("key"))
                            .id("calendar-week-column-" + day.text("key"))
                        }
                    }
                    if visibleAllDayRows > 0 {
                        HStack(alignment: .top, spacing: 0) {
                            Text(text.text("allDay")).rnFont(11).foregroundStyle(palette.secondary).frame(width: gutter, height: allDayHeight)
                                .background(palette.bg).offset(x: weekOffset).zIndex(2)
                            ForEach(days.indices, id: \.self) { index in
                                let items = entries.filter { $0.text("type") == "item" && $0.text("lane") == "allDay" && $0.text("dayKey") == days[index].text("key") }
                                ScrollView {
                                    VStack(spacing: 3) {
                                        ForEach(items.indices, id: \.self) { itemIndex in
                                            CalendarItemButton(item: items[itemIndex].object("item"), model: model, palette: palette, compact: true)
                                        }
                                    }.padding(2)
                                }.frame(width: columnWidth, height: allDayHeight)
                            }
                        }.overlay(alignment: .bottom) { palette.border.frame(height: 1) }
                    }
                    CalendarAnchoredScroll(axis: .vertical, anchor: viewportAnchor("vertical"),
                        pointsPerUnit: pixelsPerMinute, initialOffset: initialTimelineOffset, identifier: "calendar-week-timeline") {
                        HStack(alignment: .top, spacing: 0) {
                            hourGutter.background(palette.bg).offset(x: weekOffset).zIndex(2)
                            ForEach(days.indices, id: \.self) { index in
                                timelineColumn(dayKey: days[index].text("key"), width: columnWidth, today: days[index].flag("isToday"))
                            }
                        }.frame(height: timelineHeight + 22)
                    }
                }
                .frame(width: canvasWidth, height: max(0, geometry.size.height - (entries.count < view.number("total") ? 48 : 0)))
            }
            .overlay(alignment: .bottom) { moreButton.background(palette.bg) }
        }
    }

    private var weekDensity: some View {
        VStack(spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Text(text.text("weekDensity")).rnFont(12, .semibold).foregroundStyle(palette.secondary)
                Spacer(minLength: 8)
                Text(content.object("density").text("value")).rnFont(12, .semibold).foregroundStyle(palette.text)
                    .accessibilityIdentifier("calendar-week-density-value")
            }
            AppChipFlow {
                let choices = content.object("density").objects("choices")
                ForEach(choices.indices, id: \.self) { index in
                    let choice = choices[index]
                    CalendarAction(title: String(choice.number("days")), selected: choice.flag("selected"),
                        enabled: model.calendarActionsEnabled, palette: palette, id: "calendar-week-density-" + String(choice.number("days"))) {
                        queryFocused = false
                        Task { await model.setCalendarWeekDensity(choice.number("days")) }
                    }
                    .accessibilityLabel(choice.text("label"))
                }
            }.frame(maxWidth: .infinity, alignment: .center)
        }
        .padding(.horizontal, 12).padding(.vertical, 8).background(palette.card)
        .overlay(alignment: .top) { palette.border.frame(height: 1) }
    }

    private var hourGutter: some View {
        VStack(spacing: 0) {
            ForEach(hours.indices, id: \.self) { index in
                Text(hours[index]).rnFont(10).foregroundStyle(palette.secondary)
                    .frame(width: gutter, height: index == hours.count - 1 ? 22 : 60 * pixelsPerMinute, alignment: .topTrailing)
                    .padding(.trailing, 5).accessibilityIdentifier("calendar-hour-label-" + String(index))
            }
        }.frame(width: gutter)
    }

    private func timelineColumn(dayKey: String, width: CGFloat, today: Bool) -> some View {
        let items = entries.filter { $0.text("type") == "item" && $0.text("lane") == "timed" && $0.text("dayKey") == dayKey }
        let markers = entries.filter { $0.text("type") == "item" && $0.text("lane") == "deadlineMarker" && $0.text("dayKey") == dayKey }.map { $0.object("item") }
        let blockLaneWidth = markers.isEmpty ? width : width * 0.58
        let mode = content.text("mode")
        let dayTitle = days.first(where: { $0.text("key") == dayKey })?.text("title") ?? ""
        return ZStack(alignment: .topLeading) {
            if mode == "day" || mode == "week" {
                (today ? palette.tint.opacity(0.04) : palette.card)
                    .contentShape(Rectangle())
                    .gesture(SpatialTapGesture().onEnded { tap in
                        guard model.calendarComposerOpeningEnabled else { return }
                        let raw = mode == "day" ? Double(min(1440, max(0, tap.location.y / pixelsPerMinute))) : nil
                        Task { await model.openNewCalendarComposer(day: dayKey, rawMinutes: raw) }
                    })
                    .accessibilityElement()
                    .accessibilityLabel([text.text("addTask"), dayTitle].filter { !$0.isEmpty }.joined(separator: ", "))
                    .accessibilityAddTraits(.isButton)
                    .accessibilityIdentifier((mode == "day" ? "calendar-day-free-slot-" : "calendar-week-add-") + dayKey)
                    .accessibilityAction {
                        Task { await model.openNewCalendarComposer(day: dayKey) }
                    }
            } else {
                (today ? palette.tint.opacity(0.04) : palette.card)
            }
            ForEach(hours.indices, id: \.self) { index in
                palette.border.frame(height: 0.5).offset(y: CGFloat(index) * 60 * pixelsPerMinute)
                    .allowsHitTesting(false)
            }
            if today, let minute = content["nowMinutes"] as? NSNumber {
                palette.danger.frame(height: 1).offset(y: CGFloat(minute.doubleValue) * pixelsPerMinute)
                    .allowsHitTesting(false).accessibilityHidden(true)
            }
            ForEach(items.indices, id: \.self) { index in
                let item = items[index].object("item")
                let timed = item.object("timed")
                let column = timed.object("column")
                let start = CGFloat((timed["startMinutes"] as? NSNumber)?.doubleValue ?? 0)
                let end = CGFloat((timed["endMinutes"] as? NSNumber)?.doubleValue ?? 0)
                let left = CGFloat((column["leftPercent"] as? NSNumber)?.doubleValue ?? 0)
                let fraction = CGFloat((column["widthPercent"] as? NSNumber)?.doubleValue ?? 100)
                let inset: CGFloat = column.number("columnIndex") > 0 ? 2 : 0
                let trailing: CGFloat = column.number("columnIndex") < column.number("columnCount") - 1 ? 2 : 0
                let blockWidth = max(1, blockLaneWidth * fraction / 100 - inset - trailing - 4)
                let height = max(24, (end - start) * pixelsPerMinute)
                CalendarItemButton(item: item, model: model, palette: palette, compact: height < 48, timed: true)
                    .frame(width: blockWidth, height: height).clipped()
                    .position(x: blockLaneWidth * left / 100 + inset + 2 + blockWidth / 2, y: start * pixelsPerMinute + height / 2)
            }
            ForEach(markers.indices, id: \.self) { index in
                let marker = markers[index]
                let minute = CGFloat((marker.object("deadline")["startMinutes"] as? NSNumber)?.doubleValue ?? 0)
                Text("◆").rnFont(10).foregroundStyle(palette.tint)
                    .position(x: width * 0.6 + 4, y: max(6, minute * pixelsPerMinute))
                    .allowsHitTesting(false).accessibilityHidden(true).zIndex(2)
            }
            ForEach(markers.filter { $0.object("deadline").number("groupIndex") == 0 }.indices, id: \.self) { index in
                let first = markers.filter { $0.object("deadline").number("groupIndex") == 0 }[index]
                let groupId = first.object("deadline").text("groupId")
                let group = markers.filter { $0.object("deadline").text("groupId") == groupId }
                let minute = CGFloat((first.object("deadline")["labelMinutes"] as? NSNumber)?.doubleValue ?? 0)
                let height = CGFloat(min(3, group.count)) * 32 * pixelsPerMinute
                ScrollView(.vertical) {
                        VStack(alignment: .leading, spacing: 0) {
                            ForEach(group.indices, id: \.self) { row in
                                let marker = group[row]
                                Button { Task { await model.openCalendarItem(marker) } } label: {
                                    VStack(alignment: .leading, spacing: 1) {
                                        Text(marker.text("title")).rnFont(11).foregroundStyle(palette.text).lineLimit(1)
                                        Text(marker.text("detail")).rnFont(11, .semibold).foregroundStyle(palette.tint).lineLimit(1)
                                    }.frame(maxWidth: .infinity, minHeight: 32 * pixelsPerMinute, alignment: .leading)
                                }.buttonStyle(.plain).disabled(!model.calendarActionsEnabled || !marker.flag("pressable"))
                                    .accessibilityLabel(marker.text("accessibilityLabel"))
                                    .accessibilityIdentifier("calendar-deadline-" + marker.text("taskId"))
                            }
                        }.padding(.leading, 10)
                }.frame(width: width * 0.4, height: height).background(palette.card)
                    .position(x: width * 0.8, y: minute * pixelsPerMinute + height / 2)
            }
        }.frame(width: width, height: timelineHeight + 22).clipped()
    }

    @ViewBuilder private var moreButton: some View {
        if entries.count < view.number("total") {
            CalendarAction(title: model.label("common.more"), enabled: model.calendarActionsEnabled, palette: palette, id: "calendar-more") {
                Task { await model.loadMoreCalendar() }
            }.frame(maxWidth: .infinity, minHeight: 48)
        }
    }
}

// iOS 16 ScrollViewReader restores a measured content anchor. The saved value uses
// timeline minutes or day-column units so a size change never reuses stale pixels.
private struct CalendarAnchoredScroll<Content: View>: View {
    let axis: Axis.Set
    @Binding var anchor: Double?
    let pointsPerUnit: CGFloat
    let initialOffset: CGFloat
    let identifier: String
    var revealColumn: Int? = nil
    var onOffset: (CGFloat) -> Void = { _ in }
    @ViewBuilder var content: () -> Content
    @State private var restoredGeometry: CalendarViewportPosition?
    @State private var pendingOffset: CGFloat?
    @State private var lastOffset: CGFloat?

    var body: some View {
        GeometryReader { viewport in
            ScrollViewReader { reader in
                ScrollView(axis) {
                    content()
                        .id(identifier + "-content")
                        .background(GeometryReader { geometry in
                            let frame = geometry.frame(in: .named(identifier))
                            Color.clear.preference(key: CalendarViewportPositions.self, value: [identifier: CalendarViewportPosition(
                                offset: axis == .horizontal ? -frame.minX : -frame.minY,
                                contentLength: axis == .horizontal ? frame.width : frame.height,
                                viewportLength: axis == .horizontal ? viewport.size.width : viewport.size.height,
                                pointsPerUnit: pointsPerUnit)])
                        })
                }
                .coordinateSpace(name: identifier).accessibilityIdentifier(identifier)
                .onPreferenceChange(CalendarViewportPositions.self) { positions in
                    guard let position = positions[identifier], position.contentLength > 0, position.viewportLength > 0, position.pointsPerUnit > 0 else { return }
                    let maximum = max(0, position.contentLength - position.viewportLength)
                    let offset = min(maximum, max(0, position.offset))
                    let geometryChanged = restoredGeometry?.contentLength != position.contentLength
                        || restoredGeometry?.viewportLength != position.viewportLength
                        || restoredGeometry?.pointsPerUnit != position.pointsPerUnit
                    // Keep the logical minute/day even when a rotation temporarily fits all content.
                    if anchor == nil { anchor = Double(initialOffset / position.pointsPerUnit) }
                    if geometryChanged {
                        restoredGeometry = position
                        lastOffset = offset
                        var target = min(maximum, max(0, CGFloat(anchor ?? 0) * position.pointsPerUnit))
                        if let column = revealColumn {
                            let start = CGFloat(column) * position.pointsPerUnit
                            let end = start + position.pointsPerUnit
                            let restored = target
                            if start < target { target = start }
                            else if end > target + position.viewportLength { target = end - position.viewportLength }
                            target = min(maximum, max(0, target))
                            // Preserve the manual logical offset unless the new geometry would
                            // hide the current selection. A necessary reveal becomes its new anchor.
                            if target != restored { anchor = Double(target / position.pointsPerUnit) }
                        }
                        onOffset(target)
                        pendingOffset = abs(offset - target) > 1 ? target : nil
                        if pendingOffset != nil {
                            let fraction = maximum > 0 ? target / maximum : 0
                            reader.scrollTo(identifier + "-content", anchor: UnitPoint(
                                x: axis == .horizontal ? fraction : 0,
                                y: axis == .vertical ? fraction : 0))
                        }
                        return
                    }
                    onOffset(offset)
                    if let pendingOffset {
                        if abs(offset - pendingOffset) <= 1 { self.pendingOffset = nil }
                        lastOffset = offset
                        return
                    }
                    // Geometry/restoration callbacks never replace the logical anchor. Once the
                    // extent settles, ordinary touch, VoiceOver and programmatic scrolling all do.
                    if maximum > 0, abs(position.offset - offset) <= 1,
                       let previous = lastOffset, previous != offset {
                        anchor = Double(offset / position.pointsPerUnit)
                    }
                    lastOffset = offset
                }
            }
        }
    }
}

private struct CalendarViewportPosition: Equatable {
    let offset: CGFloat
    let contentLength: CGFloat
    let viewportLength: CGFloat
    let pointsPerUnit: CGFloat
}

private struct CalendarViewportPositions: PreferenceKey {
    static var defaultValue: [String: CalendarViewportPosition] = [:]
    static func reduce(value: inout [String: CalendarViewportPosition], nextValue: () -> [String: CalendarViewportPosition]) {
        value.merge(nextValue(), uniquingKeysWith: { _, new in new })
    }
}

private struct CalendarEntryOffsets: PreferenceKey {
    static var defaultValue: [String: CGFloat] = [:]
    static func reduce(value: inout [String: CGFloat], nextValue: () -> [String: CGFloat]) { value.merge(nextValue(), uniquingKeysWith: { _, new in new }) }
}

private func calendarEntryID(_ entry: CoreObject) -> String {
    let opaqueID = entry.text("type") == "day" ? entry.text("key")
        : entry.text("type") == "task" ? entry.text("taskId") : entry.object("item").text("id")
    return entry.text("type") + ":" + entry.text("dayKey") + ":" + entry.text("lane") + ":" +
        Data(opaqueID.utf8).base64EncodedString()
}

private struct CalendarWeekdayMeasurements: Equatable {
    var identity = ""
    var widths: [Int: CGFloat] = [:]
    var maximumWidth: CGFloat { widths.values.max() ?? 0 }
}

private struct CalendarWeekdayWidths: PreferenceKey {
    static var defaultValue = CalendarWeekdayMeasurements()
    static func reduce(value: inout CalendarWeekdayMeasurements, nextValue: () -> CalendarWeekdayMeasurements) {
        let next = nextValue()
        guard !next.identity.isEmpty else { return }
        if value.identity != next.identity { value = next }
        else { value.widths.merge(next.widths, uniquingKeysWith: { _, width in width }) }
    }
}

private struct CalendarEntryList<LeadingContent: View>: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    let entries: [CoreObject]
    let empty: String
    let prefix: String
    @ViewBuilder var leadingContent: () -> LeadingContent
    @State private var restored = false
    @State private var queryReset: String?
    var body: some View {
        ScrollViewReader { reader in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    Color.clear.frame(height: 0).id("calendar-list-top").accessibilityHidden(true)
                    leadingContent()
                    if !empty.isEmpty { Text(empty).rnFont(14).foregroundStyle(palette.secondary).padding(.vertical, 20) }
                    ForEach(entries.indices, id: \.self) { index in
                        let entry = entries[index]
                        let id = calendarEntryID(entry)
                        Group {
                            if entry.text("type") == "day" {
                                Text(entry.text("title")).rnFont(14, .bold).foregroundStyle(palette.secondary)
                                    .padding(.top, 8).accessibilityAddTraits(.isHeader)
                            } else if entry.text("type") == "task" {
                                if index == 0 || entries[index - 1].text("type") != "task" {
                                    let content = model.calendarView.object("content")
                                    Text(entry.text("list") == "planning" ? content.object("planning").text("title") : model.calendarView.object("text").text("searchResultsTitle"))
                                        .rnFont(13, .semibold).foregroundStyle(palette.secondary)
                                    if entry.text("list") == "planning" { Text(content.object("planning").text("subtitle")).rnFont(12).foregroundStyle(palette.secondary) }
                                }
                                CalendarCandidate(entry: entry, model: model, palette: palette)
                            } else { CalendarItemButton(item: entry.object("item"), model: model, palette: palette) }
                        }
                        .id(id)
                        .background(GeometryReader { geometry in
                            Color.clear.preference(key: CalendarEntryOffsets.self, value: [id: geometry.frame(in: .named(prefix)).minY])
                        })
                    }
                    if model.calendarView.objects("items").count < model.calendarView.number("total") {
                        CalendarAction(title: model.label("common.more"), enabled: model.calendarActionsEnabled, palette: palette, id: "calendar-more") {
                            Task { await model.loadMoreCalendar() }
                        }
                    }
                }.padding(14)
            }
            .coordinateSpace(name: prefix).accessibilityIdentifier(prefix)
            .onAppear {
                if !restored {
                    if model.calendarScrollAnchor == "calendar-list-top" { queryReset = model.calendarQuery }
                    reader.scrollTo(model.calendarScrollAnchor, anchor: .top)
                    restored = true
                    resetQueryScroll(reader)
                }
            }
            .onChange(of: model.calendarQuery) { query in
                queryReset = query
                reader.scrollTo("calendar-list-top", anchor: .top)
            }
            .onChange(of: model.calendarCurrent) { current in
                if current { resetQueryScroll(reader) }
            }
            .onPreferenceChange(CalendarEntryOffsets.self) { positions in
                if restored, model.calendarCurrent, queryReset == nil,
                   let first = positions.filter({ $0.value >= 0 }).min(by: { $0.value < $1.value }) { model.calendarScrollAnchor = first.key }
            }
            .refreshable { await model.refresh() }
        }
    }

    private func resetQueryScroll(_ reader: ScrollViewProxy) {
        guard model.calendarCurrent, let query = queryReset else { return }
        Task { @MainActor in
            await Task.yield()
            guard model.calendarCurrent, model.calendarQuery == query, queryReset == query else { return }
            reader.scrollTo("calendar-list-top", anchor: .top)
            queryReset = nil
        }
    }
}

private extension CalendarEntryList where LeadingContent == EmptyView {
    init(model: CoreModel, palette: AppPalette, entries: [CoreObject], empty: String, prefix: String) {
        self.init(model: model, palette: palette, entries: entries, empty: empty, prefix: prefix,
            leadingContent: { EmptyView() })
    }
}

private struct CalendarCandidate: View {
    let entry: CoreObject
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    var body: some View {
        Button { Task { await model.openCalendarComposer(entry) } } label: {
            VStack(alignment: .leading, spacing: 5) {
                Text(entry.text("title")).rnFont(15, .medium)
                Text(entry.text("detail")).rnFont(12).foregroundStyle(palette.secondary)
            }
            .fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .padding(12).background(palette.filter, in: RoundedRectangle(cornerRadius: 8))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(!model.calendarComposerOpeningEnabled)
        .accessibilityIdentifier("calendar-candidate-" + entry.text("taskId"))
    }
}

private struct CalendarItemButton: View {
    let item: CoreObject
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    var compact = false
    var timed = false
    var body: some View {
        HStack(spacing: 6) {
            Button { Task { await model.openCalendarItem(item) } } label: {
                CalendarItemLabel(item: item, palette: palette, compact: compact, timed: timed)
                    .frame(maxWidth: .infinity, maxHeight: timed ? .infinity : nil, alignment: .topLeading)
                    .frame(minHeight: timed ? 0 : 44).contentShape(Rectangle())
            }
            .buttonStyle(.plain).disabled(!model.calendarItemOpeningEnabled(item))
            .accessibilityLabel(item.text("accessibilityLabel").isEmpty ? [item.text("title"), item.text("detail")].filter { !$0.isEmpty }.joined(separator: ", ") : item.text("accessibilityLabel"))
            .accessibilityIdentifier("calendar-item-" + item.text("id"))
            if item.flag("showDone") {
                CalendarAction(title: model.calendarView.object("text").text("done"), enabled: model.calendarActionsEnabled,
                    palette: palette, id: "calendar-item-done-" + item.text("id")) {
                    Task { await model.completeCalendarItem(item) }
                }
            }
        }
    }
}

private struct CalendarItemLabel: View {
    let item: CoreObject
    let palette: AppPalette
    var compact: Bool
    var timed: Bool
    private var tones: CoreObject { item.object("tones") }
    private func tone(_ name: String) -> Color {
        switch name {
        case "tint": return palette.tint
        case "danger": return palette.danger
        case "secondary": return palette.secondary
        case "input": return palette.filter
        case "source": return item.text("sourceColor").isEmpty ? palette.tint : Color(hex: item.text("sourceColor"))
        case "none": return .clear
        default: return palette.text
        }
    }
    private var fill: Color {
        if timed && !item.flag("projected") && tones.text("fill") == "tint" { return palette.tint }
        if tones.text("fill") == "input" { return palette.filter }
        return tones.text("fill").isEmpty ? .clear : tone(tones.text("fill")).opacity(palette.dark ? 0.2 : 0.12)
    }
    var body: some View {
        VStack(alignment: .leading, spacing: compact ? 1 : 5) {
            Text(item.text("title")).rnFont(compact ? 10 : 14, .semibold)
                .foregroundStyle(tones.text("text").isEmpty && timed ? palette.onTint : tone(tones.text("text")))
                .strikethrough(tones.flag("struck")).lineLimit(compact ? 1 : 3)
            if !compact && !item.text("detail").isEmpty {
                Text(item.text("detail")).rnFont(11).foregroundStyle(timed && !item.flag("projected") ? palette.onTint.opacity(0.85) : palette.secondary)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: timed ? .infinity : nil, alignment: .topLeading)
        .padding(compact ? 3 : 10).background(fill, in: RoundedRectangle(cornerRadius: 6))
        .overlay(alignment: .leading) { tone(tones.text("accent")).frame(width: 2).opacity(tones.text("accent").isEmpty ? 0 : 1) }
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(tones.flag("dashed") ? palette.tint.opacity(0.6) : .clear,
            style: StrokeStyle(lineWidth: 1, dash: tones.flag("dashed") ? [3, 3] : [])))
        .opacity(tones.flag("faded") ? 0.65 : 1)
    }
}

private struct CalendarAction: View {
    let title: String
    var selected = false
    var destructive = false
    let enabled: Bool
    let palette: AppPalette
    let id: String
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Text(title).rnFont(12, .semibold).fixedSize(horizontal: false, vertical: true)
                .foregroundStyle(destructive ? palette.danger : selected ? palette.onTint : palette.tint).padding(.horizontal, 12)
                .frame(minWidth: 44, minHeight: 44).background(selected ? palette.tint : palette.filter, in: RoundedRectangle(cornerRadius: 8))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(!enabled).accessibilityIdentifier(id).accessibilityAddTraits(selected ? .isSelected : [])
    }
}

struct CalendarItemSheet: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    private var sheetTitle: some View {
        let title = Text(model.calendarItemSheet.text("title")).rnFont(19, .bold).accessibilityAddTraits(.isHeader)
            .accessibilityIdentifier("calendar-item-title")
        #if DEBUG && targetEnvironment(simulator)
        return title.accessibilityValue(model.calendarEventTaskDispatchTestState)
        #else
        return title
        #endif
    }
    var body: some View {
        GeometryReader { geometry in
            ZStack {
                Color.black.opacity(0.35).ignoresSafeArea().onTapGesture { model.closeCalendarItem() }.accessibilityHidden(true)
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        sheetTitle
                        if !model.calendarItemSheet.text("message").isEmpty {
                            Text(model.calendarItemSheet.text("message")).rnFont(14).fixedSize(horizontal: false, vertical: true)
                        }
                        if let error = model.calendarItemError {
                            Text(error).rnFont(14).foregroundStyle(palette.danger).accessibilityIdentifier("calendar-item-error")
                            CalendarAction(title: model.label("common.retry"), enabled: !model.busy && !model.retryNeeded,
                                palette: palette, id: "calendar-item-retry") { Task { await model.retryCalendarItem() } }
                        }
                        let allowedActions = model.calendarItemSheet.text("kind") == "event"
                            ? ["createTask", "openInCalendar", "cancel"] : ["edit", "unschedule", "done", "delete", "cancel", "ok"]
                        let actions = model.calendarItemSheet.objects("buttons").filter { allowedActions.contains($0.text("id")) }
                        ForEach(actions.indices, id: \.self) { index in
                            let action = actions[index]
                            CalendarAction(title: action.text("label"), destructive: action.text("style") == "destructive", enabled: model.calendarItemActionEnabled(action.text("id")),
                                palette: palette, id: "calendar-action-" + action.text("id")) {
                                Task { await model.performCalendarItemAction(action.text("id")) }
                            }
                        }
                        if actions.isEmpty {
                            CalendarAction(title: model.label("common.close"), enabled: !model.busy && !model.retryNeeded,
                                palette: palette, id: "calendar-item-close") { model.closeCalendarItem() }
                        }
                        if model.retryNeeded && model.error != nil { FailureBanner(model: model, palette: palette) }
                        if model.busy { ProgressView() }
                    }.padding(20).frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxWidth: 440, maxHeight: geometry.size.height * 0.75)
                .background(palette.card, in: RoundedRectangle(cornerRadius: 16)).padding(20)
            }
            .accessibilityElement(children: .contain).accessibilityAddTraits(.isModal)
            .accessibilityAction(.escape) { model.closeCalendarItem() }
        }
    }
}

struct CalendarComposerSheet: View {
    @ObservedObject var model: CoreModel
    let palette: AppPalette
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    private enum TimeField: Hashable { case start, end }
    @FocusState private var focusedTime: TimeField?
    @FocusState private var queryFocused: Bool
    @FocusState private var titleFocused: Bool
    private var view: CoreObject { model.calendarComposerView }
    private var labels: CoreObject { view.object("text") }
    private var mode: String { view.object("composer").text("mode") }
    private var controlsEnabled: Bool { !model.busy && !model.retryNeeded && !model.calendarComposerEditPending }

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .bottom) {
                Button { close() } label: { Color.black.opacity(0.35).contentShape(Rectangle()) }
                    .buttonStyle(.plain).ignoresSafeArea().disabled(model.busy || model.retryNeeded)
                    .accessibilityLabel(model.label("common.close"))
                    .accessibilityIdentifier("calendar-composer-backdrop")
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        HStack(alignment: .top, spacing: 8) {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(labels.text("title")).rnFont(19, .bold).accessibilityAddTraits(.isHeader)
                                    .accessibilityIdentifier("calendar-composer-title")
                                Text(view.text("dateLabel")).rnFont(14).foregroundStyle(palette.secondary)
                                    .accessibilityIdentifier("calendar-composer-date")
                            }.frame(maxWidth: .infinity, alignment: .leading)
                            Button { close() } label: {
                                AppIcon(name: "x", size: 20).frame(width: 44, height: 44).contentShape(Rectangle())
                            }.buttonStyle(.plain).disabled(model.busy || model.retryNeeded)
                                .accessibilityLabel(labels.text("close"))
                                .accessibilityIdentifier("calendar-composer-close")
                        }
                        AppChipFlow {
                            CalendarAction(title: labels.text("newTask"), selected: mode == "new",
                                enabled: controlsEnabled, palette: palette, id: "calendar-composer-mode-new") {
                                model.setCalendarComposerMode("new")
                                endEditing()
                            }
                            CalendarAction(title: labels.text("existingTask"), selected: mode == "existing",
                                enabled: controlsEnabled, palette: palette, id: "calendar-composer-mode-existing") {
                                model.setCalendarComposerMode("existing")
                                endEditing()
                            }
                        }
                        if mode == "new" {
                            TextField(labels.text("titlePlaceholder"), text: Binding(
                                get: { model.calendarComposerTitleInput },
                                set: { if titleFocused { model.setCalendarComposerTitle($0) } }))
                                .rnFont(15).focused($titleFocused)
                                .padding(12).frame(minHeight: 44)
                                .background(palette.filter, in: RoundedRectangle(cornerRadius: 8))
                                .disabled(model.busy || model.retryNeeded)
                                .contentShape(Rectangle()).onTapGesture {
                                    if !model.busy && !model.retryNeeded { titleFocused = true }
                                }
                                .accessibilityLabel(labels.text("titlePlaceholder"))
                                .accessibilityIdentifier("calendar-composer-new-title")
                            Text(labels.text("help")).rnFont(13).foregroundStyle(palette.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                                .accessibilityIdentifier("calendar-composer-help")
                        } else {
                            TextField(labels.text("queryPlaceholder"), text: Binding(
                                get: { model.calendarComposerQueryInput },
                                set: { if queryFocused { model.setCalendarComposerQuery($0) } }))
                                .rnFont(15).textInputAutocapitalization(.never).autocorrectionDisabled()
                                .focused($queryFocused)
                                .padding(12).frame(minHeight: 44).background(palette.filter, in: RoundedRectangle(cornerRadius: 8))
                                .disabled(model.busy || model.retryNeeded)
                                .contentShape(Rectangle()).onTapGesture {
                                    if !model.busy && !model.retryNeeded { queryFocused = true }
                                }
                                .accessibilityIdentifier("calendar-composer-query")
                            let candidates = view.objects("candidates")
                            ScrollView {
                                LazyVStack(spacing: 4) {
                                    if candidates.isEmpty {
                                        Text(labels.text("noMatchingTasks")).rnFont(14).foregroundStyle(palette.secondary)
                                            .frame(maxWidth: .infinity, alignment: .leading).padding(12)
                                    }
                                    ForEach(candidates.indices, id: \.self) { index in
                                        let candidate = candidates[index]
                                        Button {
                                            model.selectCalendarComposerTask(candidate.text("id"))
                                            queryFocused = false
                                        } label: {
                                            Text(candidate.text("title")).rnFont(14)
                                                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                                                .padding(.horizontal, 12)
                                                .background(candidate.flag("selected") ? palette.tint.opacity(0.16) : palette.filter,
                                                    in: RoundedRectangle(cornerRadius: 8))
                                                .contentShape(Rectangle())
                                        }
                                        .buttonStyle(.plain).disabled(!controlsEnabled)
                                        .accessibilityAddTraits(candidate.flag("selected") ? .isSelected : [])
                                        .accessibilityIdentifier("calendar-composer-candidate-" + candidate.text("id"))
                                    }
                                }
                            }.frame(maxHeight: min(240, geometry.size.height * 0.28))
                            if !view.text("selectedTaskTitle").isEmpty {
                                Text(view.text("selectedTaskTitle")).rnFont(13, .semibold)
                                    .foregroundStyle(palette.tint).accessibilityIdentifier("calendar-composer-selected-task")
                            }
                        }
                        if dynamicTypeSize.isAccessibilitySize || min(geometry.size.width, 520) < 370 {
                            VStack(spacing: 12) {
                                timeInput("start", label: labels.text("start"), placeholder: view.object("placeholders").text("start"))
                                timeInput("end", label: labels.text("end"), placeholder: view.object("placeholders").text("end"))
                            }
                        } else {
                            HStack(alignment: .top, spacing: 12) {
                                timeInput("start", label: labels.text("start"), placeholder: view.object("placeholders").text("start"))
                                timeInput("end", label: labels.text("end"), placeholder: view.object("placeholders").text("end"))
                            }
                        }
                        AppChipFlow {
                            let durations = view.objects("durations")
                            ForEach(durations.indices, id: \.self) { index in
                                let duration = durations[index]
                                CalendarAction(title: duration.text("label"), selected: duration.flag("selected"),
                                    enabled: controlsEnabled, palette: palette,
                                    id: "calendar-composer-duration-" + String(duration.number("minutes"))) {
                                    model.setCalendarComposerDuration(duration.number("minutes"))
                                    endEditing()
                                }
                            }
                        }
                        if let error = model.calendarComposerError ?? view["error"] as? String, !error.isEmpty {
                            Text(error).rnFont(14).foregroundStyle(palette.danger)
                                .accessibilityIdentifier("calendar-composer-error")
                        }
                        if model.calendarComposerEditPending && model.calendarComposerError == nil {
                            ProgressView().accessibilityLabel(model.label("common.loading"))
                        }
                        if model.calendarComposerError != nil && model.calendarComposerEditPending {
                            CalendarAction(title: model.label("common.retry"), enabled: !model.busy && !model.retryNeeded,
                                palette: palette, id: "calendar-composer-retry-edit") { model.retryCalendarComposerEdit() }
                        }
                        if model.retryNeeded && model.error != nil { FailureBanner(model: model, palette: palette) }
                        HStack(spacing: 10) {
                            Spacer(minLength: 0)
                            Button { close() } label: {
                                Text(labels.text("cancel")).rnFont(14, .bold).foregroundStyle(palette.text)
                                    .frame(minWidth: 96, minHeight: 44)
                                    .padding(.horizontal, 10).background(palette.input, in: RoundedRectangle(cornerRadius: 10))
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain).disabled(model.busy || model.retryNeeded)
                            .accessibilityIdentifier("calendar-composer-cancel")
                            Button {
                                endEditing()
                                Task { await model.saveCalendarComposer() }
                            } label: {
                                Text(labels.text("save")).rnFont(14, .bold).foregroundStyle(palette.onTint)
                                    .frame(minWidth: 96, minHeight: 44)
                                    .padding(.horizontal, 10).background(palette.tint, in: RoundedRectangle(cornerRadius: 10))
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain).disabled(!model.calendarComposerCanSave)
                            .opacity(model.calendarComposerCanSave ? 1 : 0.5)
                            .accessibilityIdentifier("calendar-composer-save")
                        }
                    }
                    .padding(20).frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxWidth: 520, maxHeight: geometry.size.height * 0.82, alignment: .bottom)
                .background(palette.card, in: UnevenRoundedRectangle(topLeadingRadius: 16, topTrailingRadius: 16))
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
            .accessibilityElement(children: .contain).accessibilityAddTraits(.isModal)
            .accessibilityAction(.escape) { close() }
        }
    }

    @ViewBuilder private func timeInput(_ name: String, label: String, placeholder: String) -> some View {
        let isStart = name == "start"
        let focused: TimeField = isStart ? .start : .end
        VStack(alignment: .leading, spacing: 5) {
            Text(label).rnFont(13, .semibold)
            TextField(placeholder, text: Binding(get: {
                if focusedTime == focused { return isStart ? model.calendarComposerStartInput : model.calendarComposerEndInput }
                return view.object("timeLabels").text(name)
            }, set: {
                if focusedTime == focused { model.setCalendarComposerTime(isStart ? "startTime" : "endTime", text: $0) }
            }))
                .rnFont(15).keyboardType(.numbersAndPunctuation)
                .textInputAutocapitalization(.never).autocorrectionDisabled()
                .focused($focusedTime, equals: focused)
                .padding(12).frame(minHeight: 44).background(palette.filter, in: RoundedRectangle(cornerRadius: 8))
                .disabled(model.busy || model.retryNeeded)
                .contentShape(Rectangle()).onTapGesture {
                    if !model.busy && !model.retryNeeded { focusedTime = focused }
                }
                .accessibilityLabel(label)
                .accessibilityIdentifier("calendar-composer-" + name)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func endEditing() { queryFocused = false; titleFocused = false; focusedTime = nil }
    private func close() { endEditing(); model.closeCalendarComposer() }
}
