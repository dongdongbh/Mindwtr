struct HostAdmission {
    struct Turns: OptionSet {
        let rawValue: UInt16
        static let captureAI = Turns(rawValue: 1 << 0)
        static let calendarAccess = Turns(rawValue: 1 << 1)
        static let calendarPush = Turns(rawValue: 1 << 2)
        static let reminderEffects = Turns(rawValue: 1 << 3)
        static let pomodoroAlarm = Turns(rawValue: 1 << 4)
        static let notificationSetting = Turns(rawValue: 1 << 5)
        static let aiConfiguration = Turns(rawValue: 1 << 6)
        static let aiTextConfiguration = Turns(rawValue: 1 << 7)
        static let aiRequestTimeout = Turns(rawValue: 1 << 8)
        static let aiReasoningEffort = Turns(rawValue: 1 << 9)
        static let aiGeminiThinkingBudget = Turns(rawValue: 1 << 10)
        static let deviceCalendarSetting = Turns(rawValue: 1 << 11)
        static let calendarSubscriptionSetting = Turns(rawValue: 1 << 12)

        static let reminders: Turns = [.reminderEffects, .pomodoroAlarm]
        static let deviceStorageExclusive: Turns = [.aiTextConfiguration, .aiConfiguration, .aiRequestTimeout, .aiReasoningEffort,
                                                    .aiGeminiThinkingBudget, .deviceCalendarSetting, .calendarSubscriptionSetting]
    }

    let active: Turns
    let ownerAccess: Turns
    let calendarSubscriptionOperation: String?

    init(active: Turns, ownerAccess: Turns, calendarSubscriptionOperation: String?) {
        self.active = calendarSubscriptionOperation == nil ? active : active.union(.calendarSubscriptionSetting)
        self.ownerAccess = ownerAccess
        self.calendarSubscriptionOperation = calendarSubscriptionOperation
    }

    static let calendarAccessAwaitingOwner = CoreHostRejection(message: "NOT_READY: Calendar access is still awaiting its owner")

    private func isOwned(_ turn: Turns) -> Bool { !active.contains(turn) || ownerAccess.contains(turn) }

    func admitCall(_ method: String, pomodoroOwned: Bool, reminderCompletionOwned: Bool) throws {
        let facade = HostMethod.registry[method]?.facade
        guard facade != .voice else { throw NativeVoiceJSON.invalid }
        guard facade != .aiTextConfiguration || (["iosAITextConfiguration", "iosAITextConfigurationV2"].contains(method) && ownerAccess.contains(.aiTextConfiguration)) else { throw CoreHostRejection(message: "INVALID_INPUT: AI text configuration requires its private facade") }
        guard facade != .aiRequestTimeout || (method == "iosAIRequestTimeout" && ownerAccess.contains(.aiRequestTimeout)) else { throw CoreHostRejection(message: "INVALID_INPUT: AI timeout requires its private facade") }
        guard facade != .aiReasoningEffort || (method == "iosAIReasoningEffort" && ownerAccess.contains(.aiReasoningEffort)) else { throw CoreHostRejection(message: "INVALID_INPUT: AI reasoning effort requires its private facade") }
        guard facade != .aiGeminiThinkingBudget || (method == "iosAIGeminiThinkingBudget" && ownerAccess.contains(.aiGeminiThinkingBudget)) else { throw CoreHostRejection(message: "INVALID_INPUT: AI Gemini thinking budget requires its private facade") }
        guard facade != .pomodoro || pomodoroOwned else { throw CoreHostRejection(message: "INVALID_INPUT: Pomodoro requires its explicit facade") }
        guard !active.contains(.calendarPush), facade != .calendarPush else {
            throw CoreHostRejection(message: "NOT_READY: Calendar push requires its current explicit owner")
        }
        guard !active.contains(.calendarAccess), facade != .calendarAccess else {
            throw CoreHostRejection(message: "NOT_READY: Calendar access requires its current explicit owner")
        }
        guard method != "iosPruneReceipts" else {
            throw CoreHostRejection(message: "INVALID_INPUT: Receipt retention requires startup ownership")
        }
        guard facade != .reminderSnooze else {
            throw CoreHostRejection(message: "INVALID_INPUT: Reminder Snooze requires its explicit facade")
        }
        guard facade != .reminderCompletion || method == "reminderCompletionCommit" && reminderCompletionOwned else {
            throw CoreHostRejection(message: "INVALID_INPUT: Reminder completion requires its explicit facade")
        }
        guard active.isDisjoint(with: .reminders), facade != .reminder else { throw NativeReminderEffects.unavailable }
        guard (calendarSubscriptionOperation == nil || method == calendarSubscriptionOperation),
              facade != .calendarSubscriptionSetting || method == calendarSubscriptionOperation else {
            throw CoreHostRejection(message: "NOT_READY: Calendar subscription settings require their current explicit owner")
        }
        guard (!active.contains(.deviceCalendarSetting) || method == "deviceCalendarSetting"),
              facade != .deviceCalendarSetting || (method == "deviceCalendarSetting" && active.contains(.deviceCalendarSetting)) else {
            throw CoreHostRejection(message: "NOT_READY: Device Calendar Settings require their current explicit owner")
        }
        guard isOwned(.notificationSetting),
              facade != .notificationSetting || (method == "notificationSetting" && ownerAccess.contains(.notificationSetting)) else {
            throw CoreHostRejection(message: "NOT_READY: Notification Settings require their current explicit owner")
        }
    }

    func admitInvoke(_ method: String) throws {
        guard !active.contains(.calendarAccess) || method == "deviceCalendarAccessAcknowledged" else { throw Self.calendarAccessAwaitingOwner }
        guard active.isDisjoint(with: .reminders) || ownerAccess.contains(.reminderEffects) && HostMethod.registry[method]?.facade == .reminder else { throw NativeReminderEffects.unavailable }
    }

    func admitAttachmentDraft() throws {
        guard !active.contains(.captureAI) else { throw HostFailure("Capture copilot request is still active") }
        guard !active.contains(.calendarAccess) else { throw Self.calendarAccessAwaitingOwner }
        guard isOwned(.aiTextConfiguration) else { throw HostFailure("AI text configuration edit is still awaiting its owner") }
        guard !active.contains(.aiConfiguration) else { throw HostFailure("AI text configuration operation is active") }
        guard isOwned(.aiRequestTimeout) else { throw HostFailure("AI timeout edit is still awaiting its owner") }
        guard isOwned(.aiReasoningEffort) else { throw HostFailure("AI reasoning effort edit is still awaiting its owner") }
        guard isOwned(.aiGeminiThinkingBudget) else { throw HostFailure("AI Gemini thinking budget edit is still awaiting its owner") }
        guard isOwned(.notificationSetting) else { throw HostFailure("Notification edit is still awaiting its owner") }
        guard active.isDisjoint(with: .reminders) || ownerAccess.contains(.reminderEffects) else { throw NativeReminderEffects.unavailable }
    }
}
