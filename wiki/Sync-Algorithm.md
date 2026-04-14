# Sync Algorithm

Mindwtr uses local-first synchronization with deterministic conflict handling.

## Inputs and Outputs

- Input A: local snapshot (`tasks`, `projects`, `sections`, `areas`, `settings`)
- Input B: remote snapshot (same shape)
- Output: merged snapshot + merge stats (`conflicts`, `clockSkew`, `timestampAdjustments`, `conflictIds`)

## Merge Rules

1. Entities are matched by `id`.
2. If entity exists on one side only, it is kept.
3. If both exist, merge uses revision-aware LWW:
   - Compare `rev` first (higher wins).
   - If revisions tie, compare `updatedAt` (newer wins).
   - If timestamps tie, apply deterministic tie-break by normalized content signature.
4. Soft-deletes use operation time:
   - Operation time = `max(updatedAt, deletedAt)` for tombstones.
   - Live-vs-deleted conflicts choose newer operation time.
   - If the delete-vs-live operation times are within 30 seconds of each other, Mindwtr preserves the live item instead of immediately letting the tombstone win.
   - If revisions differ inside that 30-second window, the higher revision still wins.
5. Invalid `deletedAt` falls back to `updatedAt` for conservative operation timing.
6. Attachments are merged per attachment `id` with the same LWW rules.
7. Settings merge by sync preferences:
   - Appearance/language/external calendars/AI can be merged independently.
   - Conflict resolution uses group-level timestamps (`appearance`, `language`, `externalCalendars`, `ai`).
   - Concurrent edits to different fields inside the same group can still collapse to the newer group update.
   - Secrets (API keys, local model paths) are never synced.
8. Remote-write recovery is explicit:
   - Local data is first written with `pendingRemoteWriteAt`.
   - Remote write clears the flag on success.
   - Failed remote writes schedule retries with exponential backoff from 5 seconds up to 5 minutes.
9. Clock skew telemetry:
   - Merge stats record the largest observed skew.
   - Warnings surface when skew exceeds 5 minutes.

## Pseudocode

```text
read local
read remote
validate payload shape
normalize entities (timestamps, revision metadata)

for each entity type in [tasks, projects, sections, areas]:
  index local by id
  index remote by id
  for each id in union(localIds, remoteIds):
    if only one side exists: keep it
    else:
      winner = resolveWinner(localItem, remoteItem)
      mergedItem = mergeConflict(localItem, remoteItem, winner) // attachments/settings-specific logic
      push mergedItem

merge settings by sync preferences
validate merged payload
write local
write remote
record sync history and diagnostics
```

## Conflict Examples

### Example 1: Live vs Deleted

- Local: task `t1` updated at `10:01`, not deleted
- Remote: task `t1` deleted at `10:03`
- Result: deleted version wins (`10:03` operation time is newer)

### Example 1b: Ambiguous delete vs live

- Local: task `t1` edited at `10:00:05`, still live
- Remote: task `t1` deleted at `10:00:20`
- Result: live item wins because the operations are only 15 seconds apart, which falls inside the ambiguity window

### Example 2: Equal Revision and Timestamp

- Local and remote both have `rev=4`, `updatedAt=10:00`
- Content differs (`title`, `tags`, etc.)
- Result: deterministic signature comparison picks the same winner on all devices

### Example 3: Invalid deletedAt

- Local tombstone has `deletedAt="invalid-date"` and `updatedAt=09:30`
- Remote live item has `updatedAt=10:00`
- Result: live item wins because invalid delete uses `updatedAt` fallback (`09:30`)

## Attachments

- Metadata merge runs before file transfer reconciliation.
- Winner attachment URI/local status is preserved when usable.
- If winner has no usable local URI, merge can fall back to the other side URI/status.
- Missing local files are handled later by attachment sync/download.

## Retry Recovery

- A failed remote write does not silently discard the just-merged local state.
- `pendingRemoteWriteAt`, `pendingRemoteWriteRetryAt`, and `pendingRemoteWriteAttempts` are stored locally.
- The next sync pauses until the retry window expires, then retries using the preserved local snapshot plus any newer local edits.

## Diagnostics You Can Inspect

- Conflict count and IDs
- Max clock skew observed
- Timestamp normalization adjustments
- Last sync status/history in Settings

## Related docs

- [[Data and Sync]]
- [[Cloud Sync]]
- [[Diagnostics and Logs]]
- [[Core API]]

## Troubleshooting

If you see repeated conflicts or skew warnings:

1. Verify device clocks (automatic network time enabled).
2. Check sync backend connectivity/auth.
3. Inspect sync diagnostics in app settings and logs.
