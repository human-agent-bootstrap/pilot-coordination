# CHG-TASK-001 — 팀 작업 보드 — 작업 등록과 조회

## State

- Status: APPROVED
- Coordinator: jpyoon
- Human merger: jpyoon (may also author the PR)
- Plan base: a514f041fd0ba799c7cbebcac856371ccd782c71
- Tracking: none

## Goals

### GOAL-001 — 작업을 등록하고 다시 확인한다

사용자는 작업 제목을 등록하고 목록에서 확인하며, 새로고침 후에도 저장된 작업을 볼 수 있다.

## Non-goals

- 로그인과 사용자 권한
- 작업 완료 처리·수정·삭제
- 알림·외부 API 연동
- 운영 배포와 운영 데이터

## User flow

1. 사용자가 작업 보드에 접속한다.
2. 작업 제목을 입력하고 등록 버튼을 누른다.
3. frontend가 backend API로 작업을 저장한다.
4. 목록에 새 작업이 표시된다.
5. 페이지를 새로고침하고 저장한 작업을 다시 확인한다.
6. 공백 제목 등록과 backend 연결 실패 시 오류 안내를 확인한다.

## Acceptance criteria

- [AC-001] 등록 버튼을 누르면 실제 backend가 201을 반환하고 새 작업이 화면 목록에 표시된다.
- [AC-002] 페이지 새로고침 및 backend 재시작 후에도 SQLite에 저장한 작업이 유지된다.
- [AC-003] 공백뿐인 제목은 422 오류로 거절되고 화면에 오류가 표시되며 저장되지 않는다.
- [AC-004] backend 연결 실패 또는 계약과 다른 성공 응답을 받으면 실패 안내를 표시하고 성공으로 처리하지 않는다.
- [AC-005] front/back의 모든 선언된 검증 명령과 자체 CI가 실제 최종 merge SHA에서 통과한다.
- [AC-006] 정확한 Candidate merge SHA 조합에서 실제 브라우저 통합 검증과 Root main CI를 통과한다.

## Contracts

- Shared snapshots: `contracts/tasks-api.md` (pilot-front ↔ pilot-back)
- Compatibility/migration: none unless explicitly stated in a contract snapshot

## Order

- Merge order: dependency order recorded in WORK_UNITS.yaml
- Deploy order: decided during Candidate integration
- Activation: none unless added by an approved plan amendment

## Risks

- Concurrent path ownership or contract ambiguity blocks approval readiness.

## Rollback

| Item | Plan |
|---|---|
| Trigger | An acceptance criterion or approved contract cannot be satisfied |
| Owner | Coordinator and affected service owner |
| Kill switch | Defined before deployment when applicable |
| Code recovery | Revert or roll forward from exact merge SHAs |
| Data recovery | Not applicable unless added by an approved plan amendment |
| Verification | Re-run all declared checks and Candidate verification |

## Stop conditions

- A contract, scope, base SHA, dependency, or required verification must change.
- Secret, production, destructive, or undeclared repository access is required.
