# Status — CHG-PILOT-CLOSE-001

**State:** APPROVED

## Scope

작업 마감 화면을 한 화면·네 줄·사람 결정 두 개로 재설계하고, 구현되어 있지 않던 마감을
검증 가능한 상태 전이로 구현한다. 제품 E2E 요구 여부를 승인된 계획이 정하게 한다.
Root 도구만 바꾸며 서비스 코드·계약·다른 Change의 승인된 계획은 건드리지 않는다.

## Work units

| Work unit | Repository | State | Gate |
|---|---|---|---|
| `close-flow` | Root | in_progress | 사람이 diff·CI를 확인하고 병합 |

## Evidence boundary

- Root base SHA: `9cf22f9d0d2f33b32a4e32bc44a92262de6a39a9`
- 서비스 저장소와 submodule 포인터는 변경하지 않는다.
- 제품 통합 주장은 이 Change에 없다. 작업 보드의 제품 E2E 증거는 `CHG-TASK-001`에 속한다.

## Next gate

사람이 PR의 diff와 CI를 확인하고 병합한다. 병합 후 `CHG-TASK-001`을 새 Candidate 실행으로
다시 진행하면 고쳐진 `verify-candidate`·`verify-prs`가 workspace에 들어간다.
