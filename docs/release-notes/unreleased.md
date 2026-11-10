# Mindwtr Unreleased

Changes collected since the latest stable release.

- Desktop Local API and MCP: reopen ordinary done/archived tasks with optional stale-write protection, and create or restore areas by name without duplicates. Reopening reactivates the parent while leaving finished siblings finished; recurring history requires the app. (#1506)
- Bun Local API helper: add task-list versions, stale-write protection for PATCH and completion/archive, durable retry-safe creates, and unchanged-PATCH detection. (#1506)
- Desktop Local API and MCP: sections and people can be listed read-only. Task-list polls support query-specific ETags and bodyless unchanged responses, including retained tombstones when requested. (#1506)

- Daily and Weekly Review: Waiting For prompts follow the task's review date, or its start date when no valid review date is set. Future dates defer follow-up; an explicit review date can bring a task back before it starts. (#1531)

- Android: returning within App Lock's Require unlock delay shows the open task without briefly displaying the unlock panel. An opaque privacy cover still hides the app while it is away. (#1423)
