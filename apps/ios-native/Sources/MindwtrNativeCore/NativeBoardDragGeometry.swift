import Foundation
import CoreFoundation
import CoreGraphics

/// Fixed, content-free geometry snapshot shared by App emission and host admission.
public enum NativeBoardDragGeometry {
    public static let message = "Native iOS Board drag geometry"
    public static let releaseCheck = "v1.3.8/ios-board-drag-geometry"
    private static let rectangles = ["originalViewport", "currentViewport", "originalArea", "currentArea", "originalRow", "currentRow"]
    private static let reasons = ["geometry-missing", "geometry-viewport", "geometry-area", "geometry-rows", "geometry-other", "geometry-scroll-rebased"]

    public static func payload(reason: String, originalViewport: CGRect?, currentViewport: CGRect?,
                               originalArea: CGRect?, currentArea: CGRect?, originalRow: CGRect?, currentRow: CGRect?) -> [String: Any]? {
        guard reasons.contains(reason) else { return nil }
        func record(_ rect: CGRect?) -> [String: Any] {
            let values = rect.map { [Double($0.origin.x), Double($0.origin.y), Double($0.width), Double($0.height)] }
            let validity = values == nil ? "missing" : (values!.allSatisfy { $0.isFinite } ? "finite" : "nonfinite")
            let numbers = validity == "finite" ? values! : [0, 0, 0, 0]
            return ["validity": validity, "x": numbers[0], "y": numbers[1], "width": numbers[2], "height": numbers[3]]
        }
        var value: [String: Any] = ["releaseCheck": releaseCheck, "reason": reason]
        for (name, rect) in zip(rectangles, [originalViewport, currentViewport, originalArea, currentArea, originalRow, currentRow]) {
            value[name] = record(rect)
        }
        return value
    }

    public static func accepts(_ value: [String: Any]) -> Bool {
        guard Set(value.keys) == Set(rectangles + ["releaseCheck", "reason"]),
              value["releaseCheck"] as? String == releaseCheck,
              reasons.contains(value["reason"] as? String ?? "") else { return false }
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
