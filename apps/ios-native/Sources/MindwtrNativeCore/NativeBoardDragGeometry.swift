import Foundation
import CoreFoundation
import CoreGraphics

public enum NativeBoardDragGeometry {
    public static let message = "Native iOS Board drag geometry"
    public static let releaseCheck = "v1.3.9/ios-board-drag-geometry"
    private static let rectangles = ["originalViewport", "currentViewport", "originalArea", "currentArea", "originalRow", "currentRow", "originalColumn", "currentColumn"]
    public enum RebaseRejection: String, CaseIterable {
        case claimed = "claimed", captureUnavailable = "capture-unavailable"
        case viewportCount = "viewport-count", viewportChanged = "viewport-changed", viewportInvalid = "viewport-invalid"
        case columnCount = "column-count", columnsUnavailable = "columns-unavailable"
        case translationNonfinite = "translation-nonfinite", translationZero = "translation-zero"
        case columnIdentity = "column-identity", columnInvalid = "column-invalid"
        case columnX = "column-x", columnSize = "column-size", columnArithmetic = "column-arithmetic-nonfinite", columnY = "column-y"
        case rowCount = "row-count", rowStatus = "row-status", rowIdentity = "row-identity", rowFrame = "row-frame"
        case sourceIneligible = "source-ineligible"
    }
    private static let columnRejections: [RebaseRejection] = [.columnIdentity, .columnInvalid, .columnX, .columnSize, .columnArithmetic, .columnY]
    private static let reasons = ["geometry-missing", "geometry-viewport", "geometry-area", "geometry-rows", "geometry-other", "geometry-scroll-rebased", "geometry-scroll-roundoff-rebased", "geometry-scroll-height-roundoff-rebased"]

    public static func matchesVerticalTranslation(_ original: CGRect, _ current: CGRect, delta: CGFloat,
        rejected: (RebaseRejection) -> Void = { _ in }) -> Bool {
        func refuse(_ reason: RebaseRejection) -> Bool { rejected(reason); return false }
        guard [original.minX, original.minY, original.width, original.height, original.maxX, original.maxY,
               current.minX, current.minY, current.width, current.height, current.maxX, current.maxY, delta]
            .allSatisfy({ $0.isFinite }), original.width > 0, original.height > 0 else { return refuse(.columnInvalid) }
        guard current.origin.x == original.origin.x else { return refuse(.columnX) }
        guard current.size.width == original.size.width else { return refuse(.columnSize) }
        let endpointULP = max(max(original.minY.ulp, original.maxY.ulp), max(current.minY.ulp, current.maxY.ulp))
        let heightRoundoff = min(CGFloat(0.000000001), 2 * endpointULP)
        let heightResidual = current.size.height - original.size.height
        guard original.size.height > 0, current.size.height > 0, heightResidual.isFinite,
              abs(heightResidual) <= heightRoundoff else { return refuse(.columnSize) }
        let expectedY = original.origin.y + delta
        let residual = current.origin.y - expectedY
        guard expectedY.isFinite, residual.isFinite else { return refuse(.columnArithmetic) }
        guard abs(residual) <= 0.000000001 else { return refuse(.columnY) }
        return true
    }

    public static func payload(reason: String, originalViewport: CGRect?, currentViewport: CGRect?,
                               originalArea: CGRect?, currentArea: CGRect?, originalRow: CGRect?, currentRow: CGRect?,
                               rebaseReason: RebaseRejection? = nil, columnOrdinal: Int? = nil,
                               originalColumn: CGRect? = nil, currentColumn: CGRect? = nil) -> [String: Any]? {
        guard reasons.contains(reason) else { return nil }
        let column = rebaseReason.map { columnRejections.contains($0) } ?? false
        guard column ? (columnOrdinal.map { (0...4).contains($0) } == true && originalColumn != nil && currentColumn != nil)
            : (columnOrdinal == nil && originalColumn == nil && currentColumn == nil) else { return nil }
        func record(_ rect: CGRect?) -> [String: Any] {
            let values = rect.map { [Double($0.origin.x), Double($0.origin.y), Double($0.width), Double($0.height)] }
            let validity = values == nil ? "missing" : (values!.allSatisfy { $0.isFinite } ? "finite" : "nonfinite")
            let numbers = validity == "finite" ? values! : [0, 0, 0, 0]
            return ["validity": validity, "x": numbers[0], "y": numbers[1], "width": numbers[2], "height": numbers[3]]
        }
        var value: [String: Any] = ["releaseCheck": releaseCheck, "reason": reason,
            "rebaseReason": rebaseReason?.rawValue ?? "not-recorded", "columnOrdinal": columnOrdinal ?? -1]
        for (name, rect) in zip(rectangles, [originalViewport, currentViewport, originalArea, currentArea, originalRow, currentRow, originalColumn, currentColumn]) {
            value[name] = record(rect)
        }
        return value
    }

    public static func accepts(_ value: [String: Any]) -> Bool {
        guard Set(value.keys) == Set(rectangles + ["releaseCheck", "reason", "rebaseReason", "columnOrdinal"]),
              value["releaseCheck"] as? String == releaseCheck,
              reasons.contains(value["reason"] as? String ?? ""),
              let rejection = value["rebaseReason"] as? String,
              rejection == "not-recorded" || RebaseRejection(rawValue: rejection) != nil,
              let ordinal = value["columnOrdinal"] as? NSNumber, CFGetTypeID(ordinal) != CFBooleanGetTypeID(),
              ordinal.doubleValue.isFinite, ordinal.doubleValue.rounded(.towardZero) == ordinal.doubleValue,
              (-1.0...4.0).contains(ordinal.doubleValue) else { return false }
        let column = RebaseRejection(rawValue: rejection).map { columnRejections.contains($0) } ?? false
        guard column == (ordinal.intValue >= 0) else { return false }
        for name in ["originalColumn", "currentColumn"] {
            guard let record = value[name] as? [String: Any],
                  (record["validity"] as? String == "missing") == !column else { return false }
        }
        return rectangles.allSatisfy { name in
            guard let rect = value[name] as? [String: Any],
                  Set(rect.keys) == Set(["validity", "x", "y", "width", "height"]),
                  let validity = rect["validity"] as? String,
                  ["finite", "missing", "nonfinite"].contains(validity) else { return false }
            return ["x", "y", "width", "height"].allSatisfy { component in
                guard let number = rect[component] as? NSNumber,
                      CFGetTypeID(number) != CFBooleanGetTypeID(), number.doubleValue.isFinite else { return false }
                return validity == "finite" || number.doubleValue == 0
            }
        }
    }
}
