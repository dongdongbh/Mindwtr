import WidgetKit


@_cdecl("mindwtr_reload_widgets")
public func mindwtr_reload_widgets() {
    if #available(macOS 11.0, *) {
        WidgetCenter.shared.reloadAllTimelines()
    }
}
