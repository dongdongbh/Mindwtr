import ExpoModulesCore
import Foundation

public final class MindwtrNativeUtf8TextModule: Module {
    public func definition() -> ModuleDefinition {
        Name("MindwtrNativeUtf8Text")


        Function("decodeBase64Utf8") { (base64: String) -> String? in
            guard let data = Data(base64Encoded: base64) else { return nil }
            let body = data.starts(with: [0xEF, 0xBB, 0xBF]) ? data.dropFirst(3) : data[...]
            let text = String(decoding: body, as: UTF8.self)

            return text.utf8.elementsEqual(body) ? text : nil
        }
    }
}
