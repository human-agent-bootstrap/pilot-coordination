# 팀 작업 보드 협업 파일럿

## 실습의 출발점

> 먼저 `CHG-PILOT-SETUP-001` 설정 PR을 독립 리뷰 후 병합합니다. README와 CODEOWNERS만 있는 서비스도 신규 서비스로 인식하도록 하는 수정입니다. 제품 계획 `CHG-TASK-001`은 그 다음 UI에서 작성합니다.

이 Root와 연결된 두 서비스는 **계획 작성부터 직접 테스트할 수 있는 준비 상태**입니다. 서비스에는 README와 CODEOWNERS만 있으며 제품 코드, 승인된 계획, 작업 지시서, 구현 PR, Candidate는 없습니다.

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

## 먼저 사람 리뷰 준비하기

세 저장소의 `main`은 PR과 독립된 사람의 승인 1개를 요구합니다. 관리자도 규칙을 적용받습니다. Agent가 승인하거나 병합하지 않습니다.

초기 CODEOWNERS는 준비 작업을 요청한 계정 `@whdvlf94`입니다. 현재 확인 가능한 조직 멤버도 이 계정뿐입니다. **계획 PR 작성자와 다른 리뷰어에게 저장소 write 권한을 추가해야 실제 병합이 가능합니다.** 자신의 PR을 자신이 승인하거나 보호 규칙을 해제하는 방식으로 실습하지 않습니다.

초기 보호 규칙은 독립 승인 1개를 강제하지만 CODEOWNER 승인까지는 요구하지 않습니다. 소유자 한 명만 있는 초기 상태에서 본인 PR이 영구 차단되는 것을 피하기 위한 구분입니다. CODEOWNERS는 리뷰 요청 경로를 제공합니다. 팀 리뷰어/팀이 확정되면 승인된 Root 설정 작업에서 CODEOWNERS와 required CODEOWNER review를 함께 강화할 수 있습니다. Root의 일반 설정 PR은 현재 계획/작업 단위 CI와 맞지 않으므로 임의 브랜치로 올리지 말고 RUNBOOK의 관리자 설정 경로를 합의합니다.

Root PR에는 `pull-request`, `planning-ui` 검증을 요구합니다. 서비스 CI는 아직 존재하지 않으므로 없는 상태 검사를 요구하거나 통과로 꾸미지 않습니다. 첫 구현 PR에 각 스택의 CI를 만들고, 실제로 실행된 검사 이름을 확인한 뒤 사람이 서비스의 required checks에 추가합니다.

## Change 1: 작업 등록·조회 (`CHG-TASK-001`)

아래는 UI 입력용 **제안**이지 승인된 작업 지시가 아닙니다. 계약·검증·Writer를 확정하고 계획 PR을 병합해야 구현을 시작할 수 있습니다.

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

1. Coordinator: 계약·계획. UI의 계획 PR로 독립 검토·사람 병합.
2. Front Writer: 최소 프로젝트 + 첫 화면 + 테스트 + 자체 CI. 첫 신규 서비스 구현에만 `**` 허용.
3. Back Writer: 최소 프로젝트 + API + SQLite + 테스트 + 자체 CI. 첫 신규 서비스 구현에만 `**` 허용.
4. Coordinator: 서비스 PR 병합 후 Candidate와 통합 검증.

front/back은 승인된 계획만 선행 조건으로 둔다. front가 back 구현 완료를 기다리지 않도록 계약 기반 mock으로 병렬 작업한다. mock 검증과 실제 Candidate 검증은 구분한다.

검증 명령 제안(첫 구현에서 제공해야 하는 요구사항):

- front: `npm test`, `npm run lint`, `npm run typecheck`, `npm run build`.
- back: `python -m pytest`, `python -m ruff check .`.

설치 방법, Python 가상환경과 lockfile을 포함해 실행 환경을 계획에서 합의한다. 두 서비스의 `.gitignore`는 첫 설치 전에 작성하고 실제 생성 경로가 무시되는지 확인한다. 명령이 없거나 실행 불가면 통과가 아니다.

### UI와 사람 승인

```text
목표·범위·완료 기준 입력 → 작업 나누기 → 계약 매핑 → 계획 검토 → 초안 저장
→ 승인 요청 확정 → 계획 PR → 독립 사람 리뷰 → 사람 병합
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

### Candidate

사람의 서비스 PR 병합 후 최종 merge SHA를 Root gitlink와 Candidate에 기록한다. squash 전 PR head를 사용하지 않는다. Root 기록은 Coordinator만 갱신한다.

```bash
npm run verify:registry
npm run verify:prs -- --change CHG-TASK-001
npm run verify:candidate -- --change CHG-TASK-001 --candidate 001 --target-ref origin/main
npm run test:e2e
```

`verify:prs`는 사람/신뢰된 CI의 인증 환경에서 실행한다. 토큰을 Agent나 문서에 전달하지 않는다.

제품 E2E는 아직 없다. Candidate 작업에서 `e2e/*.test.mjs`의 Node test 형식으로 suite를 구현하고 필요하면 Playwright browser API를 사용한다. 실제로 고정된 front/back을 설치·빌드·시작한 뒤 공개 UI를 조작하고 요청·응답·DOM·콘솔 오류를 검증한다. 프로세스 그룹 전체를 finally에서 정리하고 로그에 두 서비스 SHA를 남긴다. HTML fetch와 직접 API 요청만으로는 브라우저 E2E 통과가 아니다.

필요한 제품 E2E CI의 스택 설치/시작 단계와 관련 Root 경로도 계획에 포함하거나 승인된 별도 변경으로 추가한다. 현재 Root CI는 서비스 스택 설치까지 수행하지 않는다.

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
| Change 2에서 write_paths 밖 수정 | 범위 검사 실패 |

첫 Change의 `**`로는 범위 위반 거절을 증명할 수 없다. 두 번째 Change에서 확인한다.

## 이 실습 Root의 설정 차이

- 원본 템플릿의 self-hosted main job 대신 공개 저장소용 GitHub-hosted runner와 read-only 기본 토큰을 사용한다. private 저장소나 기업 runner 정책을 변경한 것이 아니다.
- Actions를 full commit SHA로 고정했다.
- 계획 UI suite는 `npm run test:ui`로 실행하고 제품 `test:e2e`에서 제외했다. 제품 suite가 없으면 명시적 실행은 실패하며 optional 실행은 skipped라고 기록한다. UI 테스트를 제품 증거로 세지 않는다.
- 초기 submodule 등록만 Candidate 없이 허용하는 opt-in CI 설정을 추가했다. 기존 포인터 이동은 여전히 Candidate 없으면 실패한다.
- 이 파일이 공개 실습 환경의 설정 안내이며 원본 RUNBOOK의 기업 네트워크/runner 설명과 구분한다. 실행·권한 계약은 AGENTS.md와 승인된 계획을 따른다.
