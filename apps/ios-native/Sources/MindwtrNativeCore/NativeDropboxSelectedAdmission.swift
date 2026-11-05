import Foundation

enum NativeDropboxSelectedAdmission {
    static let legacyTokens = "@mindwtr_dropbox_tokens"
    static let secureTokens = "mindwtr_dropbox_tokens"
    static var unavailable: HostFailure { HostFailure("Selected Dropbox attachment is unavailable") }

    static func path(_ cloudKey: String) throws -> String {
        let spaces = CharacterSet(charactersIn: "\u{0009}\u{000A}\u{000B}\u{000C}\u{000D}\u{0020}\u{00A0}\u{1680}\u{2000}\u{2001}\u{2002}\u{2003}\u{2004}\u{2005}\u{2006}\u{2007}\u{2008}\u{2009}\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}")
        let trimmed = cloudKey.trimmingCharacters(in: spaces)
        guard !trimmed.isEmpty, trimmed.utf8.count <= 16_384 else { throw unavailable }
        return trimmed.hasPrefix("/") ? trimmed : "/" + trimmed
    }
    static func validateHTTP(_ json: String, configuration: NativeDropboxConfiguration, cloudKey: String) throws {
        guard json.utf8.count <= 128 * 1024, try NativeJSON.hasUniqueObjectKeys(json),
              let input = try NativeJSON.jsonObject(with: Data(json.utf8)) as? [String: Any],
              let url = input["url"] as? String, input["method"] as? String == "POST", input["redirect"] as? String == "error",
              let pairs = input["headers"] as? [[String]], pairs.count <= 2 else { throw unavailable }
        var headers: [String: String] = [:]
        for pair in pairs {
            guard pair.count == 2, pair[0].utf8.allSatisfy({ $0 < 128 }), pair[1].utf8.count <= 32_768,
                  headers.updateValue(pair[1], forKey: pair[0].lowercased()) == nil else { throw unavailable }
        }
        if url.utf8.elementsEqual("https://content.dropboxapi.com/2/files/download".utf8) {
            guard Set(input.keys) == Set(["url", "method", "redirect", "headers"]),
                  Set(headers.keys) == Set(["authorization", "dropbox-api-arg"]),
                  let authorization = headers["authorization"], authorization.hasPrefix("Bearer "), authorization.utf8.count > 7,
                  let argument = headers["dropbox-api-arg"], try NativeJSON.hasUniqueObjectKeys(argument),
                  let parsed = try NativeJSON.jsonObject(with: Data(argument.utf8)) as? [String: Any],
                  Set(parsed.keys) == Set(["path"]), let requested = parsed["path"] as? String,
                  requested.utf8.elementsEqual(try path(cloudKey).utf8) else { throw unavailable }
        } else if url.utf8.elementsEqual("https://api.dropboxapi.com/oauth2/token".utf8) {
            guard Set(input.keys) == Set(["url", "method", "redirect", "headers", "text"]),
                  Set(headers.keys) == Set(["content-type"]), headers["content-type"] == "application/x-www-form-urlencoded",
                  let text = input["text"] as? String, text.utf8.count <= 64 * 1024 else { throw unavailable }
            var fields: [String: String] = [:]
            for pair in text.split(separator: "&", omittingEmptySubsequences: false) {
                let parts = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
                guard parts.count == 2,
                      let name = String(parts[0]).replacingOccurrences(of: "+", with: " ").removingPercentEncoding,
                      let value = String(parts[1]).replacingOccurrences(of: "+", with: " ").removingPercentEncoding,
                      fields.updateValue(value, forKey: name) == nil else { throw unavailable }
            }
            guard Set(fields.keys) == Set(["grant_type", "refresh_token", "client_id"]), fields["grant_type"] == "refresh_token",
                  fields["client_id"]?.utf8.elementsEqual(configuration.clientID.utf8) == true,
                  let refresh = fields["refresh_token"], !refresh.isEmpty, refresh.utf8.count <= 16_384,
                  !refresh.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { throw unavailable }
        } else { throw unavailable }
    }
    static func validateSecret(_ json: String) throws {
        guard json.utf8.count <= 512 * 1024, try NativeJSON.hasUniqueObjectKeys(json),
              let input = try NativeJSON.jsonObject(with: Data(json.utf8)) as? [String: Any],
              input["key"] as? String == secureTokens, let operation = input["op"] as? String else { throw unavailable }
        if operation == "get" {
            guard Set(input.keys) == Set(["op", "key"]) else { throw unavailable }
        } else if operation == "set" {
            guard Set(input.keys).isSubset(of: Set(["op", "key", "value", "accessibility"])),
                  let value = input["value"] as? String, value.utf8.count <= 64 * 1024,
                  input["accessibility"] == nil || input["accessibility"] as? String == "when-unlocked" else { throw unavailable }
        } else { throw unavailable }
    }
}
