# Android on-device Inbox clarification evaluation

Tracks [#1215](https://github.com/dongdongbh/Mindwtr/issues/1215). This is a text-only development evaluation of Gemini Nano through ML Kit, alongside the Apple clarification prototype. It does not approve a production rollout, image extraction, cloud routing, or an assistant that edits tasks autonomously.

**Parked on `feat/android-nano-clarification`; do not merge or enable in production.** The maintainer chose to retain the work on this feature branch after the physical quality results below. Re-evaluate when a newer model becomes available. Record the new model version, rerun the corpus and lifecycle cases, and require an explicit adoption decision; an AICore/model update alone must not enable the feature.

## Evaluation contract

Use one selected Inbox item and bounded relevant candidate associations. Generation produces a proposed title and optional GTD fields. Shared TypeScript validation rejects invented associations and malformed output; the person reviews the proposal, explicitly applies it to the draft, and saves through normal Inbox processing. Native inference never opens SQLite or writes tasks. Later draft edits, changed task revisions, deleted associations, cancellation, and backgrounding must prevent stale application.

The provider choice is device-local and independent of the synced configured provider and the Apple device preference. An unavailable local model must never select a cloud provider implicitly. The existing manual workflow remains available.

## Build and SDK boundary

The prototype is opt-in with `MINDWTR_NANO_ENABLED=1` and `APP_VARIANT=development`, and is disabled for `FOSS_BUILD=1`. Normal and FOSS builds keep the existing Android API 24 floor and exclude the new Google dependency. The explicitly enabled evaluation build requires API 26. Preserve both dependency graphs in build validation.

The Android Nano CI matrix checks both the module and complete app runtime dependency graphs and the app's merged manifest in default, enabled development, and FOSS-flag modes. Its FOSS lane proves this module's exclusion boundary; the existing FOSS release workflow still owns the complete stripped APK build and `verify_foss_no_google_services.py` scan.

The pinned Prompt API is `com.google.mlkit:genai-prompt:1.0.0-beta4`. Google documents runtime capability checks, model download states, and a complete-prompt token limit. The prototype must check the complete prompt before generation and reject oversized input rather than truncate it. [Prompt API setup](https://developers.google.com/ml-kit/genai/prompt/android/get-started)

Beta4 carries Kotlin 2.3 metadata while the app uses Kotlin 2.1. The enabled module uses the SDK's Java/Futures adapter, keeps Kotlin 2.1 on its compile classpath, and packages Kotlin stdlib 2.3.21 at runtime. Its coroutine runtime is aligned to 1.11.0: a physical cancellation probe exposed a missing `Job.cancel$default` bridge in the app's original 1.9.0 resolution. A metadata-check exception is limited to this optional module. This compatibility boundary needs a complete app build and device execution; module compilation alone cannot establish runtime compatibility. Default/FOSS builds do not use this adapter or dependency override.

Use JSON-oriented text prompting and strict shared validation in this first evaluation. The adapter accepts either a JSON object or one complete JSON code fence, as observed on Nano v3; surrounding prose, multiple objects, malformed fields, and invented IDs remain rejected. Google's separate typed-output API is alpha and introduces KSP/schema compiler dependencies; it is a possible future comparison, not a capability implemented here. [Structured output](https://developers.google.com/ml-kit/genai/prompt/android/structured-output)

Model download needs an explicit action after explaining that it uses network access and device storage. Generation is on-device after readiness; it must run only while the app is foreground. Busy and battery-quota responses must terminate or use a bounded retry, preserving the draft. Model support is decided at runtime, not by a hardcoded phone list. [Runtime restrictions](https://developers.google.com/ml-kit/genai)

### Try the development build

Use the repository's Android SDK/Java setup. From `apps/mobile`, generate a clean development native project with `APP_VARIANT=development MINDWTR_NANO_ENABLED=1 FOSS_BUILD=0` set, then build `:app:assembleDebug` in `android`. This changes generated native files and requires a new Dev APK; Expo Go or an older installed binary cannot load the bridge. Keep the same flags when starting Metro with `expo start --dev-client --clear`.

In Mindwtr Dev, open Settings → Advanced → AI assistant and expand the assistant card. The Inbox clarification section shows runtime availability and stores the backend choice only on this device. If a model download is offered, read the network/storage and SDK metrics disclosure before starting it. Select On-device, open Process Inbox for a synthetic item, and choose Clarify. Review the proposal, Apply it to the editable draft, make any corrections, then use the normal Save action. An unavailable model leaves manual processing and the configured provider available; it does not switch providers automatically.

## SDK distribution and privacy review

The ML Kit SDK and AICore are optional Google components, not part of the FOSS build. Keep the pinned dependency and its transitive resolution in CI artifacts; code-sample licensing does not establish the SDK/model license. Do not infer redistribution or production compatibility merely from a successful download/build.

The beta4 POM identifies its license as ML Kit Terms of Service. Its transitive graph includes Google Play services, Android Data Transport, Firebase encoders, Guava, and `genai-schema:1.0.0-alpha1`. That schema artifact is bundled transitively even though this prototype does not use the alpha structured-output API or KSP compiler. The Prompt/common AARs include third-party license notices; preserve those notices and inspect the complete resolved app graph when reviewing distribution.

Google's additional GenAI terms restrict access to adults and API clients likely to be accessed by minors, require disclosure of SDK metrics processing, and constrain experimental services. This evaluation is for developer-controlled adult testing. Production adoption needs an explicit review of Mindwtr's general-audience distribution against those terms. On-device task inference does not imply that model setup or SDK telemetry is offline. Google documents that input/output stay on-device while SDK performance and utilization metrics are sent to Google. [ML Kit privacy](https://developers.google.com/ml-kit/terms) [GenAI additional terms](https://developers.google.com/ml-kit/genai-terms)

The Play policy tool's Phase 1 static scan completed against the mobile app. That scan is not a full policy audit or proof of current Play Console declarations. No new Play submission is part of this evaluation; rerun the relevant policy/manifest review on the final SDK build before distribution.

## Predeclared corpus and thresholds

Run `scripts/android-evaluation/clarification-corpus.json` with synthetic data. Expand the oversized marker to a 4,001-character description. Use both identically named projects for the duplicate-name case. Run the scenario overlays against the same preview/Apply flow. Record refusals explicitly and inspect the input, proposal, and resulting saved task; passing JSON validation is not a quality score.

Before collecting results, use these initial go/no-go thresholds:

| Measure | Gate |
| --- | --- |
| Invented associations, unsupported dates/commitments, unintended completion | Zero in the corpus and lifecycle cases |
| Correct populated fields, judged against input | At least 95% |
| Useful suggestions needing no material correction | At least 80%; compare with manual clarification |
| Warm request latency | p95 at most 15 seconds on each evaluated model version |
| Cold request latency after model ready | p95 at most 30 seconds |
| Cancellation, backgrounding, duplicate Apply, failed save | Zero stale applications, lost drafts, or duplicate tasks |
| Memory/battery | No OOM; record peak process memory and battery/quota observations during 30 repeated requests |
| Distribution | Default/FOSS dependency graphs exclude the new SDK; supported manual flow still works |

These are evaluation targets, not measured results or service promises. Report every case, including errors and refusals. Do not drop unsuccessful runs from latency/failure summaries. Do not average different model versions into a single passing score.

For the manual comparison, clarify each actionable case without AI and record elapsed time and the resulting fields. Then evaluate its model proposal on a fresh copy. Score each populated field against the source and record edits required, total time through Save, and whether the proposal improved the manual result. The refusal case probes safe failure; it must not be counted as a useful action proposal.

## Physical-device record

Record device, Android version, AICore/ML Kit/model version, locale, build revision, model readiness, network state, cold/warm timing, peak memory, battery observations, field errors, useful-suggestion score, and failure category. Compare at least two supported model versions when devices are available. Keep private task content out of committed results and diagnostics.

Required sequence: download with consent; complete an offline clarification in airplane mode; edit the preview; Apply once; Save; reopen the actual task; repeat cancellation, background/app-lock, duplicate Apply, changed association, and failed-save cases. Unsupported/emulator behavior is useful for fallback checks but cannot prove Gemini Nano quality or offline model execution.

### OnePlus investigation and offline execution (2026-09-15)

An enabled `tech.dongdongbh.mindwtr.dev` ARM64 APK was installed beside the production app and opened with a fresh Metro bundle. Device: OnePlus CPH2655, Android 16/API 36; AICore `0.release.qc.prod_aicore_20260723.00_RC11.964081323` (494422); Prompt SDK beta4; runtime model `nano-v3`. Production app/data were untouched.

Initial capability was `downloadable`. Explicit Download remained pending on validated unmetered Wi-Fi. Cancelling exposed an SDK coroutine ABI crash (`Job.cancel$default` missing from resolved 1.9.0). Aligning the optional runtime to 1.11.0 fixed cancellation; an exact JVM ABI regression failed before the fix and passed afterward. A subsequent pending setup cancelled with `ERR_NANO_CANCELLED` and no crash. Restarting the AICore process, without clearing its data, then yielded `available` and `nano-v3`. No byte-progress or download-completed callback was observed, so the exact reason the service's setup state remained pending is unconfirmed. Do not describe the service restart as a general download fix.

Physical inference then exposed two integration defects: an empty optional description was rejected by native parsing, and fenced JSON was rejected by the text adapter. Both have failing-before/passing-after regressions and are fixed. The final enabled APK and all 17 JVM tests passed; 157 focused mobile tests, TypeScript, and changed-file lint passed.

With airplane mode enabled, Wi-Fi disabled, and Android reporting no active default network, a fresh UI request produced a validated preview. USB forwarding served only the development JavaScript bundle. Applying changed the editable draft, and the normal guided “I'll do it” action saved it as Next; search and the reopened task confirmed the saved title and project. A ready preview was also discarded on Home/resume, preserving the original draft and requiring another request. Privacy-safe `suggestion_ready`, `stale_ignored`, and `applied_to_draft` diagnostics identify `nano_on_device`.

This verifies the mechanics, not acceptable suggestions: the dentist task was assigned to an unrelated existing trip project. Current ID validation blocks nonexistent IDs, but cannot establish semantic relevance of an existing ID. The preview exposed the bad choice before application; the synthetic test deliberately followed it through Save to check persistence.

### Prompt comparison

Four synthetic requests used the same two candidate projects, `Summer trip to the coast` and `Health`, with each prompt variant on this phone, offline. The refined prompt explicitly requires a named association, allows title-only output, preserves vague input, and lists valid statuses and date constraints. Raw synthetic input/output and timings are in [the comparison record](../../scripts/android-evaluation/oneplus-nano-v3-prompt-comparison.json).

| Case | Original prompt | Refined prompt |
| --- | --- | --- |
| Dentist appointment, no named project | Returned both unrelated/unrequested projects; multiple-project validation rejects it | Returned the unrelated trip project |
| Dentist, explicitly use Health project | Correct Health association | Correct Health association |
| Vague “Life admin” | Preserved title, no invented fields | Invented trip association and Next status |
| Form with uncertain date | Omitted date but invented trip association | Omitted date but invented trip association |

Observed native end-to-end times were 1.405–3.224 seconds for the original prompt and 2.136–3.204 seconds for the refined prompt. These are four runs per variant, not p95 or a cold/warm benchmark; no seed was fixed. The stricter wording did not resolve the observed association failure. Formatting/schema constraints alone would not prove that a real project is relevant.

The full multilingual/refusal corpus, manual comparison, repeated quality scores, memory/battery run, second model version, and physical app-lock/failed-save/changed-association cases remain unmeasured. Unit coverage of lifecycle and persistence guards is separate from physical confirmation.

## Current decision

**Defer production adoption: the first physical quality probe failed the zero-invented-associations gate.** Offline execution works on this OnePlus, but additional prompt instructions did not make its structured suggestions reliable. Evaluate deterministic association evidence checks, a smaller title-only feature, or a different model before expanding access. Preserve the explicit preview/Apply boundary. Beta SDK changes, model-version differences, and the distribution boundary remain part of the shipping review.

The smallest proposed entry point is the existing optional AI settings section and Inbox Clarify action. Production follow-up includes measured quality, localization, accessibility/device testing, SDK/license and Play disclosure review, and a maintained non-Google build. It is a medium-to-large follow-up depending on the device findings; no release date is committed.

See [completed work and validation](on-device-ai-progress.md) for recorded implementation and CI evidence.
