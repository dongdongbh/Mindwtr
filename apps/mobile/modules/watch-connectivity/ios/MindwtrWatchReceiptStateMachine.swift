import Foundation

enum MindwtrWatchReceiptState: String {
    case awaitingAudio
    case audioRetained
    case prepared
    case published
}

enum MindwtrWatchStageAction: Equatable {
    case create
    case reuse
    case collision
}

enum MindwtrWatchPreparedRecoveryAction: Equatable {
    case publishStage
    case compactPublishedQueue
    case compactConsumedQueue
    case collision
}


enum MindwtrWatchReceiptStateMachine {
    static func stageAction(stageExists: Bool, bytesMatch: Bool) -> MindwtrWatchStageAction {
        guard stageExists else { return .create }
        return bytesMatch ? .reuse : .collision
    }

    static func preparedRecoveryAction(
        stageExists: Bool,
        queueExists: Bool,
        bytesMatch: Bool
    ) -> MindwtrWatchPreparedRecoveryAction {
        if stageExists {
            return !queueExists && bytesMatch ? .publishStage : .collision
        }
        if queueExists {
            return bytesMatch ? .compactPublishedQueue : .collision
        }


        return .compactConsumedQueue
    }
}
