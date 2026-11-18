import Foundation

public enum NativeAppInfo {
    public static let defaultAnalyticsHeartbeatURL = "https://mindwtr-analytics.mindwtr.workers.dev/"
    private static let lock = NSLock()
    private static var installed: String?

    public static func install(_ json: String) {
        lock.lock(); defer { lock.unlock() }
        installed = json
    }

    static var json: String? {
        lock.lock(); defer { lock.unlock() }
        return installed
    }

    public static func encode(info: [String: Any], bundleIdentifier: String?, systemVersion: String, isPad: Bool, isDev: Bool) -> String {
        func text(_ key: String) -> String { ((info[key] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines) }
        let configured = text("MindwtrAnalyticsHeartbeatURL")
        let heartbeat = bundleIdentifier != NativeLaunchSelection.productionNamespace ? ""
            : configured.isEmpty ? defaultAnalyticsHeartbeatURL : configured
        let object: [String: Any] = [
            "appName": text("CFBundleDisplayName"), "version": text("CFBundleShortVersionString"),
            "releaseVersion": text("MindwtrReleaseVersion"), "build": text("CFBundleVersion"),
            "packageName": bundleIdentifier ?? "", "isFossBuild": false, "isDev": isDev,
            "platform": "ios", "platformVersion": systemVersion, "osRelease": systemVersion, "isPad": isPad,
            "feedbackEndpointUrl": text("MindwtrFeedbackEndpointURL"),
            "analyticsHeartbeatUrl": heartbeat,
            "analyticsHeartbeatChannel": "",
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else { return "{}" }
        return String(decoding: data, as: UTF8.self)
    }
}
