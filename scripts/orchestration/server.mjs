import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { createPlanPr } from './plan-pr.mjs';
import { assertPathHasNoSymlinks, buildChangeFiles, managedDraftContractPaths, normalizeDraft, recoverChangeWrites, saveChange, validateDraft } from './change-service.mjs';

const moduleRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const BODY_LIMIT = 1024 * 1024;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const STACK_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9+_.-]{0,63}$/;
const FULL_SHA = /^[0-9a-f]{40}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
const STACK_MARKERS = [
  ['package.json', 'node'],
  ['pyproject.toml', 'python'],
  ['requirements.txt', 'python'],
  ['Cargo.toml', 'rust'],
  ['go.mod', 'go'],
  ['pom.xml', 'java-maven'],
  ['build.gradle', 'java-gradle'],
  ['build.gradle.kts', 'kotlin-gradle'],
];

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function registryAt(root) {
  const path = join(root, 'services/registry.yaml');
  if (!existsSync(path)) throw new Error('services/registry.yaml을 찾을 수 없습니다. Coordination Root에서 실행하세요.');
  const registry = YAML.parse(readFileSync(path, 'utf8')) ?? {};
  const services = Array.isArray(registry.services) ? registry.services : [];
  return { ...registry, services };
}

function serviceInput(root, repo) {
  let parsed;
  try {
    parsed = new URL(String(repo ?? '').trim());
  } catch {
    throw new Error('올바른 GitHub HTTPS URL을 입력하세요.');
  }
  const registry = registryAt(root);
  if (parsed.protocol !== 'https:' || parsed.hostname !== registry.github?.host || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash) {
    throw new Error(`서비스 저장소는 ${registry.github?.host || '설정된 GitHub 호스트'}의 HTTPS URL이어야 합니다.`);
  }
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length !== 2) throw new Error('GitHub 저장소 URL은 조직/저장소 형식이어야 합니다.');
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(parts[0])) throw new Error('GitHub 조직 또는 사용자 이름 형식이 올바르지 않습니다.');
  const id = parts[1].replace(/\.git$/i, '');
  if (!IDENTIFIER.test(id)) throw new Error('저장소 이름은 서비스 ID로 사용할 수 없는 형식입니다.');
  return {
    repo: parsed.toString().replace(/\/$/, ''),
    id,
    path: `services/${id}`,
    owners: [`@${parts[0]}`],
  };
}

function serviceAdd(root, service, { apply = false } = {}) {
  const commandArgs = ['--repo', service.repo, '--stack', service.stack];
  const packagePath = join(root, 'package.json');
  const hasServiceAddScript = existsSync(packagePath)
    && Boolean(JSON.parse(readFileSync(packagePath, 'utf8')).scripts?.['service:add']);
  const command = hasServiceAddScript ? (process.platform === 'win32' ? 'npm.cmd' : 'npm') : process.execPath;
  const args = hasServiceAddScript
    ? ['run', 'service:add', '--', ...commandArgs]
    : [join(moduleRoot, 'scripts/service-add.mjs'), ...commandArgs];
  if (apply) args.push('--apply');
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || '서비스 등록 확인에 실패했습니다.').trim());
  return { output: result.stdout.trim(), exitCode: result.status ?? 0 };
}

function detectStack(root, service) {
  const directory = mkdtempSync(join(tmpdir(), 'orchestration-service-'));
  try {
    const result = spawnSync('git', ['clone', '--depth', '1', '--no-checkout', '--filter=blob:none', service.repo, directory], {
      cwd: root,
      encoding: 'utf8',
      timeout: 30_000,
    });
    if (result.status !== 0) return { stack: 'unspecified', detected: false, marker: null };
    const tree = spawnSync('git', ['ls-tree', '-r', '--name-only', 'HEAD'], { cwd: directory, encoding: 'utf8' });
    if (tree.status !== 0) return { stack: 'unspecified', detected: false, marker: null };
    const names = new Set(tree.stdout.split('\n').map((path) => path.split('/').at(-1)));
    const marker = STACK_MARKERS.find(([file]) => names.has(file));
    return { stack: marker?.[1] ?? 'unspecified', detected: Boolean(marker), marker: marker?.[0] ?? null };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function previewService(root, input) {
  const service = serviceInput(root, input?.repo);
  const candidate = { ...service, ...detectStack(root, service) };
  return { service: candidate, dryRun: serviceAdd(root, candidate) };
}

function registerService(root, input) {
  const service = serviceInput(root, input?.repo);
  const stack = String(input?.stack ?? '').trim();
  if (!STACK_IDENTIFIER.test(stack)) throw new Error('기술 스택은 영문, 숫자, +, _, ., -만 사용해 입력하세요.');
  const candidate = { ...service, stack };
  serviceAdd(root, candidate);
  const applied = serviceAdd(root, candidate, { apply: true });
  return { service: repositoryContext(root).services.find(({ id }) => id === candidate.id), applied };
}

function serviceBase(root, service, registryVersion) {
  try {
    const row = git(root, ['ls-tree', 'HEAD', '--', service.path]);
    const gitlink = row.match(/^160000 commit ([0-9a-f]{40})\t/)?.[1];
    if (gitlink) return gitlink;
  } catch {
    // Fall back to the initialized service checkout for registry-v1 fixtures.
  }
  try {
    const row = git(root, ['ls-files', '--stage', '--', service.path]);
    const gitlink = row.match(/^160000 ([0-9a-f]{40}) 0\t/)?.[1];
    if (gitlink) return null;
  } catch {
    // A service that is neither committed nor staged is invalid for registry v2.
  }
  if (registryVersion >= 2) {
    throw new Error(`서비스 ${service.id}의 등록 커밋을 Root gitlink에서 찾을 수 없습니다.`);
  }
  try {
    return git(join(root, service.path), ['rev-parse', 'HEAD']);
  } catch {
    return null;
  }
}

function bootstrapEligible(root, service, baseSha) {
  if (!baseSha) return false;
  try {
    const files = git(join(root, service.path), ['ls-tree', '-r', '--name-only', baseSha])
      .split('\n')
      .map((item) => item.trim())
      .filter(Boolean);
    const anchorFiles = new Set(['README', 'README.md', '.gitignore', 'LICENSE', 'LICENSE.md']);
    return files.length > 0 && files.every((file) => anchorFiles.has(file));
  } catch {
    return false;
  }
}

function markdownSection(markdown, heading) {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start < 0) return '';
  const canonicalHeadings = new Set(['State', 'Goals', 'Goal', 'Non-goals', 'User flow', 'Acceptance criteria', 'Contracts', 'Order', 'Risks', 'Rollback', 'Stop conditions']);
  const end = lines.findIndex((line, index) => index > start && canonicalHeadings.has(line.replace(/^##\s+/, '').trim()));
  return lines.slice(start + 1, end < 0 ? lines.length : end).join('\n').trim();
}

function listItems(section, pattern = /^-\s+(.*)$/) {
  const items = [];
  for (const line of section.split('\n')) {
    const match = line.match(pattern);
    if (match) items.push(match[1].trim());
    else if (items.length && line.trim() && !line.trimStart().startsWith('-')) items[items.length - 1] += ` ${line.trim()}`;
  }
  return items;
}

function readDraftChange(root, changeId, manifest) {
  const directory = join(root, 'changes', changeId);
  const draftPath = join(directory, 'DRAFT.json');
  if (existsSync(draftPath)) {
    assertPathHasNoSymlinks(directory, 'DRAFT.json');
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(draftPath, 'utf8'));
    } catch {
      throw new Error(`draft Change ${changeId}의 DRAFT.json 형식이 올바르지 않습니다.`);
    }
    const draft = normalizeDraft(parsed);
    if (draft.changeId !== changeId) throw new Error(`draft Change ${changeId}의 Change ID가 디렉터리와 일치하지 않습니다.`);
    for (const contract of draft.contracts) {
      assertPathHasNoSymlinks(directory, `contracts/${contract.name}`);
      const contractPath = join(directory, 'contracts', contract.name);
      if (!existsSync(contractPath)) throw new Error(`draft Change ${changeId}의 계약 파일 contracts/${contract.name}을 찾을 수 없습니다.`);
      const expected = contract.content.endsWith('\n') ? contract.content : `${contract.content}\n`;
      if (readFileSync(contractPath, 'utf8') !== expected) throw new Error(`draft Change ${changeId}의 계약 파일 contracts/${contract.name}이 DRAFT.json과 일치하지 않습니다.`);
    }
    return draft;
  }
  const planPath = join(directory, 'PLAN.md');
  if (!existsSync(planPath)) throw new Error(`draft Change ${changeId}에 PLAN.md가 없습니다.`);
  assertPathHasNoSymlinks(directory, 'PLAN.md');
  const plan = readFileSync(planPath, 'utf8');
  const title = plan.match(/^#\s+[^—\n]+—\s*(.+)$/m)?.[1]?.trim() ?? '';
  const coordinator = plan.match(/^- Coordinator:\s*(.+)$/m)?.[1]?.trim() ?? '';
  const goalsSection = markdownSection(plan, 'Goals');
  const goalMatches = [...goalsSection.matchAll(/^###\s+(\S+)\s+—\s+(.+)\n+([\s\S]*?)(?=^###\s+|(?![\s\S]))/gm)];
  let goals = goalMatches.map((match) => ({ id: match[1].trim(), title: match[2].trim(), outcome: match[3].trim() }));
  if (!goals.length) {
    const outcome = markdownSection(plan, 'Goal');
    if (outcome) goals = [{ id: 'GOAL-001', title: title || 'Primary goal', outcome }];
  }
  const nonGoals = listItems(markdownSection(plan, 'Non-goals'));
  const userFlow = listItems(markdownSection(plan, 'User flow'), /^\d+\.\s+(.*)$/);
  const acceptanceCriteria = listItems(markdownSection(plan, 'Acceptance criteria'), /^-\s+(?:\[AC-\d+\]\s*)?(.*)$/);
  const declaredContracts = [...plan.matchAll(/`contracts\/([^`]+)`(?:\s*\(([^)]+)\))?/g)];
  const contractServices = new Map(declaredContracts.map((match) => [
    match[1],
    String(match[2] ?? '').split('↔').map((item) => item.trim()).filter(Boolean),
  ]));
  const contractsPath = join(directory, 'contracts');
  for (const name of contractServices.keys()) {
    if (!existsSync(join(contractsPath, name))) throw new Error(`draft Change ${changeId}의 계약 파일 contracts/${name}을 찾을 수 없습니다.`);
  }
  const contracts = existsSync(contractsPath)
    ? [...contractServices].map(([name, serviceIds]) => {
      assertPathHasNoSymlinks(directory, `contracts/${name}`);
      return {
        name,
        content: readFileSync(join(contractsPath, name), 'utf8'),
        serviceIds,
      };
    })
    : [];
  const workUnits = (manifest.work_units ?? [])
    .filter((unit) => !['contract-and-plan', 'candidate-integration'].includes(unit.id))
    .map((unit) => ({
      id: unit.id,
      goalId: unit.goal_id ?? '',
      service: unit.repo ?? '',
      goal: unit.goal ?? '',
      writer: unit.writer ?? '',
      writePaths: unit.write_paths ?? [],
      dependsOn: (unit.depends_on ?? []).filter((id) => id !== 'contract-and-plan'),
      verify: unit.verify ?? [],
    }));
  if (goals.length === 1) {
    for (const unit of workUnits) if (!unit.goalId) unit.goalId = goals[0].id;
  }
  const services = [...new Set([...workUnits.map(({ service }) => service), ...contracts.flatMap(({ serviceIds }) => serviceIds)])];
  const noneDeclared = nonGoals.length === 1 && nonGoals[0] === 'None declared for this Change.';
  return normalizeDraft({
    changeId,
    title,
    coordinator,
    goals,
    noNonGoals: noneDeclared,
    nonGoals: noneDeclared ? [] : nonGoals,
    hasUserFlow: userFlow.length > 0,
    userFlow,
    acceptanceCriteria,
    services,
    noSharedContract: contracts.length === 0,
    contracts,
    workUnits,
  });
}

function activeDraftAt(root, changes) {
  const drafts = [];
  for (const changeId of changes) {
    const manifestPath = join(root, 'changes', changeId, 'WORK_UNITS.yaml');
    if (!existsSync(manifestPath)) continue;
    assertPathHasNoSymlinks(join(root, 'changes', changeId), 'WORK_UNITS.yaml');
    const manifest = YAML.parse(readFileSync(manifestPath, 'utf8')) ?? {};
    if (String(manifest.state).toLowerCase() === 'draft') drafts.push({ changeId, manifest });
  }
  if (drafts.length > 1) {
    throw new Error(`draft Change는 하나만 허용합니다: ${drafts.map(({ changeId }) => changeId).join(', ')}`);
  }
  return drafts.length ? readDraftChange(root, drafts[0].changeId, drafts[0].manifest) : null;
}

function changeSummary(root, changeId) {
  const directory = join(root, 'changes', changeId);
  const manifestPath = join(directory, 'WORK_UNITS.yaml');
  if (!existsSync(manifestPath)) return { state: 'unknown', planningPr: null };
  const manifest = YAML.parse(readFileSync(manifestPath, 'utf8')) ?? {};
  const prsPath = join(directory, 'PRS.yaml');
  let planningPr = null;
  if (existsSync(prsPath)) {
    const row = (YAML.parse(readFileSync(prsPath, 'utf8')) ?? {}).prs?.find((entry) => entry.work_unit === 'contract-and-plan');
    if (Number.isInteger(row?.number)) planningPr = { number: row.number, state: String(row.state ?? '') };
  }
  return { state: String(manifest.state ?? ''), planningPr };
}

export function repositoryContext(root) {
  recoverChangeWrites(root);
  const registry = registryAt(root);
  let head;
  let branch;
  let dirty;
  try {
    head = git(root, ['rev-parse', 'HEAD']);
    branch = git(root, ['branch', '--show-current']) || '(detached)';
    dirty = Boolean(git(root, ['status', '--porcelain']));
  } catch {
    throw new Error('현재 폴더가 커밋이 있는 Git Coordination Root가 아닙니다.');
  }
  const changesPath = join(root, 'changes');
  const changes = existsSync(changesPath)
    ? readdirSync(changesPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('_'))
      .map((entry) => entry.name)
      .sort()
    : [];
  return {
    root,
    head,
    branch,
    dirty,
    changes,
    changeStates: Object.fromEntries(changes.map((changeId) => [changeId, changeSummary(root, changeId)])),
    activeDraft: activeDraftAt(root, changes),
    services: registry.services.map((service) => {
      const baseSha = serviceBase(root, service, registry.version ?? 1);
      return { ...service, baseSha, bootstrapEligible: bootstrapEligible(root, service, baseSha) };
    }),
  };
}

function revisionFor(root, draft, files, context) {
  const hash = createHash('sha256');
  hash.update(context.head);
  hash.update(git(root, ['status', '--porcelain=v1']));
  hash.update(git(root, ['diff', '--binary', 'HEAD', '--', 'services/registry.yaml', '.gitmodules', 'changes']));
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '--', 'services/registry.yaml', '.gitmodules', 'changes'])
    .split('\n').filter(Boolean).sort();
  for (const path of untracked) hash.update(path).update('\0').update(readFileSync(join(root, path))).update('\0');
  hash.update(JSON.stringify(normalizeDraft(draft)));
  for (const [path, content] of files) hash.update(path).update('\0').update(content).update('\0');
  return hash.digest('hex');
}

function strictValidation(root, draft, files, { replaceDraft = false } = {}) {
  const fixture = mkdtempSync(join(tmpdir(), 'orchestration-preview-'));
  try {
    mkdirSync(join(fixture, 'services'), { recursive: true });
    cpSync(join(root, 'services/registry.yaml'), join(fixture, 'services/registry.yaml'));
    if (existsSync(join(root, '.gitmodules'))) cpSync(join(root, '.gitmodules'), join(fixture, '.gitmodules'));
    if (existsSync(join(root, 'changes'))) cpSync(join(root, 'changes'), join(fixture, 'changes'), { recursive: true });
    for (const service of repositoryContext(root).services) {
      mkdirSync(join(fixture, service.path, '.git'), { recursive: true });
    }
    saveChange(fixture, draft.changeId, files, { replaceDraft });
    const result = spawnSync(process.execPath, [join(moduleRoot, 'scripts/verify-registry.mjs'), '--change', draft.changeId, '--strict'], {
      cwd: fixture,
      encoding: 'utf8',
    });
    return {
      exitCode: result.status ?? 1,
      output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(),
    };
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

function previewFileDiff(root, changeId, path, content, replacingActiveDraft) {
  const label = `changes/${changeId}/${path}`;
  const existingPath = join(root, label);
  if (!replacingActiveDraft || !existsSync(existingPath)) {
    return `--- /dev/null\n+++ b/${label}\n${content.split('\n').map((line) => `+${line}`).join('\n')}`;
  }
  const existing = readFileSync(existingPath, 'utf8');
  if (existing === content) return `--- a/${label}\n+++ b/${label}\n`;
  return `--- a/${label}\n+++ b/${label}\n${existing.split('\n').map((line) => `-${line}`).join('\n')}\n${content.split('\n').map((line) => `+${line}`).join('\n')}`;
}

export function previewChange(root, input) {
  const context = repositoryContext(root);
  const checked = validateDraft(input, context);
  if (!checked.valid) return { valid: false, errors: checked.errors, unresolved: checked.errors };
  if (context.activeDraft && context.activeDraft.changeId !== checked.draft.changeId) {
    const errors = [{
      field: 'changeId',
      code: 'ACTIVE_DRAFT_EXISTS',
      message: `활성 초안 ${context.activeDraft.changeId}가 있습니다. 먼저 해당 초안을 완료하거나 상태를 변경하세요.`,
    }];
    return { valid: false, errors, unresolved: errors };
  }
  const replacingActiveDraft = context.activeDraft?.changeId === checked.draft.changeId;
  if (context.changes.includes(checked.draft.changeId) && !replacingActiveDraft) {
    const errors = [{ field: 'changeId', code: 'EXISTS', message: `Change ${checked.draft.changeId}가 이미 존재합니다.` }];
    return { valid: false, errors, unresolved: errors };
  }
  if (checked.draft.services.some((id) => !context.services.find((service) => service.id === id)?.baseSha)) {
    const errors = [{ field: 'services', code: 'MISSING_BASE', message: '선택한 서비스의 작업 시작 기준 SHA를 확인할 수 없습니다.' }];
    return { valid: false, errors, unresolved: errors };
  }
  const files = buildChangeFiles(checked.draft, { rootHead: context.head, services: context.services });
  const validation = strictValidation(root, checked.draft, files, { replaceDraft: replacingActiveDraft });
  const revision = revisionFor(root, checked.draft, files, context);
  const deletedFiles = replacingActiveDraft
    ? managedDraftContractPaths(join(root, 'changes', checked.draft.changeId)).filter((path) => !files.has(path))
    : [];
  return {
    valid: validation.exitCode === 0,
    errors: validation.exitCode === 0 ? [] : [{ field: 'review', code: 'STRICT_VALIDATION', message: validation.output }],
    unresolved: validation.exitCode === 0 ? [] : [{ field: 'review', code: 'STRICT_VALIDATION', message: validation.output }],
    revision,
    validation,
    files: [
      ...[...files].map(([path, content]) => ({
        path,
        content,
        diff: previewFileDiff(root, checked.draft.changeId, path, content, replacingActiveDraft),
      })),
      ...deletedFiles.map((path) => ({
        path,
        content: '',
        deleted: true,
        diff: `--- a/changes/${checked.draft.changeId}/${path}\n+++ /dev/null\n${readFileSync(join(root, 'changes', checked.draft.changeId, path), 'utf8').split('\n').map((line) => `-${line}`).join('\n')}`,
      })),
    ],
    draft: checked.draft,
  };
}

function approvedRef(root) {
  return spawnSync('git', ['rev-parse', '--verify', 'origin/main'], { cwd: root }).status === 0
    ? 'origin/main'
    : 'main';
}

function approvedManifest(root, change, planSha) {
  if (!IDENTIFIER.test(change) || !FULL_SHA.test(planSha)) {
    throw new Error('승인된 계획을 확인하려면 올바른 Change ID와 40자리 Plan SHA가 필요합니다.');
  }
  const commit = spawnSync('git', ['cat-file', '-e', `${planSha}^{commit}`], { cwd: root });
  const reachable = spawnSync('git', ['merge-base', '--is-ancestor', planSha, approvedRef(root)], { cwd: root });
  if (commit.status !== 0 || reachable.status !== 0) {
    throw new Error('승인된 계획 SHA가 현재 main에서 확인되지 않습니다.');
  }
  let raw;
  try {
    raw = git(root, ['show', `${planSha}:changes/${change}/WORK_UNITS.yaml`]);
  } catch {
    let present = '';
    try {
      present = git(root, ['ls-tree', '--name-only', `${planSha}:changes/`])
        .split('\n').map((name) => name.replace(/\/$/, '')).filter((name) => name && !name.startsWith('_')).join(', ');
    } catch {
      present = '';
    }
    throw new Error(present
      ? `이 커밋에 ${change} 계획이 없습니다. 커밋에 들어 있는 계획: ${present}. ${change}의 Planning PR 머지 커밋인지 확인하세요.`
      : `이 커밋에 ${change} 계획이 없습니다. ${change}의 Planning PR 머지 커밋인지 확인하세요.`);
  }
  const manifest = YAML.parse(raw) ?? {};
  if (!['approved', 'active'].includes(String(manifest.state))) {
    throw new Error(`이 커밋의 ${change} 상태가 ${manifest.state ?? '알 수 없음'}입니다. Planning PR에 승인 값(approved)이 포함되어야 작업 지시서를 발급할 수 있습니다.`);
  }
  return manifest;
}

export function approveChange(root, input) {
  const changeId = String(input?.changeId ?? '');
  if (!IDENTIFIER.test(changeId)) throw new Error('올바른 Change ID가 필요합니다.');
  const context = repositoryContext(root);
  const draft = context.activeDraft;
  if (!draft || draft.changeId !== changeId) {
    throw new Error(`${changeId}는 현재 편집 중인 초안이 아닙니다. 초안 상태의 계획만 승인 요청으로 확정할 수 있습니다.`);
  }
  const files = buildChangeFiles(draft, { rootHead: context.head, services: context.services, approval: 'approved' });
  const manifest = YAML.parse(files.get('WORK_UNITS.yaml')) ?? {};
  const units = (manifest.work_units ?? []).filter((unit) => unit.repo && unit.repo !== 'root');
  const missingVerify = units.filter((unit) => !(unit.verify ?? []).length);
  if (missingVerify.length) {
    const error = new Error('검증 명령이 없는 작업이 있어 승인 요청으로 확정할 수 없습니다.');
    error.statusCode = 422;
    error.units = missingVerify.map((unit) => ({
      id: unit.id,
      reason: '검증 명령이 비어 있어 ready 상태가 될 수 없고, 작업 지시서도 발급할 수 없습니다.',
    }));
    throw error;
  }
  const validation = strictValidation(root, draft, files, { replaceDraft: true });
  if (validation.exitCode !== 0) {
    const error = new Error(validation.output || '저장소 규칙 검사를 통과하지 못했습니다.');
    error.statusCode = 422;
    throw error;
  }
  const saved = saveChange(root, changeId, files, { replaceDraft: true });
  return {
    ...saved,
    changeId,
    state: 'approved',
    validation,
    units: units.map(({ id, repo, writer, state }) => ({ id, repo, writer, state })),
    waiting: units.filter((unit) => unit.state !== 'ready').map((unit) => ({
      id: unit.id,
      reason: '선행 작업이 병합된 뒤에 발급할 수 있습니다.',
    })),
  };
}

export function dispatchEligibility(root, change, planSha) {
  const manifest = approvedManifest(root, change, planSha);
  const byId = new Map((manifest.work_units ?? []).map((unit) => [unit.id, unit]));
  const units = (manifest.work_units ?? [])
    .filter((unit) => {
      const planning = unit.repo === 'root' && unit.branch === `change/${change}/coordination`;
      return !planning && ['ready', 'in_progress'].includes(String(unit.state));
    })
    .map((unit) => {
      const blockers = (unit.depends_on ?? [])
        .filter((id) => {
          const dependency = byId.get(id);
          const planning = dependency?.repo === 'root' && dependency?.branch === `change/${change}/coordination`;
          return !planning && dependency?.state !== 'merged';
        })
        .map((id) => `선행 작업 ${id}가 아직 병합되지 않았습니다.`);
      return {
        id: unit.id,
        repo: unit.repo,
        writer: unit.writer,
        goal: unit.goal,
        branch: unit.branch,
        baseSha: unit.base_sha,
        blockers,
        eligible: blockers.length === 0,
      };
    });
  return { change, planSha, units };
}

function createPacket(root, request) {
  for (const key of ['change', 'unit', 'writer', 'run']) {
    if (!IDENTIFIER.test(String(request[key] ?? ''))) throw new Error(`${key} 값이 올바르지 않습니다.`);
  }
  const dispatch = dispatchEligibility(root, request.change, request.planSha);
  const eligible = dispatch.units.find((unit) => (
    unit.id === request.unit && unit.eligible && unit.writer === request.writer
  ));
  if (!eligible) throw new Error('이 작업은 현재 작업 패킷을 발급할 수 없습니다.');
  const result = spawnSync(process.execPath, [
    join(moduleRoot, 'scripts/bootstrap.mjs'),
    '--plan-sha', request.planSha,
    '--change', request.change,
    '--unit', request.unit,
    '--writer', request.writer,
    '--run', request.run,
    '--apply',
  ], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) throw new Error((result.stderr || result.stdout || '작업 패킷 생성에 실패했습니다.').trim());
  const relativePath = `.task-packets/${request.run}.md`;
  const content = readFileSync(join(root, relativePath), 'utf8');
  const marker = '\nPacket SHA-256: ';
  const markerIndex = content.lastIndexOf(marker);
  const declaredDigest = markerIndex >= 0
    ? content.slice(markerIndex + marker.length).trim()
    : '';
  const computedDigest = markerIndex >= 0
    ? createHash('sha256').update(content.slice(0, markerIndex + 1)).digest('hex')
    : '';
  if (!SHA256.test(declaredDigest) || declaredDigest !== computedDigest) {
    throw new Error('생성된 작업 패킷의 무결성 검증에 실패했습니다.');
  }
  return {
    path: relativePath,
    digest: declaredDigest,
    content,
  };
}

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

function securityHeaders(contentType) {
  return {
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-type': contentType,
  };
}

function allowedRequestOrigin(request) {
  const host = String(request.headers.host ?? '').toLowerCase();
  const hostname = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0];
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(hostname)) return false;
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
      && parsed.host.toLowerCase() === host;
  } catch {
    return false;
  }
}

async function readJson(request) {
  if (!String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
    const error = new Error('JSON 요청만 지원합니다.');
    error.statusCode = 415;
    throw error;
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > BODY_LIMIT) {
      const error = new Error('요청 본문은 1MB를 넘을 수 없습니다.');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('올바른 JSON 요청이 아닙니다.');
    error.statusCode = 400;
    throw error;
  }
}

const STATIC_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
]);

function staticFile(pathname) {
  if (pathname === '/') return 'index.html';
  const allowed = new Map([
    ['/app.js', 'app.js'],
    ['/styles.css', 'styles.css'],
  ]);
  return allowed.get(pathname);
}

function tokenMatches(request, token) {
  const provided = String(request.headers['x-coordination-token'] ?? '');
  const expected = Buffer.from(token, 'utf8');
  const actual = Buffer.from(provided, 'utf8');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function createOrchestrationServer({
  root = process.cwd(),
  uiRoot = join(moduleRoot, 'ui'),
  token = randomBytes(24).toString('hex'),
  planPr,
} = {}) {
  const resolvedRoot = resolve(root);
  const planning = planPr ?? createPlanPr({ root: resolvedRoot });
  const server = createServer(async (request, response) => {
    try {
      if (!allowedRequestOrigin(request)) {
        return json(response, 403, { error: '로컬 요청만 허용합니다.' });
      }
      const url = new URL(request.url, 'http://127.0.0.1');
      if (request.method === 'GET' && url.pathname === '/api/status') {
        return json(response, 200, repositoryContext(resolvedRoot));
      }
      if (request.method === 'POST' && url.pathname === '/api/services/preview') {
        return json(response, 200, previewService(resolvedRoot, await readJson(request)));
      }
      if (request.method === 'POST' && url.pathname === '/api/services') {
        return json(response, 201, registerService(resolvedRoot, await readJson(request)));
      }
      if (request.method === 'POST' && url.pathname === '/api/changes/preview') {
        const draft = await readJson(request);
        const result = previewChange(resolvedRoot, draft);
        return json(response, result.valid ? 200 : 422, result);
      }
      if (request.method === 'POST' && url.pathname === '/api/changes') {
        const body = await readJson(request);
        const preview = previewChange(resolvedRoot, body.draft);
        if (!preview.valid) return json(response, 422, preview);
        if (body.revision !== preview.revision) return json(response, 409, { error: '미리보기 이후 저장소나 입력이 변경되었습니다. 다시 검토하세요.' });
        const files = new Map(preview.files.filter(({ deleted }) => !deleted).map(({ path, content }) => [path, content]));
        const activeDraft = repositoryContext(resolvedRoot).activeDraft;
        const replaceDraft = activeDraft?.changeId === preview.draft.changeId;
        const saved = saveChange(resolvedRoot, preview.draft.changeId, files, { replaceDraft });
        return json(response, replaceDraft ? 200 : 201, { ...saved, validation: preview.validation });
      }
      if (request.method === 'POST' && url.pathname === '/api/changes/approval') {
        try {
          return json(response, 200, approveChange(resolvedRoot, await readJson(request)));
        } catch (error) {
          return json(response, error.statusCode ?? 422, { error: error.message, units: error.units ?? [] });
        }
      }
      if (request.method === 'GET' && url.pathname === '/api/plan-pr/preflight') {
        try {
          return json(response, 200, planning.preflight(url.searchParams.get('change')));
        } catch (error) {
          return json(response, 422, { error: error.message });
        }
      }
      if (request.method === 'GET' && url.pathname === '/api/plan-pr/status') {
        try {
          return json(response, 200, planning.status(url.searchParams.get('change'), Number(url.searchParams.get('number'))));
        } catch (error) {
          return json(response, 422, { error: error.message });
        }
      }
      if (request.method === 'POST' && url.pathname === '/api/plan-pr') {
        if (!tokenMatches(request, token)) {
          return json(response, 403, { error: '이 작업에는 서버 시작 시 출력된 접근 토큰이 필요합니다.' });
        }
        try {
          return json(response, 201, planning.execute((await readJson(request)).changeId));
        } catch (error) {
          return json(response, 422, { error: error.message, steps: error.steps ?? [], blockers: error.blockers ?? [] });
        }
      }
      if (request.method === 'GET' && url.pathname === '/api/plan-candidates') {
        try {
          return json(response, 200, planning.candidates(url.searchParams.get('change')));
        } catch (error) {
          return json(response, 422, { error: error.message });
        }
      }
      if (request.method === 'GET' && url.pathname === '/api/dispatch') {
        try {
          return json(response, 200, dispatchEligibility(resolvedRoot, url.searchParams.get('change'), url.searchParams.get('planSha')));
        } catch (error) {
          return json(response, 422, { error: error.message });
        }
      }
      if (request.method === 'POST' && url.pathname === '/api/packets') {
        try {
          return json(response, 201, createPacket(resolvedRoot, await readJson(request)));
        } catch (error) {
          return json(response, 422, { error: error.message });
        }
      }
      if (request.method === 'GET' && url.pathname.startsWith('/api/packets/')) {
        const runId = decodeURIComponent(url.pathname.slice('/api/packets/'.length));
        if (!IDENTIFIER.test(runId)) return json(response, 400, { error: '올바른 Run ID가 아닙니다.' });
        const packetPath = join(resolvedRoot, '.task-packets', `${runId}.md`);
        if (!existsSync(packetPath)) return json(response, 404, { error: '작업 지시서를 찾을 수 없습니다.' });
        response.writeHead(200, {
          ...securityHeaders('text/markdown; charset=utf-8'),
          'content-disposition': `attachment; filename="${runId}.md"`,
        });
        return response.end(readFileSync(packetPath));
      }
      const file = request.method === 'GET' ? staticFile(url.pathname) : null;
      if (file) {
        const path = join(uiRoot, file);
        if (!existsSync(path)) return json(response, 404, { error: 'UI 파일을 찾을 수 없습니다.' });
        const content = readFileSync(path);
        response.writeHead(200, securityHeaders(STATIC_TYPES.get(extname(path)) ?? 'application/octet-stream'));
        return response.end(content);
      }
      return json(response, 404, { error: '지원하지 않는 작업입니다.' });
    } catch (error) {
      return json(response, error.statusCode ?? 500, { error: error.message });
    }
  });
  server.coordinationToken = token;
  return server;
}
