public enum NativeSearchAppLockReread {
    public static func keepsIndex(lockEnabledBefore: Bool?, readOnSameHost: Bool, writing: Bool) -> Bool {
        lockEnabledBefore == false && readOnSameHost && !writing
    }
}
