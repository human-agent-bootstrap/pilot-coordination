# pilot-coordination — 끝까지 돌려본 사례

> **이 저장소는 교보재입니다.** 실제 Change 하나(`CHG-TASK-001`)를 계획부터 마감까지 돌린
> 기록이 그대로 남아 있습니다. 여기서 도구를 **읽고 따라해 보고**, 본인 Root는
> [템플릿](https://github.com/human-agent-bootstrap/coordination-root-template)으로 만드세요.

여러 서비스 저장소에 걸친 작업을 하나의 **계획**으로 관리합니다. Root는 제품 코드를 갖지 않고
계획, 서비스 간 계약, 작업 담당자, PR 기록과 검증할 서비스 버전 조합만 관리하므로 서비스
저장소는 독립적으로 유지됩니다.

```text
계획 작성·저장 → 계획 PR 리뷰·병합 → 담당자별 작업 지시서 발급
→ 서비스 구현·PR 병합 → 작업 마감 → Root PR·main CI·통합 환경 확인 → 닫힘
```

## 여기서 볼 수 있는 것

`CHG-TASK-001`(팀 작업 보드 — 작업 등록과 조회)의 실물입니다. 설명이 아니라 실제로 일어난 기록입니다.

| 보고 싶은 것 | 어디에 |
|---|---|
| 승인된 계획과 작업 분할 | [`changes/CHG-TASK-001/WORK_UNITS.yaml`](./changes/CHG-TASK-001/WORK_UNITS.yaml) |
| 서비스 간 계약 | [`changes/CHG-TASK-001/contracts/tasks-api.md`](./changes/CHG-TASK-001/contracts/tasks-api.md) |
| 고정된 서비스 조합과 완료 기준별 증거 | [`changes/CHG-TASK-001/releases/candidate-002.yaml`](./changes/CHG-TASK-001/releases/candidate-002.yaml) |
| 마감 기록 (merge SHA·main CI·사람의 통합 환경 확인) | 같은 파일의 `closure:` 블록 |
| 최종 상태 | [`changes/CHG-TASK-001/STATUS.md`](./changes/CHG-TASK-001/STATUS.md) — `COMPLETE` |

실제 PR도 그대로 있습니다: 계획 [#3](https://github.com/human-agent-bootstrap/pilot-coordination/pull/3) →
서비스 구현([front#3](https://github.com/human-agent-bootstrap/pilot-front/pull/3),
[back#3](https://github.com/human-agent-bootstrap/pilot-back/pull/3)) →
Candidate [#5](https://github.com/human-agent-bootstrap/pilot-coordination/pull/5) →
마감 [#7](https://github.com/human-agent-bootstrap/pilot-coordination/pull/7).

## 직접 따라해보기

[PILOT.md](./PILOT.md)가 이 Change를 처음부터 재현하는 시나리오입니다. 화면을 먼저 보고 싶다면:

```bash
git clone --recurse-submodules https://github.com/human-agent-bootstrap/pilot-coordination.git
cd pilot-coordination && npm ci
npm run ui    # 출력된 http://127.0.0.1:4173/#token=... 를 그대로 열기
```

상단 **작업 마감**이 통합·마감 화면입니다. 이 저장소의 Change는 이미 닫혀 있으므로 조회만 됩니다.

## 내 Root 만들기

[coordination-root-template](https://github.com/human-agent-bootstrap/coordination-root-template)에서
**Use this template**으로 새 저장소를 만들고, 그쪽 README의 Quick Start를 따르세요.
**이 저장소에서 `npm run init`을 실행하지 마세요** — 이미 초기화된 인스턴스라 실패합니다.

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

[WRITER.md](./WRITER.md)의 빠른 경로를 따릅니다. Agent는 로컬 구현·검증·commit·handoff까지만 수행하고, push·PR·승인·병합은 사람이 합니다. 서비스 PR이 모두 병합되면 계획 진행자가 아래 작업 마감 화면에서 실제 병합 결과를 불러옵니다.

**지시서 발급 완료 ≠ 담당자 작업 완료 ≠ 계획 완료**입니다. 완료 기준은 [RUNBOOK.md](./RUNBOOK.md)를 따릅니다.

## 작업 마감하기

계획과 서비스 PR이 병합되면 `npm run ui`가 출력한 세션 주소를 열고 상단 **작업 마감**을
누릅니다. 계획을 다시 입력하거나 PR 번호·SHA·Run ID를 직접 적지 않습니다. 화면은 네 줄로
고정되어 있고, 사람이 결정하는 지점은 두 곳입니다.

1. **마감할 작업**을 고르면 모인 결과가 바로 보입니다 — 저장소별 PR 번호·병합 여부·CI·merge SHA와
   바꿀 기록. 확인한 뒤 **이 결과로 마감 시작**을 누르면 준비와 검증이 자동으로 이어집니다.
   막히는 항목은 그 줄에 무엇을 해야 하는지로 표시되고, 실패에는 **다시 시도**가 하나 생깁니다.
   제품 E2E가 없으면 **Agent에게 E2E 맡기기**로 지시서와 작업 폴더 경로를 전달하고,
   실제 handoff를 받은 뒤 **Agent 작업 끝났음**을 누릅니다.
2. 완료 기준마다 통과한 검사가 근거로 제안됩니다. 실제로 입증하는지 확인하고 기준마다 표시한 뒤
   **완료 기준 확인 완료**, 이어서 **Candidate PR 만들기**를 누릅니다. 리뷰·병합은 사람이 하고,
   병합과 main CI 상태는 화면이 스스로 조회합니다.
3. **PR 생성·병합·main CI·통합 환경**이 각각 따로 표시됩니다. 셋이 통과하면 통합 환경에서 확인한
   내용을 적고 **작업 마감**을 누릅니다. 마감 기록이 별도 브랜치에 커밋되고 마감 PR이 만들어집니다.
   **여기까지는 아직 마감이 아닙니다** — 이 PR을 사람이 병합해야 `STATUS.md`가 `COMPLETE`,
   Change가 `state: complete`가 되고 ④가 완료로 바뀝니다.

제품 E2E를 **요구할지**는 승인된 계획이 정하고(Candidate 작업의 `verify:`에 `npm run test:e2e`),
**실행**은 suite가 있으면 언제나 합니다. 선언하지 않아도 작성해 둔 suite는 돌려서 증거로 남깁니다. 선언한 제품 E2E의 없음·실패, 필수 검사 미실행,
증거 누락 또는 검증 후 변경은 PR 생성 통과 조건이 아닙니다.
`test:ui`(`tests-ui/`)는 도구 화면 회귀 테스트이지 제품 E2E가 아닙니다. PR 생성·병합·main CI·통합 환경 확인은
별개이며 UI는 사람 확인 없이 작업을 닫지 않습니다. 승인 원본과 실행·마감 기록은 `.task-packets/`에
보존하고, 재접속하면 진행 중인 마감을 자동으로 복원합니다. Run ID·workspace·digest 같은 내부 값은
화면의 **기술 상세**에 있습니다.
자세한 운영·복구·CLI 대안은 [RUNBOOK.md 9장](./RUNBOOK.md#9-작업-마감)을,
작업 보드 실습은 [PILOT.md](./PILOT.md#작업-마감--ui에서-닫기)를 따르세요.

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
| 모인 결과가 비었거나 막힘으로 표시됨 | 원격 읽기 인증·선언 브랜치·실제 PR 병합·merge SHA의 CI. 여러 PR은 화면에서 선택 |
| 새 계획 저장 시 write-path 겹침 에러 | 같은 저장소를 쓰는 진행 중(비종료) 작업이 있는지. 메시지의 괄호가 각 작업이 선언한 경로입니다. 상대가 `**`면 무엇을 적어도 겹치므로 그 Change를 먼저 끝내거나 다른 저장소를 쓰세요 |
| 마감 실행 승인이 만료됨 | Root base·계약·PR·SHA·범위 변경 확인. 작업을 다시 고르고 승인하며 기존 증거 재사용 금지 |
| 통합 검증·PR 생성이 막힘 | 제품 E2E, 선언된 필수 검사, 기준별 증거, 검증 후 변경과 Agent handoff 확인 여부 |
| 실행·저장 잠금이 남음 | 이전 프로세스·Agent 종료 여부를 먼저 확인. RUNBOOK 9장의 복구 절차를 따르고 workspace·기록 보존 |
| **작업 마감**이 눌리지 않음 | PR 병합과 main CI 통과 여부, 통합 환경에서 확인한 내용을 적고 확인에 표시했는지 |

## 다음 문서

| 문서 | 용도 |
|---|---|
| [PILOT.md](./PILOT.md) | 이 사례를 처음부터 재현하는 실습 시나리오 |
| [WRITER.md](./WRITER.md) | 작업 지시서를 받은 담당자의 실행 안내 |
| [RUNBOOK.md](./RUNBOOK.md) | 전체 운영 절차와 명령 레퍼런스 |
| [AGENTS.md](./AGENTS.md) | 사람과 Agent가 지키는 실행 계약 |

`RUNBOOK.md`와 `AGENTS.md`는 `WORK_UNITS.yaml`의 필드 이름과 맞추기 위해 원문 용어를 씁니다. **계획 = Change, 작업 = Work Unit, 담당자 = Writer**입니다.

`CLAUDE.md`는 Claude Code가 `AGENTS.md`를 찾도록 연결하는 파일이며 별도 규칙을 담지 않습니다.

## 알아둘 경계

- UI가 하는 일: 서비스 등록, 계획 작성·검토·저장, 계획 PR 생성·병합 확인, 작업 지시서 발급,
  승인된 Change의 Candidate 준비·Agent E2E 지시서·검증·증거 연결·Candidate PR 생성과,
  사람이 확인한 통합 환경을 받아 작업을 닫는 마감 기록·마감 PR 생성.
  상단 **작업 마감**에서 시작합니다. 리뷰·병합·통합 환경 확인 자체는 사람이 합니다.
- UI가 하지 않는 일: 리뷰·병합, 서비스 Writer workspace 준비, Agent 자동 실행, 서비스 PR 생성·병합과 운영 배포.
- 하나의 작업은 한 담당자, 한 브랜치, 독립 workspace를 사용합니다. 서비스 저장소는 자체 CI와 소유자를 유지하며, 서비스 등록은 서비스의 코드나 workflow를 수정하지 않습니다.
- 검증·운영 규칙의 기준은 [RUNBOOK.md](./RUNBOOK.md)와 [AGENTS.md](./AGENTS.md)입니다.
