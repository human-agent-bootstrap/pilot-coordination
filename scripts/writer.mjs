#!/usr/bin/env node
import { fail, parseArgs } from './lib.mjs';
import { createWriter } from './writer/core.mjs';

const VERBS = new Set(['start', 'check', 'commit', 'handoff', 'pr', 'finish']);
const USAGE = `사용법: npm run writer -- <verb> --packet <run-id 또는 경로> [옵션]

  start     사전 점검, 브랜치 준비, Agent 지시문 출력
  check     검증 명령과 범위 검사 실행, 증거 기록
  commit    선언된 경로만 커밋하고 검증 재실행
  handoff   기록된 증거로 handoff 블록 생성
  pr        push와 PR 생성 (merge는 하지 않음)
  finish    check → commit → handoff → pr 연속 실행

옵션: --apply(실제 실행) --workspace <경로> --worktree <경로> --message <커밋 제목>
      --agent <도구 이름> --base <대상 브랜치> --allow-failing-checks`;

function line(label, value) {
  process.stdout.write(`${label}: ${value}\n`);
}

function printSteps(steps, applied) {
  for (const step of steps) {
    const command = step.command ? step.command.join(' ') : step.note ?? '';
    const suffix = applied && step.exitCode !== undefined ? ` (exit ${step.exitCode})` : '';
    process.stdout.write(`  ${step.label}: ${command}${suffix}\n`);
  }
}

try {
  const [verb, ...rest] = process.argv.slice(2);
  if (!verb || !VERBS.has(verb)) throw new Error(`${USAGE}`);
  const options = parseArgs(rest);
  if (!options.packet) throw new Error('--packet <run-id 또는 경로>가 필요합니다.');

  const writer = createWriter({ root: process.cwd() });
  const shared = {
    packet: options.packet,
    workspace: options.workspace,
    worktree: options.worktree,
    message: options.message,
    agent: options.agent,
    base: options.base ?? 'main',
    allowFailingChecks: Boolean(options['allow-failing-checks']),
    apply: Boolean(options.apply),
  };

  if (verb === 'start') {
    const result = writer.start(shared);
    line('Change', `${result.packet.change} / ${result.packet.unit}`);
    line('담당자', result.packet.writer);
    line('계획 SHA', result.packet.planSha);
    line('작업 위치', result.workspace);
    line('브랜치', result.packet.branch);
    line('base SHA', result.packet.baseSha);
    line('수정 가능 경로', result.packet.writePaths.join(', '));
    line('검증 명령', result.packet.verify.join(', ') || '없음');
    process.stdout.write(`${result.applied ? '실행한' : '실행할'} 명령:\n`);
    printSteps(result.steps, result.applied);
    process.stdout.write(`\n--- Agent에 위임할 때 붙여넣을 지시문 ---\n${result.prompt}\n--- 직접 작업할 때는 무시하세요 ---\n`);
    process.stdout.write(result.applied
      ? `\nAPPLIED: ${result.statePath}\n다음: npm run writer -- check --packet ${result.packet.run}\n`
      : '\nDRY RUN: --apply를 붙이면 위 명령을 실행하고 진행 상태를 기록합니다.\n');
  }

  if (verb === 'check') {
    const result = writer.check(shared);
    line('Head SHA', result.headSha);
    line('변경 파일', result.changedFiles.length ? result.changedFiles.join(', ') : '없음');
    for (const { command, exitCode, output } of result.commands) {
      line(`검증 ${command}`, `exit ${exitCode}`);
      if (exitCode === 0 || !output) continue;
      for (const detail of output.split('\n').filter(Boolean).slice(-3)) process.stdout.write(`    ${detail}\n`);
      // 127 is the shell's "command not found", which here almost always means uninstalled dependencies.
      if (exitCode === 127) process.stdout.write('    힌트: 작업 저장소에 의존성이 설치되어 있는지 확인하세요 (예: npm ci).\n');
    }
    if (!result.commands.length) line('검증', '선언된 명령이 없습니다');
    line('범위 검사', `exit ${result.scopeCheck.exitCode} · ${result.scopeCheck.output.split('\n').at(-1)}`);
    process.stdout.write(result.passed
      ? `\n통과. 다음: npm run writer -- commit --packet ${result.packet.run} --message "<제목>" --apply\n`
      : '\n실패한 항목이 있습니다. 수정 후 다시 실행하세요.\n');
    if (!result.passed) process.exitCode = 1;
  }

  if (verb === 'commit') {
    const result = writer.commit(shared);
    process.stdout.write(`${result.applied ? '실행한' : '실행할'} 명령:\n`);
    printSteps(result.steps, result.applied);
    if (result.applied) {
      line('\n커밋 후 Head SHA', result.check.headSha);
      line('검증 재실행', result.check.passed ? '통과' : '실패');
      if (!result.check.passed) process.exitCode = 1;
    } else {
      process.stdout.write('\nDRY RUN: --apply를 붙이면 커밋하고 검증을 다시 실행합니다.\n');
    }
  }

  if (verb === 'handoff') {
    const result = writer.handoff(shared);
    process.stdout.write(`${result.text}\n`);
    process.stdout.write(result.applied ? `\nAPPLIED: ${result.path}\n` : '\nDRY RUN: --apply를 붙이면 위 내용을 파일로 저장합니다.\n');
  }

  if (verb === 'pr') {
    const result = writer.pr(shared);
    process.stdout.write(`${result.applied ? '실행한' : '실행할'} 명령:\n`);
    printSteps(result.steps, result.applied);
    if (result.applied) {
      line('\nPR', `#${result.pr.number} ${result.pr.url}`);
      process.stdout.write('리뷰 승인과 merge는 GitHub에서 사람이 합니다.\n');
    } else {
      process.stdout.write(`\n--- PR 본문 미리보기 ---\n${result.body}\n--- 끝 ---\nDRY RUN: --apply를 붙이면 push하고 PR을 만듭니다.\n`);
    }
  }

  if (verb === 'finish') {
    const result = writer.finish(shared);
    line('검증', result.check.passed ? '통과' : '실패');
    if (result.commit) line('커밋', result.commit.applied ? '완료' : 'DRY RUN');
    line('handoff', result.handoff.path);
    line('PR', result.pr.applied ? `#${result.pr.pr.number} ${result.pr.pr.url}` : 'DRY RUN');
  }
} catch (error) {
  fail(error.message);
}
