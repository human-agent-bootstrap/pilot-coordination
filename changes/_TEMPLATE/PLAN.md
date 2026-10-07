# <CHANGE-ID> — <short title>

## State

- Status: DRAFT
- Coordinator: <name>
- Required approvers: <product-owner>, <service-owner>, <independent-reviewer>
- Plan base: <ROOT_BASE_SHA>
- Tracking: <issue-or-project-url | none>

## Goal

<One sentence of user-visible value. Not an implementation description.>

## Non-goals

- <explicitly out of scope>
- <explicitly out of scope>

## User flow

1. <observable step>
2. <observable step>

## Acceptance criteria

State results a test can observe. "The screen works" is not a criterion.

- [AC-001] <observable success result>
- [AC-002] <observable boundary or error result>
- [AC-003] All participating service checks pass at the recorded merge SHAs.
- [AC-004] Cross-repository verification passes against the exact candidate SHA combination.

## Contracts

- Shared snapshots: `contracts/<file>` or none
- Compatibility/migration: <none | plan>

## Order

- Merge order: <which PR first, and why>
- Deploy order: <service order>
- Activation: <feature flag or none>

## Risks

- <risk and its detection signal>

## Rollback

| Item | Plan |
|---|---|
| Trigger | <error rate, latency, data mismatch threshold> |
| Owner | <who decides to stop> |
| Kill switch | <flag, route block, consumer pause, or none> |
| Code recovery | <previous artifact digest or forward fix> |
| Data recovery | <restore, replay, backfill, or not applicable> |
| Verification | <what to check after recovery> |

## Stop conditions

- A contract change is required.
- A `base_sha` or dependency SHA changed.
- Authentication, persistence, or deployment enters scope.
- A required verification cannot be run.
