# CHG-PILOT-SETUP-001 status

Human review and merge pending. This is not the product Change CHG-TASK-001.

The prepared services contain README and CODEOWNERS. The original UI recognizes only README/license/gitignore anchors, so it rejects the documented first-service ** scope. A regression test reproduces this and a one-line allowlist repair addresses it without accepting product files.

The initial PR hosted run also exposed the existing 10,000-work-unit timing check: normalization rescanned every preceding unit. A running-count implementation removes the quadratic scan, retains generated-ID behavior, and keeps the original timing/limit check intact. Fresh exact-head verification is required.

Product planning, Writer dispatch, implementation, service PRs, Candidate and deployment are not started. Reconcile this setup unit to merged when recording the next reviewed Root coordination update; do not invent a merge SHA in advance.
