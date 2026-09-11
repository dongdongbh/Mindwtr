import ExpoModulesCore
import Foundation
import WidgetKit

public final class MindwtrIosWidgetModule: Module {
    public func definition() -> ModuleDefinition {
        Name("MindwtrIosWidget")

        AsyncFunction("claimPendingCompletions") { () throws -> [[String: Any]] in
            let actions = try MindwtrWidgetActionStore.appGroupStore().claimReady()
            return actions.map { action in
                [
                    "id": action.id,
                    "taskId": action.taskId,
                    "token": action.token,
                    "createdAt": action.createdAt,
                    "notBefore": action.notBefore,
                    "claimed": action.claimed,
                ]
            }
        }

        AsyncFunction("acknowledgePendingCompletion") { (id: String) throws -> Void in
            try MindwtrWidgetActionStore.appGroupStore().acknowledge(id: id)
            WidgetCenter.shared.reloadTimelines(ofKind: "MindwtrTasksWidget")
        }

        AsyncFunction("getNextPendingCompletionAt") { () throws -> Double? in
            try MindwtrWidgetActionStore.appGroupStore().nextReadyAt()
        }
    }
}
