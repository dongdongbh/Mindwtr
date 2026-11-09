enum NativeSyncTurnCancellation {
    static let commands: Set<String> = ["syncStored", "syncResume", "syncPull"]

    static func isClean(_ error: Error, command: String, cleanupOwed: Bool, settled: Bool) -> Bool {
        settled && !cleanupOwed && commands.contains(command) && error is CancellationError
    }
}
