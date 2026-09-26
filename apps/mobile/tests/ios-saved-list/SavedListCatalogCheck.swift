// Run on macOS: swiftc apps/mobile/ios-app-intents/MindwtrSavedListCatalog.swift
// apps/mobile/tests/ios-saved-list/SavedListCatalogCheck.swift -o /path/to/check && /path/to/check
import Foundation

@main
struct SavedListCatalogCheck {
    static func main() {
        let json = #"{"savedFilters":[{"id":"desk","name":"Desk"},{"id":"desk","name":"Duplicate"},{"id":"","name":"Invalid"},{"id":"blank","name":" "}]}"#
        assert(MindwtrSavedListCatalog.decode(json) == [.init(id: "desk", name: "Desk")])
        assert(MindwtrSavedListCatalog.decode(json.replacingOccurrences(of: "Desk", with: "Office")).first?.id == "desk")
        for missing in [nil, "bad json", "{}", #"{"savedFilters":[]}"#] as [String?] {
            assert(MindwtrSavedListCatalog.decode(missing).isEmpty)
        }
        for invalid in ["", "  ", "bad\nvalue", String(repeating: "a", count: 1018)] {
            assert(MindwtrSavedListCatalog.destination(id: invalid) == nil)
        }
        let id = "desk/ ?#%é"
        let url = MindwtrSavedListCatalog.destination(id: id)!
        let parts = URLComponents(url: url, resolvingAgainstBaseURL: false)!
        assert(parts.scheme == "mindwtr" && parts.host == "")
        assert(parts.percentEncodedPath.split(separator: "/").count == 2)
        assert(parts.path == "/widget-list/filter:" + id)
        assert(parts.queryItems == [URLQueryItem(name: "source", value: "shortcut")])
        print("Saved list catalog and destination checks passed")
    }
}
