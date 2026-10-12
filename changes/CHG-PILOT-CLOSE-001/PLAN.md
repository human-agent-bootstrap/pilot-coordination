# CHG-PILOT-CLOSE-001 — 작업 마감을 한 화면·두 결정으로

## 문제

담당자들이 작업을 끝낸 뒤 마지막 coordinate가 Change를 닫는 단계가 두 번 실패했다.

- **수작업 SHA**: Change 하나당 `gh pr view`로 얻은 40자 SHA를 세 YAML의 약 13개 필드에
  옮겨 적고 서비스마다 submodule을 detach했다. 오타는 검증 명령을 돌릴 때까지 드러나지 않았다.
- **1차 개선**: SHA 입력은 0개가 되었지만 버튼 11회, 자유 입력 2개, 상태값 약 25개,
  digest·fingerprint 개념 8개로 개념 부담이 폭증했다.
- 그리고 **마감 자체가 구현되어 있지 않았다**. 상태 기계는 `pr-created`에서 멈췄고,
  통합 환경 확인을 기록할 자리가 없었으며, `verify-registry`는 `state: complete`를 거부했다.

## 목표

coordinate가 보는 것을 한 화면·네 줄·사람 결정 두 개로 줄이고, 마감을
`changes/<CHANGE-ID>/` 문서가 실제로 닫히는 검증 가능한 행위로 구현한다.
merge SHA 조회·submodule 고정·검증 실행 같은 자동화 엔진은 유지한다.

## 완료 기준

- [AC-001] 마감 화면이 식별자(Run ID·Candidate 번호)를 묻지 않고, 작업을 고르면 병합 결과가 보인다.
- [AC-002] 정상 경로에서 사람이 누르는 버튼은 실행 승인과 증거 확인 두 번이다.
- [AC-003] 12개 실행 phase가 모양이 변하지 않는 네 줄로 표시되고, 1차 표면에 전문용어가 없다.
- [AC-004] 막힌 줄은 상태 이름이 아니라 할 일을 쓰고, 재시도 버튼을 같은 자리에 하나 제공한다.
- [AC-005] 병합·main CI·통합 환경 확인을 모두 만족하면 Change가 `state: complete`로 닫히고
  `verify-registry --strict`가 그 완료를 검증한다.
- [AC-006] 마감 PR 생성과 마감 PR 병합이 구분되며, 병합 전에는 완료로 표시하지 않는다.
- [AC-007] 제품 E2E를 요구할지는 승인된 계획이 정하고, 존재하는 suite는 선언 여부와 무관하게 실행된다.

## 범위 밖

- 서비스 제품 코드와 계약. 이 Change는 Root 도구만 바꾼다.
- `CHG-TASK-001`의 승인된 계획. 병합된 계획은 수정하지 않는다.
- `e2e/task-board.test.mjs`(작업 보드 제품 E2E). submodule 포인터 이동과 같은 PR에 실려야 하므로
  `CHG-TASK-001`의 Candidate에 속한다.

## 검증

`npm test`, `npm run test:ui`, `npm run verify:registry -- --strict`.
