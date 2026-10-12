# 직접 테스트하기

이번 변경(작업 마감 화면 + 마감 기능 + 계획이 정하는 제품 E2E)을 손으로 확인하는 순서입니다.
위에서부터 비용이 낮고, 아래로 갈수록 실제에 가깝습니다. 1·2는 네트워크 없이 됩니다.

## 0. 사전 확인

```bash
node -v        # 26.x
uv --version   # 3번에서만 필요
gh auth status # 4번에서만 필요
```

## 1. 자동 검사 (약 1분 30초)

```bash
npm test          # 161개 — 엔진·가드·마감 규칙
npm run test:ui   # 9개  — 화면 회귀 (Playwright)
npm run verify:registry -- --change CHG-TASK-001 --strict
```

셋 다 통과해야 합니다. 특히 볼 만한 테스트:

| 테스트 | 무엇을 막는가 |
|---|---|
| `the change is closed only when the closure PR is merged` | 마감 PR 생성을 마감으로 착각하는 것 |
| `closing refuses an unconfirmed or empty integration environment` | 사람 확인 없이 닫는 것 |
| `a plan that declares no product E2E verifies and publishes without one` | 도구가 E2E를 강제하는 것 |
| `a plan that declares product E2E still blocks until the suite exists` | 선언했는데 그냥 넘어가는 것 |
| `evidence is suggested from passing checks but never pre-confirmed` | 제안을 확인으로 바꿔치기하는 것 |

## 2. 화면 둘러보기 (네트워크 없이)

```bash
npm run test:ui -- --headed   # 브라우저를 띄워 마감 흐름을 눈으로 따라가기
```

`tests-ui/orchestration-ui.test.mjs`의 첫 테스트가 전 구간을 모킹으로 재생합니다:
작업 선택 → 마감 시작 → E2E 막힘 → Agent 위임 → 검증 → 기준 확인 → PR → 병합 → 마감 → 마감 PR 병합.

스크린샷만 보려면:

```bash
npm run test:ui && open test-results/candidate-screen-desktop.png
```

## 3. 제품 E2E 실제로 돌리기 (약 2~3분)

고정된 front/back을 실제로 설치·기동하고 브라우저로 조작합니다.
`e2e/task-board.test.mjs`가 설치·기동·임시 SQLite·종료를 전부 책임집니다.

**서비스가 고정된 workspace에서 돌려야 합니다.** Root의 `services/`는 아직 base SHA(README만)입니다.

```bash
cd .task-packets/candidate-workspaces/run-CHG-TASK-001-candidate-001
npm run test:e2e
```

검사하는 것:

| | 내용 |
|---|---|
| AC-001 | 등록 → 실제 201 → 목록에 표시, 입력 비워짐, 콘솔 오류 없음 |
| AC-002 | 새로고침 **및 backend 재시작** 후에도 유지 (같은 SQLite, 새 프로세스) |
| AC-003 | 공백 제목 → 422 → 화면 오류 → 저장 안 됨 |
| AC-004 | 연결 실패와 **계약 위반 성공 응답** 둘 다 실패로 처리 |

포트 5173·8000을 씁니다(계약이 CORS를 그 origin으로 고정). 선점돼 있으면 먼저 비우세요:

```bash
lsof -nP -iTCP:5173 -sTCP:LISTEN; lsof -nP -iTCP:8000 -sTCP:LISTEN
```

## 4. 마감 화면 실제로 써보기 (gh 인증 필요)

```bash
npm run ui
# 출력된 http://127.0.0.1:4173/#token=... 를 그대로 열고 상단 "작업 마감"
```

확인할 점:

- **입력을 묻지 않는다** — 작업만 고르면 됩니다. Run ID·Candidate 번호·승인 체크박스 없음
- 화면을 열자마자 front/back PR의 병합·CI·merge SHA가 보임
- 4줄 트랙의 모양이 진행 중에 바뀌지 않음
- 전문용어 0개 — Run ID·digest·phase는 맨 아래 **기술 상세** 안에만

진행 중인 실행이 하나 있어 자동 복원됩니다. ②가 막혀 있으면 3번의 E2E를 먼저 돌리세요
(계획이 `npm run test:e2e`를 선언했으므로 필수입니다).

### 마감까지 가려면

마감 버튼은 **Candidate PR이 병합되고 main CI가 통과해야** 열립니다. 즉 실제로 PR을
올리고 병합해야 하므로, 끝까지 가려면 공개 저장소에 실제 변경이 생깁니다. 거기까지 원하지
않으면 2번의 모킹 재생으로 ④줄의 동작을 확인하세요.

## 5. E2E 선언을 빼보기 (설계 확인)

제품 E2E 요구가 도구가 아니라 계획에 있다는 것을 직접 확인하려면:

```bash
# changes/CHG-TASK-001/WORK_UNITS.yaml 의 candidate-integration verify 에서
#   - npm run test:e2e
# 한 줄을 지우고 저장한 뒤 화면을 새로고침
```

②의 막힘 카드가 사라집니다. 되돌리려면 그 줄을 다시 넣으세요.

단, **선언을 빼도 suite가 있으면 실행은 됩니다**. 계획이 정하는 것은 "없을 때 막을지"이고,
있는 suite를 무시하지는 않습니다. 작성해 둔 통합 증거가 조용히 사라지지 않게 하기 위해서입니다.

`CHG-TASK-001`의 커밋된 계획에는 이 선언이 없습니다(선언 규칙 자체가 이번 변경에서 생겼기
때문입니다). 그래도 `e2e/task-board.test.mjs`가 있으므로 검증에서 실행되고 AC-006 증거가 남습니다.

## 알아둘 것

### `e2e/task-board.test.mjs`는 혼자 commit하면 안 됩니다

Root CI(`main` job)가 `test:e2e`를 돌리는데, Root의 `services/`가 아직 base SHA(README만)라
이 suite는 거기서 실패합니다. 지금 Root에서 직접 돌려도 같은 이유로 실패합니다:

```
Error: pilot-front is not checked out at .../services/pilot-front; initialise the pinned submodules first
```

이건 버그가 아니라 설계입니다. 제품 E2E는 **submodule 포인터 이동과 같은 PR에 들어가야**
합니다. 그래서 `e2e/**`가 Candidate 작업 단위의 `write_paths`에 있습니다. 포인터가 merge SHA로
움직이는 순간 서비스 구현이 들어오고 suite가 통과합니다. 3번처럼 workspace에서 돌리세요.

### 나머지

- 아직 **커밋하지 않았습니다**. `ci-workflow-check.mjs`가 브랜치를 선언된 Work Unit에
  매핑하도록 요구하므로, 도구 변경을 올리려면 자체 Change와 브랜치가 먼저 필요합니다.
  제품 E2E는 그와 별개로 Candidate PR에 실립니다.
- `e2e/`에는 제품 suite만 둡니다. 도구 화면 회귀 테스트는 `tests-ui/`로 옮겼습니다.
- 진행 중인 실행의 workspace는 재구성 이전에 clone된 것이라 옛 `e2e/orchestration-ui.test.mjs`가
  남아 있었습니다. 제거해 뒀습니다. 새 실행은 깨끗한 구조로 시작합니다.
