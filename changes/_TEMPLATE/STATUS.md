# Status — <CHANGE-ID>

**State:** DRAFT

## Scope

<One paragraph: what this change adds, and the explicit non-goals.>

## Work units

| Work unit | Repository | State | Gate |
|---|---|---|---|
| `contract-and-plan` | Root | draft | Human plan and contract approval |
| `<service-id>-implementation` | `<service-id>` | draft | Approved plan merge SHA |
| `candidate-integration` | Root | draft | Service PRs reviewed and human-merged |

## Evidence boundary

- Root base SHA: `<ROOT_BASE_SHA>`
- Service base SHAs: see `WORK_UNITS.yaml`
- No implementation has started.
- No implementation agent has been dispatched.
- No candidate, release, or deployment claim exists yet.

Verify recorded PR and SHA rows against GitHub:

```bash
npm run verify:prs -- --change <CHANGE-ID>
```

## Next gate

A human reviews and approves the Root planning PR. Its merge SHA becomes the immutable
plan version supplied to the participating service Writers.
