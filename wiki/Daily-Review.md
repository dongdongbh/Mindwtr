# Daily Review

Daily Review is the lightweight reset flow for staying current between Weekly Reviews. It appears in the Review view on desktop and as the daily review route on mobile.

## Flow

The default order is:

1. Today and Calendar
2. Inbox, only when live inbox tasks exist
3. Today's Focus, when enabled
4. Waiting For
5. Complete

The inbox step is intentionally before focus so new captures are clarified before choosing what should stay visible today. If the inbox is empty, the step is skipped.

## Settings

The focus step is controlled by:

```typescript
settings.gtd.dailyReview.includeFocusStep
```

Desktop and mobile expose this as the "Include Focus step" setting in GTD settings. The step is shown by default. Set the value to `false` to use the shorter Today/Inbox/Waiting flow.

Related settings:

| Setting | Purpose |
| --- | --- |
| `settings.gtd.defaultScheduleTime` | Prefills manual scheduling fields. |
| `settings.weekStart` | Controls calendar week layout. |
| `settings.calendar.viewMode` | Stores the calendar view mode used elsewhere in the app. |

## Desktop Behavior

Desktop persists the current review step in local storage while the modal is in progress. Closing and reopening the modal resumes the same step; finishing the review clears the stored step.

Task rows inside the review use the normal quick actions and task detail affordances, including area and project actions where available.

## Mobile Behavior

Mobile uses the same GTD setting for the focus step and presents the review as a route-level screen. It shares the same step intent with the desktop flow, with mobile-specific navigation controls.

## Related Pages

- [[Weekly Review]]
- [[GTD Workflow in Mindwtr]]
- [[Calendar Integration]]
