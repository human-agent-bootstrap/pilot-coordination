import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import YAML from 'yaml';
import { defaultRun, isFullSha, isPlanningUnit, safeIdentifier, sha256, verifyCommandsFor } from '../lib.mjs';
import { createGithub, githubSlug, localCheckEnv, redact } from '../github.mjs';
import { assertPathHasNoSymlinks } from './change-service.mjs';

export function runAsync(command, args, options = {}) {
  return new Promise((done) => {
    const grouped = process.platform !== 'win32';
    const child = spawn(command, args, { ...options, detached: grouped, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let forced;
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk).slice(-64_000); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-64_000); });
    const kill = (signal) => {
      if (!child.pid) return;
      try { grouped ? process.kill(-child.pid, signal) : child.kill(signal); }
      catch (error) { if (error.code !== 'ESRCH') stderr += `\n${error.message}`; }
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      kill('SIGTERM');
      forced = setTimeout(() => kill('SIGKILL'), 5000);
    }, 600_000);
    child.on('error', (error) => { clearTimeout(timeout); clearTimeout(forced); done({ status: -1, stdout, stderr: error.message }); });
    child.on('close', (code) => {
      clearTimeout(timeout);
      clearTimeout(forced);
      if (timedOut) kill('SIGKILL');
      done({ status: timedOut ? 124 : code ?? -1, stdout, stderr: timedOut ? `${stderr}\nCommand timed out; child process group terminated.` : stderr });
    });
  });
}

function reject(message, code = 409) {
  const error = new Error(message);
  error.statusCode = code;
  throw error;
}

function pathsAllow(path, allowed) {
  return allowed.some((pattern) => pattern.endsWith('/**') ? path.startsWith(pattern.slice(0, -2)) : path === pattern);
}

function candidateNumber(value) {
  if (!/^\d{1,3}$/.test(String(value ?? ''))) reject('Candidate 번호는 1~3자리 숫자여야 합니다.', 422);
  return String(value).padStart(3, '0');
}

// The Coordinator never types these; both are derived so the surface asks for no identifiers.
function runIdFor(change, number, taken) {
  const base = `run-${change}-candidate-${number}`;
  if (!taken(base)) return base;
  for (let attempt = 2; attempt <= 99; attempt += 1) {
    const candidate = `${base}-r${attempt}`;
    if (!taken(candidate)) return candidate;
  }
  reject('같은 Candidate 번호의 실행이 너무 많습니다. 기존 실행 기록을 정리하세요.');
}

const splitLines = (text) => text.split('\n').filter(Boolean);
const jsonText = (value) => `${JSON.stringify(value, null, 2)}\n`;

export function createCandidateService({
  root, run = defaultRun, execute = runAsync, env = process.env, github,
} = {}) {
  root = resolve(root);
  const control = join(root, '.task-packets');
  const previews = new Map();
  const jobs = new Map();
  let active = false;
  const registry = () => YAML.parse(readFileSync(join(root, 'services/registry.yaml'), 'utf8'));
  const api = github ?? createGithub({ cwd: root, registry: registry(), env, run: execute });
  const gitResult = (args, cwd = root) => run('git', args, { cwd });
  function git(args, cwd = root) {
    const result = gitResult(args, cwd);
    if (result.status !== 0) reject(`git ${args[0]} 실패: ${redact(result.stderr || result.stdout, env)}`);
    return result.stdout.trim();
  }
  function at(sha, path) {
    return execFileSync('git', ['show', `${sha}:${path}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  }
  function yamlAt(sha, path) { return YAML.parse(at(sha, path)); }
  function checkedPath(relative) {
    assertPathHasNoSymlinks(root, relative);
    return join(root, relative);
  }
  function statePath(id) { return checkedPath(`.task-packets/${safeIdentifier('Run ID', id)}.candidate-state.json`); }
  function load(id) {
    const path = statePath(id);
    if (!existsSync(path)) reject('Candidate 실행을 찾을 수 없습니다.', 404);
    return JSON.parse(readFileSync(path, 'utf8'));
  }
  function save(state) {
    const target = statePath(state.run);
    const temp = `${target}.tmp`;
    // A process lock protects writes; interrupted journals require human inspection.
    if (existsSync(temp)) reject('중단된 상태 저장 파일이 남아 있습니다. 원본과 .tmp를 사람이 확인하세요.');
    writeFileSync(temp, jsonText(state), { flag: 'wx', mode: 0o600 });
    renameSync(temp, target);
  }
  function runs() {
    if (!existsSync(control)) return [];
    return readdirSync(control).filter((name) => name.endsWith('.candidate-state.json'))
      .map((name) => load(name.slice(0, -'.candidate-state.json'.length)));
  }
  function takenRunId(id) {
    return existsSync(join(control, `${id}.candidate-state.json`)) || existsSync(join(control, `${id}.candidate-approval.json`))
      || existsSync(join(control, 'candidate-workspaces', id)) || existsSync(join(control, `${id}.md`)) || existsSync(join(control, `${id}.state.json`));
  }
  // Lowest number that no run and no already-pinned record has claimed.
  function nextNumber(change, baseSha) {
    const used = new Set(runs().filter((state) => state.change === change).map((state) => state.candidate));
    for (let value = 1; value <= 999; value += 1) {
      const number = String(value).padStart(3, '0');
      if (used.has(number)) continue;
      const path = `changes/${change}/releases/candidate-${number}.yaml`;
      if (gitResult(['cat-file', '-e', `${baseSha}:${path}`]).status === 0) {
        const existing = yamlAt(baseSha, path);
        if (isFullSha(existing.plan_sha) || existing.state !== 'draft') continue;
      }
      return number;
    }
    reject('사용할 수 있는 Candidate 번호가 없습니다.');
  }
  function snapshot(state) {
    const path = checkedPath(`.task-packets/${state.run}.candidate-approval.json`);
    const text = readFileSync(path, 'utf8');
    if (sha256(text) !== state.approvalDigest) reject('원본 실행 승인이 변경되었습니다. 다시 승인해야 합니다.');
    const approval = JSON.parse(text);
    if (approval.run !== state.run || approval.workspace !== state.workspace) reject('실행 상태와 승인 원본이 다릅니다.');
    return approval;
  }
  async function locked(action, id, callback) {
    if (active) reject('다른 Candidate 작업이 진행 중입니다.');
    mkdirSync(control, { recursive: true });
    const lock = checkedPath('.task-packets/candidate.lock');
    try { writeFileSync(lock, jsonText({ run: id, pid: process.pid }), { flag: 'wx', mode: 0o600 }); }
    catch { reject('다른 Candidate 실행이 잠겨 있습니다. 이전 프로세스 종료 여부를 사람이 확인하세요.'); }
    active = true;
    try {
      const agent = runs().find((state) => state.phase === 'agent');
      if (agent && (agent.run !== id || action !== 'handoff')) reject('Agent가 workspace를 사용 중입니다. 먼저 인계를 확인하세요.');
      return await (callback ? callback() : actionHandlers[action](id));
    } finally {
      active = false;
      unlinkSync(lock);
    }
  }
  async function command(state, label, executable, args, cwd = state.workspace, shell = false) {
    state.steps ??= [];
    state.steps.push({ label, status: 'running' });
    save(state);
    const remote = executable === 'git' || executable === 'gh' || /^npm run verify:prs(?:\s|$)/.test(executable);
    const ghEnv = { ...env, GH_HOST: api.host };
    if (env.COORDINATION_GITHUB_TOKEN) ghEnv[api.host === 'github.com' ? 'GH_TOKEN' : 'GH_ENTERPRISE_TOKEN'] = env.COORDINATION_GITHUB_TOKEN;
    const result = await execute(executable, args, { cwd, env: executable === 'gh' ? ghEnv : remote ? env : localCheckEnv(env), shell });
    const step = state.steps.at(-1);
    const approval = snapshot(state);
    const head = existsSync(join(state.workspace, '.git')) ? gitResult(['rev-parse', 'HEAD'], state.workspace).stdout.trim() : approval.baseSha;
    Object.assign(step, { command: redact([executable, ...args].join(' '), env), rootHead: head,
      services: approval.services.map((service) => ({ repo: service.repo, sha: service.sha })), approvalDigest: state.approvalDigest,
      status: result.status === 0 ? 'passed' : 'failed', exitCode: result.status, output: redact(`${result.stdout}\n${result.stderr}`, env).slice(-8000) });
    save(state);
    if (result.status !== 0) reject(`${label} 실패 (exit ${result.status}). 실행 기록을 확인하세요.`);
    return result;
  }
  async function syncRoot() {
    const fetched = await execute('git', ['fetch', 'origin', 'main'], { cwd: root, env });
    if (fetched.status !== 0) reject(`Root 조회 실패: ${redact(fetched.stderr, env)}`, 422);
    return git(['rev-parse', 'origin/main']);
  }
  const rootSlug = () => githubSlug(git(['remote', 'get-url', 'origin']), registry().github?.host);
  function recordFiles(approval, digest, runId) {
    const prefix = `changes/${approval.change}`;
    // Start with current records so unrelated Coordinator entries are preserved.
    const manifest = yamlAt(approval.baseSha, `${prefix}/WORK_UNITS.yaml`);
    const prs = yamlAt(approval.baseSha, `${prefix}/PRS.yaml`);
    manifest.plan_merge_sha = approval.planSha;
    for (const unit of manifest.work_units) {
      if (approval.rows.some((row) => row.unit === unit.id)) unit.state = 'merged';
      if (unit.id === approval.unit) { unit.state = 'in_progress'; unit.base_sha = approval.baseSha; }
    }
    prs.plan_merge_sha = approval.planSha;
    for (const row of approval.rows) {
      const record = (prs.prs ?? []).find((item) => item.work_unit === row.unit);
      if (!record) reject('선택된 작업의 PRS 기록이 없습니다.');
      Object.assign(record, { number: row.number, state: 'merged', base_sha: row.baseSha, head_sha: row.headSha, merge_sha: row.mergeSha });
    }
    const candidateRow = prs.prs.find((item) => item.work_unit === approval.unit);
    if (candidateRow) candidateRow.base_sha = approval.baseSha;
    const release = { schema_version: 1, change_id: approval.change, candidate: Number(approval.candidate),
      state: 'draft', plan_sha: approval.planSha, approval_digest: digest,
      services: approval.services.map((service) => ({ repo: service.repo, path: service.path, base_sha: service.baseSha, sha: service.sha, source_prs: service.units })), evidence: [] };
    return [
      [`${prefix}/WORK_UNITS.yaml`, YAML.stringify(manifest)],
      [`${prefix}/PRS.yaml`, YAML.stringify(prs)],
      [`${prefix}/STATUS.md`, `${at(approval.baseSha, `${prefix}/STATUS.md`)}\n\n## Candidate execution\n\n- Run: ${runId}\n- Approval: ${digest}\n- Service PRs: merged and pinned; Candidate PR, main CI and integration environment remain separate human gates.\n`],
      [`${prefix}/releases/candidate-${approval.candidate}.yaml`, YAML.stringify(release)],
    ];
  }
  async function ci(slug, sha, rootEvent) {
    const [checks, status] = await Promise.all([
      api.get(`/repos/${slug}/commits/${sha}/check-runs?per_page=100`),
      api.get(`/repos/${slug}/commits/${sha}/status`),
    ]);
    const items = checks.check_runs ?? [];
    const statuses = status.statuses ?? [];
    // Only the Root's opposite-event job may be skipped; required checks must actually succeed.
    const required = rootEvent ? [rootEvent === 'pull_request' ? 'pull-request' : 'main', 'planning-ui'] : [];
    const inactive = rootEvent === 'pull_request' ? 'main' : rootEvent === 'push' ? 'pull-request' : null;
    const applicable = items.filter((item) => !(item.name === inactive && item.status === 'completed' && item.conclusion === 'skipped'));
    const passing = applicable.length + statuses.length > 0
      && Number(checks.total_count ?? items.length) === items.length
      && required.every((name) => applicable.some((item) => item.name === name))
      && applicable.every((item) => item.status === 'completed' && item.conclusion === 'success')
      && statuses.every((item) => item.state === 'success');
    return { state: passing ? 'passed' : items.some((item) => ['failure', 'cancelled', 'timed_out', 'action_required'].includes(item.conclusion)) || statuses.some((item) => ['failure', 'error'].includes(item.state)) ? 'failed' : 'pending',
      checks: items.map(({ name, status: checkState, conclusion, html_url: url }) => ({ name, status: checkState, conclusion, url })) };
  }
  async function discover(unit, services, selections, planning = false) {
    const slug = unit.repo === 'root' ? rootSlug() : githubSlug(services.find((item) => item.id === unit.repo)?.repo, api.host);
    const matches = await api.list(`/repos/${slug}/pulls?state=all&base=main&head=${encodeURIComponent(`${slug.split('/')[0]}:${unit.branch}`)}`);
    const options = matches.filter((pull) => pull.head?.ref === unit.branch && pull.base?.ref === 'main');
    const selected = selections[unit.id];
    const pull = selected ? options.find((item) => item.number === selected) : options.length === 1 ? options[0] : null;
    const row = { unit: unit.id, repo: unit.repo, branch: unit.branch, slug,
      options: options.map(({ number, html_url: url, state, merged_at }) => ({ number, url, state: merged_at ? 'merged' : state })),
      state: !options.length ? 'missing' : !pull ? 'ambiguous' : 'unmerged' };
    if (!pull) return row;
    const actual = await api.get(`/repos/${slug}/pulls/${pull.number}`);
    if (actual.head?.ref !== unit.branch || actual.base?.ref !== 'main') reject('선택한 PR 브랜치가 계획과 다릅니다.');
    Object.assign(row, { number: actual.number, url: actual.html_url, baseSha: actual.base?.sha, headSha: actual.head?.sha,
      mergeSha: actual.merge_commit_sha, state: actual.merged_at ? 'merged' : 'unmerged' });
    if (row.state === 'merged') {
      if (![row.baseSha, row.headSha, row.mergeSha].every(isFullSha)) reject('PR에 정확한 SHA가 없습니다.');
      row.ci = await ci(slug, planning ? row.headSha : row.mergeSha, planning ? 'pull_request' : undefined);
    }
    return row;
  }
  async function preview(input) {
    const change = safeIdentifier('Change ID', input.change);
    const selected = input.selections ?? {};
    if (!selected || Array.isArray(selected) || typeof selected !== 'object' || Object.values(selected).some((value) => !Number.isInteger(value) || value <= 0)) reject('선택한 PR 번호가 올바르지 않습니다.', 422);
    const baseSha = await syncRoot();
    const explicit = input.candidate !== undefined && input.candidate !== null && input.candidate !== '';
    const number = explicit ? candidateNumber(input.candidate) : nextNumber(change, baseSha);
    const manifestPath = `changes/${change}/WORK_UNITS.yaml`;
    const current = yamlAt(baseSha, manifestPath);
    const planning = current.work_units.find((unit) => isPlanningUnit(change, unit));
    if (!planning) reject('선언된 계획 브랜치가 없습니다.', 422);
    const services = yamlAt(baseSha, 'services/registry.yaml').services ?? [];
    if (!['approved', 'active'].includes(current.state)) reject('현재 Root 계획 상태가 approved 또는 active가 아닙니다.');
    const planRow = await discover(planning, services, selected, true);
    const result = { change, candidate: number, baseSha, rows: [planRow], blockers: [], ready: false };
    if (planRow.state !== 'merged') {
      result.blockers.push('계획 PR이 하나로 선택되고 병합되어야 합니다.');
      return result;
    }
    const planSha = planRow.mergeSha;
    if (gitResult(['merge-base', '--is-ancestor', planSha, baseSha]).status !== 0) reject('선택한 계획 PR이 현재 Root main에 포함되어 있지 않습니다.');
    const manifest = yamlAt(planSha, manifestPath);
    if (!['approved', 'active'].includes(manifest.state)) reject('병합된 계획이 approved 또는 active 상태가 아닙니다.', 422);
    const candidates = manifest.work_units.filter((unit) => unit.repo === 'root' && !isPlanningUnit(change, unit) && (unit.write_paths ?? []).includes('e2e/**'));
    if (candidates.length !== 1) reject('계획에 Candidate 통합 Work Unit이 하나여야 합니다.', 422);
    const unit = candidates[0];
    safeIdentifier('Work Unit ID', unit.id);
    if (!/^change\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(unit.branch)) reject('Candidate 브랜치가 올바르지 않습니다.');
    safeIdentifier('Writer', unit.writer);
    const allowed = unit.write_paths ?? [];
    if (allowed.some((path) => path === '**' || !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.*-]+)*$/.test(path) || path.split('/').includes('..'))) {
      reject('Candidate 경로는 명확한 상대 경로여야 합니다. 전체 저장소 범위는 허용하지 않습니다.');
    }
    const required = [`changes/${change}/WORK_UNITS.yaml`, `changes/${change}/PRS.yaml`, `changes/${change}/STATUS.md`, `changes/${change}/releases/candidate-${number}.yaml`, 'e2e/example.test.mjs'];
    if (required.some((path) => !pathsAllow(path, allowed))) reject('계획의 Candidate 허용 경로에 준비·E2E 경로가 없습니다.');
    const implementations = manifest.work_units.filter((item) => item.repo !== 'root');
    if (!implementations.length) reject('계획에 서비스 작업이 없습니다.');
    for (const implementation of implementations) {
      if (!/^(?:feat|fix|refactor|test|docs|chore)\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(implementation.branch)
        || !isFullSha(implementation.base_sha)) reject('서비스 작업 브랜치 또는 base SHA가 올바르지 않습니다.');
      const row = await discover(implementation, services, selected);
      result.rows.push(row);
      if (row.state !== 'merged') result.blockers.push(`${implementation.id}: ${row.state === 'ambiguous' ? '여러 PR 중 하나를 선택하세요.' : row.state === 'missing' ? 'PR을 찾을 수 없습니다.' : '먼저 PR을 병합하세요.'}`);
      if (row.ci?.state !== 'passed') result.blockers.push(`${implementation.id}: merge SHA의 CI가 아직 통과하지 않았습니다.`);
      if (!verifyCommandsFor(implementation, services).commands.length) result.blockers.push(`${implementation.id}: 필수 검증 명령이 없습니다.`);
      for (const dependency of implementation.depends_on ?? []) {
        if (!manifest.work_units.some((item) => item.id === dependency && (item.repo !== 'root' || isPlanningUnit(change, item)))) {
          result.blockers.push(`${implementation.id}: 실행할 수 없는 의존성 ${dependency}`);
        }
      }
    }
    if (planRow.ci?.state !== 'passed') result.blockers.push('계획 PR CI가 아직 통과하지 않았습니다.');
    if (!(unit.verify ?? []).length) result.blockers.push('Candidate 필수 검증 명령이 없습니다.');
    if (!unit.depends_on?.length || unit.depends_on.some((id) => !implementations.some((implementation) => implementation.id === id))) {
      result.blockers.push('Candidate 의존성이 선언된 서비스 작업과 일치하지 않습니다.');
    }
    if (Object.keys(selected).some((id) => !manifest.work_units.some((item) => item.id === id))) reject('선택한 PR의 Work Unit이 승인 계획에 없습니다.');
    const contracts = splitLines(git(['ls-tree', '-r', '--name-only', planSha, '--', `changes/${change}/contracts/`]))
      .map((path) => ({ path, digest: sha256(at(planSha, path)) }));
    const currentContracts = splitLines(git(['ls-tree', '-r', '--name-only', baseSha, '--', `changes/${change}/contracts/`]));
    if (currentContracts.join(',') !== contracts.map((item) => item.path).join(',')) result.blockers.push('승인 이후 계약 목록이 변경되었습니다.');
    for (const contract of contracts) {
      if (sha256(at(baseSha, contract.path)) !== contract.digest) result.blockers.push('계약이 승인된 계획 이후 변경되었습니다. 새 계획 승인이 필요합니다.');
    }
    // Scope/goal changes after the selected planning merge cannot be approved as runtime values.
    const stable = (value) => JSON.stringify((value.work_units ?? []).map(({ state, base_sha, ...rest }) => rest));
    if (stable(current) !== stable(manifest) || at(baseSha, `changes/${change}/PLAN.md`) !== at(planSha, `changes/${change}/PLAN.md`)) result.blockers.push('계획 범위가 선택한 계획 SHA 이후 변경되었습니다.');
    const releasePath = `changes/${change}/releases/candidate-${number}.yaml`;
    if (gitResult(['cat-file', '-e', `${baseSha}:${releasePath}`]).status === 0) {
      const existing = yamlAt(baseSha, releasePath);
      if (isFullSha(existing.plan_sha) || existing.state !== 'draft') result.blockers.push('이미 준비된 Candidate 기록이 있습니다. 새 Candidate 번호를 사용하세요.');
    }
    const serviceSnapshot = [];
    for (const service of services.filter((item) => implementations.some((implementation) => implementation.repo === item.id))) {
      if (!/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(service.path) || !pathsAllow(service.path, allowed)) reject('서비스 포인터 경로가 허용 범위 밖입니다.');
      const rows = result.rows.filter((row) => row.repo === service.id);
      const serviceBase = git(['ls-tree', baseSha, '--', service.path]).match(/^160000 commit ([0-9a-f]{40})\t/)?.[1];
      if (!serviceBase || implementations.find((item) => item.repo === service.id)?.base_sha !== serviceBase) result.blockers.push(`${service.id}: Root 포인터가 서비스 작업 base와 다릅니다. 새 계획 확인이 필요합니다.`);
      serviceSnapshot.push({ repo: service.id, path: service.path, url: service.repo,
        baseSha: serviceBase,
        sha: rows.at(-1)?.mergeSha, units: rows.map((row) => row.unit) });
    }
    result.ready = !result.blockers.length;
    Object.assign(result, { planSha, unit: unit.id, writer: unit.writer, branch: unit.branch, writePaths: allowed,
      workspaceParent: join(control, 'candidate-workspaces'),
      services: serviceSnapshot, contracts, criteria: [...at(planSha, `changes/${change}/PLAN.md`).matchAll(/^\s*-\s+\[(AC-\d+)\]\s+(.+)$/gm)].map((match) => ({ id: match[1], text: match[2] })),
      files: required.slice(0, 4).concat(serviceSnapshot.map((service) => service.path)) });
    if (!result.criteria.length) { result.blockers.push('승인 계획에 AC 완료 기준이 없습니다.'); result.ready = false; }
    if (result.ready) {
      result.diffs = recordFiles(result, '(실행 승인 시 고정되는 digest)', '(입력할 Run ID)').map(([path, content]) => {
        const before = gitResult(['show', `${baseSha}:${path}`]);
        return { path, diff: `--- ${before.status === 0 ? `a/${path}` : '/dev/null'}\n+++ b/${path}\n${before.status === 0 ? splitLines(before.stdout).map((line) => `-${line}`).join('\n') : ''}\n${splitLines(content).map((line) => `+${line}`).join('\n')}` };
      }).concat(serviceSnapshot.map((service) => ({ path: service.path, diff: `-${service.baseSha}\n+${service.sha}` })));
    }
    result.revision = sha256(JSON.stringify(result));
    previews.set(result.revision, { result, manifest, unit, implementations, services });
    return result;
  }
  async function approve(input) {
    const cached = previews.get(input.revision);
    if (!cached?.result.ready) reject('통과한 미리보기를 먼저 확인하세요.');
    const id = safeIdentifier('Run ID', input.run ?? runIdFor(cached.result.change, cached.result.candidate, takenRunId));
    const refreshed = await preview({ change: cached.result.change, candidate: cached.result.candidate,
      selections: Object.fromEntries(cached.result.rows.map((row) => [row.unit, row.number])) });
    if (refreshed.revision !== input.revision) reject('미리보기 이후 PR·SHA·범위가 바뀌었습니다. 다시 확인하세요.');
    const { result, unit, implementations, services } = cached;
    const approval = {
      schemaVersion: 1, kind: 'candidate-execution', ...result, run: id,
      workspace: join(control, 'candidate-workspaces', id), coordinatorRoot: root,
      agentPaths: ['e2e/**'], agentVerify: ['npm run test:e2e'],
      verify: unit.verify, serviceVerify: implementations.map((item) => ({ unit: item.id, repo: item.repo, commands: verifyCommandsFor(item, services).commands })),
      approvedAt: new Date().toISOString(), responsibility: 'Human confirms approval and acceptance evidence; agent only writes E2E and runs local E2E.',
    };
    const approvalPath = checkedPath(`.task-packets/${id}.candidate-approval.json`);
    const target = statePath(id);
    if (existsSync(target) || existsSync(approvalPath) || existsSync(approval.workspace) || existsSync(join(control, `${id}.md`)) || existsSync(join(control, `${id}.state.json`))) reject('Run ID 또는 workspace가 이미 있습니다. 덮어쓰지 않습니다.');
    mkdirSync(control, { recursive: true });
    writeFileSync(approvalPath, jsonText(approval), { flag: 'wx', mode: 0o600 });
    const state = { run: id, change: result.change, candidate: result.candidate, workspace: approval.workspace, approvalDigest: sha256(jsonText(approval)), phase: 'approved', steps: [], checks: [], evidence: [] };
    save(state);
    return status(id);
  }
  async function fresh(state, remote = true) {
    const approval = snapshot(state);
    if ((remote ? await syncRoot() : git(['rev-parse', 'origin/main'])) !== approval.baseSha) reject('Root base SHA가 변경되어 실행 승인이 만료되었습니다.');
    if (remote) for (const row of approval.rows) {
      const actual = await api.get(`/repos/${row.slug}/pulls/${row.number}`);
      if (!actual.merged_at || actual.base?.ref !== 'main' || actual.base?.sha !== row.baseSha || actual.head?.sha !== row.headSha || actual.merge_commit_sha !== row.mergeSha || actual.head?.ref !== row.branch) reject('선택한 PR·SHA가 변경되어 실행 승인이 만료되었습니다.');
    }
    return approval;
  }
  function workspaceCheck(state, agentOnly = false) {
    const approval = snapshot(state);
    checkedPath(`.task-packets/candidate-workspaces/${state.run}`);
    if (git(['branch', '--show-current'], state.workspace) !== approval.branch) reject('Candidate workspace 브랜치가 변경되었습니다.');
    if (gitResult(['merge-base', '--is-ancestor', approval.baseSha, 'HEAD'], state.workspace).status !== 0) reject('Candidate HEAD가 승인 Root base의 후손이 아닙니다.');
    const paths = [...new Set([
      ...splitLines(git(['diff', '--name-only', `${approval.baseSha}...HEAD`], state.workspace)),
      ...splitLines(git(['diff', '--name-only', 'HEAD'], state.workspace)),
      ...splitLines(git(['diff', '--cached', '--name-only'], state.workspace)),
      ...splitLines(git(['ls-files', '--others', '--exclude-standard'], state.workspace)),
    ])];
    if (paths.some((path) => !pathsAllow(path, approval.writePaths))) reject(`허용 범위 밖의 변경이 있습니다: ${paths.filter((path) => !pathsAllow(path, approval.writePaths)).join(', ')}`);
    for (const path of paths) assertPathHasNoSymlinks(state.workspace, path);
    for (const contract of approval.contracts) {
      if (sha256(readFileSync(join(state.workspace, contract.path))) !== contract.digest) reject('승인 계약이 변경되었습니다.');
    }
    for (const [path, digest] of Object.entries(state.preparedFiles ?? {})) {
      if (sha256(readFileSync(join(state.workspace, path))) !== digest) reject('Coordinator가 준비한 Root 기록이 변경되었습니다.');
    }
    if (agentOnly && state.agentBaseline) {
      const committed = splitLines(git(['diff', '--name-only', `${state.agentBaseline.head}..HEAD`], state.workspace));
      if (committed.some((path) => !path.startsWith('e2e/'))) reject('Agent가 e2e/** 밖을 커밋했습니다.');
      if (git(['ls-files', '--stage', '--', ':(exclude)e2e/**'], state.workspace) !== state.agentBaseline.index) reject('Agent가 e2e/** 밖의 Git index를 변경했습니다.');
      const before = new Map(state.agentBaseline.files.map((item) => [item.path, item.digest]));
      for (const [path, digest] of before) {
        const file = join(state.workspace, path);
        if (!existsSync(file) || sha256(readFileSync(file)) !== digest) reject('Agent가 Root 기록을 변경했습니다.');
      }
      const additions = [...splitLines(git(['diff', '--name-only', `${state.agentBaseline.head}..HEAD`], state.workspace)), ...paths];
      if (additions.some((path) => !path.startsWith('e2e/') && !before.has(path) && !state.agentBaseline.pointers.includes(path))) reject('Agent 변경 범위는 e2e/**만 허용됩니다.');
    }
    for (const service of approval.services) {
      const cwd = join(state.workspace, service.path);
      if (git(['rev-parse', 'HEAD'], cwd) !== service.sha || git(['status', '--porcelain'], cwd)) reject(`${service.repo} SHA 또는 서비스 파일이 변경되었습니다.`);
      if (agentOnly && git(['ls-files', '--stage', '--', service.path], state.workspace).match(/^160000 ([0-9a-f]{40}) /)?.[1] !== service.baseSha) reject('Agent가 Coordinator 소유의 서비스 포인터를 stage했습니다.');
    }
    return { approval, paths };
  }
  function fingerprint(state) {
    workspaceCheck(state);
    return sha256(JSON.stringify({ head: git(['rev-parse', 'HEAD'], state.workspace),
      diff: git(['diff', '--binary', 'HEAD'], state.workspace),
      staged: git(['diff', '--cached', '--binary'], state.workspace),
      files: splitLines(git(['ls-files', '--others', '--exclude-standard'], state.workspace)).map((path) => [path, sha256(readFileSync(join(state.workspace, path)))]) }));
  }
  // The plan decides whether a product suite is *required*; a suite that exists is
  // always *run*, so writing one can only ever add evidence, never be ignored.
  function requiresProductE2e(approval) {
    return (approval.verify ?? []).some((command) => /^npm run test:e2e(?:\s|$)/.test(command));
  }
  function productE2e(state) {
    const directory = join(state.workspace, 'e2e');
    return existsSync(directory) && readdirSync(directory).some((name) => name.endsWith('.test.mjs'));
  }
  // A product suite has no durable home until a Candidate PR merges, so an abandoned run
  // would otherwise force the Coordinator to rewrite it. Carry the source forward; evidence
  // is never carried — every run re-runs the suite and records its own result.
  function inheritProductE2e(state) {
    if (productE2e(state)) return null;
    const prior = runs()
      .filter((item) => item.change === state.change && item.run !== state.run && item.workspace)
      .sort((left, right) => String(left.run).localeCompare(String(right.run)))
      .reverse();
    for (const source of prior) {
      const directory = join(source.workspace, 'e2e');
      if (!existsSync(directory)) continue;
      const suites = readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith('.test.mjs'))
        .map((entry) => entry.name);
      if (!suites.length) continue;
      mkdirSync(join(state.workspace, 'e2e'), { recursive: true });
      const copied = [];
      for (const name of suites) {
        assertPathHasNoSymlinks(source.workspace, `e2e/${name}`);
        const content = readFileSync(join(directory, name));
        const target = join(state.workspace, 'e2e', name);
        if (existsSync(target)) continue;
        writeFileSync(target, content);
        copied.push({ path: `e2e/${name}`, digest: sha256(content) });
      }
      if (copied.length) return { run: source.run, files: copied };
    }
    return null;
  }
  async function prepare(id) {
    const state = load(id);
    if (!['approved', 'preparing', 'prepare-failed'].includes(state.phase)) reject('이 실행은 준비 단계가 아닙니다.');
    const approval = await fresh(state);
    state.phase = 'preparing';
    save(state);
    try {
      const parent = checkedPath('.task-packets/candidate-workspaces');
      mkdirSync(parent, { recursive: true });
      if (!existsSync(state.workspace)) {
        await command(state, '전용 Root clone', 'git', ['clone', '--no-local', '--no-checkout', root, state.workspace], root);
      } else if (!existsSync(join(state.workspace, '.git'))) reject('부분 clone이 남아 있습니다. 삭제하지 않고 중단합니다. 새 Run ID로 승인하세요.');
      if (state.preparationFingerprint && state.preparationFingerprint !== rawFingerprint(state)) reject('준비 중단 후 workspace가 변경되었습니다. 자동으로 덮어쓰지 않습니다.');
      if (!state.preparationFingerprint && !state.recordsPrepared && git(['branch', '--show-current'], state.workspace) === snapshot(state).branch) {
        const pending = git(['status', '--porcelain', '--ignore-submodules=all'], state.workspace);
        if (pending) reject('중단된 준비 workspace에 미기록 변경이 있습니다. 자동으로 덮어쓰지 않습니다.');
      }
      const origin = git(['remote', 'get-url', 'origin']);
      githubSlug(origin, api.host);
      await command(state, 'Root 원격 설정', 'git', ['remote', 'set-url', 'origin', origin]);
      await command(state, 'Candidate Root base 확인', 'git', ['fetch', 'origin', 'main']);
      if (git(['rev-parse', 'origin/main'], state.workspace) !== approval.baseSha) reject('Candidate clone의 Root base가 승인과 다릅니다.');
      const branch = gitResult(['rev-parse', '--verify', `refs/heads/${approval.branch}`], state.workspace);
      if (branch.status !== 0) await command(state, 'Candidate 브랜치 준비', 'git', ['switch', '-c', approval.branch, approval.baseSha]);
      else if (git(['branch', '--show-current'], state.workspace) !== approval.branch) reject('기존 브랜치를 자동 전환하지 않습니다.');
      for (const key of ['user.name', 'user.email']) {
        const value = gitResult(['config', '--get', key]);
        if (value.status === 0) await command(state, '로컬 작성자 설정', 'git', ['config', key, value.stdout.trim()]);
      }
      // Registration is from the approved Root, not the Writer checkout.
      if (!state.submodulesPrepared) {
        await command(state, '서비스 submodule 준비', 'git', ['submodule', 'update', '--init', '--recursive']);
        state.submodulesPrepared = true;
        save(state);
      }
      for (const service of approval.services) {
        const cwd = join(state.workspace, service.path);
        if (git(['status', '--porcelain'], cwd)) reject('서비스 workspace에 변경이 있습니다.');
        const current = git(['rev-parse', 'HEAD'], cwd);
        if (![service.baseSha, service.sha].includes(current)) reject('서비스 workspace가 선언된 base/merge SHA와 다릅니다.');
        await command(state, `${service.repo} merge SHA 조회`, 'git', ['fetch', 'origin', 'main'], cwd);
        await command(state, `${service.repo} SHA 고정`, 'git', ['switch', '--detach', service.sha], cwd);
        if (gitResult(['merge-base', '--is-ancestor', service.baseSha, service.sha], cwd).status !== 0) reject(`${service.repo}: base 이후 merge SHA가 아닙니다.`);
        const expected = approval.rows.filter((row) => row.repo === service.repo).map((row) => row.mergeSha);
        const actual = splitLines(git(['rev-list', '--first-parent', '--reverse', `${service.baseSha}..${service.sha}`], cwd));
        if (actual.join(',') !== expected.join(',')) reject(`${service.repo}: 통합 범위가 선택한 서비스 PR들과 정확히 일치하지 않습니다.`);
      }
      if (!state.rootDependenciesInstalled) {
        await command(state, 'Root 검증 의존성 준비', 'npm', ['ci', '--include=dev', '--ignore-scripts']);
        state.rootDependenciesInstalled = true;
        save(state);
      }
      if (!state.productE2eInherited) {
        const inherited = inheritProductE2e(state);
        if (inherited) {
          state.inheritedProductE2e = inherited;
          state.steps.push({ label: '이전 실행의 제품 E2E 승계', status: 'passed', exitCode: 0,
            command: `copy ${inherited.files.map((file) => file.path).join(', ')} from ${inherited.run}`,
            output: '소스만 승계했습니다. 증거는 이 실행에서 다시 생성합니다.' });
        }
        state.productE2eInherited = true;
        save(state);
      }
      if (!state.recordsPrepared) {
        const writes = recordFiles(approval, state.approvalDigest, id);
        for (const [path, content] of writes) {
          assertPathHasNoSymlinks(state.workspace, path);
          mkdirSync(resolve(state.workspace, path, '..'), { recursive: true });
          // Journal every individual write; a retry must see exactly what was recorded.
          state.preparedFiles ??= {};
          if (state.preparedFiles[path]) {
            if (sha256(readFileSync(join(state.workspace, path))) !== state.preparedFiles[path]) reject('부분 준비 기록이 변경되었습니다. 덮어쓰지 않습니다.');
            continue;
          }
          writeFileSync(join(state.workspace, path), content);
          state.preparedFiles[path] = sha256(content);
          save(state);
        }
        state.recordsPrepared = true;
      }
      workspaceCheck(state);
      state.phase = 'prepared';
      state.hasProductE2e = productE2e(state);
      state.error = null;
      state.preparationFingerprint = null;
      save(state);
    } catch (error) {
      state.phase = 'prepare-failed';
      state.error = redact(error.message, env);
      if (existsSync(join(state.workspace, '.git')) && !state.preparationFingerprint) state.preparationFingerprint = rawFingerprint(state);
      save(state);
      throw error;
    }
    return status(id);
  }
  async function packet(id) {
    const state = load(id);
    if (state.phase !== 'prepared') reject('준비된 실행만 Agent에게 위임할 수 있습니다.');
    const approval = await fresh(state);
    const { paths } = workspaceCheck(state);
    const packetPath = checkedPath(`.task-packets/${id}.candidate.md`);
    const copyPath = checkedPath(`.task-packets/candidate-workspaces/${id}/.task-packets/${id}.candidate-approval.json`);
    if (existsSync(packetPath) || existsSync(copyPath)) reject('기존 Agent 패킷을 덮어쓰지 않습니다. 이전 패킷에 따라 e2e/**만 보완하고 다시 검증하세요.');
    mkdirSync(join(state.workspace, '.task-packets'), { recursive: true });
    const original = readFileSync(checkedPath(`.task-packets/${id}.candidate-approval.json`));
    writeFileSync(copyPath, original, { flag: 'wx', mode: 0o600 });
    const body = [
      '# TASK', `- Change ID: ${approval.change}`, `- Work Unit ID: ${approval.unit}`, `- Writer: ${approval.writer}`, `- Run ID: ${id}`, `- Plan SHA: ${approval.planSha}`,
      `- Candidate approval SHA-256: ${state.approvalDigest}`, `- Coordinator root: ${root}`,
      '', '# SCOPE', '- Repository: root', `- Required branch: ${approval.branch}`, `- Base SHA: ${approval.baseSha}`, `- Workspace: ${state.workspace}`,
      '- Allowed paths:', '  - e2e/**', '', '# CONTRACT',
      '- Approved contract snapshots (do not modify):', ...approval.contracts.map((item) => `  - ${item.path} (sha256:${item.digest})`),
      '', '# SERVICE SNAPSHOT', ...approval.services.map((item) => `- ${item.repo}: ${item.sha}`),
      '', '# VERIFY (agent local)', '- npm run test:e2e (expect exit 0)',
      `- node ${resolve(import.meta.dirname, '../workflow-check.mjs')} --plan-sha ${approval.planSha} --change ${approval.change} --unit ${approval.unit} --repo-path ${state.workspace} --candidate-approval ${join(root, '.task-packets', `${id}.candidate-approval.json`)} --candidate-role agent (expect exit 0)`,
      '', '# RESPONSIBILITY',
      '- Write product E2E from the fixed contracts; tests own install/start/temporary data/cleanup.',
      '- Compare the approval copy and packet digest to the original in the Coordinator control directory before editing.',
      '- Only e2e/** is writable. Root records and service pointers are owned by Coordinator tools.',
      '- Do not use credentials, network PR verification, remote publication, branch changes or destructive operations.',
      '- The Coordinator UI will not mutate or verify this workspace until the human confirms your handoff.',
      '', '# HANDOFF', 'Report Change/Work Unit/Run, repository, branch, base/head/plan SHA, changed files, commands and exit codes, unrun checks, deviations, risks and next action.',
      '',
    ].join('\n');
    const content = `${body}Packet SHA-256: ${sha256(body)}\n`;
    writeFileSync(packetPath, content, { flag: 'wx', mode: 0o600 });
    writeFileSync(join(state.workspace, '.task-packets', `${id}.candidate.md`), content, { flag: 'wx', mode: 0o600 });
    state.packetDigest = sha256(content);
    state.agentBaseline = { head: git(['rev-parse', 'HEAD'], state.workspace),
      index: git(['ls-files', '--stage', '--', ':(exclude)e2e/**'], state.workspace),
      files: paths.filter((path) => !path.startsWith('e2e/') && !approval.services.some((service) => service.path === path))
        .map((path) => ({ path, digest: sha256(readFileSync(join(state.workspace, path))) })),
      pointers: approval.services.map((service) => service.path) };
    state.phase = 'agent';
    save(state);
    return { ...status(id), packet: { path: packetPath, content } };
  }
  async function handoff(id) {
    const state = load(id);
    if (state.phase !== 'agent') reject('Agent에게 위임된 실행이 아닙니다.');
    await fresh(state);
    workspaceCheck(state, true);
    const copy = checkedPath(`.task-packets/candidate-workspaces/${id}/.task-packets/${id}.candidate-approval.json`);
    if (sha256(readFileSync(copy)) !== state.approvalDigest || sha256(readFileSync(checkedPath(`.task-packets/${id}.candidate.md`))) !== state.packetDigest
      || sha256(readFileSync(join(state.workspace, '.task-packets', `${id}.candidate.md`))) !== state.packetDigest) reject('Agent 승인 사본 또는 패킷이 변경되었습니다.');
    state.phase = 'prepared';
    state.handoffHead = git(['rev-parse', 'HEAD'], state.workspace);
    state.hasProductE2e = productE2e(state);
    save(state);
    return status(id);
  }
  async function verifyNow(state) {
    const approval = await fresh(state);
    workspaceCheck(state);
    if (requiresProductE2e(approval) && !productE2e(state)) reject('승인된 계획이 제품 E2E를 요구합니다. e2e/** 작성을 위임하거나 직접 작성하세요.');
    const before = fingerprint(state);
    const head = git(['rev-parse', 'HEAD'], state.workspace);
    state.checks = [];
    state.phase = 'verifying';
    save(state);
    const checks = [];
    for (const declared of approval.serviceVerify) for (const command of declared.commands) {
      checks.push({ command, repo: declared.repo, cwd: join(state.workspace, approval.services.find((item) => item.repo === declared.repo).path), targetSha: approval.services.find((item) => item.repo === declared.repo).sha });
    }
    for (const command of approval.verify) {
      // Candidate evidence checks run after human linkage, then again at final HEAD.
      if (!/^npm run verify:candidate(?:\s|$)/.test(command)) checks.push({ command, repo: 'root', cwd: state.workspace, targetSha: head });
    }
    if (!checks.some((check) => /^npm run verify:prs(?:\s|$)/.test(check.command))) checks.push({ command: `npm run verify:prs -- --change ${approval.change}`, repo: 'root', cwd: state.workspace, targetSha: head });
    if ((requiresProductE2e(approval) || productE2e(state)) && !checks.some((check) => /^npm run test:e2e(?:\s|$)/.test(check.command))) {
      checks.push({ command: 'npm run test:e2e', repo: 'root', cwd: state.workspace, targetSha: head });
    }
    const checker = resolve(import.meta.dirname, '../workflow-check.mjs');
    checks.push({ command: process.execPath, args: [checker, '--change', approval.change, '--unit', approval.unit, '--plan-sha', approval.planSha, '--repo-path', state.workspace, '--candidate-approval', join(root, '.task-packets', `${state.run}.candidate-approval.json`)], repo: 'root', cwd: root, targetSha: head, label: '승인 범위 검사' });
    checks.push({ command: process.execPath, args: [resolve(import.meta.dirname, '../verify-registry.mjs'), '--change', approval.change, '--strict'],
      repo: 'root', cwd: state.workspace, targetSha: head, label: 'Root registry 검사' });
    for (const check of checks) {
      const item = { id: `check-${state.checks.length + 1}`, command: check.label ?? check.command, repo: check.repo,
        targetSha: check.targetSha, rootHead: head, approvalDigest: state.approvalDigest, status: 'running' };
      state.checks.push(item);
      save(state);
      const remote = /^npm run verify:prs(?:\s|$)/.test(check.command);
      const result = await execute(check.command, check.args ?? [], { cwd: check.cwd, env: remote ? env : localCheckEnv(env), shell: !check.args });
      Object.assign(item, { exitCode: result.status, status: result.status === 0 ? 'passed' : 'failed', output: redact(`${result.stdout}\n${result.stderr}`, env).slice(-8000) });
      save(state);
    }
    for (const row of approval.rows) {
      const result = await ci(row.slug, row.repo === 'root' ? row.headSha : row.mergeSha, row.repo === 'root' ? 'pull_request' : undefined);
      state.checks.push({ id: `check-${state.checks.length + 1}`, command: `CI ${row.repo} PR #${row.number}`, repo: row.repo, targetSha: row.mergeSha,
        rootHead: head, approvalDigest: state.approvalDigest, exitCode: result.state === 'passed' ? 0 : 1, status: result.state, output: JSON.stringify(result) });
      save(state);
    }
    if (before !== fingerprint(state)) reject('검증 중 파일 또는 SHA가 변경되었습니다. 증거를 사용할 수 없습니다.');
    state.verifiedFingerprint = before;
    state.verifiedHead = head;
    state.phase = state.checks.length && state.checks.every((check) => check.exitCode === 0) ? 'verified' : 'verification-failed';
    state.error = null;
    save(state);
    return status(state.run);
  }
  async function verify(id) {
    const state = load(id);
    if (['verifying', 'publishing'].includes(state.phase)) state.phase = 'verification-interrupted';
    if (!['prepared', 'verified', 'verification-failed', 'pr-failed', 'verification-interrupted'].includes(state.phase)) reject('검증할 수 없는 실행 상태입니다.');
    try { return await verifyNow(state); }
    catch (error) { state.phase = 'verification-failed'; state.verifiedFingerprint = null; state.error = error.message; save(state); throw error; }
  }
  async function evidence(input) {
    const state = load(input.run);
    if (state.phase !== 'verified') reject('통과한 검증에만 증거를 연결할 수 있습니다.');
    const approval = await fresh(state);
    if (state.verifiedFingerprint !== fingerprint(state)) reject('검증 이후 변경되었습니다. 다시 검증하세요.');
    if (!Array.isArray(input.links) || input.links.length !== approval.criteria.length) reject('모든 완료 기준에 증거가 필요합니다.');
    const seen = new Set();
    const entries = input.links.map((link) => {
      if (Object.keys(link).some((key) => !['criterion', 'checkIds', 'note', 'confirmed'].includes(key)) || !approval.criteria.some((item) => item.id === link.criterion) || seen.has(link.criterion)) reject('완료 기준 입력이 올바르지 않습니다.');
      seen.add(link.criterion);
      if (link.confirmed !== true || typeof link.note !== 'string' || !link.note.trim() || link.note.length > 2000 || !Array.isArray(link.checkIds) || !link.checkIds.length) reject('실제 결과의 완료 기준 입증 여부를 사람이 확인하고 설명을 기록해야 합니다.');
      return link.checkIds.map((id) => {
        const check = state.checks.find((item) => item.id === id && item.exitCode === 0 && !item.command.startsWith('CI '));
        if (!check) reject('통과한 실제 검사만 증거로 연결할 수 있습니다.');
        return { criterion: link.criterion, kind: check.repo === 'root' ? 'integration-command' : 'command', command: check.command,
          target_sha: check.targetSha, root_head: state.verifiedHead, approval_digest: state.approvalDigest,
          exit_code: check.exitCode, reviewer: approval.writer, note: redact(link.note.trim(), env), check_id: check.id };
      });
    }).flat();
    const releasePath = join(state.workspace, `changes/${approval.change}/releases/candidate-${approval.candidate}.yaml`);
    const release = YAML.parse(readFileSync(releasePath, 'utf8'));
    release.evidence = entries;
    release.state = 'ready';
    writeFileSync(releasePath, YAML.stringify(release));
    state.preparedFiles[`changes/${approval.change}/releases/candidate-${approval.candidate}.yaml`] = sha256(readFileSync(releasePath));
    state.evidence = entries;
    state.linkedChecks = input.links;
    state.evidenceFingerprint = fingerprint(state);
    save(state);
    try { await candidateChecks(state); }
    catch (error) {
      state.evidenceFingerprint = null;
      state.phase = 'verification-failed';
      state.error = error.message;
      save(state);
      throw error;
    }
    return status(state.run);
  }
  async function pr(id) {
    const state = load(id);
    if (!['verified', 'pr-failed'].includes(state.phase)) reject('검증 통과 후에만 Candidate PR을 만들 수 있습니다.');
    const approval = await fresh(state);
    if (!state.evidence.length || state.evidenceFingerprint !== fingerprint(state)) reject('완료 기준 증거가 없거나 증거 연결 이후 변경되었습니다.');
    workspaceCheck(state);
    state.phase = 'publishing';
    save(state);
    try {
      const paths = workspaceCheck(state).paths;
      if (paths.length) await command(state, '승인 경로만 스테이징', 'git', ['add', '--', ...paths]);
      const staged = splitLines(git(['diff', '--cached', '--name-only'], state.workspace));
      if (staged.some((path) => !pathsAllow(path, approval.writePaths))) reject('Git index에 승인 범위 밖의 파일이 있습니다.');
      if (git(['diff', '--cached', '--name-only'], state.workspace)) {
        await command(state, 'Candidate 커밋', 'git', ['commit', '-m', `feat(${approval.change}): prepare candidate ${approval.candidate}`,
          '-m', `Change-ID: ${approval.change}\nWork-Unit: ${approval.unit}\nAgent-Run-ID: ${id}`]);
      }
      // Only our own commit may change the evidence representation. A subsequent
      // external edit or a check that modifies files must require verification again.
      state.evidenceFingerprint = fingerprint(state);
      save(state);
      const checked = await verifyNow(state);
      if (checked.phase !== 'verified') reject('최종 HEAD 검증이 통과하지 못했습니다.');
      await candidateChecks(state);
      await fresh(state);
      if (git(['status', '--porcelain'], state.workspace) || state.verifiedFingerprint !== fingerprint(state)) reject('최종 검증 후 변경되었습니다. push하지 않습니다.');
      state.phase = 'publishing';
      save(state);
      await command(state, 'Candidate 브랜치 push', 'git', ['push', '-u', 'origin', approval.branch]);
      const slug = rootSlug();
      const existing = await api.list(`/repos/${slug}/pulls?state=all&base=main&head=${encodeURIComponent(`${slug.split('/')[0]}:${approval.branch}`)}`);
      const matching = existing.filter((pull) => pull.head?.ref === approval.branch && pull.base?.ref === 'main');
      if (matching.length > 1) reject('Candidate PR이 여러 개 있습니다. 사람이 확인하세요.');
      let pull = matching[0];
      if (pull && (pull.state !== 'open' || pull.merged_at)) reject('기존 Candidate PR이 닫혔거나 병합되었습니다. 재사용하지 않습니다.');
      if (pull && pull.head?.sha !== state.verifiedHead) reject('기존 Candidate PR의 HEAD가 최종 검증 SHA와 다릅니다.');
      if (!pull) {
        const body = `Candidate ${approval.change}/${approval.candidate}\n\nApproval digest: ${state.approvalDigest}\nRoot HEAD: ${state.verifiedHead}\n\n${approval.services.map((item) => `${item.repo}: ${item.sha}`).join('\n')}\n\n완료 기준 증거를 사람이 확인했습니다. 병합, main CI, 통합 환경 확인은 별도 단계입니다.`;
        const result = await command(state, 'Candidate PR 생성', 'gh', ['pr', 'create', '--repo', slug, '--base', 'main', '--head', approval.branch, '--title', `feat(${approval.change}): candidate ${approval.candidate}`, '--body', body], state.workspace);
        const url = result.stdout.trim().split('\n').find((line) => /^https:\/\//.test(line));
        if (!url) reject('생성된 PR URL을 확인할 수 없습니다. 다시 조회하세요.');
        pull = { html_url: url, number: Number(url.split('/').at(-1)) };
      }
      state.pr = { number: pull.number, url: pull.html_url, headSha: state.verifiedHead };
      state.phase = 'pr-created';
      state.error = null;
      save(state);
    } catch (error) {
      state.phase = 'pr-failed';
      state.error = redact(error.message, env);
      save(state);
      throw error;
    }
    return status(id);
  }
  // A starting point for the human, never an answer: the per-criterion confirmation stays theirs.
  function suggestEvidence(state, approval) {
    const passing = (state.checks ?? []).filter((check) => check.exitCode === 0 && !check.command.startsWith('CI '));
    const integration = passing.filter((check) => check.repo === 'root' && /\btest:e2e\b/.test(check.command));
    const perService = passing.filter((check) => check.repo !== 'root');
    return approval.criteria.map((criterion) => {
      const named = perService.filter((check) => criterion.text.includes(check.repo));
      const declaredChecks = /검증|테스트|CI|lint|typecheck|build|pytest/.test(criterion.text);
      const picked = named.length ? named
        : declaredChecks && perService.length ? perService
          : integration.length ? integration : passing.slice(0, 1);
      return { criterion: criterion.id, checkIds: picked.map((check) => check.id), suggested: true,
        note: picked.map((check) => `${check.repo} · ${check.command} → exit ${check.exitCode} (대상 ${String(check.targetSha ?? '').slice(0, 7)})`).join('\n') };
    });
  }
  function status(id) {
    if (!id) return { runs: runs().map((state) => ({ run: state.run, change: state.change, candidate: state.candidate, phase: state.phase })),
      changes: existsSync(join(root, 'changes')) ? readdirSync(join(root, 'changes')).filter((change) => !change.startsWith('_') && existsSync(join(root, 'changes', change, 'WORK_UNITS.yaml')) && ['approved', 'active'].includes(YAML.parse(readFileSync(join(root, 'changes', change, 'WORK_UNITS.yaml'), 'utf8')).state)) : [] };
    const state = load(id);
    const approval = snapshot(state);
    const job = jobs.get(id);
    const phase = !job?.running && state.phase === 'preparing' ? 'prepare-failed'
      : ['verifying', 'publishing'].includes(state.phase) && !job?.running ? 'verification-interrupted'
      : state.phase === 'closing' && !job?.running ? 'pr-created' : state.phase;
    let packet;
    if (state.packetDigest) {
      const packetPath = checkedPath(`.task-packets/${id}.candidate.md`);
      const content = readFileSync(packetPath, 'utf8');
      if (sha256(content) !== state.packetDigest) reject('원본 Agent 패킷이 변경되었습니다.');
      packet = { path: packetPath, content };
    }
    const suggestions = phase === 'verified' && !state.linkedChecks ? suggestEvidence(state, approval) : undefined;
    const hasProductE2e = existsSync(join(state.workspace, '.git')) ? productE2e(state) : Boolean(state.hasProductE2e);
    // A local ref read, no network: an approval pinned to a superseded Root base can never
    // proceed, so say so instead of letting every action fail one at a time. Only the phases
    // before publication are gated on freshness — once the Candidate PR exists, main moving
    // past the approved base is the expected outcome, not an expiry.
    const head = gitResult(['rev-parse', 'origin/main']);
    const stale = head.status === 0 && head.stdout.trim() !== approval.baseSha
      && !['pr-created', 'closing', 'closure-pr-created', 'closed'].includes(phase);
    return { ...state, phase, approval, job, packet, suggestions, hasProductE2e, stale, needsProductE2e: requiresProductE2e(approval),
      gates: { prCreated: Boolean(state.pr), merged: Boolean(state.remote?.merged), mainCiPassed: Boolean(state.remote?.mainCiPassed),
        integrationEnvironment: state.closure ? 'confirmed' : 'human-confirmation-required',
        closurePrCreated: Boolean(state.closure?.pr), closureMerged: Boolean(state.closure?.merged), closed: phase === 'closed' } };
  }
  async function remoteStatus(id) {
    const state = load(id);
    if (!state.pr) reject('Candidate PR이 아직 없습니다.');
    const pull = await api.get(`/repos/${rootSlug()}/pulls/${state.pr.number}`);
    if (pull.head?.sha !== state.pr.headSha || pull.head?.ref !== snapshot(state).branch) reject('Candidate PR HEAD가 최종 검증 이후 변경되었습니다.');
    const merged = Boolean(pull.merged_at);
    const mainCi = merged ? await ci(rootSlug(), pull.merge_commit_sha, 'push') : { state: 'pending' };
    state.remote = { merged, mergeSha: merged ? pull.merge_commit_sha : null, mainCiPassed: mainCi.state === 'passed',
      mainCiUrl: mainCi.checks?.find((check) => check.name === 'main')?.url ?? null };
    // The change is closed when its closure record is on main, not when the PR exists.
    if (state.closure?.pr) {
      const closurePull = await api.get(`/repos/${rootSlug()}/pulls/${state.closure.pr.number}`);
      if (closurePull.head?.ref !== `change/${state.change}/candidate-closure`) reject('마감 PR 브랜치가 기록과 다릅니다.');
      state.closure.merged = Boolean(closurePull.merged_at);
      state.closure.mergeSha = state.closure.merged ? closurePull.merge_commit_sha : null;
      if (state.closure.merged) state.phase = 'closed';
    }
    save(state);
    return status(id);
  }
  // One human decision opens the whole run: approve the discovered PR/SHA set, then
  // preparation and verification follow without further presses.
  async function start(input) {
    const change = safeIdentifier('Change ID', input.change);
    const result = await preview({ change });
    if (!result.ready) reject('아직 마감을 시작할 수 없습니다. 막고 있는 항목을 먼저 해결하세요.');
    return { run: runIdFor(change, result.candidate, takenRunId), revision: result.revision };
  }
  function closureFiles(approval, state, mergeSha, base) {
    const prefix = `changes/${approval.change}`;
    const read = (path) => readFileSync(join(state.workspace, path), 'utf8');
    const manifest = YAML.parse(read(`${prefix}/WORK_UNITS.yaml`));
    const integration = manifest.work_units.find((unit) => unit.id === approval.unit);
    if (!integration) reject('마감할 Candidate 작업 기록이 없습니다.');
    integration.state = 'merged';
    const closureBranch = `change/${approval.change}/candidate-closure`;
    let closure = manifest.work_units.find((unit) => unit.branch === closureBranch);
    if (!closure) {
      closure = { id: 'candidate-closure', repo: 'root', goal: 'Record post-merge gate outcomes and close the change.', branch: closureBranch };
      manifest.work_units.push(closure);
    }
    Object.assign(closure, {
      state: 'merged', base_sha: base, writer: approval.writer,
      write_paths: [`${prefix}/WORK_UNITS.yaml`, `${prefix}/STATUS.md`, `${prefix}/releases/**`],
      depends_on: [approval.unit],
      verify: ['npm test', `npm run verify:registry -- --change ${approval.change} --strict`],
    });
    manifest.state = 'complete';
    const releasePath = `${prefix}/releases/candidate-${approval.candidate}.yaml`;
    const release = YAML.parse(read(releasePath));
    release.state = 'complete';
    release.closure = {
      candidate_merge_sha: mergeSha,
      main_ci: state.remote.mainCiUrl ?? 'passed',
      environment: { note: state.closure.environment.note, confirmed_by: approval.writer, confirmed_at: state.closure.confirmedAt },
    };
    const services = approval.services.map((service) => `- ${service.repo}: \`${service.sha}\``).join('\n');
    const evidence = (state.evidence ?? []).map((item) => `- ${item.criterion}: \`${item.command}\` exit ${item.exit_code}`).join('\n');
    const before = read(`${prefix}/STATUS.md`);
    const marked = /^\*\*State:\*\* .*$/m.test(before)
      ? before.replace(/^\*\*State:\*\* .*$/m, '**State:** COMPLETE')
      : before.replace(/^(#[^\n]*\n)?/, (heading) => `${heading}\n**State:** COMPLETE\n`);
    const status = `${marked}
## Closure

- Plan SHA: \`${approval.planSha}\`
- Candidate PR: #${state.pr.number} merged as \`${mergeSha}\`
- Service merge SHAs:
${services}
- Acceptance evidence:
${evidence}
- Gates: Candidate PR created, merged, Root main CI passed, integration environment confirmed by a human.
- Integration environment: ${state.closure.environment.note}
`;
    return [
      [`${prefix}/WORK_UNITS.yaml`, YAML.stringify(manifest)],
      [`${prefix}/STATUS.md`, status],
      [releasePath, YAML.stringify(release)],
    ];
  }
  // Checked before the job starts so a bad input answers immediately, not after a round trip.
  function closeReady(input) {
    const state = load(safeIdentifier('Run ID', input.run));
    if (['closure-pr-created', 'closed'].includes(state.phase)) return state;
    if (state.phase !== 'pr-created') reject('Candidate PR 병합과 main CI 통과 후에만 마감할 수 있습니다.');
    const note = String(input.environment?.note ?? '').trim();
    if (input.environment?.confirmed !== true || !note || note.length > 2000) reject('통합 환경에서 확인한 내용을 적고 직접 확인했음을 표시해야 합니다.', 422);
    if (!state.pr || !state.remote?.merged || !state.remote?.mainCiPassed) reject('병합과 main CI 통과를 먼저 확인하세요.');
    return state;
  }
  // The only thing a machine cannot observe is whether a human looked at the running system.
  async function close(input) {
    const state = closeReady(input);
    if (['closure-pr-created', 'closed'].includes(state.phase)) return status(state.run);
    const note = String(input.environment.note).trim();
    const approval = snapshot(state);
    const mergeSha = state.remote.mergeSha;
    if (!isFullSha(mergeSha)) reject('병합 SHA를 확인할 수 없습니다. 병합 상태를 다시 조회하세요.');
    state.closure = { environment: { note: redact(note, env) }, confirmedAt: new Date().toISOString() };
    state.phase = 'closing';
    save(state);
    try {
      await command(state, '마감 base 확인', 'git', ['fetch', 'origin', 'main']);
      // The Candidate merge must really be in main's history. Main moving on past it is
      // normal — other changes land while a Coordinator checks the integration environment.
      if (gitResult(['merge-base', '--is-ancestor', mergeSha, 'origin/main'], state.workspace).status !== 0) {
        reject('Candidate 병합 SHA가 Root main 히스토리에 없습니다. 병합 상태를 다시 조회하세요.');
      }
      const base = git(['rev-parse', 'origin/main'], state.workspace);
      const branch = `change/${approval.change}/candidate-closure`;
      if (gitResult(['rev-parse', '--verify', `refs/heads/${branch}`], state.workspace).status !== 0) {
        await command(state, '마감 브랜치 준비', 'git', ['switch', '-c', branch, base]);
      } else if (git(['branch', '--show-current'], state.workspace) !== branch) reject('기존 마감 브랜치를 자동 전환하지 않습니다.');
      const allowed = [`changes/${approval.change}/WORK_UNITS.yaml`, `changes/${approval.change}/STATUS.md`, `changes/${approval.change}/releases/**`];
      const writes = closureFiles(approval, state, mergeSha, base);
      for (const [path, content] of writes) {
        if (!pathsAllow(path, allowed)) reject('마감 기록 경로가 허용 범위 밖입니다.');
        assertPathHasNoSymlinks(state.workspace, path);
        writeFileSync(join(state.workspace, path), content);
      }
      await command(state, '마감 기록 스테이징', 'git', ['add', '--', ...writes.map(([path]) => path)]);
      const staged = splitLines(git(['diff', '--cached', '--name-only'], state.workspace));
      if (!staged.length) reject('마감으로 기록할 변경이 없습니다.');
      if (staged.some((path) => !pathsAllow(path, allowed))) reject('Git index에 마감 범위 밖의 파일이 있습니다.');
      await command(state, '마감 커밋', 'git', ['commit', '-m', `chore(${approval.change}): close change`,
        '-m', `Change-ID: ${approval.change}\nWork-Unit: candidate-closure\nAgent-Run-ID: ${state.run}`]);
      await command(state, 'Root registry 검사', process.execPath,
        [resolve(import.meta.dirname, '../verify-registry.mjs'), '--change', approval.change, '--strict'], state.workspace);
      await command(state, '마감 브랜치 push', 'git', ['push', '-u', 'origin', branch]);
      const slug = rootSlug();
      const existing = await api.list(`/repos/${slug}/pulls?state=all&base=main&head=${encodeURIComponent(`${slug.split('/')[0]}:${branch}`)}`);
      const matching = existing.filter((pull) => pull.head?.ref === branch && pull.base?.ref === 'main');
      if (matching.length > 1) reject('마감 PR이 여러 개 있습니다. 사람이 확인하세요.');
      let pull = matching.find((item) => item.state === 'open' && !item.merged_at);
      if (!pull && matching.length) reject('기존 마감 PR이 닫혔거나 병합되었습니다. 재사용하지 않습니다.');
      if (!pull) {
        const body = `Close ${approval.change}\n\nCandidate PR: #${state.pr.number} (merged ${mergeSha})\nRoot main CI: passed\n\n통합 환경 확인: ${state.closure.environment.note}\n\n모든 완료 기준 증거는 Candidate 기록에 있습니다.`;
        const result = await command(state, '마감 PR 생성', 'gh', ['pr', 'create', '--repo', slug, '--base', 'main', '--head', branch,
          '--title', `chore(${approval.change}): close change`, '--body', body], state.workspace);
        const url = result.stdout.trim().split('\n').find((line) => /^https:\/\//.test(line));
        if (!url) reject('생성된 마감 PR URL을 확인할 수 없습니다. 다시 조회하세요.');
        pull = { html_url: url, number: Number(url.split('/').at(-1)) };
      }
      state.closure.pr = { number: pull.number, url: pull.html_url };
      // Creating the closure PR is not closing the change; a human still merges it.
      state.phase = 'closure-pr-created';
      state.error = null;
      save(state);
    } catch (error) {
      state.phase = 'pr-created';
      state.error = redact(error.message, env);
      save(state);
      throw error;
    }
    return status(state.run);
  }
  const actionHandlers = { prepare, packet, handoff, verify, pr, 'remote-status': remoteStatus };
  async function perform(action, input) {
    if (action === 'preview') {
      if (active) reject('Candidate 작업이 진행 중입니다.');
      return preview(input);
    }
    if (action === 'start') {
      if (active) reject('Candidate 작업이 진행 중입니다.');
      if (runs().some((item) => item.phase === 'agent')) reject('Agent가 workspace를 사용 중입니다. 먼저 인계를 확인하세요.');
      const { run: id, revision } = await start(input);
      if (jobs.get(id)?.running) reject('Candidate 작업이 이미 실행 중입니다.');
      // Approve synchronously so the caller gets a run it can immediately render.
      await locked('approve', id, () => approve({ revision, run: id }));
      const job = { action, running: true, startedAt: new Date().toISOString() };
      jobs.set(id, job);
      (async () => {
        await locked('prepare', id, () => prepare(id));
        // Stop at the honest blocker instead of failing verification for a suite the
        // plan requires but nobody has written yet.
        const ready = status(id);
        if (!ready.needsProductE2e || ready.hasProductE2e) await locked('verify', id, () => verify(id));
      })().then(() => { job.running = false; }, (error) => { job.running = false; job.error = redact(error.message, env); });
      return { run: id, job };
    }
    if (action === 'close') {
      const id = safeIdentifier('Run ID', input.run);
      if (active || jobs.get(id)?.running) reject('Candidate 작업이 이미 실행 중입니다.');
      if (runs().some((item) => item.phase === 'agent')) reject('Agent가 workspace를 사용 중입니다. 먼저 인계를 확인하세요.');
      if (['closure-pr-created', 'closed'].includes(closeReady(input).phase)) return status(id);
      const job = { action, running: true, startedAt: new Date().toISOString() };
      jobs.set(id, job);
      locked(action, id, () => close(input)).then(() => { job.running = false; }, (error) => { job.running = false; job.error = redact(error.message, env); });
      return { run: id, job };
    }
    if (action === 'approve' || action === 'evidence') {
      // Same global lock for short state writes; inputs never contain shell commands or paths.
      return locked(action, safeIdentifier('Run ID', input.run), () => action === 'approve' ? approve(input) : evidence(input));
    }
    if (!actionHandlers[action]) reject('지원하지 않는 Candidate 작업입니다.', 404);
    const id = safeIdentifier('Run ID', input.run);
    const state = load(id);
    const phase = ['verifying', 'publishing'].includes(state.phase) && !jobs.get(id)?.running ? 'verification-interrupted' : state.phase;
    if (runs().some((item) => item.phase === 'agent') && action !== 'handoff') reject('Agent가 workspace를 사용 중입니다. 먼저 인계를 확인하세요.');
    if (['prepare', 'verify', 'pr'].includes(action)) {
      const allowedPhases = {
        prepare: ['approved', 'preparing', 'prepare-failed'],
        verify: ['prepared', 'verified', 'verification-failed', 'pr-failed', 'verification-interrupted'],
        pr: ['verified', 'pr-failed'],
      }[action];
      if (!allowedPhases.includes(phase)) reject('이 상태에서는 실행할 수 없습니다. 준비와 검증을 먼저 완료하세요.');
      if (active || jobs.get(id)?.running) reject('Candidate 작업이 이미 실행 중입니다.');
      const job = { action, running: true, startedAt: new Date().toISOString() };
      jobs.set(id, job);
      locked(action, id).then(() => { job.running = false; }, (error) => { job.running = false; job.error = redact(error.message, env); });
      return { run: id, job };
    }
    return locked(action, id);
  }
  function rawFingerprint(state) {
    return sha256(JSON.stringify({ head: git(['rev-parse', 'HEAD'], state.workspace),
      diff: git(['diff', '--binary', 'HEAD'], state.workspace),
      staged: git(['diff', '--cached', '--binary'], state.workspace),
      untracked: splitLines(git(['ls-files', '--others', '--exclude-standard'], state.workspace)).map((path) => [path, sha256(readFileSync(join(state.workspace, path)))]) }));
  }
  async function candidateChecks(state) {
    const approval = snapshot(state);
    const before = fingerprint(state);
    // All declared Candidate checks plus the exact selected Candidate number are mandatory.
    for (const check of approval.verify.filter((value) => /^npm run verify:candidate(?:\s|$)/.test(value))) {
      const resolved = /--candidate(?:\s|=)/.test(check) ? check : `${check} --candidate ${approval.candidate}`;
      await command(state, '선언된 Candidate 검사', resolved, [], state.workspace, true);
    }
    await command(state, '정확한 Candidate 검사', 'npm', ['run', 'verify:candidate', '--', '--change', approval.change, '--candidate', approval.candidate, '--target-ref', 'origin/main']);
    if (before !== fingerprint(state)) reject('Candidate 검사 중 변경되었습니다.');
  }
  return { perform, status };
}
