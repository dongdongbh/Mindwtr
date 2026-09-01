# Mindwtr Unreleased

Changes collected after `v1.2.6` and before the next version tag.

## Full Change List

- Sync: a device killed mid-sync (or a failed cleanup) could leave its reservation on the sync location for up to five minutes, during which every other device showed "Another compatible Mindwtr device is updating this sync location" and stopped. Devices now prove they are alive by renewing the reservation every 20 seconds; a waiting device that sees no renewal for a few of those takes the reservation over safely instead of waiting out the timer, so a dead device stalls others for about a minute at most. The notice now says sync retries on its own (it always did), and the debug log names which device's reservation was in the way and whether it was taken over. Regression introduced with the 1.2.5 reservation mechanism; 1.2.1 had no such stall.
