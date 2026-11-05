# Mainline safety repair — Android17 scoped acceptance

2026-10-04. Android17 `DEVICE_ANDROID17` / MODEL_ANDROID17/API37 only. Final installed debug APK
SHA-256 `816C8EAC537771BF43CCE78222B62A8B866B7EEA7F1B7EA4CB1EB121A6BCF2C0`.
**Android17 safety repair PASS; Android15 independent acceptance pending.** This is
not a declaration that the full mainline execution plan is complete.

Runtime stays 0.16.9-runtime5, frozen ZCode Core0.16.9, Node24.18.0/Bash5.3.20.
One existing production Gateway and journal schema3; no new policy/hard-confirm
matrix, no Route C, no Kotlin Agent runtime expansion. Runtime/payload/source hashes
are in `evidence/mainline-safety/final-identity.json` and `final-installed-hashes.json`.

## Resulting behavior

All registered native worker tools, including device identity, must obtain a specific
existing Gateway operation before queue delivery. Worker checks both active and
authorized immediately before UI or dispatcher execution. Direct Web Search uses
the same Gateway admission before its existing network ledger/provider execution.
Unknown tools and foreign session substitution fail closed; caller-supplied operation
IDs do not confer authority. Workspace INLINE tools retain existing intent claims.

Normal Core permission approvals are recorded by the host using the returned exact
operation ID and reused once for identical tool/session/arguments. Ambiguous, expired,
completed or cancelled grants cannot authorize dispatch. Internal Gateway IDs are
stripped from the Core protocol response. The visual trio retains actual capture/
target preflight; its earlier unexpanded approval is not reused. Internal calls bind
the actual operation ID instead of the nearest row. Legacy /ui/selftest returns403.

Forward swipe is bottom→top; backward is top→bottom. LongList and UiLab fixtures now
live in debug sources, absent from merged release manifest. Unconditional boot-time
hello.txt overwrite was removed; task files are not reset during runtime startup.

## Measured coverage

| Check | Result and scope |
|---|---|
| Final APK direct admission/scroll | 10/10: denied scroll no mutation; denied search no network_request row; positive forward/backward by fresh item sets; at_end separately; wrong session/unknown tool rejected; selftest disabled; pending cancellation never reaches worker; 23 completed UI rows each exact committed Gateway op |
| Actual Gateway/admission isolated faults | 15/15 desktop and final APK-owned phone Node; deny, real closed SQLite, injected journal failure, missing row, mismatch, single-use, ambiguity, expiry and cancellation. Production database was not faulted |
| Final real model tools | device identity, ui.inspect and Tavily search3/3; Web Search permission event1/carrier event1, no duplicate approval |
| Final real model scroll/native identity | Positive verified scroll with one committed allow operation; direct native identity ignored supplied foreign UI approval and obtained its own new operation, physical model matched |
| Final runtime |6/6 real turn+stream, cancellation, Activity reconnect, runtime crash/restart, resume and force-stop/relaunch with persisted messages |
| Visual regression |3/3 on immediately preceding UI/native candidate APK9F60A4CA…: screenshot, image provider and coordinate tap. Final difference adds Web Search admission only; visual branches unchanged. This is explicitly not a new final-APK visual measurement |
| Build/source | Debug/release build PASS; JVM30/0/0 and lint PASS on unchanged Kotlin sources; internal exact-binding, carrier cancellation and retained Phase8 repair regressions PASS. 35 packaged/34 immutable installed hashes verified |

Exact final scenario logs/summaries and frozen final APK are under
`evidence/mainline-safety/`; original Phase9/F1 APKs remain preserved. Earlier UI/native
candidate identity and APK are also retained. No Android15 or other-device operation.

## Failures and limits retained

Immediately after cold installation/setup, first direct fixture connection produced
socket hang up. Evidence is retained (`device.log`, `search-admission-device.log`);
fixture retry passed. This startup transport issue remains unresolved and is not
concealed by successful retries. No uncertain production write/send/delete was replayed.

An added direct identity test initially waited without a permission responder and
timed out; fixed the test to answer only that non-hard-confirm tool. No policy was
weakened. A subsequent harness SSE-close thread exception was fixed in test cleanup;
the latest final run has clean PASS output. Original attempt logs remain.

ROM force-stop still removes Accessibility enablement; authorized debug setup restores
the service while retaining other enabled services. Product does not silently restore
grants with root. Final UI/native model check restored Accessibility after lifecycle
tests. General vision accuracy, Android15 repair compatibility, system-first350ms
capture branch and command/Skill useful-task acceptance are not claimed here.

Completed ZCode investigation is reviewed in
`carrier-boundary-analysis-receiving-review.md`; old characterization9/9 with target6/9
is preserved as defect evidence, not counted as repaired invariants. The new directed
Android15 task will report its own build identity and failures, without architecture
redesign. Stage two readiness is `../project/command-skill-readiness.md`.
