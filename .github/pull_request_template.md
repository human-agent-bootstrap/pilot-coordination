## Change

- Change ID:
- Work Unit ID:
- Run ID:
- Plan SHA:
- Base SHA:
- Head SHA:

## Scope

- Purpose:
- Changed paths:
- Explicit non-goals:

## Dependencies and contract

- Dependency PRs/SHA:
- Contract snapshot:

## Verification evidence

- [ ] Command, target SHA, and exit code recorded below
- [ ] Checks not run are listed below

```text
command | target | exit code
```

## Candidate evidence (Candidate PR only)

Candidate UI가 생성한 본문의 approval digest·최종 Root HEAD·서비스 SHA와 실제 실행 기록을 대조합니다.
Candidate YAML의 커밋 전 증거 연결과 최종 HEAD 재검증 기록은 구분합니다.

- Candidate / approval digest:
- Exact service merge SHAs:
- Final Root HEAD / verification record:
- [ ] Product E2E ran successfully; UI regression tests or skipped checks are not product evidence
- [ ] A human checked the actual results and linked every acceptance criterion
- [ ] No file or SHA changed after final verification
- Remaining post-merge gates: main CI and human integration-environment confirmation

## AI provenance

- Writer/tool/run ID:
- Human changes after agent work:

## Risk and recovery

- Risk:
- Stop/rollback or roll-forward path:

## Checklist

- [ ] Branch includes Change ID and work-unit ID
- [ ] Diff stays within declared write scope
- [ ] No merge, deploy, settings, or secret change is included

## Closure (closure PR only)

- Candidate PR / merge SHA:
- Root main CI result:
- Integration environment checked (what, where):
- [ ] A human observed the integration environment; this is not inferred from main CI
