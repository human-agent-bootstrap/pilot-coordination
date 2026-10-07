# pilot-coordination

> **팀 작업 보드 실습:** 서비스 연결은 완료되어 있습니다. [PILOT.md](./PILOT.md)의 시나리오와 시작 명령을 따르세요. 초기화·서비스 등록을 다시 실행하지 않습니다. 제품 구현과 계획 승인은 아직 시작하지 않았습니다.

여러 서비스 저장소에 걸친 작업을 하나의 **계획**으로 관리하는 협업 템플릿입니다. 본인의 **협업 관리 저장소(Root)** 를 만들고, 로컬 UI에서 서비스 저장소를 submodule로 연결합니다.

Root는 제품 코드를 갖지 않습니다. 계획, 서비스 간 계약, 작업 담당자, PR 기록과 검증할 서비스 버전 조합만 관리하므로 서비스 저장소는 독립적으로 유지됩니다. 서비스 저장소를 미리 clone하거나 `.gitmodules`와 YAML을 직접 작성할 필요는 없습니다.

```text
Root 만들기 → clone·초기화 → UI 실행 → 서비스 등록 → 등록 commit·push
→ 계획 작성·저장 → 계획 PR 리뷰·병합 → 담당자별 작업 지시서 발급
```

## 나에게 맞는 시작점

| 내 상황 | 읽을 곳 |
|---|---|
| 협업 관리 저장소를 처음 구성한다 | [Quick Start](#quick-start) 0단계부터 |
| 이미 초기화된 Root에 담당자로 참여한다 | [팀원으로 참여하기](#팀원으로-참여하기) |
| 어떤 도구인지 먼저 체험해보고 싶다 | Quick Start를 그대로 따라가되, 0단계의 **실습용 서비스 저장소 만들기**를 사용 |

## Quick Start

목표는 **본인 서비스를 연결하고 첫 계획을 저장한 뒤, 담당자에게 줄 작업 지시서를 발급하는 것**입니다.

### 0. 준비물 확인하기

| 준비물 | 확인 명령 | 필요한 시점 |
|---|---|---|
| Git | `git --version` | 지금 |
| Node.js 22 이상, npm | `node --version` / `npm --version` | 지금 |
| GitHub CLI 인증 | `gh auth status --hostname github.com` | 5단계(계획 PR)부터 |

- Git 작성자 이름·이메일이 설정돼 있어야 로컬 commit을 만들 수 있습니다.
- 연결할 서비스 저장소마다 **읽기 권한**과 **최초 commit 하나**가 필요합니다. 이후 구현 PR을 올리는 담당자는 쓰기 권한도 필요합니다.
- 비밀번호나 토큰을 저장소 URL, 문서, 작업 지시서에 넣지 마세요.

**실습용 서비스 저장소 만들기(선택).** 체험이 목적이라면 빈 저장소 두 개를 만들어 쓰고, 실제 프로젝트에 적용한다면 이 블록을 건너뛰고 기존 저장소를 사용하세요.

```bash
gh repo create <내-계정>/demo-api --private --add-readme
gh repo create <내-계정>/demo-web --private --add-readme
```

`--add-readme`가 만드는 최초 commit이 작업 시작 기준이 됩니다. 실습을 끝낸 뒤에는 `gh repo delete`로 정리하세요.

### 1. 템플릿으로 내 Root 만들기

[GitHub 템플릿](https://github.com/human-agent-bootstrap/coordination-root-template)에서 **Use this template → Create a new repository**를 선택합니다.

- 소유자: 본인 계정 또는 권한이 있는 조직
- 이름: 예를 들어 `my-coordination`
- 공개 범위: 팀 정책에 맞게 선택

**확인:** 본인이 소유한 새 Root 저장소가 생깁니다. 원본 템플릿과 서비스 저장소는 그대로 유지됩니다.

### 2. clone하고 초기화하기

`<내-계정>`, `<내-Root>`, `<내-깃허브-아이디>`만 본인 값으로 바꿔 실행합니다. 서비스 저장소는 따로 clone하지 않습니다.

```bash
git clone https://github.com/<내-계정>/<내-Root>.git
cd <내-Root>
npm ci

npm run init -- --name "$(basename "$PWD")" --org <내-계정> --apply

npm test && npm run verify:registry
git add -A && git commit -m "chore: initialize coordination root"
git push origin main
npm run ui
```

`init`은 프로젝트 이름·GitHub 설정을 채우고 템플릿 자체의 계획 기록을 정리합니다. **이 초기화는 Root를 만든 사람이 한 번만 실행합니다.**

**확인:** 검증 명령이 모두 성공하고 `http://127.0.0.1:4173/#token=...` 형식의 주소가 출력됩니다. 이 주소를 **그대로** 브라우저에서 엽니다. 주소의 토큰은 실행 중인 세션에서만 유효하고, 터미널을 닫으면 UI도 종료됩니다.

> **`main`에 직접 push하는 범위:** 위 push는 **본인이 방금 만든 Root의 초기 설정**에만 해당합니다. 보호 규칙이 있는 팀 공용 Root라면 관리자가 정한 경로를 따르세요. 설정 변경은 현재 PR CI가 요구하는 계획·작업 단위 브랜치 형식과 맞지 않습니다([RUNBOOK.md](./RUNBOOK.md) 3장).

### 3. UI에서 서비스 저장소 연결하기

1. **목표 정하기**에서 계획 ID(예: `CHG-DEMO-001`), 계획 제목, 계획 진행자, 목표를 입력하고 **다음**을 누릅니다.
2. **범위와 완료 기준**에서 **서비스 등록**을 누릅니다.
3. 서비스마다 반복합니다: GitHub URL 입력 → **등록 전 확인** → 기술 스택 확인(감지되지 않으면 직접 입력) → **서비스 등록**.

```text
https://github.com/<내-계정>/demo-api.git
https://github.com/<내-계정>/demo-web.git
```

UI가 submodule을 추가하고 서비스 코드를 내려받으며 `.gitmodules`와 `services/registry.yaml`을 갱신합니다. 저장소 이름이 서비스 ID가 됩니다. 터미널을 선호하면 `npm run service:add -- --repo <url> --apply`로도 등록할 수 있습니다.

**확인:** UI 서비스 목록에 본인 저장소가 보이고 Root 아래에 다음 구조가 생깁니다.

```text
<내-Root>/
├── services/
│   ├── registry.yaml
│   ├── demo-api/
│   └── demo-web/
├── changes/
└── .gitmodules
```

### 4. 등록 내용을 commit·push하기

계획의 작업 시작 기준은 **commit된 submodule 포인터**에서 읽습니다. 등록을 commit하기 전에는 계획 검토가 실패합니다.

UI를 실행한 터미널은 그대로 두고, 다른 터미널에서 같은 Root 디렉터리로 이동해 실행합니다.

```bash
git add .gitmodules services
git commit -m "chore: register service repositories"
git push origin main
```

**확인:** `git ls-tree HEAD services/`에 등록한 서비스가 `160000 commit`으로 보입니다. UI로 돌아가 **서비스 목록 새로고침**을 누릅니다.

### 5. 계획을 저장하고 작업 지시서 발급하기

| UI 단계 | 작성할 내용 |
|---|---|
| 목표 정하기 | 계획 ID·제목, 계획 진행자, 목표와 기대 결과 |
| 범위와 완료 기준 | 참여 서비스, 제외 범위, 확인 가능한 완료 기준 |
| 작업 나누기 | 목표에 연결된 서비스별 작업, 담당자 한 명, 수정 범위 |
| 서비스 간 계약 | 서비스가 함께 지킬 요청·응답·데이터 형식 |
| 검토하고 저장하기 | 오류와 생성 파일 확인 후 초안 저장 |

작은 기능 하나로 시작하세요. 작성할 때 세 가지만 주의합니다.

- 작업마다 **검증 명령**(테스트·lint·build)을 직접 입력해야 승인 요청으로 확정할 수 있습니다. UI는 기본값을 채우지 않습니다.
- 수정 범위는 정확한 파일 또는 `폴더/**`로 지정합니다. 기본 파일만 있는 신규 서비스의 첫 작업만 전체 범위 `**`를 사용합니다.
- 계약은 참여 서비스를 두 개 이상 선택해, 각 서비스를 구현할 담당자가 같은 계약을 읽도록 연결합니다.

**계획 검토하기**로 오류를 해결하고 **계획 초안 저장**을 누른 뒤, 화면에 이어지는 순서대로 진행합니다.

1. **승인 요청으로 확정** — 작업 상태를 계획 PR에 담습니다. 이후에는 UI에서 이 계획을 편집하지 않습니다.
2. **계획 PR 올리기** — `changes/<계획 ID>/`만 담은 계획 PR을 만듭니다.
3. GitHub에서 계획·계약·범위·검증 방법과 CI 결과를 확인하고 **사람이 병합**합니다. PR 작성자 본인이 병합해도 되며 별도 승인 계정은 필요하지 않습니다.
4. **병합 상태 확인** — 병합된 계획 commit SHA를 가져옵니다.
5. **작업 지시서 만들기** — 실행 가능한 작업을 확인하고 Run ID를 정해 발급합니다. 화면의 기본 Run ID를 그대로 사용해도 됩니다.

**확인:** `.task-packets/<Run ID>.md`가 생성되고 내용과 해시가 표시됩니다. **지시서 내려받기**로 담당자에게 전달합니다.

승인 요청으로 확정하는 것은 사람의 승인·병합을 대신하지 않고, 지시서 발급만으로 workspace가 생성되거나 Agent가 실행되지도 않습니다.

## 팀원으로 참여하기

초기화와 서비스 등록이 이미 원격 Root에 반영돼 있다면 다음만 실행합니다.

```bash
git clone --recurse-submodules https://github.com/<계정>/<Root>.git
cd <Root>
npm ci
npm run ui
```

- `npm run init`은 다시 실행하지 않습니다.
- 서비스는 최신 브랜치가 아니라 **Root가 지정한 버전**으로 내려옵니다. 각 서비스 저장소의 읽기 권한이 필요합니다.
- Root만 clone해서 서비스 폴더가 비어 있으면 `git submodule update --init --recursive`를 실행합니다.
- 작업 지시서를 이미 받았다면 [WRITER.md](./WRITER.md)로 바로 이동하세요.

## 담당자(Writer)는 어디서 시작하나요

```text
지시서 확인 → 전용 workspace 준비 → 직접 구현 또는 Agent 위임
→ 검증 → 로컬 commit·handoff → 사람이 서비스 PR 리뷰·병합
```

[WRITER.md](./WRITER.md)의 빠른 경로를 따릅니다. Agent는 로컬 구현·검증·commit·handoff까지만 수행하고, push·PR·승인·병합은 사람이 합니다. 서비스 PR이 모두 병합되면 계획 진행자가 실제 merge SHA를 모아 Candidate와 통합 검증을 진행합니다.

**지시서 발급 완료 ≠ 담당자 작업 완료 ≠ 계획 완료**입니다. 완료 기준은 [RUNBOOK.md](./RUNBOOK.md)를 따릅니다.

## 막혔을 때

| 증상 | 확인할 내용 |
|---|---|
| 서비스 등록 실패 | 설정한 GitHub 호스트의 HTTPS URL인지, 읽기 권한과 최초 commit이 있는지 |
| 기술 스택이 감지되지 않음 | UI에 직접 입력. 감지 결과가 검증 명령까지 정해주지는 않음 |
| 서비스는 보이는데 계획 검토가 실패함 | 4단계의 등록 commit 여부, **서비스 목록 새로고침** |
| 승인 요청 확정이 막힘 | 작업별 검증 명령, 담당자, 수정 범위, 계약 매핑, 선행 작업 |
| 계획 PR 생성이 막힘 | 현재 브랜치, `gh` 인증, 출력된 세션 주소 사용 여부 |
| 작업 지시서 발급이 막힘 | 해당 계획의 실제 병합 SHA인지, 승인 상태·담당자·의존성이 맞는지 |
| 같은 Run ID로 다시 발급되지 않음 | 기존 파일은 덮어쓰지 않음. 새 실행이면 새 Run ID를 사용 |

## 다음 문서

| 문서 | 용도 |
|---|---|
| [WRITER.md](./WRITER.md) | 작업 지시서를 받은 담당자의 실행 안내 |
| [RUNBOOK.md](./RUNBOOK.md) | 전체 운영 절차와 명령 레퍼런스 |
| [AGENTS.md](./AGENTS.md) | 사람과 Agent가 지키는 실행 계약 |

`RUNBOOK.md`와 `AGENTS.md`는 `WORK_UNITS.yaml`의 필드 이름과 맞추기 위해 원문 용어를 씁니다. **계획 = Change, 작업 = Work Unit, 담당자 = Writer**입니다.

`CLAUDE.md`는 Claude Code가 `AGENTS.md`를 찾도록 연결하는 파일이며 별도 규칙을 담지 않습니다.

## 알아둘 경계

- UI가 하는 일: 서비스 등록, 계획 작성·검토·저장, 계획 PR 생성·병합 확인, 작업 지시서 발급.
- UI가 하지 않는 일: 리뷰·병합, 담당자 workspace 준비와 Agent 실행, 서비스 PR 관리, Candidate 조립과 배포.
- 하나의 작업은 한 담당자, 한 브랜치, 독립 workspace를 사용합니다. 서비스 저장소는 자체 CI와 소유자를 유지하며, 서비스 등록은 서비스의 코드나 workflow를 수정하지 않습니다.
- 검증·운영 규칙의 기준은 [RUNBOOK.md](./RUNBOOK.md)와 [AGENTS.md](./AGENTS.md)입니다.
