import Foundation
import CoreFoundation

public enum NativeVoiceProvider: String, Decodable, Sendable { case gemini, openai, whisper, parakeet }
public enum NativeVoiceMode: String, Decodable, Sendable { case smartParse = "smart_parse", transcribeOnly = "transcribe_only" }
public enum NativeVoiceFieldStrategy: String, Decodable, Sendable { case smart, titleOnly = "title_only", descriptionOnly = "description_only" }
public enum NativeVoiceAvailabilityReason: Sendable { case disabled, unsupportedProvider, credentialMissing, modelMissing, unavailable }

public struct NativeVoiceSettingsWitness: Sendable, Equatable {
    let json: String
    var object: [String: Any] { get throws { try NativeVoiceJSON.object(json, maximum: 32768) } }
    static func validated(_ input: Any?) throws -> Self {
        guard let value = input as? [String: Any], Set(value.keys) == Set(["aiPresent", "speechPresent", "providerPresent", "provider", "enabledPresent", "enabled", "modelPresent", "model", "languagePresent", "language", "modePresent", "mode", "fieldStrategyPresent", "fieldStrategy", "stampPresent", "stamp"]) else { throw NativeVoiceJSON.invalid }
        for field in ["ai", "speech", "provider", "enabled", "model", "language", "mode", "fieldStrategy", "stamp"] {
            guard NativeVoiceJSON.boolean(value[field + "Present"]) != nil else { throw NativeVoiceJSON.invalid }
        }
        for field in ["provider", "enabled", "model", "language", "mode", "fieldStrategy", "stamp"] {
            guard value[field + "Present"] as? Bool == true ? !(value[field] is NSNull) : value[field] is NSNull else { throw NativeVoiceJSON.invalid }
        }
        guard value["enabled"] is NSNull || NativeVoiceJSON.boolean(value["enabled"]) != nil,
              value["provider"] is NSNull || (value["provider"] as? String).flatMap(NativeVoiceProvider.init(rawValue:)) != nil,
              value["mode"] is NSNull || (value["mode"] as? String).flatMap(NativeVoiceMode.init(rawValue:)) != nil,
              value["fieldStrategy"] is NSNull || (value["fieldStrategy"] as? String).flatMap(NativeVoiceFieldStrategy.init(rawValue:)) != nil else { throw NativeVoiceJSON.invalid }
        for (field, bound) in [("model", 2000), ("language", 200), ("stamp", 40)] {
            guard value[field] is NSNull || (value[field] as? String).map({ $0.utf16.count <= bound }) == true else { throw NativeVoiceJSON.invalid }
        }
        return .init(json: try NativeVoiceJSON.encode(value))
    }
}
public enum NativeVoiceSettingsChange: Sendable, Equatable {
    case useGemini, useOpenAI, useWhisper, enabled(Bool), model(String), language(String), mode(NativeVoiceMode), fieldStrategy(NativeVoiceFieldStrategy)
    var object: [String: Any] {
        switch self {
        case .useGemini: return ["type": "useGemini"]
        case .useOpenAI: return ["type": "useOpenAI"]
        case .useWhisper: return ["type": "useWhisper"]
        case .enabled(let value): return ["type": "enabled", "value": value]
        case .model(let value): return ["type": "model", "value": value]
        case .language(let value): return ["type": "language", "value": value]
        case .mode(let value): return ["type": "mode", "value": value.rawValue]
        case .fieldStrategy(let value): return ["type": "fieldStrategy", "value": value.rawValue]
        }
    }
}
public struct NativeVoiceSettingsRequest: Sendable, Equatable {
    let requestId: String
    let expected: NativeVoiceSettingsWitness
    public let change: NativeVoiceSettingsChange
    public init(requestId: String, expected: NativeVoiceSettingsWitness, change: NativeVoiceSettingsChange) {
        self.requestId = requestId; self.expected = expected; self.change = change
    }
    func json() throws -> String {
        guard let id = UUID(uuidString: requestId), id.uuidString.lowercased() == requestId else { throw NativeVoiceJSON.invalid }
        switch change {
        case .model(let value): guard value.utf16.count <= 2000 else { throw NativeVoiceJSON.invalid }
        case .language(let value): guard value.utf16.count <= 200 else { throw NativeVoiceJSON.invalid }
        default: break
        }
        return try NativeVoiceJSON.encode(["version": 1, "requestId": requestId, "expected": expected.object, "change": change.object])
    }
}
public struct NativeVoiceSettingsOptions: Sendable, Equatable {
    public let version: Int
    public let provider: NativeVoiceProvider
    public let supported: Bool
    public let enabled: Bool
    public let model: String
    public let modelOptions: [String]
    public let language: String
    public let mode: NativeVoiceMode
    public let fieldStrategy: NativeVoiceFieldStrategy
    public let expected: NativeVoiceSettingsWitness
    static func validated(_ raw: String) throws -> Self {
        let value = try NativeVoiceJSON.object(raw, maximum: 65536)
        guard Set(value.keys) == Set(["version", "provider", "supported", "enabled", "model", "modelOptions", "language", "mode", "fieldStrategy", "expected"]),
              value["version"] as? Int == 1, let provider = (value["provider"] as? String).flatMap(NativeVoiceProvider.init(rawValue:)),
              let supported = NativeVoiceJSON.boolean(value["supported"]), supported == (provider == .gemini || provider == .openai || provider == .whisper), let enabled = NativeVoiceJSON.boolean(value["enabled"]),
              let model = value["model"] as? String, model.utf16.count <= 2000,
              let models = value["modelOptions"] as? [String], models.count <= 100, models.allSatisfy({ $0.utf16.count <= 2000 }), models.contains(model),
              let language = value["language"] as? String, language.utf16.count <= 200,
              let mode = (value["mode"] as? String).flatMap(NativeVoiceMode.init(rawValue:)),
              let strategy = (value["fieldStrategy"] as? String).flatMap(NativeVoiceFieldStrategy.init(rawValue:)) else { throw NativeVoiceJSON.invalid }
        return .init(version: 1, provider: provider, supported: supported, enabled: enabled, model: model, modelOptions: models, language: language, mode: mode, fieldStrategy: strategy, expected: try NativeVoiceSettingsWitness.validated(value["expected"]))
    }
}
public struct NativeVoiceRuntime: Sendable {
    public let provider: NativeVoiceProvider
    public let supported: Bool
    public let enabled: Bool
    public let model: String
    public let language: String
    public let mode: NativeVoiceMode
    public let fieldStrategy: NativeVoiceFieldStrategy
    public let saveAudioAttachments: Bool
    public let credentialAvailable: Bool
    let credentialRequired: Bool
    let endpointAvailable: Bool
    let modelAvailable: Bool
    public var available: Bool { supported && enabled && modelAvailable && endpointAvailable && (!credentialRequired || credentialAvailable) }
    public var availabilityReason: NativeVoiceAvailabilityReason? {
        if !supported { return .unsupportedProvider }; if !enabled { return .disabled }; if !endpointAvailable { return .unavailable }
        if !modelAvailable { return .modelMissing }
        if credentialRequired && !credentialAvailable { return .credentialMissing }; return nil
    }
    static func validated(_ raw: String, credentialAvailable: Bool, credentialRequired: Bool = true, endpointAvailable: Bool = true, modelAvailable: Bool = true) throws -> Self {
        var value = try NativeVoiceJSON.object(raw, maximum: 65536)
        guard let retain = NativeVoiceJSON.boolean(value.removeValue(forKey: "saveAudioAttachments")), let model = value["model"] as? String else { throw NativeVoiceJSON.invalid }
        value["modelOptions"] = [model]
        let options = try NativeVoiceSettingsOptions.validated(NativeVoiceJSON.encode(value))
        return .init(provider: options.provider, supported: options.supported, enabled: options.enabled, model: options.model, language: options.language, mode: options.mode, fieldStrategy: options.fieldStrategy, saveAudioAttachments: retain, credentialAvailable: credentialAvailable,
                     credentialRequired: credentialRequired, endpointAvailable: endpointAvailable, modelAvailable: modelAvailable)
    }
}
public struct NativeVoiceCredentialWitness: Sendable, Equatable {
    let id: UUID
    let secureItem: String
    let legacyPresent: Bool
}
public struct NativeVoiceSettingsSession: Sendable {
    public let id: UUID
    public let options: NativeVoiceSettingsOptions
    public let credentialAvailable: Bool
    public let credentialWitness: NativeVoiceCredentialWitness
}
public struct NativeVoiceModelChoices: Sendable, Equatable {
    public let provider: NativeVoiceProvider
    public let status: NativeAITextModelChoices.Status
    public let modelOptions: [String]
    public let expected: NativeVoiceSettingsWitness
    static func validated(_ raw: String) throws -> Self {
        let value = try NativeVoiceJSON.object(raw, maximum: 64 * 1024)
        guard Set(value.keys) == Set(["version", "provider", "status", "modelOptions", "expected"]),
              let version = value["version"] as? NSNumber, CFGetTypeID(version) != CFBooleanGetTypeID(), version.doubleValue == 1,
              let provider = (value["provider"] as? String).flatMap(NativeVoiceProvider.init(rawValue:)), provider == .openai || provider == .gemini,
              let status = (value["status"] as? String).flatMap(NativeAITextModelChoices.Status.init(rawValue:)),
              let models = value["modelOptions"] as? [String], (1...100).contains(models.count), Set(models.map { Data($0.utf8) }).count == models.count,
              models.allSatisfy({ !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && $0.utf16.count <= 2000 }) else { throw NativeVoiceJSON.invalid }
        let expected = try NativeVoiceSettingsWitness.validated(value["expected"])
        guard provider.rawValue == (try expected.object["provider"] as? String ?? "gemini") else { throw NativeVoiceJSON.invalid }
        return .init(provider: provider, status: status, modelOptions: models, expected: expected)
    }
}
public enum NativeVoiceSettingsOutcome: Sendable, Equatable { case saved(changed: Bool) }

public struct NativeVoiceLocalModelState: Sendable {
    public enum Availability: String, Sendable { case missing, installed, invalid }
    public let modelID: String
    public let sizeBytes: Int64
    public let availability: Availability
}

enum NativeVoiceJSON {
    static let invalid = HostFailure("INVALID_INPUT: Native voice data is malformed")
    static func boolean(_ value: Any?) -> Bool? {
        guard let value = value as? NSNumber, CFGetTypeID(value) == CFBooleanGetTypeID() else { return nil }; return value.boolValue
    }
    static func object(_ raw: String, maximum: Int) throws -> [String: Any] {
        guard raw.utf8.count <= maximum, try NativeJSON.hasUniqueObjectKeys(raw), let value = try NativeJSON.jsonObject(with: Data(raw.utf8)) as? [String: Any] else { throw invalid }; return value
    }
    static func encode(_ value: Any) throws -> String { String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self) }
}
