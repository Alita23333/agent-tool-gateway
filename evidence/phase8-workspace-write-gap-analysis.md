# Phase 8 Workspace-Write Readiness Gap Analysis

Date: 2026-09-29  
Scope: inspection only  
Production implementation status: **ON HOLD**

This document describes the current receiving product. It does not define a new workspace-write, policy, journal, rollback, hard-confirm, or carrier contract. Any Phase 8 handoff that covers these boundaries supersedes the open questions here.

## Current production boundary

The ZCode production path remains read-only for Android-dispatched tools:

```text
ZCode model
  → production MCP carrier
  → upstream permission broker
  → production Gateway v2
  → ZCodeCarrierWorker
  → ReadOnlyToolDispatcher
  → device_info.identity | ui.inspect
```

`web_search` uses the accepted bridge-inline NETWORK route. `ReadOnlyToolDispatcher` contains a fixed allow-list of only `device_info.identity` and `ui.inspect`, rejects everything else with `TOOL_NOT_EXPOSED`, and refuses any registered tool whose side-effect class is not `NONE`. No workspace-write definition is registered with the production carrier.

The existing Android contracts are suitable as a transport boundary but do not yet specify write semantics:

- `AndroidToolDefinition`
- `AndroidToolRequest`
- `AndroidToolResult`
- `AndroidToolError`
- `ArtifactRef`
- `AndroidToolCancellation`
- `AndroidToolDispatcher`
- `ZCodeToolMapping`

## Workspace roots currently present

There are two different app-private workspace roots in the repository:

| Path | Owner | Current use |
|---|---|---|
| `files/workspaces/<active-name>` | ZCode Phase 5 workspace surface and ZCode runtime | production ZCode sessions, user import/export |
| `files/workspace` | legacy Kotlin `BuiltinToolProvider` | older Kotlin Agent file/shell tools |

The ZCode active workspace is selected through `files/active-workspace`. `WorkspaceRepository` validates workspace names and single-level imported filenames. The bootstrap independently reads the active workspace and launches ZCode with that directory.

Phase 8 must identify the authoritative workspace root and path representation. The product must not silently map a new write carrier to the legacy singular `files/workspace` root.

## Existing user-driven file surface

`WorkspaceActivity` already supports user-driven operations through Android's document picker:

- create and switch an app-private workspace;
- import a selected document into the active workspace;
- export a selected top-level workspace file.

These actions are UI operations, not model-visible tools. Import currently streams directly to the destination and does not use Gateway journaling, pre-image backup, post-image hashing, or atomic replacement. Phase 8 must state whether this user-driven surface is outside its operation contract or must be aligned with it. No change is made during the hold.

## Current path-containment behavior

| Component | Current behavior | Gap requiring Phase 8 contract |
|---|---|---|
| `WorkspaceRepository` | restricts workspace names and imported files to a single level; canonical parent equality check | does not provide nested model workspace paths or a reusable mutation resolver |
| Legacy `BuiltinToolProvider.resolve` | canonicalizes a relative path and checks root plus separator | belongs to the legacy Kotlin Agent and the wrong workspace root; not wired to production Gateway |
| Gateway `classify` | treats a write target as in-workspace when `target.startsWith(workspace)` | string-prefix check does not establish canonical containment, separator boundary, symlink safety, or stable handling of nonexistent descendants |
| Gateway approval backup | repeats `target.startsWith(this.workspace)` | same unresolved containment and symlink questions |
| Gateway rollback | accepts the first recorded absolute target | does not re-check current workspace containment before copying the backup |

Traversal, sibling-prefix paths, symlink traversal, nonexistent targets and path replacement races need authoritative handling. This analysis does not select an implementation.

## Existing journal integration

Journal v2 already has fields that may support a later write protocol:

- `files_modified`
- `before_hash`
- `after_hash`
- `backup_path`
- `reversible`
- `result`
- `detail`

Current behavior is permission-oriented:

1. The Gateway classifies a ZCode permission request.
2. It records an allow, deny, reject or timeout decision.
3. For an approved `Write` or `Edit`, it may capture a pre-image and backup before returning allow.
4. ZCode performs the actual tool execution after permission returns.

There is no product-owned completion callback that links the subsequent mutation result to the original operation row. The auto-allow path creates a journal row but does not return its ID to an Android executor. `after_hash`, execution result and verified files changed are therefore not populated by a complete production write lifecycle.

The Phase 4 invariant “no journal write → no execution” remains authoritative. Phase 8 must define where the durable intent record is committed, how its identity follows the execution, and how completion or uncertainty is recorded. No parallel transaction model is proposed here.

## Existing backup behavior

Gateway v2 creates `files/gateway/backups` and, for an approved existing `Write` or `Edit` target:

- reads the current file;
- calculates a SHA-256 pre-image;
- copies it to an app-private backup path;
- records `backup_path` and `reversible=1` in the later permission journal row.

Open gaps:

- a newly created file has no pre-image or deletion-style rollback marker;
- append and delete do not have named production paths;
- backup and intent journal are not one atomic state transition;
- the backup filename format is an implementation detail, not a versioned artifact contract;
- backup retention, quotas, cleanup and orphan recovery are undefined;
- backup integrity is not re-hashed and stored as a separate artifact identity;
- backup failure currently records `backup-failed` and still resolves the original permission as allowed;
- crash boundaries between backup, journal, permission response and mutation are not modeled.

The requested backup-failure test remains disabled until Phase 8 decides whether the required result is denial, a non-reversible approved operation, or another explicit state. No assumption is encoded in production.

## Before/after hash readiness

Pre-image SHA-256 support exists only for existing files on the interactive `Write`/`Edit` approval path. Post-image support is incomplete:

- no execution completion hook calculates or persists `after_hash` for a normal write;
- permission rows may list an intended path before actual mutation is known;
- failed or partially completed writes cannot currently be distinguished from successful writes using the operation row alone;
- no expected-current-hash precondition protects rollback from overwriting later edits;
- create, append and delete need operation-specific hash semantics from Phase 8.

## Existing rollback entry point

The loopback bridge exposes `POST /gateway/rollback`; `ZCodeGatewayClient.rollback` can call it. Gateway rollback currently:

1. loads the operation row;
2. requires an existing `backup_path`;
3. extracts the first recorded absolute path;
4. copies the backup over that target;
5. hashes the restored target;
6. writes a new `gateway:rollback` operation row after the copy.

The current code does not provide a complete accepted rollback contract for Phase 8:

- rollback is not model-visible, which is correct for the frozen baseline;
- the endpoint calls mutation code directly rather than first passing a new Gateway authorization/intent lifecycle;
- rollback journal insertion happens after the filesystem mutation;
- containment, symlink and current-content checks are incomplete;
- `row.after_hash` is normally absent, so the rollback row lacks a reliable pre-rollback hash;
- rollback cannot restore deletion of a newly created file;
- rollback failure and crash recovery states are not defined.

The standing invariant that rollback itself is a new Gateway operation remains in force. Phase 8 must define how that invariant is satisfied before this endpoint can become a production capability.

## Dispatcher and provider seams

The Android transport seam is reusable:

- definitions carry schema, capability, read-only and cancellation metadata;
- requests carry a stable request ID, arguments, session ID and metadata;
- results preserve structured errors and artifact references;
- the carrier maps canonical IDs to underscore-separated MCP tool IDs;
- Android Local Tool Protocol remains separate JSON-RPC 2.0.

Missing write-side pieces:

- no production write-capable dispatcher;
- no production workspace mutation provider;
- no mapping from a Gateway operation ID to dispatcher request/result;
- no post-mutation verification callback;
- no accepted backup/artifact reference mapping;
- no operation-specific cancellation semantics once mutation begins;
- no recovery representation for an uncertain result after process death;
- no accepted create/overwrite/append/delete schemas.

Phase 8 can be adapted behind `AndroidToolDispatcher` without changing the two protocol families, provided its authoritative Gateway lifecycle is preserved.

## Legacy Kotlin Agent residue

`BuiltinToolProvider` contains older `files.write`, `files.replace`, shell and root tools. `MainViewModel` can still run the older Kotlin `AgentEngine`, and diagnostics can invoke the old root shell directly. These components:

- use `files/workspace`, not the ZCode active workspace;
- use the legacy Kotlin policy/run store;
- do not use production Gateway v2 or its operation journal;
- do not implement the Phase 8 backup/hash/rollback lifecycle.

They must not be reused as the Phase 8 production implementation and must not be registered through the production ZCode carrier. Their eventual retirement or UI treatment is an integration decision that should be reconciled with the Phase 8 handoff; it is not changed during this freeze.

## Test scaffolding prepared during the hold

`Phase8WorkspaceMutationScaffoldTest` contains disabled test names for:

- create file;
- overwrite file;
- append file;
- delete file;
- rollback;
- journal failure causing no mutation;
- backup failure;
- traversal rejection.

The class is ignored at the JUnit level and contains no production executor, schema, expected decision or filesystem mutation. Phase 8 should replace each placeholder with an authoritative fixture rather than relaxing or guessing its contract.

## Questions for the Phase 8 handoff

1. Which tool names and schemas represent create, overwrite, append and delete?
2. Is the authoritative target expressed as a workspace-relative path, canonical absolute path, file handle or another identity?
3. Which component owns resolution and containment for nonexistent paths and symlinks?
4. What durable states and correlation IDs connect intent, backup, execution, verification and recovery?
5. What are the exact hash semantics for absent files, append, delete and rollback?
6. Must backup failure deny the mutation, and how is that denial journaled?
7. What post-image/current-image precondition is required before rollback?
8. How are new-file rollback and delete rollback represented?
9. Which backup retention, quota, cleanup and integrity rules apply?
10. Does Phase 8 include the user-driven `WorkspaceActivity` import path or only model-originated operations?
11. Does Phase 8 require removal or disabling of the legacy Kotlin Agent mutation surface?
12. Which residual paths must have regression tests proving that they cannot bypass Gateway?

## Files the Workflow side should inspect

- `app/src/main/assets/zcode-runtime/gateway.cjs`
- `app/src/main/assets/zcode-runtime/bootstrap.cjs`
- `app/src/main/assets/zcode-runtime/contracts/journal.sql`
- `app/src/main/java/dev/alita/androidagent/zcode/runtime/WorkspaceActivity.kt`
- `app/src/main/java/dev/alita/androidagent/zcode/runtime/ZCodeGatewayClient.kt`
- `app/src/main/java/dev/alita/androidagent/zcode/runtime/ZCodeCarrierWorker.kt`
- `app/src/main/java/dev/alita/androidagent/zcode/adapter/AndroidToolContracts.kt`
- `app/src/main/java/dev/alita/androidagent/zcode/adapter/ReadOnlyToolDispatcher.kt`
- `app/src/main/java/dev/alita/androidagent/zcode/adapter/ZCodeToolMapping.kt`
- `app/src/main/java/dev/alita/androidagent/tools/BuiltinTools.kt`
- `app/src/main/java/dev/alita/androidagent/AgentApplication.kt`
- `app/src/main/java/dev/alita/androidagent/MainViewModel.kt`
- `app/src/test/java/dev/alita/androidagent/Phase8WorkspaceMutationScaffoldTest.kt`

## Hold conclusion

The product has useful transport and storage building blocks, but it does not yet have a production-safe, end-to-end workspace mutation lifecycle. The correct next action is to keep the Phase 7 carrier allow-list unchanged and wait for the complete Phase 8 export.
