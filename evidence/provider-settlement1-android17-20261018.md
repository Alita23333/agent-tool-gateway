# Provider settlement1 — Android17 scoped acceptance (2026-10-18)

Disposition: PASS_SCOPED_EXACT_DISPATCHER_OPERATION_SETTLEMENT. Not model, HTTP-carrier end-to-end, durable session binding or production installation acceptance.

The candidate extends native Dispatcher result completion from the fixed text digest to host-registered non-UI Dispatcher tools. Pending scope snapshots the registered canonical-tool marker and optional provider hash before asynchronous admission; caller metadata cannot supply that scope. Malformed registered hashes fail before admission/dispatch. UI retains its existing writer.

CarrierAuthorization.finish checks exact admitted operation/tool/arguments/session, bounded host call ID, explicit boolean success and consistent envelope fields. Successful versioned provider results require host provenance matching the pending hash. Failed calls can finish without success provenance and record a bounded error code. One conditional SQL update completes the existing operation only while decision=allow, result IS NULL, and the original tool/session/raw arguments still match. Zero-row update or journal failure returns JOURNAL_RESULT_FAILED to both responder and waiting call; no successful result is forwarded. Epoch changes refuse settlement.

No new policy matrix, journal schema, registry, execution capability or core loop. Unknown provider tools remain PRIVILEGED and require existing confirmation. The existing device_info_identity entry is also PRIVILEGED; text_digest_inspect remains READ. Core, Node, Bash, Gateway source, journal contract, native libraries and compiled Android manifest are byte-identical to the previous candidate.

Validation:
- Host actual Gateway/SQLite: 22 checks PASS, including extracted production responder with real SQLite, scope/hash/duplicate/reentrant-write/error/journal failure cases. Extracted responder is not HTTP integration proof.
- Android17 DEVICE_ANDROID17 / MODEL_ANDROID17: exact candidate sources + same 22 checks PASS under existing isolationTest app UID, actual APK-owned Node v24.18.0 and SQLite. Run 1792329308356424100. No APK installed, no model, no provider spawn or carrier HTTP path in this increment. Candidate-source cache retained.
- JVM: 106 tests, zero failures/errors/skips. Debug build PASS. Regenerated lint report: 0 errors / 28 existing warnings. Known Windows workspace exclamation-mark lint analysis diagnostics remain in raw build log.
- Existing carrier authorization15, cancellation, Phase8 repair, internal boundary, config-disable9, workspace analysis12, Skill control28 and Skill session16 regression outputs retained.
- Payload 40 SHA rows verified inside the built APK. Exactly five asset differences from binding1: bootstrap, carrier authorization, runtime manifest, payload SHA manifest, generated isolated-runtime manifest. Every native library and compiled main manifest unchanged.

First failure: the new test initially asserted device_info_identity risk READ; actual preserved Gateway classification was PRIVILEGED. Corrected test only; details in first-attempt.json. Device checks passed first attempt.

Installed host postflight initially had no process/HTTP response. MainActivity was opened normally; app-UID internal am start was refused by Android and no bypass was used. ADB tap did not open the Agent. User clicked Open Agent after notification; final authenticated status is ready / real / v24.18.0. Read failures retained separately. No root, Android15, production APK reinstall, policy, permissions or settings changes.

Frozen candidate SHA256: AF2544DA6D2DA30089A118EABA98844A4D2FD49404FD868C2203F462DF0B6424
Installed accepted APK SHA256: C51DB531DCC9CB9CB398FAA061E9B53724E099E8456F1D3666A1E4604865C98D
Runtime identity: 0.16.9-runtime5 / productRevision provider-settlement1-candidate / Gateway journal schema3.

Remaining: persist host-reviewed provider definitions/grants; pin provider versions in the existing sessions-index lifecycle and restore old pins after update/restart; startup admission/registration; real model -> carrier -> Dispatcher -> Gateway -> isolated provider -> physical artifact -> final-answer proof including cancel/restart. Retained handles and per-worker hash fences do not prove durable session pinning. No imported provider is automatically exposed on production startup.

Evidence: evidence/provider-settlement1/acceptance-summary.json, frozen candidate.apk, sources/, unit-tests/, build.log, lint-fresh.log, regression logs, Android17 run/commands-and-exits.json and identity.json. Source/package hash provenance does not establish semantic correctness of arbitrary provider output.
