# 협업 관리 저장소(Coordination Root) 실행 Runbook

> 기준일: 2026-10-06
> 목적: 여러 서비스와 여러 AI 도구가 참여하는 Change를 동일한 계획, 계약, 작업 경계와 증거로 완료한다.

## 1. 핵심 원칙

```text
1 Change = 하나의 사용자 결과
1 Work Unit = 1 Writer = 1 Branch = 1 Workspace
```

- Root는 제품 코드를 소유하지 않는다.
- Root는 계획, 계약, Work Unit, PR/SHA, Candidate와 완료 증거를 관리한다.
- Claude, Codex 등 AI 도구를 통일하지 않고 작업 지시서(Task Packet)와 결과 증거를 통일한다.
- Agent는 로컬 구현, 검증, commit과 handoff까지만 수행한다.
- 사람 또는 CI가 push, PR, 승인, merge, Candidate와 배포를 담당한다.
- Worktree는 필수가 아니다. 다른 Writer와 공유하지 않는 workspace가 필수다.

## 2. 역할

| 역할 | 책임 |
|---|---|
| Coordinator(계획 진행자) | 계획·계약·Work Unit·상태·Candidate 관리 |
| Writer(담당자) | 할당된 서비스와 경로만 구현하고 검증 |
| 사람 확인 | PR 작성자 본인이 계획·diff·CI 결과를 확인할 수 있음 |
| Service Owner(서비스 소유자) | 서비스 PR merge |
| Release Owner(배포 승인자) | Candidate와 staging 결과 승인 |

## 3. 프로젝트 최초 준비

Root는 프로젝트마다 한 번 만들고 서비스도 한 번 등록한다.

> 템플릿으로 Root를 만들고 UI로 서비스를 등록하는 **처음 1회 경로**는 [`README.md`](./README.md)
> Quick Start에 단계별로 있다. 이 장은 같은 작업의 CLI 경로와 운영 규칙을 정리한다.

필수 환경은 Git(submodule 지원), Node.js 22 이상과 npm이다. CI는 Node.js 26을 사용한다.
`init`, `service:add`, `change:create`, `bootstrap`은 기본적으로 dry run이며 `--apply`를
붙였을 때만 파일을 변경한다.

```bash
npm ci
npm run init -- --name <root-name> --org <org> \
  --github-host github.com --apply

npm run service:add -- \
  --repo https://github.com/<org>/<service-repo>.git \
  --stack <detected-stack> \
  --apply

npm run verify:registry
git add .gitmodules services/registry.yaml services/<service-id>
git commit -m "chore: register <service-id>"
```

서비스와 Change가 없는 새 Root에서도 `npm test`, `npm run verify:registry`,
`npm run verify:candidate -- --detect`, `git submodule status`가 정상 종료되어야 한다.
`change:create`는 현재 checkout이 아니라 이 Root commit의 submodule gitlink를
`base_sha`로 사용하므로, 서비스 등록을 먼저 commit해야 한다.
`service:add`는 저장소 이름을 서비스 ID로 사용하고 URL의 조직 또는 사용자를 기본 owner로
기록한다. `--apply`를 빼고 먼저 dry run으로 확인한다. 서비스 등록 시 `--verify`는 생략할 수
있지만, 실행 상태로 전환할 Work Unit에는 검증 명령을 반드시 선언해야 한다.

UI(`npm run ui`)의 **서비스 등록**도 같은 일을 한다. 어느 경로를 쓰든 등록을 commit해야 계획이
작업 시작 기준을 읽을 수 있다. UI의 계획 검토는 Root `HEAD`의 submodule gitlink만 읽으므로
stage 상태로는 실패한다.

설정과 등록 commit은 Root 원격 `main`에 반영돼야 다른 담당자가 clone하고 계획 PR을 만들 수 있다.

### 네트워크와 자격 증명

| 구간 | 주체 | 수행 작업 |
|---|---|---|
| 사내 Wi-Fi | 사람/CI | clone, fetch, push, PR·리뷰·merge, 원격 검증 |
| 외부망 | Writer/Agent | 준비된 commit으로 구현, 로컬 검증·commit·handoff |

- Agent에게 PAT나 `COORDINATION_GITHUB_TOKEN`을 전달하지 않는다.
- 사람의 Git/`gh` 인증에는 회사가 승인한 PAT를 사용한다.
- PR CI는 GitHub-hosted runner에서 secret과 private submodule 없이 PR head를 검사한다.
- `main` push CI만 self-hosted runner에서 private submodule과
  `COORDINATION_GITHUB_TOKEN`을 사용해 원격 PR/Candidate 검증을 다시 수행한다.
- `main`은 직접 push를 금지하고 PR CI를 요구하는 보호 규칙을 적용한다. 별도 리뷰어 승인이나 파일 소유자 승인은 요구하지 않는다. PR 작성자 본인이 검증 후 병합할 수 있다.
  예외는 보호 규칙도 다른 참여자도 아직 없는 **1인 신규 Root의 최초 설정 commit**(초기화와
  서비스 등록)뿐이다. PR CI는 Change와 Work Unit에 연결된 브랜치만 검사하므로
  (`scripts/ci-workflow-check.mjs`) 설정 PR을 그대로 통과시킬 수 없다. 팀 공용 Root에서는
  관리자가 승인한 설정 PR 경로를 사용하고, 보호 규칙을 우회하지 않는다.
- 토큰은 환경 변수나 Actions Secret으로만 제공하고 파일, 작업 지시서, 로그, 명령줄,
  commit에 기록하지 않는다.
- GitHub.com 조직은 `GH_HOST=github.com`을 사용한다. 별도 GitHub Enterprise Server를
  사용하는 경우에만 `init`의 host/API 값을 변경한다.

### 신규 서비스

아직 레포가 없다면 Planning 전에 다음만 준비한다.

```text
원격 레포 생성
→ README.md 최소 최초 commit
→ main push
→ Root에 service:add
```

최초 commit은 `base_sha`를 만들기 위한 anchor다. 프로젝트 구조나 CI를 미리 만들 필요는 없다.

신규 서비스의 최초 기능 Work Unit만 전체 경로를 허용한다.

```yaml
write_paths:
  - "**"
```

조건:

- 단일 Writer가 담당한다.
- 프로젝트 최소 구조, CI, 테스트와 첫 기능을 함께 구현한다.
- 최초 PR merge 이후 모든 Work Unit은 구체적인 경로를 사용한다.
- 별도 bootstrap Work Unit은 만들지 않는다.

## 4. Change Planning

Coordinator가 Change를 생성한다.

### 로컬 회의형 UI 사용

CLI와 Markdown 직접 편집 대신 로컬 UI에서 회의를 진행할 수 있다.

```bash
npm run ui
# http://127.0.0.1:4173/#token=<세션 토큰>
```

명령이 출력한 주소를 그대로 연다. 주소 fragment의 토큰은 계획 PR 생성에만 쓰이고 서버
세션이 끝나면 무효가 된다.

UI에서 목표, 비목표, 성공 기준, 참여 서비스, 작업 단위, 담당자, 수정 범위, 의존성과
계약을 순서대로 작성한다. 저장 전에는 생성 파일과 strict registry 검증 결과를 확인한다.
저장하면 `changes/<CHANGE-ID>/` 전체 산출물이 생성되지만, 이는 계획 승인을 의미하지 않는다.

`WORK_UNITS.yaml`이 `state: draft`인 Change가 하나 있으면 해당 Change를 현재 활성 초안으로
간주하고 서버 시작 시 모든 입력 단계를 복원한다. 신규 UI 초안은 `DRAFT.json`을 손실 없는
편집 원본으로 사용하며, 기존 초안은 `PLAN.md`, `WORK_UNITS.yaml`, 계약 파일에서 복원한다.
활성 초안은 같은 Change ID로 갱신하고 UI가 관리하지 않는 파일은 보존한다. draft Change가
둘 이상이면 임의 선택하지 않고 서버/API 검증을 실패시킨다.
Planning PR의 계획과 CI 결과를 사람이 확인하고 병합해야 한다. 작성자 본인이 확인해도 된다.

저장 이후 검토 단계는 세 단계로 이어진다.

1. **승인 요청으로 확정** — `WORK_UNITS.yaml` 최상단을 `state: approved`로, 검증 명령을 선언한
   구현 Work Unit을 `state: ready`로 다시 쓴다. `PLAN.md`와 `STATUS.md`의 상태 문구도 함께
   바뀐다. 이 값은 반드시 Planning PR 내용에 포함되어야 한다. bootstrap과 UI 발급은 작업
   디렉터리가 아니라 **plan SHA 시점의 manifest**를 읽으므로, 병합 후에 값을 채우면 그 SHA로는
   발급할 수 없다. 검증 명령이 없는 구현 Work Unit이 있으면 전환이 차단된다.
2. **계획 PR 올리기** — `change/<CHANGE-ID>/coordination` 브랜치를 `origin/main`에서 만들고
   `changes/<CHANGE-ID>/` 경로만 커밋해 push한 뒤 `gh`로 PR을 연다. PR 번호는 같은 브랜치에서
   `PRS.yaml`에 기록한다.
3. **병합 상태 확인** — 사람이 GitHub에서 리뷰·병합한 뒤 이 버튼으로 머지 커밋 SHA를 가져온다.

그 SHA로 **작업 지시서 만들기**에서 Work Unit별 `.task-packets/<run-id>.md`를 생성한다. SHA가
`main` 또는 `origin/main`에서 확인되고 Work Unit의 상태, 담당자와 의존성이 유효해야 한다.

UI는 merge, force push, `main` 직접 push, submodule 포인터 변경, workspace 생성, Agent 실행,
Candidate 조립을 수행하지 않는다. 리뷰와 병합은 GitHub에서 사람이 한다.

```bash
npm run change:create -- \
  --change CHG-<NAME>-001 \
  --services <service-a>,<service-b> \
  --apply
```

다음을 확정한다.

- 사용자 목표와 비목표
- 검증 가능한 Acceptance Criteria
- 서비스 간 API·인증·이벤트 계약
- Work Unit별 Writer, branch와 `write_paths`
- `depends_on`
- 서비스별 검증 명령
- 사람 병합 담당자와 merge 이후 staging 검증 방법

서비스 Work Unit 예시:

```yaml
- id: chat-service-implementation
  repo: chat-service
  state: ready
  goal: 인증된 사용자의 질문을 받아 응답을 반환한다.
  writer: d
  branch: feat/CHG-CHAT-001/chat-service-implementation
  base_sha: <full-service-commit-sha>
  write_paths:
    - src/chat/**
    - src/llm/**
    - src/auth/**
    - tests/**
  depends_on:
    - contract-and-plan
  verify:
    - npm test
    - npm run lint
```

`base_sha`는 Planning이 생성하는 commit이 아니다. Change 생성 시 Root의 서비스 submodule이
가리키던 기존 서비스 commit이다. 신규 서비스라면 최소 anchor commit이 첫 `base_sha`다.
로컬 submodule checkout이 Root gitlink와 다르면 `change:create`는 실패한다.

승인 전에는 활성 Work Unit의 경로 충돌도 검사한다.

```bash
npm run verify:registry -- --change CHG-<NAME>-001 --strict
```

기본 실행은 겹치는 `write_paths`를 warning으로 보고하고, `--strict`는 이를 실패로 처리한다.
같은 서비스의 경로가 겹치는 작업은 하나로 합치거나 `depends_on`으로 순서를 정한다.
`state: merged` 또는 `state: aborted`인 Work Unit은 활성 경로 예약에서 제외된다.

`ready`/`in_progress` Work Unit의 의존성은 `merged` 상태여야 한다. 유일한 예외는
planning unit(`contract-and-plan`)이다. planning unit은 자기 자신의 PR로 merge되므로
merge 전에 작성되는 manifest가 이를 `merged`로 기록할 수 없고, 대신 bootstrap의
plan SHA 검증(`origin/main` 도달 가능성)이 planning merge를 증명한다. 따라서 구현
Work Unit은 Planning PR 안에서 바로 `state: ready`로 승인할 수 있다.

Change 자체의 상태도 Planning PR 안에서 `state: approved`로 올린다. bootstrap은
`approved` 또는 `active` manifest만 받는다. UI를 쓰면 승인 확정 단계가 이 값을 기록하고,
CLI로 계획을 작성했다면 `WORK_UNITS.yaml` 최상단을 직접 고쳐 PR에 포함한다.

Planning PR의 내용과 CI를 사람이 확인해 merge하고 merge SHA를 기록한다. 다른 리뷰어 계정은 필요하지 않다.

```bash
GH_HOST=github.com gh pr view <planning-pr-number> \
  --json mergeCommit --jq .mergeCommit.oid
```

구현은 Planning PR merge 전에는 시작하지 않는다.

## 5. Writer 사전 준비

> 작업 지시서를 받은 Writer가 구현부터 PR까지 진행하는 방법은 [`WRITER.md`](./WRITER.md)에 정리돼 있다.
> 직접 작업하는 경우와 Agent에 위임하는 경우를 모두 다룬다.

### Root가 아직 없는 경우

기존 서비스 clone은 그대로 사용하고 Root만 추가로 clone한다.

```bash
git clone --no-recurse-submodules <root-url> <root-path>
git -C <root-path> fetch origin
git -C <root-path> switch --detach <planning-merge-sha>
npm --prefix <root-path> ci

git -C <existing-service-repo> fetch origin
git -C <existing-service-repo> cat-file -e <base-sha>^{commit}
```

마지막 명령은 `base_sha`가 로컬에 존재하는지 확인한다. 성공 시 출력 없이 exit code `0`을
반환한다.

### Workspace 선택

다음 중 하나를 사용할 수 있다.

1. 기존 clean checkout
2. Git worktree
3. 별도 clone
4. Agent 하네스가 만든 격리 workspace

기존 checkout을 사용하는 경우:

```bash
git -C <service-repo> switch -c \
  feat/CHG-<NAME>-001/<work-unit> \
  <base-sha>
```

기존 작업이 있거나 여러 Change·Agent를 병렬 실행하는 경우:

```bash
git -C <service-repo> worktree add \
  -b feat/CHG-<NAME>-001/<work-unit> \
  <workspace-path> \
  <base-sha>
```

Agent 하네스가 workspace를 자동 생성하면 해당 기능을 사용한다. 어떤 방식을 사용하든 다음을
만족해야 한다.

- Work Unit 전용 branch
- 다른 Writer와 공유하지 않는 workspace와 Git index
- `HEAD`가 `base_sha`와 같거나 그 후손
- 시작 시 관련 없는 로컬 변경 없음
- 실제 작업 경로를 `workflow-check --repo-path`에 전달할 수 있음

Branch에는 Agent, 모델 또는 vendor 이름을 넣지 않는다. 실행 provenance는 작업 지시서,
handoff와 commit trailer에 기록한다.

## 6. 작업 지시서 생성과 AI 지시

Writer의 Root clone에서 작업 지시서를 생성한다.

```bash
npm --prefix <root-path> run bootstrap -- \
  --plan-sha <planning-merge-sha> \
  --change CHG-<NAME>-001 \
  --unit <work-unit> \
  --writer <writer> \
  --run <run-id> \
  --apply
```

`bootstrap`은 작업 지시서만 생성한다. branch나 workspace는 만들지 않는다.
작업 지시서에는 plan SHA, Work Unit, `base_sha`, `write_paths`, 계약 snapshot과 SHA-256,
검증 명령, manifest SHA-256과 packet SHA-256이 들어간다. 분산된 Writer는 같은 plan SHA에서
작업 지시서를 다시 생성하고 hash가 일치하는지 확인할 수 있다.

AI 도구에는 다음과 같이 지시한다.

```text
Root의 AGENTS.md와 .task-packets/<run-id>.md를 읽으세요.
승인된 plan SHA를 기준으로 지정된 Work Unit만 수행하세요.
write_paths 밖을 수정하거나 계약의 빈 내용을 추측하지 마세요.
범위 확대 또는 계약 결정이 필요하면 멈추고 보고하세요.
모든 검증 명령을 실행하고 실제 exit code를 기록하세요.
push, PR 생성, merge는 하지 마세요.
완료하면 표준 handoff를 작성하세요.
```

workspace를 어떻게 넘기고 Agent의 보고를 어떻게 확인하는지는 [`WRITER.md`](./WRITER.md) 4장에
있다.

## 7. 구현, 검증과 로컬 Handoff

> Writer 시점의 단계별 안내는 [`WRITER.md`](./WRITER.md) 5장을 참고한다.

Writer 또는 Agent는 할당된 workspace에서 구현하고 Work Unit의 검증 명령을 실행한다.

Root의 범위 검증도 실행한다.

반드시 Root clone을 현재 디렉터리로 두고 실행한다.

```bash
(cd <root-path> && node scripts/workflow-check.mjs \
  --plan-sha <planning-merge-sha> \
  --change CHG-<NAME>-001 \
  --unit <work-unit> \
  --repo-path <service-workspace>)
```

검증 완료 후 Work Unit branch에 로컬 commit을 만들고 최종 commit에서 검증을 다시 실행한다.

```bash
git -C <service-workspace> add <declared-paths>
git -C <service-workspace> commit
git -C <service-workspace> rev-parse HEAD
```

Commit은 Conventional Commit 형식을 사용하고 다음 trailer를 남긴다.

```text
Change-ID: <CHANGE-ID>
Work-Unit: <work-unit>
Agent-Run-ID: <run-id>
```

Handoff:

```text
Change ID:
Work Unit ID:
Run ID:
Repository:
Branch:
Base SHA:
Head SHA:
Plan SHA:
Changed files:
Commands and exit codes:
Checks not run:
Contract deviations:
Known risks:
Next action:
```

필수 검증을 실행하지 못했거나 계약 이탈이 있으면 완료로 보고하지 않는다.

## 8. Push, PR과 Merge

사내 Wi-Fi에서 사람 Writer 또는 Service Owner가 handoff와 로컬 SHA를 확인한다.
PR 생성 시 `.github/pull_request_template.md`를 작성하고 미실행 검증도 숨기지 않는다.

```bash
git -C <service-workspace> status
git -C <service-workspace> rev-parse HEAD
git -C <service-workspace> push -u origin <work-unit-branch>
```

이후 순서:

```text
PR 생성
→ CI
→ 사람이 내용·CI 확인 (작성자 본인 가능)
→ Service Owner merge
→ merge SHA 확인
```

Squash merge에서는 PR head SHA와 merge SHA가 다르다. Candidate에는 merge SHA를 사용한다.

```bash
GH_HOST=github.com gh pr view <pr-number> --repo <org>/<repo> \
  --json mergeCommit --jq .mergeCommit.oid
```

Writer가 Coordinator에게 전달할 최종 증거:

```text
PR 번호
Base SHA
PR head SHA
Merge SHA
CI 결과
사람 확인 기록 (PR 본문 또는 체크리스트)
계약 이탈과 미실행 검증
```

Coordinator는 `PRS.yaml`과 `STATUS.md`에 이 증거를 기록한다. `verify:prs`는 기록된
모든 PR이 merge된 상태를 전제로 하므로 일부 PR만 merge된 시점에는 실행하지 않고,
Candidate 단계(9장)에서 한 번 실행한다.

## 9. Candidate 조립과 통합 검증

모든 서비스 PR이 merge되면 Coordinator가 각 submodule을 정확한 merge SHA로 맞추고
Candidate를 작성한다.

Candidate는 registry 전체가 아니라 이번 Change에 필요한 서비스 부분집합만 포함할 수 있다.

```yaml
services:
  - repo: web-client
    base_sha: <frontend-base-sha>
    sha: <frontend-merge-sha>
    source_prs: [frontend-chat-client]

  - repo: chat-service
    base_sha: <chat-base-sha>
    sha: <chat-merge-sha>
    source_prs: [chat-service-implementation]
```

검증:

```bash
npm run verify:registry
npm run verify:prs -- --change CHG-<NAME>-001
npm run verify:candidate -- \
  --change CHG-<NAME>-001 \
  --target-ref origin/main
# e2e/*.test.mjs가 있는 경우
npm run test:e2e
```

`verify:prs`는 GitHub API 네트워크와 `COORDINATION_GITHUB_TOKEN`이 필요하다. Agent의
외부망 로컬 단계에서는 실행하지 않는다. Root의 `origin`은 HTTPS와
`git@<host>:<org>/<repo>.git` 형식을 모두 지원한다.

Candidate PR은 candidate 파일과 함께 `WORK_UNITS.yaml`도 갱신한다. 자신의
`candidate-integration` unit에 실제 base SHA(planning merge SHA 또는 그 후손)를 기록하고,
merge된 구현 Work Unit을 `state: merged`로 표시한다. 이 경로들은 candidate-integration의
`write_paths`에 선언되어 있다.

통합 환경과 검증 가능한 시나리오가 있는 경우 Candidate PR에서 `e2e/` suite를 추가하고
`npm run test:e2e`를 실행한다. 명시적으로 실행한 `test:e2e`는 테스트가 0개면 실패하지만,
자동 Candidate 게이트는 suite가 없으면 `skipped`로 기록하며 이를 통과 증거로 취급하지 않는다.
`e2e/**`는 선택적으로 추가할 수 있도록 candidate-integration의 `write_paths`에 포함된다.
`verify:candidate --target-ref`는 target pointer, ancestry, 원격 도달성, squash merge
commit 범위와 모든 `AC-*`의 증거를 검사한다. 다만 증거 설명이 실제 Acceptance Criteria를
충분히 만족하는지는 사람이 검토한다.

앞선 Candidate가 같은 서비스의 Root pointer를 먼저 변경했다면 현재 Candidate의
`base_sha`가 stale해질 수 있다. 앞선 Candidate가 Root `main`에 merge된 뒤 현재 Candidate를
rebase하고, 새 target을 기준으로 전체 검증과 필요한 승인을 다시 수행한다.

Candidate PR은 필수 검증 3종과, 가능한 경우 E2E를 실행한 뒤 사람이 내용과 증거를 확인해 병합한다. 구현 Writer와 같은 사람이 확인할 수 있다.
PR CI는 의도적으로 secret을 받지 않으므로 GitHub API 검증을 대신하지 않는다. Candidate PR
merge 후에는 신뢰된 `main` 코드가 self-hosted CI에서 PR/SHA와 Candidate를 다시 검증하고,
E2E suite가 있으면 함께 실행한다. 적용 가능한 staging 검증까지 통과해야 완료다.
`STATUS.md`에는 planning SHA, 서비스별 merge SHA, CI와 실행한 E2E 증거, 다음 gate를 기록한다.
Candidate PR 자신의 merge SHA만 기록하기 위한 별도 Closure PR은 만들지 않는다.

## 10. 변경 중단과 재승인

다음 상황에서는 구현을 멈추고 Coordinator에게 보고한다.

- `write_paths` 밖의 수정 필요
- 승인된 계약으로 구현 불가능
- API·인증·이벤트 형식을 추측해야 함
- `base_sha`, dependency SHA 또는 plan SHA 변경
- secret, 운영 권한 또는 파괴적 작업 필요
- 필수 검증 실행 불가

계약, 범위, base SHA 또는 필수 검증이 바뀌면 영향받는 Work Unit의 기존 승인은 무효다.
Coordinator가 Root 변경을 승인받고 새 plan SHA로 작업 지시서를 다시 생성한다.

## 11. 완료 기준

다음 항목이 모두 충족되어야 `STATUS.md`를 COMPLETE로 변경한다.

- Planning PR의 내용·CI 확인 및 사람 merge
- 모든 Writer가 승인된 plan SHA와 base SHA를 사용
- 모든 변경이 선언된 `write_paths` 안에 있음
- 모든 서비스 PR이 CI를 통과하고 사람이 내용·증거를 확인
- `PRS.yaml`과 실제 GitHub SHA가 일치
- Candidate가 PR head SHA가 아닌 merge SHA를 사용
- 모든 Acceptance Criteria에 실행 또는 리뷰 증거가 있음
- Candidate 검증과 Root Candidate PR 승인 완료
- Root `main` CI와 staging 통합 테스트 통과
- 필수 미실행 검증이나 계약 이탈이 남아 있지 않음

최종 흐름:

```text
서비스 사전 등록과 anchor SHA 준비
→ Change Planning 및 계약 승인
→ 작업 지시서 발급
→ Writer별 독립 workspace에서 병렬 구현
→ 로컬 검증·commit·handoff
→ 사람이 push·PR·review·merge
→ Coordinator가 merge SHA 기록
→ exact-SHA Candidate 검증
→ Candidate merge와 staging 검증
→ STATUS.md COMPLETE
```

## 12. 명령 레퍼런스

| 명령 | 용도 |
|---|---|
| `npm run init` | 템플릿을 프로젝트 값으로 초기화 |
| `npm run ui` | 로컬 계획 UI (서비스 등록·계획 작성·계획 PR·작업 지시서 발급) |
| `npm run service:add` | 서비스 등록과 submodule 추가 |
| `npm run change:create` | 승인 전 Change skeleton 생성 |
| `npm run bootstrap` | 승인된 Work Unit의 작업 지시서 생성 |
| `npm run writer` | 작업 지시서 기반 준비·검증·커밋·PR (Writer용) |
| `npm run workflow:check` | Root PR의 Work Unit 범위 검사 |
| `node scripts/workflow-check.mjs ...` | 서비스 workspace의 branch·base·경로 검사 |
| `npm run verify:registry` | registry, submodule, manifest와 경로 예약 검사 |
| `npm run verify:prs` | 기록된 PR의 병합 상태와 SHA를 GitHub와 대조 |
| `npm run verify:candidate` | exact-SHA Candidate와 Acceptance Criteria 증거 검사 |
| `npm test` | Root 도구 테스트 |
| `npm run test:e2e` | Root의 cross-repository E2E 실행 |

`verify:candidate -- --detect`는 현재 checkout과 일치하는 Candidate를 찾는 로컬 편의
기능이다. 승인 게이트에서는 Change와 `--target-ref`를 명시한다.
