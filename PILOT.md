# 팀 작업 보드 협업 파일럿

## 실습의 출발점

> 먼저 `CHG-PILOT-SETUP-001` 설정 PR의 CI와 병합 여부를 확인합니다. 이미 병합했다면 다시 진행하지 않습니다. 같은 계정으로 작성·확인·병합할 수 있습니다. 그 다음 `CHG-TASK-001` 계획을 작성하거나 기존 계획의 승인·병합 상태를 확인합니다.

이 문서는 서비스 연결을 마친 Root에서 **계획 → Writer 구현 → 작업 마감 → 사람의 완료 확인**까지 실습하는 안내입니다. 초기 서비스는 README만 있는 상태에서 출발합니다. 실제 진행 상태는 `changes/CHG-TASK-001/`의 기록과 GitHub PR·CI에서 확인합니다. 문서의 예시만으로 계획 승인이나 제품 통합 성공을 주장하지 않습니다.

| 저장소 | 역할 | 예정 스택 |
|---|---|---|
| [pilot-coordination](https://github.com/human-agent-bootstrap/pilot-coordination) | 계획·계약·작업 지시서·Candidate | 이 템플릿 |
| [pilot-front](https://github.com/human-agent-bootstrap/pilot-front) | 작업 보드 화면 | React + TypeScript + Vite |
| [pilot-back](https://github.com/human-agent-bootstrap/pilot-back) | API와 저장 | FastAPI + SQLite |

기존 `todo-collab-front`, `todo-collab-back`, 원본 템플릿은 변경하지 않았습니다. 실습은 공개 저장소이고 테스트 데이터만 사용합니다.

## 바로 시작하기

이미 로컬 Root를 준비했다면 해당 디렉터리에서 마지막 두 명령만 실행합니다. `npm run init`이나 서비스 등록을 다시 실행하지 않습니다.

```bash
git clone --recurse-submodules https://github.com/human-agent-bootstrap/pilot-coordination.git
cd pilot-coordination
npm ci --include=dev
npm run verify:registry
npm run ui
```

출력된 `http://127.0.0.1:4173/#token=...` 주소를 그대로 엽니다.

계획은 기본 화면에서, 서비스 PR 병합 이후 통합은 상단 **작업 마감**에서 진행합니다.
Candidate 조회에는 기존 GitHub 토큰 환경 변수를 사용하며, 없으면 로컬 `gh api` 인증을
재사용합니다. 토큰을 추출하거나 UI·Agent에게 전달하지 않습니다. PR 생성에는 `gh`와 Git의
원격 쓰기 인증도 필요합니다. 자세한 인증 안내는 [RUNBOOK.md](./RUNBOOK.md#네트워크와-자격-증명)를 따릅니다.

## 사람 확인과 병합

별도 리뷰어 계정이나 파일 소유자 승인 제도는 사용하지 않습니다. PR 작성자 본인이 계획·diff·CI·실행 증거를 확인한 뒤 병합할 수 있습니다. GitHub APPROVED review를 요구하지 않습니다.

Root는 `pull-request`, `planning-ui` 검증을 필수로 유지합니다. force-push와 main 삭제는 금지하며 관리자를 포함해 보호 규칙을 적용합니다. 서비스는 첫 구현에서 실제 CI를 추가하고, 실행된 검사 이름을 확인한 뒤 required checks로 등록합니다. 없는 서비스 CI나 리뷰 승인을 통과 증거로 꾸미지 않습니다.

Agent의 로컬 구현·검증·handoff 경계는 그대로입니다. 사람의 명시적 요청 없는 Agent 병합·배포는 금지합니다. 이번 설정 변경만 사용자가 직접 병합을 요청했습니다. 제품 계획과 구현은 이 승인에 포함되지 않습니다.

이 실습은 작업 분리·계약·SHA·CI·실제 통합 검증을 확인합니다. 독립 사람 리뷰 통제의 검증은 목표에서 제외합니다.

## Change 1: 작업 등록·조회 (`CHG-TASK-001`)

아래는 실습 계획의 **제안**이지 승인된 작업 지시가 아닙니다. 이미 `changes/CHG-TASK-001/`
계획이 있으면 다시 입력하지 않고 해당 계획·계약·검증 명령을 확인합니다. 계약·검증·Writer를
확정하고 계획 PR을 병합해야 구현을 시작할 수 있습니다.

### 목표와 흐름

사용자가 업무 제목을 등록하면 목록에 표시되고, 새로고침 후에도 남는다.

```text
보드 열기 → 제목 입력 → 등록 → API 저장 → 목록 표시 → 새로고침 → 유지 확인
```

제외 범위: 로그인, 권한, 알림, 외부 API, 운영 배포, 운영 데이터. SQLite 저장과 브라우저 origin CORS는 첫 Change 범위에 포함한다.

### 완료 기준 제안

- [AC-001] 등록 버튼을 통해 실제 backend에 요청하고 `201` 응답과 새 작업의 화면 표시를 확인한다.
- [AC-002] 새로고침 후에도 저장한 작업이 목록에 남는다.
- [AC-003] 공백뿐인 제목은 backend가 `422`로 거절하고, 화면은 오류를 표시하며 저장하지 않는다.
- [AC-004] backend 연결 실패 시 오류가 표시되고 성공으로 오인할 화면을 만들지 않는다.
- [AC-005] 두 서비스의 모든 선언된 검증을 최종 merge SHA에서 통과한다.
- [AC-006] 정확한 Candidate SHA 조합을 실제 브라우저로 검증하고 Root 병합 후 main CI와 합의한 실습 통합 환경의 확인을 통과한다.

### 계약 제안

`GET /api/tasks`는 `200`과 작업 목록, `POST /api/tasks`는 제목 입력에 대해 `201`과 생성한 작업을 반환한다. 작업은 `id`, `title`, `status`를 가지며 초기 상태는 `open`이다.

계획 회의에서 ID 타입, 제목 길이·trim 규칙, 목록 envelope와 순서, 빈 목록, `422` 오류 객체, 허용 frontend origin, content type을 결정한다. 빈 내용을 Agent가 추측하지 않게 완전한 JSON/OpenAPI 계약을 Root에 저장한다. front=consumer, back=provider로 매핑한다.

backend 로컬 계약 복사본, 실제 `/openapi.json`, 런타임 응답을 승인 계약과 비교하고 front에서도 응답 객체와 성공 상태 코드를 런타임에 검증한다. CORS preflight와 실제 교차 origin 요청도 확인한다.

### 작업 나누기

1. Coordinator: 계약·계획. UI의 계획 PR로 내용·CI 확인·사람 병합.
2. Front Writer: 최소 프로젝트 + 첫 화면 + 테스트 + 자체 CI. 첫 신규 서비스 구현에만 `**` 허용.
3. Back Writer: 최소 프로젝트 + API + SQLite + 테스트 + 자체 CI. 첫 신규 서비스 구현에만 `**` 허용.
4. Coordinator: 서비스 PR 병합 후 **작업 마감** UI에서 실행 승인·준비·검증·증거 연결·Root PR 생성. 리뷰·병합과 마지막 완료 판단은 사람.

front/back은 승인된 계획만 선행 조건으로 둔다. front가 back 구현 완료를 기다리지 않도록 계약 기반 mock으로 병렬 작업한다. mock 검증과 실제 Candidate 검증은 구분한다.

검증 명령은 승인된 `WORK_UNITS.yaml`을 따릅니다. 현재 실습 계획에 선언된 서비스 명령은
다음과 같으며, 첫 구현에서 실제로 실행 가능하게 제공해야 합니다.

- front: `npm ci --include=dev`, `npm test`, `npm run lint`, `npm run typecheck`, `npm run build`.
- back: `uv sync --locked --python 3.12`, `uv run --locked pytest`, `uv run --locked ruff check .`.

설치 방법, Python 가상환경과 lockfile을 포함해 실행 환경을 계획에서 합의한다. 두 서비스의 `.gitignore`는 첫 설치 전에 작성하고 실제 생성 경로가 무시되는지 확인한다. 명령이 없거나 실행 불가면 통과가 아니다.

### UI와 사람 승인

```text
목표·범위·완료 기준 입력 → 작업 나누기 → 계약 매핑 → 계획 검토 → 초안 저장
→ 승인 요청 확정 → 계획 PR → 사람이 내용·CI 확인 → 사람 병합
→ 병합 상태 확인 → Work Unit별 새 Run ID로 지시서 발급
```

승인 요청 확정은 사람 승인 자체가 아니다. 지시서 발급도 workspace 생성이나 Agent 실행 자체가 아니다.

### Writer 실행

Root에서 실행한다. packet에는 실제로 발급받은 Run ID를 넣는다. front/back은 다른 packet과 다른 workspace를 사용한다.

```bash
npm run writer -- start --packet <run-id> --worktree ../workspaces/<unit>-001 --apply
# 출력된 지시문과 workspace 경로를 담당 Agent에게 전달하거나 직접 구현
npm run writer -- check --packet <run-id>
npm run writer -- commit --packet <run-id> --message "feat: implement task board slice" --apply
npm run writer -- handoff --packet <run-id> --apply
```

사람이 검증·diff를 다시 확인한 뒤 `npm run writer -- pr --packet <run-id> --apply`를 실행한다. Agent는 push·PR·승인·병합을 하지 않는다. 최종 handoff와 PR에서 Run ID, 계획 SHA, base/head SHA, 실제 명령과 exit code를 확인한다.

### 작업 마감 — UI에서 닫기

계획과 front/back PR을 사람이 확인·병합한 뒤 Coordinator가 진행한다. 계획 입력을 반복하거나
PR 번호·SHA·Run ID를 직접 적을 필요는 없다. UI가 선언된 저장소·브랜치에서 실제 병합 결과를
조회해 **서비스 merge SHA**를 고정한다. squash 전 PR head를 서비스 포인터로 쓰지 않는다.

```text
작업 마감 → ① 결과 모으기 → ② 통합 검증 → ③ 완료 기준 확인 → ④ 마감
```

1. 상단 **작업 마감**을 열고 **마감할 작업**에서 `CHG-TASK-001`을 고른다. 모인 결과가 바로
   나타난다 — front/back PR 번호·병합 여부·CI·merge SHA, 계획 SHA, 바꿀 기록과 고정할 SHA.
   PR 없음, 미병합, 인증·조회 실패, CI 실패는 안내에 따라 해결한 후 진행한다. 같은 브랜치의
   PR이 여러 개면 사람이 고른다.
2. 내용을 확인하고 **이 결과로 마감 시작**을 누른다. 이 한 번이 실행 승인이며 실행값만 확정할 뿐
   목표·계약·범위를 넓히지 않는다. 이어서 ①과 ②가 자동으로 진행된다. UI가
   `.task-packets/candidate-workspaces/<run-id>/`에 별도 Root clone을 만들어 브랜치·서비스 포인터·기록을
   준비하고, Root·서비스 검사와 원격 PR·CI 검사, 제품 E2E와 승인 범위를 검사한다. 기존 Root 작업 파일과
   Writer workspace·Git index는 건드리지 않는다. 실패하면 그 줄에 원인과 **다시 시도**가 나온다.
   이 실습에는 아직 제품 E2E가 없으므로 ②가 막힌다. **Agent에게 E2E 맡기기**를 누르고
   **지시서 복사**·**작업 폴더 경로 복사**로 Agent에게 전달한다. Agent는 승인 원본과 사본·패킷을
   대조하고 `e2e/**`만 작성·로컬 검증한다. 서비스 코드, 계약, Root 기록·포인터를 수정하거나
   원격 검증·push·PR을 수행하지 않는다. Agent 단계에는 UI의 workspace 변경·검증이 잠긴다.
   일반 `npm run writer` 절차로 이 패킷을 실행하지 않는다. 실제 handoff를 받은 뒤
   **Agent 작업 끝났음**을 누르면 검증이 이어진다.
3. ③에서 기준마다 통과한 실제 검사가 근거로 제안된다. 제안이 그 기준을 실제로 입증하는지
   확인하고, 필요하면 **바꾸기**에서 검사와 설명을 고친 뒤 기준마다 확인에 표시하고
   **완료 기준 확인 완료**를 누른다. 이때 정확한 Candidate 검사도 실행된다. 검사로 입증하지 못한
   결과나 병합 이후의 gate를 통과했다고 적지 않는다. 특히 AC-006의 브라우저 검증과 Root 병합 후
   CI·통합 환경 확인은 구분한다. 이어서 **Candidate PR 만들기**를 누르면 승인 경로만 커밋하고
   최종 Root HEAD에서 전체 검사를 다시 실행한 뒤 push·PR을 생성한다.
4. **PR #… 열기**로 diff·CI·증거를 확인하고 사람이 병합한다. UI가 병합과 main CI 상태를 스스로
   조회한다. ④에는 **PR 생성·병합·main CI·통합 환경**이 각각 따로 표시된다. 셋이 통과하면
   UI가 통합 환경에서 무엇을 확인했는지 묻는다. 합의한 실습 통합 환경을 직접 확인하고 내용을 적은 뒤
   **작업 마감**을 누르면 `change/CHG-TASK-001/candidate-closure` 브랜치에 마감 기록을 커밋하고
   마감 PR을 만든다. 여기까지는 아직 마감이 아니다. 이 PR을 사람이 확인·병합해야
   `WORK_UNITS.yaml`의 Change가 `state: complete`, `STATUS.md`가 `COMPLETE`가 되고
   `verify:registry --strict`가 완료를 검증할 수 있다. 병합할 때까지 ④는 대기로 남고 UI가
   마감 PR 상태를 조회한다.
   **PR 생성 ≠ 병합 ≠ main CI 통과 ≠ 통합 환경 확인 ≠ 마감 PR 병합**이며, UI는 사람 확인 없이 작업을 닫지 않는다.

제품 E2E가 없는 경우에는 `e2e/*.test.mjs`의 Node test 형식으로 suite를 작성하고 필요하면
Playwright browser API를 사용한다. 실제로 고정된 front/back을 설치·빌드·시작한 뒤 제품의
공개 UI를 조작하고 요청·응답·DOM·콘솔 오류를 검증한다. E2E가 임시 SQLite 데이터와 환경,
설치·실행·종료를 책임지고 프로세스 그룹 전체를 `finally`에서 정리하며 두 서비스 SHA를
로그에 남긴다. HTML fetch와 직접 API 요청만으로는 브라우저 E2E 통과가 아니다.
`npm run test:ui`가 돌리는 `tests-ui/`의 계획·마감 화면 회귀 테스트는 작업 보드 제품 E2E가 아니다.
`CHG-TASK-001`은 AC-006의 브라우저 통합 검증이 필요하므로 계획의 Candidate 단위가
`npm run test:e2e`를 선언한다. 선언하지 않은 Change는 제품 E2E를 요구하지 않는다.

승인 원본은 `.task-packets/<run-id>.candidate-approval.json`, 진행·검증·마감 기록은
`.task-packets/<run-id>.candidate-state.json`에 남는다. 같은 Root에서 다시 접속하면 진행 중인
마감을 자동으로 복원한다. Run ID·workspace·digest는 화면의 **기술 상세**에서 볼 수 있다.
승인·패킷·workspace는 덮어쓰지 않고 실패한 clone도 보존한다. Root base·계약·선택한 PR·SHA·범위가
바뀌면 기존 증거를 재사용하지 않고 다시 확인·승인한다. 잠금이나 부분 저장 파일의 복구는
[RUNBOOK.md 9장](./RUNBOOK.md#9-작업-마감)을 따른다.

현재 Root CI는 서비스 스택 설치까지 수행하지 않는다. 제품 E2E에 필요한 CI 설치·실행 단계는
승인된 Root 변경으로 따로 추가해야 하며 `e2e/**` 전용 Agent에게 CI 수정을 맡기지 않는다.
터미널 대안과 기존 검증 명령도 [RUNBOOK.md 9장](./RUNBOOK.md#9-작업-마감)에 있다.


## Change 2: 완료 처리 (`CHG-TASK-002`)

첫 Candidate가 병합되고 통합 검증을 통과한 뒤 새 계획을 작성한다. 이전 계획의 base나 Writer workspace를 재사용하지 않는다.

목표: 완료 버튼 → `PATCH /api/tasks/{id}` → `status: done` → 화면 표시 → 새로고침 후 유지.

새 계약에 입력·응답, 존재하지 않는 ID의 `404`, 반복 완료 처리 규칙을 확정한다. 기존 등록·조회 회귀도 검사한다. 구현된 디렉터리 구조에 맞춰 구체적인 write_paths를 선언하고 `**`는 더 이상 사용하지 않는다.

## 실패 주입 테스트

폐기 가능한 별도 workspace에서 수행하며 공유 main이나 다른 Writer의 작업을 훼손하지 않는다.

| 시도 | 기대 결과 |
|---|---|
| 계획 병합 전 packet 발급 | 차단 |
| packet 임의 수정 | 해시 검증 실패 |
| 잘못된 branch 또는 base ancestry | 범위 검사 실패 |
| 필수 검증 실패·실행 불가 | 완료로 보고하지 않음 |
| 검증 이후 head 변경 | 이전 증거로 PR 진행 불가 |
| 계약과 다른 응답 필드 | 계약 테스트/제품 E2E 실패 |
| Candidate에 PR head 또는 증거 누락 | Candidate 검증 실패 |
| 여러 PR이 같은 선언 브랜치와 일치 | 사람이 선택하고 재조회하기 전 실행 승인 불가 |
| Candidate 승인 원본·Agent 사본·패킷 변조 | 승인·범위 또는 handoff 검사 실패 |
| 승인 이후 Root base·선택 PR·SHA 변경 | 기존 실행 승인 만료, 다시 확인·승인 필요 |
| Agent가 `e2e/**` 밖 수정 또는 UI와 동시에 작업 | 범위 검사 실패 또는 UI 작업 차단 |
| 제품 E2E 없음·실패, 완료 기준 증거 미연결 | Candidate UI에서 PR 생성 불가 |
| Candidate 준비 실패 후 재시도 | 기존 Writer 변경·실패 workspace 보존, 변경된 부분 준비 덮어쓰기 금지 |
| Change 2에서 write_paths 밖 수정 | 범위 검사 실패 |

첫 Change의 `**`로는 범위 위반 거절을 증명할 수 없다. 두 번째 Change에서 확인한다.

## 이 실습 Root의 설정 차이

- 원본 템플릿의 self-hosted main job 대신 공개 저장소용 GitHub-hosted runner와 read-only 기본 토큰을 사용한다. private 저장소나 기업 runner 정책을 변경한 것이 아니다.
- Actions를 full commit SHA로 고정했다.
- 계획·Candidate UI suite는 `npm run test:ui`로 실행하고 제품 `test:e2e`에서 제외했다. 제품 suite가 없으면 명시적 실행은 실패하며 기존 CI의 optional 실행은 skipped라고 기록한다. Candidate UI는 제품 E2E를 필수로 실행하고 없음·실패 시 PR 생성을 막는다. UI 테스트나 skipped를 제품 통과 증거로 세지 않는다.
- 초기 submodule 등록만 Candidate 없이 허용하는 opt-in CI 설정을 추가했다. 기존 포인터 이동은 여전히 Candidate 없으면 실패한다.
- 이 파일은 공개 실습 시나리오이고 RUNBOOK은 현재 checkout의 운영 절차다. 기업 네트워크·private 저장소·self-hosted runner를 도입한다면 별도 정책과 설정을 확인한다. 실행·권한 계약은 AGENTS.md와 승인된 계획을 따른다.
