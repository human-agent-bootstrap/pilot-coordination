# WRITER.md — 작업 지시서로 일하는 방법

작업 지시서(Task Packet)를 받은 담당자(Writer)가 읽는 문서입니다. 지시서를 받은 순간부터 서비스 PR이
병합될 때까지를 다룹니다.

| 문서 | 역할 |
|---|---|
| [`AGENTS.md`](./AGENTS.md) | Agent와 Writer가 지키는 실행 계약. 규칙의 기준 |
| [`RUNBOOK.md`](./RUNBOOK.md) | 전체 운영 절차와 명령 레퍼런스 |
| [`README.md`](./README.md) | Root 구성과 계획 작성까지의 시작 안내 |
| 이 문서 | 작업 지시서 하나를 끝내는 실행 안내 |

작업 방식은 두 가지입니다. **직접 작업(방식 A)** 과 **Agent에 위임(방식 B)**. 1–2장은 공통이고,
3장(직접)과 4장(위임)으로 갈라졌다가, 5장에서 같은 결과물(검증된 로컬 commit과 handoff)로 다시
만납니다. 이후 6장부터는 다시 공통입니다.

## 빠른 경로

작업 지시서 이름만 넣으면 아래 명령이 각 장의 절차를 대신 실행합니다. 나머지 값(계획 SHA, 브랜치,
base SHA, 수정 경로, 검증 명령)은 작업 지시서에서 읽습니다.

```bash
npm run writer -- start   --packet <run-id> --apply   # 1–2장: 점검, 브랜치 준비, 지시문 출력
#   ... 구현 (방식 A: 직접 / 방식 B: 출력된 지시문을 Agent에 전달)
npm run writer -- check   --packet <run-id>           # 5장: 검증 실행과 증거 기록
npm run writer -- commit  --packet <run-id> --message "feat: ..." --apply
npm run writer -- handoff --packet <run-id> --apply   # 5장: handoff 블록 생성
npm run writer -- pr      --packet <run-id> --apply   # 6장: push와 PR 생성
```

`--apply` 없이 실행하면 무엇을 할지만 보여 줍니다. `finish`는 check → commit → handoff → pr을
한 번에 실행합니다. 이 명령들이 하는 일을 이해하려면 아래 각 장을 읽으세요. **구현, 리뷰, merge,
그리고 7장의 Root 기록 파일은 자동화하지 않습니다.**

---

## 1. 작업 지시서 읽기

> 명령: `npm run writer -- start --packet <run-id>` (`--apply` 없이 실행하면 이 장의 점검만 수행합니다)


```text
# TASK      무엇을 어느 계획(plan SHA)에서 하는지
# SCOPE     저장소, 브랜치 이름, base SHA, 수정해도 되는 경로
# CONTRACT  고정된 계약 스냅샷과 그 해시. 수정 금지
# VERIFY    반드시 실행하고 exit code를 기록할 명령
# HANDOFF   끝낼 때 제출할 보고 형식
# STOP WHEN 멈추고 사람에게 돌려야 하는 조건
```

이 값들은 제안이 아니라 승인된 경계입니다. 브랜치 이름, base SHA, 경로 중 하나라도 작업 지시서와
다르면 5장의 범위 검사에서 실패합니다.

시작 전에 세 가지를 확인합니다.

```bash
# 1) plan SHA가 승인·병합된 계획인지
git -C <root> fetch origin
git -C <root> merge-base --is-ancestor <plan-sha> origin/main

# 2) base SHA가 로컬에 있는지 (성공하면 출력 없이 exit 0)
git -C <service-repo> fetch origin
git -C <service-repo> cat-file -e <base-sha>^{commit}

# 3) 작업 지시서가 그 계획에서 나온 것인지
npm --prefix <root> run bootstrap -- --plan-sha <plan-sha> --change <CHANGE-ID> \
  --unit <work-unit> --writer <writer> --run <run-id>
```

Root clone이 아직 없으면 `RUNBOOK.md` §5의 `--no-recurse-submodules` clone + 계획 SHA로 detach 방식을
씁니다. README 「팀원으로 참여하기」의 `--recurse-submodules` clone은 UI로 계획을 함께 보려는 경우입니다.

3번은 `--apply`가 없는 dry run이라 파일을 만들지 않고 `Packet SHA-256`을 출력합니다. 받은 작업 지시서
마지막 줄과 같으면 같은 계획·같은 입력에서 나온 작업 지시서입니다. 두 가지를 알아두세요.

- `Packet SHA-256`은 **Run ID까지 포함**해 계산합니다. Run ID가 다르면 같은 계획이라도 값이
  다릅니다. 계획이 같은지만 보려면 작업 지시서 안의 `Manifest SHA-256`을 비교하세요. 이 값은 plan
  SHA와 Change에만 의존합니다.
- 같은 경로에 작업 지시서 파일이 이미 있으면 dry run도 `task packet already exists`로 실패합니다.
  받은 파일을 잠시 다른 곳으로 옮기고 실행하세요.

## 2. Workspace 준비 (공통)

> 명령: `npm run writer -- start --packet <run-id> --apply`. worktree를 쓰려면 `--worktree <경로>`


하나의 Work Unit은 하나의 브랜치와, 다른 Writer와 공유하지 않는 workspace를 씁니다. 기존
clean checkout, worktree, 별도 clone, Agent 하네스의 격리 workspace 중 무엇이든 괜찮습니다
(선택 기준은 `RUNBOOK.md` §5).

```bash
# 기존 checkout을 쓰는 경우
git -C <service-repo> switch -c <작업 지시서의 Required branch> <작업 지시서의 Base SHA>

# 병렬 작업이거나 로컬 변경이 남아 있는 경우
git -C <service-repo> worktree add -b <Required branch> <workspace-path> <Base SHA>
```

관련 없는 로컬 변경이 섞여 있으면 다른 workspace를 쓰거나 멈춥니다. 다른 사람의 작업을
stash·reset·삭제하지 않습니다.

---

## 3. 방식 A — 직접 작업

1. `# SCOPE`의 허용 경로 안에서만 수정합니다. 근처에 고치고 싶은 것이 보여도 범위를 넓히지
   말고, 새 Work Unit을 요청하세요.
2. 계약이 필요한 부분은 `# CONTRACT`의 스냅샷만 근거로 씁니다. 다른 서비스의 소스를 읽고
   인터페이스를 추측하지 않습니다. 계약이 없거나 모호하면 멈춥니다.
3. `# VERIFY`의 명령을 모두 실행하고 실제 exit code를 적어 둡니다. 실행하지 못한 검증은
   통과가 아니라 `Checks not run`입니다.

그다음 5장으로 갑니다.

## 4. 방식 B — Agent에 위임

> 명령: `start`가 출력한 지시문을 그대로 전달하고, 끝나면 `npm run writer -- check --packet <run-id>`


도구는 무엇이든 상관없습니다. 통일하는 것은 도구가 아니라 작업 지시서와 증거입니다.

**4.1 Writer가 먼저 할 일**

- workspace를 **Writer가 만들어** 경로로 넘깁니다. Agent가 브랜치를 옮기거나 stash·reset
  하도록 두지 마세요. 이 방식에서 사고가 나는 지점은 대부분 여기입니다.
- Agent에게 PAT나 `COORDINATION_GITHUB_TOKEN`을 주지 않습니다. Agent는 push·PR·merge를
  하지 않으므로 자격 증명이 필요 없습니다 (`RUNBOOK.md` §3).
- 작업 지시서 파일과 Root clone 경로를 알려 줍니다.

**4.2 지시문**

```text
<root>/AGENTS.md와 <root>/.task-packets/<run-id>.md를 읽으세요.
작업 위치는 <workspace-path>이고, 이미 올바른 브랜치와 base SHA로 준비돼 있습니다.
작업 지시서에 적힌 Work Unit만 수행하세요.
write_paths 밖을 수정하거나 계약의 빈 내용을 추측하지 마세요.
범위 확대 또는 계약 결정이 필요하면 멈추고 보고하세요.
모든 검증 명령을 실행하고 실제 exit code를 기록하세요.
push, PR 생성, merge는 하지 마세요.
완료하면 AGENTS.md의 표준 handoff 형식으로 보고하세요.
```

**4.3 Agent가 끝낸 뒤 Writer가 할 일**

Agent의 handoff에 적힌 숫자를 그대로 믿지 않습니다. 같은 명령을 Writer가 직접 다시 실행해
exit code를 확인합니다 — 방식 B에서 Writer가 추가로 지는 책임은 이것이 전부입니다.

```bash
cd <workspace-path> && <작업 지시서의 VERIFY 명령>          # exit code 직접 확인
(cd <root> && node scripts/workflow-check.mjs ...)   # 5장 참고
git -C <workspace-path> diff --stat <base-sha>...HEAD
```

Agent가 `# STOP WHEN` 조건으로 멈췄다면 범위를 넓혀 주지 말고 Coordinator에게 돌립니다.
계약·범위·base SHA가 바뀌면 기존 승인이 무효가 되고, 새 plan SHA로 작업 지시서를 다시 받습니다
(`RUNBOOK.md` §10).

PR을 올릴 때 템플릿의 `## AI provenance` 칸에 사용한 도구와 Run ID, 그리고 Agent 작업 이후
사람이 고친 부분을 적습니다.

---

## 5. 검증과 handoff (공통)

> 명령: `npm run writer -- check --packet <run-id>` → `commit --message "..." --apply` → `handoff --apply`


Root clone을 현재 디렉터리로 두고 범위 검사를 실행합니다.

```bash
(cd <root> && node scripts/workflow-check.mjs \
  --plan-sha <plan-sha> \
  --change <CHANGE-ID> \
  --unit <work-unit> \
  --repo-path <workspace-path>)
```

이 검사가 막아 주는 것:

- 브랜치 이름이 작업 지시서의 `Required branch`와 다른 경우
- HEAD가 `base_sha`이거나 그 후손이 아닌 경우
- `write_paths` 밖의 변경. **commit된 것뿐 아니라 staged·unstaged·untracked 파일까지** 봅니다.
  작업 중 만든 임시 파일이나 로그를 지우지 않으면 여기서 실패합니다.

통과하면 commit합니다. Conventional Commit 제목에 trailer 세 줄을 붙입니다.

```text
Change-ID: <CHANGE-ID>
Work-Unit: <work-unit>
Agent-Run-ID: <run-id>
```

최종 commit에서 `# VERIFY` 명령과 범위 검사를 한 번 더 실행합니다. 증거는 그 정확한 Head SHA에
속합니다. 그리고 `AGENTS.md` §6의 handoff 블록을 채웁니다. 필수 검증을 실행하지 못했거나 계약
이탈이 있으면 완료로 보고하지 않습니다.

## 6. push → PR → 리뷰 → merge

> 명령: `npm run writer -- pr --packet <run-id> --apply`. 리뷰와 merge는 사람이 GitHub에서 합니다.


여기부터는 네트워크와 사람이 필요합니다.

```bash
git -C <workspace-path> push -u origin <Required branch>
```

PR을 열고 `.github/pull_request_template.md`를 채웁니다. 실행하지 못한 검증도 숨기지 않습니다.
이후 CI → **Writer가 아닌 리뷰어** 승인 → Service Owner merge 순서입니다 (`RUNBOOK.md` §8).

squash merge면 PR head SHA와 merge SHA가 다릅니다. 이후 단계에서 쓰는 값은 **merge SHA**입니다.

```bash
GH_HOST=<host> gh pr view <pr-number> --repo <org>/<repo> --json mergeCommit --jq .mergeCommit.oid
```

Coordinator에게 넘길 최종 증거: PR 번호, base SHA, PR head SHA, merge SHA, CI 결과, 리뷰어
승인, 계약 이탈과 미실행 검증.

---

## 7. Writer가 기록하는 것과 기록하지 않는 것

가장 자주 나오는 질문입니다. **Writer는 Root의 기록 파일을 직접 고치지 않습니다.**

| 파일 | 소유 | Writer가 하는 일 |
|---|---|---|
| `changes/<ID>/WORK_UNITS.yaml` | Coordinator (`candidate-integration` unit) | 읽기만 합니다. 자기 Work Unit이 `ready`인지 확인. 병합 후 `state: merged` 기록은 Coordinator |
| `changes/<ID>/PRS.yaml` | Coordinator | 고치지 않습니다. PR 번호와 SHA를 handoff로 전달 |
| `changes/<ID>/STATUS.md` | Coordinator | 고치지 않습니다. CI·리뷰·미실행 검증을 handoff로 전달 |
| 서비스 저장소의 `write_paths` | **Writer** | 유일하게 쓰는 범위 |

근거는 계획 자체에 있습니다. 구현 Work Unit의 `write_paths`에는 서비스 경로만 들어 있고, Root
기록 파일은 `candidate-integration`의 `write_paths`에만 선언돼 있습니다. 작업 지시서의
`Do not modify the Root coordination files or another repository.`도 같은 말이고,
`workflow-check`가 이를 기계적으로 막습니다.

### Writer와 Coordinator가 같은 사람일 때

작은 팀에서는 흔합니다. 역할은 겸해도 **PR은 겹치지 않게 분리**합니다. 서비스 PR을 먼저
병합하고, Root 기록은 모든 서비스 PR이 병합된 뒤 Candidate PR 하나에서 한 번에 합니다
(`RUNBOOK.md` §9). 그때 채우는 값:

```yaml
# WORK_UNITS.yaml / PRS.yaml
plan_merge_sha: <planning merge SHA>

# WORK_UNITS.yaml
#   병합된 구현 Work Unit → state: merged
#   candidate-integration → base_sha를 실제 값으로

# PRS.yaml (각 PR 행)
number / head_sha / merge_sha / state: merged

# releases/candidate-001.yaml
sha: <서비스 merge SHA>
```

그다음 `npm run verify:prs`와 `npm run verify:candidate`로 기록과 실제 GitHub 상태를 대조하고,
Candidate PR은 구현한 사람과 **독립된 사람**이 승인합니다. 역할을 겸할 때 포기할 수 없는 선이
여기입니다 — 기록을 먼저 쓰고 나중에 맞추는 것이 아니라, 병합된 사실을 그대로 옮겨 적습니다.

## 8. 멈춰야 하는 상황

다음 중 하나라도 해당하면 작업을 멈추고 Coordinator에게 보고합니다. 추측해서 진행하지 않습니다.

- `write_paths` 밖을 고쳐야 한다
- 승인된 계약으로는 구현할 수 없거나, 계약이 비어 있다
- API·인증·이벤트 형식을 추측해야 한다
- `base_sha`, 의존 SHA, plan SHA가 바뀌었다
- secret, 운영 권한, 파괴적 작업이 필요하다
- 필수 검증을 실행할 수 없다

이 경우 영향받는 Work Unit의 승인은 무효입니다. Coordinator가 계획을 고쳐 다시 승인받고, 새
plan SHA로 작업 지시서를 재발급합니다 (`AGENTS.md` §8, `RUNBOOK.md` §10).
