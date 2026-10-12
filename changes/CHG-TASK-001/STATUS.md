# Status — CHG-TASK-001

**State:** COMPLETE

## Scope

GOAL-001 작업을 등록하고 다시 확인한다: 사용자는 작업 제목을 등록하고 목록에서 확인하며, 새로고침 후에도 저장된 작업을 볼 수 있다. Non-goals: 로그인과 사용자 권한 작업 완료 처리·수정·삭제 알림·외부 API 연동 운영 배포와 운영 데이터

## Work units

| Work unit | Goal | Repository | State | Gate |
|---|---|---|---|---|
| `contract-and-plan` | all | Root | in_progress | Human plan and contract approval |
| `pilot-front` | `GOAL-001` | `pilot-front` | ready | Approved planning merge SHA |
| `pilot-back` | `GOAL-001` | `pilot-back` | ready | Approved planning merge SHA |
| `candidate-integration` | all | Root | draft | Service PRs reviewed and human-merged |

## Evidence boundary

- Root base SHA: `a514f041fd0ba799c7cbebcac856371ccd782c71`
- Service base SHAs: see `WORK_UNITS.yaml`
- No implementation has started.
- No implementation agent has been dispatched.
- No candidate, release, or deployment claim exists yet.

## Next gate

A human reviews and approves the Root planning PR. Its merge SHA becomes the immutable plan version supplied to participating Writers.


## Candidate execution

- Run: run-CHG-TASK-001-candidate-002
- Approval: 8a994a0ee31d2c8743a808accc02e42541720ee3cad40e0d385c3ff5f3c17f52
- Service PRs: merged and pinned; Candidate PR, main CI and integration environment remain separate human gates.

## Closure

- Plan SHA: `9cf22f9d0d2f33b32a4e32bc44a92262de6a39a9`
- Candidate PR: #5 merged as `0bbdb1e6a764103a2e348795fe6f8dff3390837d`
- Service merge SHAs:
- pilot-front: `ec57ce6b66cca0e6588abc46294f3cf9095e3a83`
- pilot-back: `08ed728587c4450d58ab93ae00f14bd66da441a4`
- Acceptance evidence:
- AC-001: `npm ci --include=dev` exit 0
- AC-002: `npm ci --include=dev` exit 0
- AC-003: `npm ci --include=dev` exit 0
- AC-004: `npm ci --include=dev` exit 0
- AC-005: `npm ci --include=dev` exit 0
- AC-005: `npm test` exit 0
- AC-005: `npm run lint` exit 0
- AC-005: `npm run typecheck` exit 0
- AC-005: `npm run build` exit 0
- AC-005: `uv sync --locked --python 3.12` exit 0
- AC-005: `uv run --locked pytest` exit 0
- AC-005: `uv run --locked ruff check .` exit 0
- AC-006: `npm ci --include=dev` exit 0
- AC-006: `npm test` exit 0
- AC-006: `npm run lint` exit 0
- AC-006: `npm run typecheck` exit 0
- AC-006: `npm run build` exit 0
- AC-006: `uv sync --locked --python 3.12` exit 0
- AC-006: `uv run --locked pytest` exit 0
- AC-006: `uv run --locked ruff check .` exit 0
- Gates: Candidate PR created, merged, Root main CI passed, integration environment confirmed by a human.
- Integration environment: 127.0.0.1:5173에서 고정된 front ec57ce6b·back 08ed7285 조합으로 작업 등록, 새로고침 후 유지, 공백 제목 오류 안내를 사람이 직접 확인했다.
