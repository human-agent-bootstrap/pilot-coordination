# Status — CHG-TASK-001

**State:** APPROVED

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
