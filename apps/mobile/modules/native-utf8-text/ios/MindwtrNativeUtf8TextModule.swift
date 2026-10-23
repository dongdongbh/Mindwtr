import ExpoModulesCore
import Foundation

public final class MindwtrNativeUtf8TextModule: Module {
    public func definition() -> ModuleDefinition {
        Name("MindwtrNativeUtf8Text")

        // #1434: the text TextDecoder("utf-8") gives for a valid UTF-8 body, without its one leading BOM;
        // nil for anything else (not base64, invalid UTF-8), so JavaScript decodes those bytes as before.
        Function("decodeBase64Utf8") { (base64: String) -> String? in
            guard let data = Data(base64Encoded: base64) else { return nil }
            let body = data.starts(with: [0xEF, 0xBB, 0xBF]) ? data.dropFirst(3) : data[...]
            let text = String(decoding: body, as: UTF8.self)
            // String(decoding:) replaces invalid bytes; valid UTF-8 round-trips byte for byte.
            return text.utf8.elementsEqual(body) ? text : nil
        }
    }
}
