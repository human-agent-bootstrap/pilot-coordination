# CHG-PILOT-SETUP-001 — Initial service anchor readiness

## State

- Status: APPROVAL REQUESTED; human review and merge pending.
- Coordinator: whdvlf94
- Plan base: 0a2512a0192a1e81a30086457853e4dd3d08aa01

## Goal

A service containing only README and CODEOWNERS remains a brand-new service for the first implementation Work Unit.

## Non-goals

- No product implementation, API contract, service SHA change, Candidate, deployment, review bypass, or approval impersonation.
- No service executable CI files are added to the anchor allowlist.

## Acceptance criteria

- [AC-001] Repository context reports bootstrapEligible=true for README plus .github/CODEOWNERS.
- [AC-002] Adding product source at the committed service gitlink makes bootstrapEligible=false.
- [AC-003] Root tests, planning UI browser tests, registry and write-scope checks pass.
- [AC-004] Work-unit normalization uses running generated-ID counts rather than rescanning all predecessors, preserving existing ID generation and passing the original 10,000-item limit test on hosted CI.

## Contracts

None; this is a Root setup repair, not the task-board product plan.

## Review gate

This setup PR is implemented locally as a bounded configuration discovery/repair. The manifest's approved serialization requests review; it is not human approval. A person other than the author must approve and merge before the product rehearsal starts. No Writer packet is emitted from this setup Change.

## Rollback

Revert this one-file allowlist repair through a reviewed PR. No data or service pointers change.
