# On-device AI work and validation

Status record for the Apple work and Android counterpart. Last updated 2026-09-15. These features are development evaluations. No production model-quality result or release date is implied.

## Completed Apple work

The implementation is on main through `d141a1b3810d651bb62756d4581a33601ed7717c`.

| Issue | Implemented | Still open |
| --- | --- | --- |
| [#915](https://github.com/dongdongbh/Mindwtr/issues/915) | Exact task links; stable ID ordering; ambiguous project handling; snapshot age and per-list/project omission information | Reminders App Schema conformance, core ingestion and durable receipts for mutations, built-app AppIntentsTesting, conversational Siri device checks |
| [#1194](https://github.com/dongdongbh/Mindwtr/issues/1194) | Development query-to-real-task path; current filters and IDs rechecked before opening; bounded result collection and cancellation | Supported-device quality/performance, Spotlight refresh/removal and opt-in design, production entry point |
| [#1214](https://github.com/dongdongbh/Mindwtr/issues/1214) | Optional device-local on-device backend; bounded guided suggestion; editable preview, explicit Apply and normal Save; concurrent-edit/cancellation guards | iPhone/iPad model quality and performance; production gate; PCC eligibility and integration are separate |
| [#1195](https://github.com/dongdongbh/Mindwtr/issues/1195) | One selected image; local OCR/model comparison; bounded decode; editable proposal and explicit save; safe retry identity; no automatic source attachment | Real-device extraction/latency/memory evidence; process-termination draft recovery; production decision |

Native code reads app-owned snapshots or receives bounded requests. It never writes live SQLite. Search and images have a development-only evaluation route; clarification uses the existing AI settings and Inbox processing flow. See [Apple validation and evaluator steps](apple-evaluation-validation.md).

### Recorded Apple evidence

- [Full native CI](https://github.com/dongdongbh/Mindwtr/actions/runs/34920480209), exact implementation revision: Xcode 26 app/Watch, Xcode 27 bundled Release simulator app, cold/warm deep-link smoke, unsigned device archive, and all three new Swift test suites passed.
- [Expanded SDK preflight](https://github.com/dongdongbh/Mindwtr/actions/runs/34920453918): ARM64 simulator/device sources and the Intel simulator fallback passed. The search tool is unavailable on the tested Intel SDK target.
- Local focused tests, mobile TypeScript, and lint passed. General post-push CI later caught missing translation keys, repaired in `fdc51dd8c7d5e15c956906d7b743f65c30292f12`; all jobs in the [replacement CI run](https://github.com/dongdongbh/Mindwtr/actions/runs/34925069783) passed, including Core, Mobile, Windows, and Tauri. This is separate from the Apple native build evidence.
- Physical Apple Intelligence/Siri quality measurements have not been performed. Fixture scores, mocked generation, and an unsigned archive are not substitutes.

## Android counterpart: #1215

Retained on `feat/android-nano-clarification`, outside `main`, by maintainer decision after physical quality testing. A draft PR exists only to preserve review and CI evidence; it is not ready to merge. Revisit after a model update and fresh evaluation.

The bounded development prototype includes a Kotlin/Expo bridge with the optional ML Kit SDK, a separate device-local backend preference, explicit model setup, and the shared editable Inbox draft/Apply/Save flow. Native inference does not write tasks or fall back to cloud. Backgrounding invalidates both pending requests and ready previews; stale IDs/revisions and repeated Apply are guarded.

Recorded local validation: 157 focused mobile tests, mobile TypeScript and changed-file lint passed. All 17 enabled native JVM tests passed. Default and FOSS-flag module builds retain API 24 and exclude the new SDK; enabled evaluation uses API 26. Switching a generated project from enabled to FOSS restores the original floor. The complete enabled ARM64 Dev APK compiles and starts on the connected OnePlus.

The OnePlus CPH2655 (Android 16/API 36) now reports `available`, model `nano-v3`. Physical debugging fixed a coroutine ABI cancellation crash, title-only input rejection, and fenced-JSON parsing. AICore process restart refreshed readiness after pending setup; download byte progress was not observed. Offline generation, preview, Apply, normal guided save, and task reopening were verified. Backgrounding discarded a ready preview without applying it.

Quality remains a blocker: a dentist task received an unrelated existing project. Four offline cases per prompt variant showed that stricter instructions did not resolve the association failure. The feature stays development-only; see [the measured results and production defer decision](android-nano-evaluation.md#prompt-comparison). The full corpus, manual comparison, repeated timing/memory/battery measurements, and additional model versions remain open.

## Other completed work

- Unified Inbox across area filters: `d09000edf`, with public docs `cdb6666` in mindwtr-web. The selected area still applies to other lists. The app's focused/e2e validation comprised 245 passing tests plus typechecks; docs build/check passed.
- [#1216](https://github.com/dongdongbh/Mindwtr/issues/1216) was declined as not planned. Save keeps its save-and-close behavior; no navigation implementation was changed.

## Documentation scope

These repository development documents describe prototypes, implementation boundaries, and observed evidence. Public user documentation remains unchanged for AI availability because the evaluations have not shipped. Publish supported-device and workflow claims only after the corresponding gates pass.
