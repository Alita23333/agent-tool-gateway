# Typed Core event consumer audit — 2026-10-29

This is a Codex internal, offline audit of the receiving product. It does not issue a task to ZCode Workflow. Production code, runtime payloads, Gateway/journal schemas, device state, and credentials were not changed or exercised by this audit.

## Result and evidence levels

The current Core emits a typed `session/event` envelope. The title consumer already matches the observed payload, although it does not check the outer event type. The upstream transaction and network consumers still expect an older payload discriminator and do not match the current Core projection.

| Consumer | Current condition in bootstrap | Actual current Core shape | Assessment |
| --- | --- | --- | --- |
| Title index | Any `session/event` with a truthy `payload.title` | `params.type = session.titleUpdated`; `payload = { previousTitle, source, title, messageID? }` | **Observed match** for seven nonempty title events. This audit does not prove the resulting `sessions-index.json` write survived restart. |
| `completeUpstreamTxn` success | `payload.type = tool_call_result` | `params.type = tool.updated`; `payload.kind = result`; `payload.toolCallId`, `payload.result`, `payload.duration` | **Observed mismatch.** Thirteen result events have no `payload.type`. None are an upstream Write/Edit completion experiment. |
| `completeUpstreamTxn` error | `payload.type = tool_call_error` | `params.type = tool.updated`; `payload.kind = error`; `payload.toolCallId`, `payload.error` | **Observed mismatch.** Two actual MCP cancellation errors have no `payload.type`. These do not prove the upstream write transaction path. |
| Core network fold | `payload.type = network_request_status` | The inspected WebFetch emitter supplies no payload discriminator; Core projects this internal event to outer `session.updated` and preserves its payload | **Source-only mismatch.** No actual WebFetch network event is present in this receiving-product evidence set. Existing field extraction is also inconsistent with the emitter. |

“Observed” here means the checked JSON already saved by the Android15 takeover run. “Source-only” means the inspected, hash-pinned local implementation establishes the mapping. “Unproven” means neither a live result nor the required persisted/journal correlation was established by this audit. Reading a method name in Core's internal event enum is not evidence that the same name appears in the wire payload.

## Inputs and exact identity

Audited product sources:

| File under `app/src/main/assets/zcode-runtime/` | Bytes | SHA-256 |
| --- | ---: | --- |
| `bootstrap.cjs` | 92,957 | `768588E85C79FFC1B439ECDF2D7DF5B1B01827F672F052A3DAF085161DDE942B` |
| `gateway.cjs` | 84,018 | `D5C1A772B40A39F8F02D344D191A932AC121AF42ABBA5219362C1B7AAD23C89B` |
| `zcode.cjs` | 14,820,819 | `B1DF2EF3E5BD76C4AF3ECB296BC003A10D3F13191A26610BD0BA940FEADAD529` |

Evidence root: `docs/handoff/evidence/android15-takeover/1793284879529999600/`. At the audit snapshot, 20 `events.json` files existed; five contained Core session events, and the remaining files were empty arrays. Only the five nonempty inputs contribute to the counts below:

| Subdirectory / `events.json` | Bytes | `session/event` count | SHA-256 |
| --- | ---: | ---: | --- |
| `provider-model-1793285239802962600` | 615,454 | 36 | `7F560D40294BD702FCE50D60828DB12C14A89D3A1090216E2F144C3B9830B286` |
| `provider-model-1793285331307919500` | 2,057,787 | 87 | `83242A3C84CF1194A411D9BB1CC7E4D7592A2306A7268BE662BED66E484CD8C8` |
| `reliability-1793285449039511800` | 2,904,764 | 153 | `474B7A99CA72FB8570306067156A43EA0C87698A7A4F93FE340D17AFA6FCFAA4` |
| `skill-model-1793285378228599000` | 270,737 | 39 | `07F281A55C3610C823E4BD8EF479AA31AD0B3B58CB00CECAC6D51BE6BD773133` |
| `skill-model-1793285431737974400` | 912,525 | 80 | `1B601EC2A77F7F32ED8532983078DE783D24A86324393097A07590678808B608` |

The wrapper is `{ type: "rpc", message: <Core JSON-RPC message> }`. Counting `message.method === "session/event"` gives 395 records and 395 distinct `(sessionId, eventId)` pairs:

| Outer `params.type` | Count |
| --- | ---: |
| `model.streaming` | 181 |
| `permission.requested` | 7 |
| `permission.resolved` | 7 |
| `session.titleUpdated` | 7 |
| `session.updated` | 96 |
| `streamRecovery.updated` | 15 |
| `tool.updated` | 60 |
| `turn.completed` | 11 |
| `turn.started` | 11 |

The outer envelope fields observed are `deliveryKind`, `eventId`, `payload`, `seq`, `sessionId`, `timestamp`, `traceId`, `turnId`, and `type`. Delivery is `desktop-continuous`. Automatic subscription at bootstrap lines 333–339 supplies that required delivery kind; this audit does not alter the accepted subscription repair.

The Core is partly minified. Source locations below use actual file line numbers plus named functions. Where useful, the zero-based offset is a **UTF-16 text index**, not a byte offset; it was obtained from the exact source above and must not be compared with historical byte offsets.

## Title branch

Current bootstrap lines 359–360 call `indexTitle(sessionId, payload.title)` for every `session/event` with a truthy title. `indexTitle` at lines 428–431 finds an already indexed session, accepts a nonempty title, truncates it to 120 characters, and writes only if it differs.

The actual event schema at `zcode.cjs:72`, `ysr` (UTF-16 offset 749873), declares:

```text
outer type: session.titleUpdated
payload:
  previousTitle: string
  source: default | first_input | generated | custom
  title: string
  messageID?: nonempty string
```

`mapSessionEventType` / `jZa` at `zcode.cjs:15252` maps internal `SessionTitleUpdated` to `session.titleUpdated`. `mapSessionEventPayload` / `ZKa` preserves the title payload. Thus the current broad guard matches the observed shape without needing a legacy `payload.type`.

Example observed identity, with task text omitted:

```text
file: provider-model-1793285239802962600/events.json
eventId: cbfa99f8-418c-4890-acbf-c44d5721b4f0
sessionId: sess_a7022433-f433-4027-922d-7de029640fba
seq: 1
params.type: session.titleUpdated
payload keys: previousTitle, source, title
payload.source: first_input
payload.previousTitle: ""
payload.title: nonempty string
```

Unproven here: title disk readback, behavior when no host session index row exists, generated/custom title updates, deliberate empty title handling, and persistence across a full host restart. A nonempty title event alone does not prove those properties.

Minimal later change: restrict this consumer to outer `session.titleUpdated` and validate the expected string fields; keep the current host index and storage semantics. Do not treat every generic session payload carrying a `title` field as an index instruction. Capture index readback before and after restart in a bounded product check before claiming persisted-title acceptance.

## Tool completion and upstream write correlation

Current bootstrap lines 365–371 test `payload.type` against `tool_call_result` / `tool_call_error`, then forward a call ID alias and that string to Gateway. None of the 60 observed `tool.updated` payloads contain `type`. Their `kind` counts are scheduled 15, started 15, result 13, error 2, and batch 15.

Core's mapping is explicit:

- `mapSessionEvent` / `$xt`, `zcode.cjs:15251`, UTF-16 offset 14416441: outer `type = jZa(internalEvent.type)` and `payload = ZKa(internalEvent)`.
- `jZa`, `zcode.cjs:15252`, UTF-16 offset 14429917: scheduled/started/progress/result/error/batch internal tool events all map to outer `tool.updated`.
- `ZKa`, `zcode.cjs:15251`, UTF-16 offset 14417079: adds `kind: "result"` or `kind: "error"`; it does not add the old `type` field.
- `Asr`, `zcode.cjs:72`, UTF-16 offset 752946: declares the `kind` discriminated union. Results contain `toolCallId`, `result`, and `duration`; errors contain `toolCallId` and `error`. `toolName` is optional on these terminal events.

Observed terminal examples:

```text
result:
  file: provider-model-1793285239802962600/events.json
  eventId: 0e1842c1-164a-4176-a0e3-e7dc084997af
  sessionId: sess_a7022433-f433-4027-922d-7de029640fba
  seq: 20
  params.type: tool.updated
  payload keys: toolCallId, result, duration, kind
  payload.kind: result
  payload.toolCallId: call_00_lQCxYtdvPeVOE3FjdwEQ2411
  payload.result.success: true

error:
  file: reliability-1793285449039511800/events.json
  eventId: 25401860-7eef-488b-97b9-d9584bdd175d
  sessionId: sess_a9b0c130-6e65-4dff-890e-7c4c0faf7344
  seq: 17
  params.type: tool.updated
  payload keys: toolCallId, error, kind
  payload.kind: error
  payload.toolCallId: call_00_puuyG0G5GKIhBhLkSC0r4223
  payload.error.type: tool_cancelled
  payload.error.code: TOOL_CANCELLED
```

All 13 observed result payloads have `result.success = true`. Source also permits a `ToolCallResult` with `result.success = false`: the restored tool-state mapping at `zcode.cjs:15262` (UTF-16 offset 14575738) emits that shape for an error state. A future adapter must not equate every `kind: result` with semantic success. This false-result case is **source-only**, not observed in the supplied run.

Gateway `completeUpstreamTxn`, `gateway.cjs:1220–1257`, has two existing responsibilities:

1. Close the Bash before/after fingerprint observation.
2. Find an `upstream_event` Write/Edit transaction in `intent` or `prepared`, by session and call ID. On its existing success kind it records `completed`, result `unobserved`, verify `event_reported`; it does not claim a verified post-image. On its existing error kind it records `failed` / `upstream_tool_error`.

These are separate from the production MCP carrier's existing result settlement. The observed imported-provider cancellation does not require this legacy upstream transaction fold to settle its carrier operation and does not prove an upstream Write/Edit mutation occurred.

An additional source-only hazard matters before enabling typed terminal consumption: Gateway line 1224 falls back from an unmatched call ID to **any** Bash marker for the same session. Line 1226 then deletes the requested key, which may differ from the fallback marker's key. Sending all typed tool terminals into this function can therefore perform the Bash after-walk on an unrelated tool's terminal event. Exact correlation is needed before widening the consumer. This audit did not execute Bash and has no physical example of that failure.

Existing `tools/phase8/wws-unittest.cjs:139–151` creates a synthetic upstream intent and calls `completeUpstreamTxn(..., "tool_call_result")` directly. It verifies the Gateway method's existing terminal behavior; it does **not** pass an actual typed Core event through `handleCoreMessage` and cannot prove the consumer mapping.

Minimal later repair and evidence:

1. At the existing host boundary, recognize only outer `tool.updated` with an exact nonempty `payload.toolCallId` and terminal `kind`. Map to the existing Gateway terminal interface, with an explicit decision for false `result.success` and cancellation. Do not introduce a new event/journal schema or replace carrier settlement.
2. Make correlation exact for already recorded Bash/Write/Edit calls; remove or narrowly guard the session-only Bash fallback. Do not use an unrelated terminal event to infer which call completed.
3. Add offline tests using the captured result and error shapes, plus malformed/missing call ID, started/batch events, unrelated call in the same session, false result, repeat delivery, and late result after terminal state. Tests must exercise the consumer and existing Gateway path, rather than only calling the Gateway method directly.
4. Before claiming the upstream route is accepted, obtain a controlled actual Core upstream Write/Edit permission → intent/prepared → exact terminal event → same transaction result correlation and the Bash exact-call after-walk. Preserve current authorization, journal-before-execution, and `event_reported` limits. Do not enable a disabled side-effect path merely to manufacture a passing event.

## Core network fold

The literal `network_request_status` occurs in the inspected Core's **internal event enum**. That alone is not its wire discriminator. `emitNetworkRequestStatus` / `Cht` at `zcode.cjs:2665` (UTF-16 offset 7539909) emits internal `NetworkRequestStatus` with `payload: t` unchanged. Its only inspected call sites are the WebFetch HTTP client path at `zcode.cjs:2684` (first call at UTF-16 offset 7557115); `U1` is `"WebFetch"`.

`jZa` has no explicit `NetworkRequestStatus` case and returns `session.updated` by default. `ZKa` also has no explicit case and preserves the payload. `shouldExposeSessionEventToProtocol` / `C3e` does not filter this internal event. Consequently, the source-defined wire shape is:

```text
params.type: session.updated
payload does not contain a synthetic type or kind discriminator

pending payload:
  method: GET
  requestId: net_<uuid>
  source: http_client
  startedAt: ISO timestamp
  status: pending
  toolCallId: context call ID
  toolName: WebFetch
  url: full URL

complete payload:
  completedAt, durationMs, egress, method, requestId, source,
  startedAt, status: complete, statusCode: HTTP status,
  toolCallId, toolName, url

error payload:
  completedAt, durationMs, error: text, method, requestId, source,
  startedAt, status: error, statusCode?: HTTP status,
  toolCallId, toolName, url
```

The emitter loops over redirects, allocating a new request ID for each HTTP request. Request start and terminal events are separate. Neither the start nor the terminal payload shown by this emitter includes flat `scheme`, `host`, `path`, `bytes` / `bytesIn`, `cacheHit` / `cache_hit`, `proxied` / `proxyUsed`, `preapproved`, or `errorCode`. Absence from this emitter does not prove that every future provider has the same shape.

Current bootstrap lines 378–397 disagree at both levels:

| Current extraction | Inspected emitter | Consequence if only the entry guard were changed |
| --- | --- | --- |
| `payload.type === network_request_status` | No payload type; outer `session.updated` | Entry condition is false. |
| Numeric `payload.status` | String lifecycle status; numeric `statusCode` | HTTP status would remain null and normal completion would not produce current `ok` result code. |
| `scheme`, `host`, `path` | Full `url` | Destination columns would remain null. |
| Flat proxy flags | Nested `egress` | Current proxy attribution would default false without inspecting its actual contract. |
| `errorCode` | `error` text | Current failure result code would remain null. |
| `preapproved ? upstream-preapproved : ui` | No `preapproved` | It would fabricate `ui` approval provenance rather than establish it. |
| No turn or call linkage passed | Outer `turnId` and payload `toolCallId` exist | Existing nullable journal linkage columns would remain empty. |
| Raw `JSON.stringify(payload)` in notes | Payload contains full URL | Simply making this live could persist URL query/user data in notes; redaction must precede persistence. |

The current 96 `session.updated` records do **not** supply this network proof. Their payload groups are: 48 records without an inner `type` from model-request/context projection, 24 `model_request_started`, and 24 `model_request_completed`. There are no `http_client`/WebFetch request-status payloads, no actual `network_request_status` payload discriminator, and no captured WebFetch error lifecycle. The model request events may include provider request metadata; they must not be relabeled as WebFetch or WebSearch egress.

This finding is scoped to the **Core-originated network fold**. It does not invalidate the separate carrier Web Search implementation at bootstrap lines 1074–1087, which directly supplies its structured rows to `gateway.journalNetworkRequest`, or the vision pipeline's direct journal callback at lines 1144–1149. No such capability was executed or reaccepted by this audit. The inspected `Cht` emitter supports WebFetch; the current source does not establish a WebSearch emitter using the same event path.

Minimal later work:

1. First capture one controlled actual WebFetch success and one controlled failure through the accepted production path, preserving typed envelope, request/call IDs, permission evidence, and the resulting existing `network_request` rows. Record whether the product enables that path; a disabled path remains a documented residual rather than a reason to relax its controls.
2. Use only a validated narrow WebFetch HTTP payload shape under `session.updated` for this compatibility consumer. Do not consume every generic session update and do not infer approval provenance, bytes, cache hits, or proxy state from absent fields.
3. Adapt lifecycle status, numeric HTTP code, outer session/turn, exact call ID, and redacted URL to the **existing** `journalNetworkRequest` fields. Inspect actual `egress` data before mapping it. Decide the start/terminal row behavior against the existing network journal contract and test exact row counts; do not invent a third network event store.
4. Add offline consumer fixtures for pending/complete/error, redirect requests, model network payload rejection, malformed URLs, redaction, and journal write failure. A compatibility test does not replace a real Core-to-journal acceptance result.

## Recommended mainline sequence

Keep the accepted Android15 migration baseline green. The least invasive next implementation is a small host-side typed consumer adapter with tests that use the already captured event shapes; title and tool terminals have real wire evidence. Preserve the current Gateway and journal contract, fix exact call correlation before activating the tool-terminal fold, and keep carrier result settlement independent.

Treat WebFetch folding as a separate evidence gap: inspect and measure the actual permitted path before completing its mapping. This audit supports a specific compatibility repair; it does not establish upstream Write/Edit or network acceptance and does not authorize additional Android write, root, Shizuku, or arbitrary execution capabilities.
