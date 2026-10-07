import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { defaultRun, validatePlanSha, verifyCommandsFor } from '../lib.mjs';
import { assertMatchesPlan, readPacket } from './packet.mjs';

const WORKFLOW_CHECK = fileURLToPath(new URL('../workflow-check.mjs', import.meta.url));

function trailerBlock(packet) {
  return [
    `Change-ID: ${packet.change}`,
    `Work-Unit: ${packet.unit}`,
    `Agent-Run-ID: ${packet.run}`,
  ].join('\n');
}

function agentPrompt(packet, workspace) {
  return [
    `${packet.path.replace(/.*\/(?=\.task-packets)/, '')}와 Root의 AGENTS.md, WRITER.md를 읽으세요.`,
    `작업 위치는 ${workspace}이고, 브랜치 ${packet.branch}와 base SHA ${packet.baseSha}로 이미 준비돼 있습니다.`,
    `Work Unit ${packet.unit}만 수행하세요.`,
    `수정 가능한 경로는 ${packet.writePaths.join(', ')}입니다. 이 밖을 수정하지 마세요.`,
    '계약의 빈 내용을 추측하지 마세요. 범위 확대나 계약 결정이 필요하면 멈추고 보고하세요.',
    `검증 명령(${packet.verify.join(', ') || '없음'})을 실행하고 실제 exit code를 기록하세요.`,
    'push, PR 생성, merge는 하지 마세요. 브랜치를 옮기거나 stash·reset 하지 마세요.',
    '완료하면 AGENTS.md의 표준 handoff 형식으로 보고하세요.',
  ].join('\n');
}

export function createWriter({ root, run = defaultRun }) {
  const rootPath = resolve(root);
  const git = (args, cwd = rootPath) => run('git', args, { cwd });
  const ok = (result) => result.status === 0;

  function statePath(runId) {
    return join(rootPath, '.task-packets', `${runId}.state.json`);
  }

  function readState(runId) {
    const path = statePath(runId);
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      throw new Error(`진행 상태 파일을 읽을 수 없습니다: ${path}`);
    }
  }

  function writeState(runId, state) {
    const path = statePath(runId);
    mkdirSync(join(rootPath, '.task-packets'), { recursive: true });
    writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    return path;
  }

  function readAtPlan(planSha, path) {
    const result = git(['show', `${planSha}:${path}`]);
    if (!ok(result)) throw new Error(`승인된 계획(${planSha})에서 ${path}를 읽을 수 없습니다.`);
    return result.stdout;
  }

  // Everything authoritative comes from the plan SHA, never from the working tree.
  function planContext(packet) {
    const manifest = YAML.parse(readAtPlan(packet.planSha, `changes/${packet.change}/WORK_UNITS.yaml`)) ?? {};
    const unit = (manifest.work_units ?? []).find((item) => item.id === packet.unit);
    if (!unit) throw new Error(`승인된 계획에 ${packet.unit} 작업이 없습니다.`);
    let services = [];
    const registry = git(['show', `${packet.planSha}:services/registry.yaml`]);
    if (ok(registry)) services = (YAML.parse(registry.stdout) ?? {}).services ?? [];
    const { commands } = verifyCommandsFor({ ...unit, write_paths: unit.write_paths ?? [], verify: unit.verify ?? [] }, services);
    return { manifest, unit: { ...unit, write_paths: unit.write_paths ?? [], verify: unit.verify ?? [] }, services, verify: commands };
  }

  function resolveWorkspace(packet, services, explicit) {
    if (explicit) return isAbsolute(explicit) ? explicit : resolve(rootPath, explicit);
    const service = services.find((entry) => entry.id === packet.repo);
    if (!service?.path) throw new Error(`레지스트리에서 ${packet.repo} 서비스 경로를 찾을 수 없습니다. --workspace로 직접 지정하세요.`);
    return resolve(rootPath, service.path);
  }

  function loadContext(reference, { workspace } = {}) {
    const packet = readPacket(rootPath, reference);
    const state = readState(packet.run);
    const plan = planContext(packet);
    assertMatchesPlan(packet, plan.unit, plan.verify);
    return {
      packet,
      state,
      plan,
      workspace: workspace
        ? resolveWorkspace(packet, plan.services, workspace)
        : (state?.workspace ? resolve(rootPath, state.workspace) : resolveWorkspace(packet, plan.services)),
    };
  }

  function start({ packet: reference, workspace: requested, worktree, apply = false }) {
    const { packet, plan, workspace } = loadContext(reference, { workspace: requested });
    validatePlanSha(packet.planSha, { cwd: rootPath, run });

    if (!['approved', 'active'].includes(String(plan.manifest.state))) {
      throw new Error(`계획 상태가 ${plan.manifest.state ?? '알 수 없음'}입니다. 승인된 계획이 아닙니다.`);
    }
    if (!['ready', 'in_progress'].includes(String(plan.unit.state))) {
      throw new Error(`작업 ${packet.unit}의 상태가 ${plan.unit.state}입니다. ready 또는 in_progress여야 합니다.`);
    }
    if (plan.unit.writer && plan.unit.writer !== packet.writer) {
      throw new Error(`담당자가 다릅니다. 계획 ${plan.unit.writer}, 지시서 ${packet.writer}`);
    }
    if (!existsSync(join(workspace, '.git'))) {
      throw new Error(`${workspace}가 Git 저장소가 아닙니다. 서브모듈을 초기화하거나 --workspace로 지정하세요.`);
    }
    if (!ok(git(['cat-file', '-e', `${packet.baseSha}^{commit}`], workspace))) {
      throw new Error(`base SHA가 로컬에 없습니다. git -C ${workspace} fetch origin 후 다시 시도하세요.`);
    }

    const target = worktree ? (isAbsolute(worktree) ? worktree : resolve(rootPath, worktree)) : workspace;
    const current = git(['branch', '--show-current'], workspace).stdout;
    const branchExists = ok(git(['rev-parse', '--verify', `refs/heads/${packet.branch}`], workspace));
    const steps = [];
    if (worktree) {
      steps.push({ label: '워크트리 생성', command: ['git', '-C', workspace, 'worktree', 'add', '-b', packet.branch, target, packet.baseSha] });
    } else if (current === packet.branch) {
      steps.push({ label: '브랜치 확인', command: null, note: `이미 ${packet.branch}에 있습니다.` });
    } else if (branchExists) {
      steps.push({ label: '브랜치 전환', command: ['git', '-C', workspace, 'switch', packet.branch] });
    } else {
      steps.push({ label: '브랜치 생성', command: ['git', '-C', workspace, 'switch', '-c', packet.branch, packet.baseSha] });
    }

    const prompt = agentPrompt(packet, target);
    if (!apply) return { packet, unit: plan.unit, workspace: target, steps, prompt, applied: false };

    for (const step of steps) {
      if (!step.command) continue;
      const [command, ...args] = step.command;
      const result = run(command, args, { cwd: rootPath });
      step.exitCode = result.status;
      if (!ok(result)) throw new Error(`${step.label} 실패: ${result.stderr || result.stdout}`);
    }
    const state = {
      packet: {
        change: packet.change, unit: packet.unit, writer: packet.writer,
        run: packet.run, planSha: packet.planSha, digest: packet.declaredDigest, path: packet.path,
      },
      workspace: target,
      branch: packet.branch,
      baseSha: packet.baseSha,
      writePaths: packet.writePaths,
      verify: packet.verify,
      startedAt: new Date().toISOString(),
    };
    writeState(packet.run, { ...(readState(packet.run) ?? {}), ...state });
    return { packet, unit: plan.unit, workspace: target, steps, prompt, applied: true, statePath: statePath(packet.run) };
  }

  function check({ packet: reference, workspace: requested }) {
    const { packet, workspace } = loadContext(reference, { workspace: requested });
    if (!existsSync(join(workspace, '.git'))) throw new Error(`${workspace}가 Git 저장소가 아닙니다. 먼저 start를 실행하세요.`);

    const commands = packet.verify.map((command) => {
      const result = run(command, [], { cwd: workspace, shell: true });
      return { command, exitCode: result.status, output: `${result.stdout}\n${result.stderr}`.trim().slice(-2000) };
    });
    const scope = run(process.execPath, [
      WORKFLOW_CHECK,
      '--plan-sha', packet.planSha,
      '--change', packet.change,
      '--unit', packet.unit,
      '--repo-path', workspace,
    ], { cwd: rootPath });

    const headSha = git(['rev-parse', 'HEAD'], workspace).stdout;
    const committed = git(['diff', '--name-only', `${packet.baseSha}...HEAD`], workspace).stdout;
    const pending = git(['status', '--porcelain'], workspace).stdout;
    const changedFiles = [...new Set([
      ...committed.split('\n').filter(Boolean),
      ...pending.split('\n').filter(Boolean).map((line) => line.slice(3)),
    ])];

    const lastCheck = {
      headSha,
      changedFiles,
      commands,
      notRun: packet.verify.length ? [] : ['선언된 검증 명령이 없습니다.'],
      scopeCheck: { exitCode: scope.status, output: (scope.stdout || scope.stderr).trim() },
      dirty: Boolean(pending),
      at: new Date().toISOString(),
    };
    const state = readState(packet.run) ?? {};
    writeState(packet.run, { ...state, workspace, branch: packet.branch, baseSha: packet.baseSha, lastCheck });

    const passed = commands.every(({ exitCode }) => exitCode === 0) && scope.status === 0;
    return { packet, workspace, ...lastCheck, passed };
  }

  function commit({ packet: reference, message, workspace: requested, apply = false }) {
    const { packet, workspace } = loadContext(reference, { workspace: requested });
    if (!message) throw new Error('--message로 커밋 제목을 입력하세요.');
    const steps = [
      { label: '선언된 경로 스테이징', command: ['git', '-C', workspace, 'add', '--', ...packet.writePaths] },
      { label: '커밋', command: ['git', '-C', workspace, 'commit', '-m', message, '-m', trailerBlock(packet)] },
    ];
    if (!apply) return { packet, workspace, steps, applied: false };

    for (const step of steps) {
      const [command, ...args] = step.command;
      const result = run(command, args, { cwd: rootPath });
      step.exitCode = result.status;
      if (!ok(result)) throw new Error(`${step.label} 실패: ${result.stderr || result.stdout}`);
    }
    // Evidence belongs to the final commit, so the checks run again here.
    const verified = check({ packet: reference, workspace: requested });
    return { packet, workspace, steps, applied: true, check: verified };
  }

  function handoff({ packet: reference, apply = false }) {
    const { packet, state, workspace } = loadContext(reference);
    const last = state?.lastCheck;
    if (!last) throw new Error('먼저 check를 실행해 검증 증거를 기록하세요.');
    const failed = last.commands.filter(({ exitCode }) => exitCode !== 0);
    const text = [
      `Change ID: ${packet.change}`,
      `Work Unit ID: ${packet.unit}`,
      `Run ID: ${packet.run}`,
      `Repository: ${packet.repo}`,
      `Branch: ${packet.branch}`,
      `Base SHA: ${packet.baseSha}`,
      `Head SHA: ${last.headSha}`,
      `Plan SHA: ${packet.planSha}`,
      `Changed files: ${last.changedFiles.join(', ') || '없음'}`,
      `Commands and exit codes: ${last.commands.map(({ command, exitCode }) => `${command}=${exitCode}`).join(', ') || '없음'}; workflow-check=${last.scopeCheck.exitCode}`,
      `Checks not run: ${last.notRun.join(', ') || '없음'}`,
      'Contract deviations: 없음',
      `Known risks: ${failed.length ? `실패한 검증 ${failed.length}건` : '없음'}`,
      `Next action: ${failed.length || last.scopeCheck.exitCode !== 0 ? '검증 실패를 수정하고 다시 check' : '사람이 push와 PR 생성'}`,
    ].join('\n');
    const path = join(rootPath, '.task-packets', `${packet.run}.handoff.md`);
    if (apply) writeFileSync(path, `${text}\n`, 'utf8');
    return { packet, workspace, text, path, applied: apply };
  }

  function prBody(packet, last, agent) {
    const templatePath = join(rootPath, '.github', 'pull_request_template.md');
    const evidence = [
      ...last.commands.map(({ command, exitCode }) => `${command} | ${last.headSha} | ${exitCode}`),
      `workflow-check | ${last.headSha} | ${last.scopeCheck.exitCode}`,
    ].join('\n');
    const values = new Map([
      ['- Change ID:', packet.change],
      ['- Work Unit ID:', packet.unit],
      ['- Base SHA:', packet.baseSha],
      ['- Head SHA:', last.headSha],
      ['- Changed paths:', last.changedFiles.join(', ') || '없음'],
      ['- Contract snapshot:', packet.contracts.join(', ') || '없음'],
      ['- Writer/tool/run ID:', `${packet.writer} / ${agent || '직접 작업'} / ${packet.run}`],
    ]);
    if (!existsSync(templatePath)) {
      return [...[...values].map(([key, value]) => `${key} ${value}`), '', '```text', evidence, '```'].join('\n');
    }
    return readFileSync(templatePath, 'utf8')
      .split('\n')
      .map((line) => {
        const match = [...values.keys()].find((key) => line.trim() === key);
        if (match) return `${match} ${values.get(match)}`;
        if (line.trim() === 'command | target | exit code') return evidence;
        if (line.trim() === '- [ ] Command, target SHA, and exit code recorded below') return '- [x] Command, target SHA, and exit code recorded below';
        if (line.trim() === '- [ ] Checks not run are listed below') {
          return `- [x] Checks not run are listed below: ${last.notRun.join(', ') || '없음'}`;
        }
        return line;
      })
      .join('\n');
  }

  function pr({ packet: reference, agent, base = 'main', allowFailingChecks = false, apply = false }) {
    const { packet, state, plan, workspace } = loadContext(reference);
    const last = state?.lastCheck;
    if (!last) throw new Error('먼저 check를 실행해 검증 증거를 기록하세요.');
    const headSha = git(['rev-parse', 'HEAD'], workspace).stdout;
    if (headSha !== last.headSha) {
      throw new Error(`검증 증거가 현재 커밋과 다릅니다. 기록 ${last.headSha}, 현재 ${headSha}. check를 다시 실행하세요.`);
    }
    if (last.dirty) throw new Error('커밋되지 않은 변경이 남아 있습니다. 먼저 commit 하세요.');
    if (last.scopeCheck.exitCode !== 0) throw new Error(`범위 검사가 실패한 상태입니다: ${last.scopeCheck.output}`);
    const failed = last.commands.filter(({ exitCode }) => exitCode !== 0);
    if (failed.length && !allowFailingChecks) {
      throw new Error(`실패한 검증이 ${failed.length}건 있습니다. 수정 후 다시 check 하거나, 사실을 PR 본문에 기록한 채 올리려면 --allow-failing-checks를 사용하세요.`);
    }

    const host = plan.services.find((entry) => entry.id === packet.repo)?.repo?.match(/^https:\/\/([^/]+)\//)?.[1] ?? 'github.com';
    const title = `feat(${packet.change}): ${packet.unit}`;
    const steps = [
      { label: '브랜치 push', command: ['git', '-C', workspace, 'push', '-u', 'origin', packet.branch] },
      { label: 'PR 생성', command: ['gh', 'pr', 'create', '--base', base, '--head', packet.branch, '--title', title, '--body', '<생성된 본문>'] },
    ];
    if (!apply) return { packet, workspace, steps, body: prBody(packet, last, agent), applied: false };

    const push = run('git', ['-C', workspace, 'push', '-u', 'origin', packet.branch], { cwd: rootPath });
    steps[0].exitCode = push.status;
    if (!ok(push)) throw new Error(`브랜치 push 실패: ${push.stderr || push.stdout}`);

    const body = prBody(packet, last, agent);
    const existing = run('gh', ['pr', 'list', '--head', packet.branch, '--state', 'open', '--json', 'number,url', '--limit', '1'], { cwd: workspace, env: { ...process.env, GH_HOST: host } });
    let created = ok(existing) ? JSON.parse(existing.stdout || '[]')[0] ?? null : null;
    if (created) {
      steps[1].label = '기존 PR 확인';
      steps[1].exitCode = 0;
    } else {
      const result = run('gh', ['pr', 'create', '--base', base, '--head', packet.branch, '--title', title, '--body', body], { cwd: workspace, env: { ...process.env, GH_HOST: host } });
      steps[1].exitCode = result.status;
      if (!ok(result)) throw new Error(`PR 생성 실패: ${result.stderr || result.stdout}`);
      const url = result.stdout.split('\n').find((line) => line.startsWith('http')) ?? '';
      created = { url, number: Number(url.split('/').at(-1)) };
    }
    writeState(packet.run, { ...(readState(packet.run) ?? {}), pr: { number: created.number, url: created.url, at: new Date().toISOString() } });
    return { packet, workspace, steps, body, pr: created, applied: true };
  }

  function finish(options) {
    const results = {};
    results.check = check(options);
    if (!results.check.passed && !options.allowFailingChecks) {
      throw new Error('검증이 실패해 이후 단계를 중단했습니다.');
    }
    if (options.message) results.commit = commit({ ...options, apply: options.apply });
    results.handoff = handoff(options);
    results.pr = pr(options);
    return results;
  }

  return { start, check, commit, handoff, pr, finish, readState, statePath };
}
