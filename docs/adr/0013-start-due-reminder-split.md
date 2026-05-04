# ADR 0013: Split Start and Due Reminders

Date: 2026-05-04
Status: Accepted

## Context

Mindwtr tasks can have a start time and a due date. These fields answer different GTD questions:

- start time: when the task should become actionable
- due date: when the task must be finished

Using one reminder setting for both made notification behavior ambiguous. Users who wanted a due-date warning could accidentally get start-time alerts, and users who wanted start nudges could not tune them separately from deadlines.

## Decision

Mindwtr keeps start reminders and due reminders as separate notification settings and scheduling keys.

1. Start reminders are scheduled from `startTime`.
2. Due reminders are scheduled from `dueDate`.
3. Notification routing preserves the reminder kind so opening a notification can land in the right workflow.
4. Local rescheduling treats the two reminder streams independently, then caps and batches the nearest upcoming alarms so mobile OS notification limits are respected.

## Consequences

- Users can reason about start nudges and deadline alerts independently.
- Reminder settings and copy need to name both concepts explicitly.
- Sync payloads still store task dates on the task; the split is notification behavior, not a new task ownership model.
- Future notification features should avoid re-coupling start and due semantics unless the product deliberately introduces a higher-level schedule policy.
