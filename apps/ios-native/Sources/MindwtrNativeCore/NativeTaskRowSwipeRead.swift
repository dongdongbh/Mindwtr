public enum NativeTaskRowSwipeRead {
    public static func identity(context: String, taskID: String, taskRevision: String, status: String, focusedToday: Bool,
                                selectionMode: Bool, readOnly: Bool, interactionDisabled: Bool,
                                languageGeneration: Int, ready: Bool) -> String {
        [context, taskID, taskRevision, status, String(focusedToday), String(selectionMode), String(readOnly),
         String(interactionDisabled), String(languageGeneration), String(ready)].joined(separator: ":")
    }
}
