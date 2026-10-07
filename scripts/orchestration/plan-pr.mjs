import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { defaultRun } from '../lib.mjs';

export { defaultRun };

const CHANGE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const PLANNING_UNIT = 'contract-and-plan';

function manifestOf(root, change) {
  const path = join(root, 'changes', change, 'WORK_UNITS.yaml');
  if (!existsSync(path)) throw new Error(`changes/${change}/WORK_UNITS.yaml을 찾을 수 없습니다.`);
  return YAML.parse(readFileSync(path, 'utf8')) ?? {};
}

function planTitle(root, change) {
  const path = join(root, 'changes', change, 'PLAN.md');
  if (!existsSync(path)) return change;
  return readFileSync(path, 'utf8').match(/^#\s+\S+\s+—\s+(.+)$/m)?.[1]?.trim() || change;
}

function githubHost(root) {
  const path = join(root, 'services/registry.yaml');
  if (!existsSync(path)) return 'github.com';
  return (YAML.parse(readFileSync(path, 'utf8')) ?? {}).github?.host || 'github.com';
}

function implementationUnits(manifest) {
  return (manifest.work_units ?? []).filter((unit) => unit.repo && unit.repo !== 'root');
}

function prBody(change, manifest) {
  const rows = implementationUnits(manifest)
    .map((unit) => `| \`${unit.id}\` | \`${unit.repo}\` | ${unit.writer} | ${unit.state} |`)
    .join('\n');
  return [
    `승인 상태로 제출된 ${change} 계획입니다.`,
    '',
    '이 PR의 머지 커밋 SHA가 불변 계획 버전이 되고, 그 SHA로만 작업 지시서를 발급할 수 있습니다.',
    '구현은 병합 이후에 시작합니다.',
    '',
    '| Work unit | Repository | Writer | State |',
    '|---|---|---|---|',
    rows,
    '',
    '검토 항목: 목표와 완료 기준, 작업 경계(`write_paths`), 담당자, 검증 명령, 계약 스냅샷.',
    '',
    '```bash',
    'npm test',
    `npm run verify:registry -- --change ${change} --strict`,
    '```',
  ].join('\n');
}

export function createPlanPr({ root, run = defaultRun }) {
  const host = githubHost(root);
  const git = (args) => run('git', args, { cwd: root });
  const gh = (args) => run('gh', args, { cwd: root, env: { ...process.env, GH_HOST: host } });
  const ok = (result) => result.status === 0;

  function assertChange(change) {
    if (!CHANGE_ID.test(String(change ?? ''))) throw new Error('올바른 Change ID가 필요합니다.');
    return String(change);
  }

  function baseRef() {
    return ok(git(['rev-parse', '--verify', 'origin/main'])) ? 'origin/main' : 'main';
  }

  function preflight(input) {
    const change = assertChange(input);
    const manifest = manifestOf(root, change);
    const branch = `change/${change}/coordination`;
    const currentBranch = git(['branch', '--show-current']).stdout;
    const pending = git(['status', '--porcelain', '--', `changes/${change}`]).stdout;
    const committed = ok(git(['cat-file', '-e', `HEAD:changes/${change}/WORK_UNITS.yaml`]));
    const branchExists = ok(git(['rev-parse', '--verify', `refs/heads/${branch}`]));
    const remoteBranchExists = ok(git(['rev-parse', '--verify', `refs/remotes/origin/${branch}`]));
    const ghInstalled = ok(gh(['--version']));
    const ghAuthenticated = ghInstalled && ok(gh(['auth', 'status', '--hostname', host]));
    const approval = String(manifest.state ?? '');

    const blockers = [];
    if (!['approved', 'active'].includes(approval)) {
      blockers.push({ code: 'NOT_APPROVED', message: `계획 상태가 ${approval || '알 수 없음'}입니다. 먼저 승인 요청으로 확정하세요.` });
    }
    if (!currentBranch) {
      blockers.push({ code: 'DETACHED_HEAD', message: 'HEAD가 detached 상태입니다. 브랜치를 체크아웃한 뒤 다시 시도하세요.' });
    }
    if (!pending && !committed) {
      blockers.push({ code: 'NOTHING_TO_COMMIT', message: `changes/${change}에 커밋할 내용이 없습니다.` });
    }
    if (!ghInstalled) {
      blockers.push({ code: 'GH_MISSING', message: 'GitHub CLI(gh)를 찾을 수 없습니다. 설치 후 다시 시도하세요.' });
    } else if (!ghAuthenticated) {
      blockers.push({ code: 'GH_UNAUTHENTICATED', message: `gh가 ${host}에 인증되어 있지 않습니다. gh auth login 후 다시 시도하세요.` });
    }

    return {
      change,
      branch,
      host,
      approval,
      currentBranch: currentBranch || '(detached)',
      pendingPaths: pending ? pending.split('\n').map((line) => line.slice(3)) : [],
      committed,
      branchExists,
      remoteBranchExists,
      gh: { installed: ghInstalled, authenticated: ghAuthenticated },
      blockers,
      ready: blockers.length === 0,
      steps: [
        `git fetch origin main`,
        branchExists ? `git switch ${branch}` : `git switch -c ${branch} ${baseRef()}`,
        `git add -- changes/${change}`,
        `git commit -m "plan(${change}): ${planTitle(root, change)}" -- changes/${change}`,
        `git push -u origin ${branch}`,
        `gh pr create --base main --head ${branch}`,
      ],
    };
  }

  function step(label, result, steps) {
    steps.push({ label, command: `${result.command} ${result.args.join(' ')}`, exitCode: result.status });
    if (!ok(result)) {
      const error = new Error(`${label} 실패: ${result.stderr || result.stdout || `exit ${result.status}`}`);
      error.steps = steps;
      throw error;
    }
    return result;
  }

  function execute(input) {
    const check = preflight(input);
    if (!check.ready) {
      const error = new Error(check.blockers.map(({ message }) => message).join('\n'));
      error.blockers = check.blockers;
      throw error;
    }
    const { change, branch } = check;
    const manifest = manifestOf(root, change);
    const steps = [];

    step('origin 동기화', git(['fetch', 'origin', 'main']), steps);
    if (check.currentBranch !== branch) {
      step(
        '계획 브랜치 준비',
        check.branchExists ? git(['switch', branch]) : git(['switch', '-c', branch, baseRef()]),
        steps,
      );
    }
    step('계획 파일 스테이징', git(['add', '--', `changes/${change}`]), steps);
    const staged = git(['diff', '--cached', '--name-only', '--', `changes/${change}`]).stdout;
    if (staged) {
      step(
        '계획 커밋',
        git(['commit', '-m', `plan(${change}): ${planTitle(root, change)}`, '--', `changes/${change}`]),
        steps,
      );
    }
    step('브랜치 push', git(['push', '-u', 'origin', branch]), steps);

    const existing = gh(['pr', 'list', '--head', branch, '--state', 'open', '--json', 'number,url', '--limit', '1']);
    let pr = ok(existing) ? (JSON.parse(existing.stdout || '[]')[0] ?? null) : null;
    if (pr) {
      steps.push({ label: '기존 PR 확인', command: `gh pr list --head ${branch}`, exitCode: 0 });
    } else {
      const created = step(
        'PR 생성',
        gh([
          'pr', 'create',
          '--base', 'main',
          '--head', branch,
          '--title', `plan(${change}): ${planTitle(root, change)}`,
          '--body', prBody(change, manifest),
        ]),
        steps,
      );
      const url = created.stdout.split('\n').find((line) => line.startsWith('http')) ?? '';
      pr = { url, number: Number(url.split('/').at(-1)) };
    }

    const headSha = git(['rev-parse', 'HEAD']).stdout;
    if (recordPrNumber(root, change, pr.number, headSha)) {
      step('PR 번호 스테이징', git(['add', '--', `changes/${change}/PRS.yaml`]), steps);
      step(
        'PR 번호 기록',
        git(['commit', '-m', `plan(${change}): record planning PR #${pr.number}`, '--', `changes/${change}/PRS.yaml`]),
        steps,
      );
      step('PR 번호 push', git(['push', 'origin', branch]), steps);
    }

    return {
      change,
      branch,
      prNumber: pr.number,
      prUrl: pr.url,
      headSha: git(['rev-parse', 'HEAD']).stdout,
      steps,
    };
  }

  function status(input, number) {
    const change = assertChange(input);
    if (!Number.isInteger(number) || number <= 0) throw new Error('PR 번호가 올바르지 않습니다.');
    const result = gh(['pr', 'view', String(number), '--json', 'number,state,url,mergeCommit,reviewDecision']);
    if (!ok(result)) throw new Error(`PR 조회에 실패했습니다: ${result.stderr || result.stdout}`);
    const view = JSON.parse(result.stdout || '{}');
    const mergeSha = view.state === 'MERGED' ? view.mergeCommit?.oid ?? '' : '';
    return {
      change,
      number: view.number ?? number,
      state: view.state ?? 'UNKNOWN',
      url: view.url ?? '',
      reviewDecision: view.reviewDecision ?? '',
      mergeSha,
      fetched: mergeSha ? ok(git(['fetch', 'origin', 'main'])) : false,
    };
  }

  function candidates(input) {
    const change = assertChange(input);
    const ref = baseRef();
    const log = git(['log', '--first-parent', '--format=%H%x09%cs%x09%s', ref, '--', `changes/${change}/WORK_UNITS.yaml`]);
    if (!ok(log) || !log.stdout) return { change, ref, candidates: [] };
    const rows = log.stdout.split('\n').slice(0, 20).map((line) => {
      const [sha, date, subject] = line.split('\t');
      const file = git(['show', `${sha}:changes/${change}/WORK_UNITS.yaml`]);
      const state = ok(file) ? String((YAML.parse(file.stdout) ?? {}).state ?? '') : '';
      return { sha, date, subject, state, dispatchable: ['approved', 'active'].includes(state) };
    });
    return { change, ref, candidates: rows };
  }

  return { preflight, execute, status, candidates };
}

export function recordPrNumber(root, change, number, headSha) {
  const path = join(root, 'changes', change, 'PRS.yaml');
  if (!existsSync(path) || !Number.isInteger(number) || number <= 0) return false;
  const document = YAML.parse(readFileSync(path, 'utf8')) ?? {};
  const row = (document.prs ?? []).find((entry) => entry.work_unit === PLANNING_UNIT);
  if (!row || row.number === number) return false;
  row.number = number;
  row.state = 'open';
  row.head_sha = headSha || row.head_sha;
  writeYaml(path, document);
  return true;
}

function writeYaml(path, document) {
  writeFileSync(path, YAML.stringify(document, { lineWidth: 0 }), 'utf8');
}
