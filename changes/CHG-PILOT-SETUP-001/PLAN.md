# CHG-PILOT-SETUP-001 — Single-account pilot setup

## State

- Status: APPROVAL REQUESTED; settings PR merge explicitly authorized by the user.
- Coordinator and human decision owner: whdvlf94
- Plan base: 0a2512a0192a1e81a30086457853e4dd3d08aa01

## Goal

Run the template pilot with one human account: the author checks CI and evidence and can merge without another reviewer or file-owner approval.

## Non-goals

- No product implementation, API contract, Writer dispatch, product Candidate or deployment.
- No weakening of scope, branch/base/SHA matching, required Root CI, force-push or deletion protections.

## Acceptance criteria

- [AC-001] File-owner configuration is removed from the three pilot default branches.
- [AC-002] PR verification accepts a merged PR without approval lookup and still rejects wrong SHA, missing PR author or unmerged state.
- [AC-003] Generated plans, guides and UI require a human content/CI check, not another reviewer account.
- [AC-004] Root tests, browser UI tests, registry, work-unit scope and actual GitHub PR checks pass.
- [AC-005] Work-unit normalization keeps running ID counts; the original 10,000-item limit test stays unchanged.
- [AC-006] Service setup pointer receipts identify exact reviewed-by-user metadata-only merges; product pointer movement continues to require a Candidate.

## Human gate

The user explicitly requested removing reviewer setup and authorized merging these setup PRs after verification. Do not represent this as an independent review. Product work needs its own merged plan.

## Recovery

Restore the previous exact configuration in a new PR if needed. No product or data is created or changed.
