import Foundation

public enum NativeWatchSelection {
    private static let devNamespace = "tech.dongdongbh.mindwtr.native.dev"

    public static func admits(_ selection: NativeLaunchSelection?, bundleIdentifier: String?) -> Bool {
        switch selection {
        case .production?:
            return bundleIdentifier == NativeLaunchSelection.productionNamespace
        case let .standard(_, _, namespace)?:
            return bundleIdentifier == devNamespace && namespace == devNamespace
        case .isolated?, .rehearsal?, nil:
            return false
        }
    }
}
