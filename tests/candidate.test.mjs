import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import YAML from 'yaml';
import { createGithub, localCheckEnv, redact } from '../scripts/github.mjs';
import { defaultRun } from '../scripts/lib.mjs';
import { createCandidateService } from '../scripts/orchestration/candidate.mjs';
import { createOrchestrationServer } from '../scripts/orchestration/server.mjs';

const change = 'CHG-TEST-001';
const source = resolve(import.meta.dirname, '..');
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'candidate-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (args, cwd = root) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  function init(cwd) {
    mkdirSync(cwd, { recursive: true });
    git(['init', '-qb', 'main'], cwd);
    git(['config', 'user.name', 'Test'], cwd);
    git(['config', 'user.email', 'test@example.invalid'], cwd);
    git(['config', 'advice.addEmbeddedRepo', 'false'], cwd);
  }
  const service = join(root, 'services/api');
  init(service);
  writeFileSync(join(service, 'README.md'), 'base\n');
  git(['add', '.'], service);
  git(['commit', '-qm', 'anchor'], service);
  const serviceBase = git(['rev-parse', 'HEAD'], service);
  writeFileSync(join(service, 'feature.txt'), 'feature\n');
  git(['add', '.'], service);
  git(['commit', '-qm', 'feature'], service);
  const serviceHead = git(['rev-parse', 'HEAD'], service);
  git(['update-ref', 'refs/remotes/origin/main', serviceHead], service);
  git(['switch', '--detach', serviceBase], service);
  init(root);
  writeFileSync(join(root, '.gitignore'), '.task-packets/\nnode_modules/\n');
  writeFileSync(join(root, '.gitmodules'), '[submodule "services/api"]\npath = services/api\nurl = https://github.com/acme/api.git\n');
  writeFileSync(join(root, 'services/registry.yaml'), YAML.stringify({ version: 2, github: { host: 'github.com' },
    services: [{ id: 'api', path: 'services/api', repo: 'https://github.com/acme/api.git', owners: ['alice'], verify: ['npm test'] }] }));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', 'test:e2e': 'node scripts/test-e2e.mjs' } }));
  const prefix = join(root, 'changes', change);
  mkdirSync(join(prefix, 'contracts'), { recursive: true });
  mkdirSync(join(prefix, 'releases'), { recursive: true });
  const branch = `change/${change}/candidate-integration`;
  const planning = { id: 'plan', repo: 'root', state: 'in_progress', branch: `change/${change}/coordination`, base_sha: serviceBase, writer: 'alice', write_paths: [`changes/${change}/**`], verify: ['npm test'] };
  const implementation = { id: 'api-feature', repo: 'api', state: 'ready', branch: `feat/${change}/api-feature`, base_sha: serviceBase, writer: 'alice', write_paths: ['feature.txt'], depends_on: ['plan'], verify: ['npm test'] };
  const candidate = { id: 'candidate-integration', repo: 'root', state: 'draft', branch, base_sha: 'pending-plan-merge', writer: 'alice',
    depends_on: ['api-feature'], verify: ['npm test', `npm run verify:prs -- --change ${change}`, 'npm run test:e2e', `npm run verify:candidate -- --change ${change} --target-ref origin/main`],
    write_paths: [`changes/${change}/WORK_UNITS.yaml`, `changes/${change}/PRS.yaml`, `changes/${change}/STATUS.md`, `changes/${change}/releases/**`, 'e2e/**', 'services/api'] };
  writeFileSync(join(prefix, 'WORK_UNITS.yaml'), YAML.stringify({ schema_version: 1, change_id: change, state: 'approved', work_units: [planning, implementation, candidate] }));
  writeFileSync(join(prefix, 'PLAN.md'), '# Test\n\n## Acceptance criteria\n\n- [AC-001] Feature works.\n');
  writeFileSync(join(prefix, 'contracts/api.md'), '# Contract\n\nFixed interface.\n');
  writeFileSync(join(prefix, 'STATUS.md'), '# Status\n');
  writeFileSync(join(prefix, 'PRS.yaml'), YAML.stringify({ schema_version: 1, prs: [
    { key: 'root-planning', work_unit: 'plan', repo: 'root', number: 999, state: 'open' },
    { key: 'api-feature', work_unit: 'api-feature', repo: 'api', number: null, state: 'not-started' },
    { key: 'root-candidate', work_unit: 'candidate-integration', repo: 'root', state: 'not-started' },
  ] }));
  writeFileSync(join(prefix, 'releases/candidate-001.yaml'), YAML.stringify({ schema_version: 1, state: 'draft', services: [] }));
  git(['add', '.']);
  git(['commit', '-qm', 'approved plan']);
  const rootHead = git(['rev-parse', 'HEAD']);
  git(['remote', 'add', 'origin', 'https://github.com/acme/root.git']);
  git(['update-ref', 'refs/remotes/origin/main', rootHead]);
  const pulls = [
    { number: 3, merged_at: '2026-10-01', merge_commit_sha: rootHead, head: { ref: planning.branch, sha: rootHead }, base: { ref: 'main', sha: rootHead }, html_url: 'https://github.com/acme/root/pull/3' },
    { number: 4, merged_at: '2026-10-01', merge_commit_sha: serviceHead, head: { ref: implementation.branch, sha: serviceHead }, base: { ref: 'main', sha: serviceBase }, html_url: 'https://github.com/acme/api/pull/4' },
  ];
  const calls = [];
  const github = {
    host: 'github.com',
    list: async (path) => {
      if (path.includes(encodeURIComponent(branch))) return [];
      return pulls.filter((pull) => path.includes(encodeURIComponent(pull.head.ref)));
    },
    get: async (path) => {
      calls.push(path);
      if (path.includes('/check-runs')) {
        const check_runs = path.includes('/repos/acme/root/')
          ? [
            { name: 'pull-request', status: 'completed', conclusion: 'success' },
            { name: 'planning-ui', status: 'completed', conclusion: 'success' },
            { name: 'main', status: 'completed', conclusion: 'skipped' },
          ]
          : [{ name: 'test', status: 'completed', conclusion: 'success' }];
        return { total_count: check_runs.length, check_runs };
      }
      if (path.endsWith('/status')) return { statuses: [] };
      const pull = pulls.find((item) => path.endsWith(`/pulls/${item.number}`));
      if (!pull) throw new Error('missing mocked PR');
      return pull;
    },
  };
  const execute = async (command, args, options) => {
    calls.push([command, args, options.cwd]);
    if (command === 'git' && args[0] === 'fetch') return { status: 0, stdout: '', stderr: '' };
    if (command === 'git' && args[0] === 'push') return { status: 0, stdout: '', stderr: '' };
    if (command === 'git' && args[0] === 'submodule') {
      const target = join(options.cwd, 'services/api');
      // Only this fixture's empty clone directory; no user workspace is involved.
      git(['clone', '--no-local', service, target]);
      git(['update-ref', 'refs/remotes/origin/main', serviceHead], target);
      return { status: 0, stdout: '', stderr: '' };
    }
    if (command === 'npm' && args[0] === 'ci') return { status: 0, stdout: '', stderr: '' };
    if (command === 'npm' && args.includes('verify:candidate')) {
      return defaultRun(process.execPath, [join(source, 'scripts/verify-candidate.mjs'), ...args.slice(args.indexOf('--') + 1)], options);
    }
    if (command.startsWith('npm run verify:candidate')) return defaultRun(process.execPath, [join(source, 'scripts/verify-candidate.mjs'), '--change', change, '--target-ref', 'origin/main'], { ...options, shell: false });
    if (command === 'gh') {
      // The candidate and closure PRs are distinct pull requests on distinct branches.
      const head = args[args.indexOf('--head') + 1] ?? '';
      return { status: 0, stdout: `https://github.com/acme/root/pull/${head.endsWith('candidate-closure') ? 11 : 10}`, stderr: '' };
    }
    if (command === 'npm test') return defaultRun(process.execPath, ['--test'], { ...options, shell: false });
    if (command === 'npm run test:e2e') return defaultRun(process.execPath, [join(source, 'scripts/test-e2e.mjs')], { ...options, shell: false });
    if (command.startsWith('npm')) return { status: 0, stdout: 'local mocked test PASS', stderr: '' };
    return defaultRun(command, args, options);
  };
  const serviceApi = createCandidateService({ root, github, execute });
  return { root, service, serviceApi, execute, github, pulls, rootHead, serviceHead, git, calls };
}
async function done(service, action, run = 'candidate-run') {
  await service.perform(action, { run });
  for (let attempts = 0; attempts < 100; attempts += 1) {
    const state = service.status(run);
    if (!state.job?.running) return state;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error('candidate job did not finish');
}
async function approved(f) {
  const preview = await f.serviceApi.perform('preview', { change, candidate: '001' });
  assert.equal(preview.ready, true, JSON.stringify(preview));
  await f.serviceApi.perform('approve', { revision: preview.revision, run: 'candidate-run' });
  return preview;
}
async function prepared(f) {
  await approved(f);
  const state = await done(f.serviceApi, 'prepare');
  assert.equal(state.phase, 'prepared', JSON.stringify(state));
  return state;
}
function addE2e(state) {
  mkdirSync(join(state.workspace, 'e2e'), { recursive: true });
  writeFileSync(join(state.workspace, 'e2e/product.test.mjs'), "import test from 'node:test'; test('product', () => {});\n");
}

test('GitHub authentication prefers existing environment token; gh fallback never extracts a token', async () => {
  const calls = [];
  const tokenApi = createGithub({ env: { GH_TOKEN: 'secret-value' }, fetchImpl: async (url, options) => {
    calls.push(options.headers.Authorization);
    return { ok: true, json: async () => [] };
  }, run: () => { throw new Error('gh must not be called'); } });
  await tokenApi.get('/repos/acme/api/pulls/1');
  assert.deepEqual(calls, ['Bearer secret-value']);
  const ghApi = createGithub({ env: {}, run: (command, args) => {
    assert.equal(command, 'gh');
    assert.equal(args[0], 'api');
    assert.ok(!args.includes('token'));
    return { status: 0, stdout: '[]', stderr: '' };
  } });
  assert.deepEqual(await ghApi.get('/repos/acme/api/pulls/1'), []);
  await assert.rejects(() => createGithub({ env: { CI: 'true' } }).get('/repos/acme/api/pulls/1'), /CI requires/);
  assert.equal(redact('secret-value', { GH_TOKEN: 'secret-value' }), '[redacted]');
  assert.deepEqual(localCheckEnv({ PATH: '/usr/bin', GH_TOKEN: 'secret', API_SECRET: 'secret', SSH_AUTH_SOCK: 'socket' }), { PATH: '/usr/bin' });
});

test('Candidate discovers live PRs despite stale PRS; ambiguity and unmerged PR are distinct', async (t) => {
  const f = fixture(t);
  const preview = await f.serviceApi.perform('preview', { change, candidate: '001' });
  assert.equal(preview.rows[0].number, 3);
  assert.equal(preview.rows[1].number, 4);
  f.pulls.push({ ...f.pulls[1], number: 5, merged_at: null });
  const ambiguous = await f.serviceApi.perform('preview', { change, candidate: '001' });
  assert.equal(ambiguous.rows[1].state, 'ambiguous');
  const unmerged = await f.serviceApi.perform('preview', { change, candidate: '001', selections: { 'api-feature': 5 } });
  assert.equal(unmerged.rows[1].state, 'unmerged');
  assert.equal(unmerged.ready, false);
});

test('Candidate approval refuses changed PR SHAs, duplicate run IDs and tampered originals', async (t) => {
  const f = fixture(t);
  const preview = await approved(f);
  await assert.rejects(() => f.serviceApi.perform('approve', { revision: preview.revision, run: 'candidate-run' }), /이미/);
  const approval = join(f.root, '.task-packets/candidate-run.candidate-approval.json');
  writeFileSync(approval, `${readFileSync(approval, 'utf8')} `);
  assert.throws(() => f.serviceApi.status('candidate-run'), /원본/);
  const changed = fixture(t);
  const before = await changed.serviceApi.perform('preview', { change, candidate: '001' });
  changed.pulls[1].head.sha = 'b'.repeat(40);
  await assert.rejects(() => changed.serviceApi.perform('approve', { revision: before.revision, run: 'candidate-run' }), /바뀌/);
});

test('Candidate reports missing CI, PR lookup failure and missing PR separately', async (t) => {
  const f = fixture(t);
  const original = f.github.get;
  f.github.get = async (path) => path.includes('/check-runs') ? { total_count: 0, check_runs: [] } : original(path);
  const pending = await f.serviceApi.perform('preview', { change, candidate: '001' });
  assert.equal(pending.ready, false);
  assert.equal(pending.rows[1].ci.state, 'pending');
  f.github.get = async () => { throw new Error('authentication unavailable'); };
  await assert.rejects(() => f.serviceApi.perform('preview', { change, candidate: '001' }), /authentication unavailable/);
  f.github.get = original;
  f.pulls.pop();
  const missing = await f.serviceApi.perform('preview', { change, candidate: '001' });
  assert.equal(missing.rows[1].state, 'missing');
});

test('Root planning CI excludes the skipped push job but requires successful PR and UI checks', async (t) => {
  const f = fixture(t);
  const original = f.github.get;
  const passing = await f.serviceApi.perform('preview', { change, candidate: '001' });
  assert.equal(passing.rows[0].ci.state, 'passed');
  assert.equal(passing.ready, true);
  assert.equal(passing.rows[0].ci.checks.find((check) => check.name === 'main').conclusion, 'skipped');

  for (const name of ['pull-request', 'planning-ui', 'main']) {
    for (const conclusion of ['failure', 'skipped', null]) {
      if (name === 'main' && conclusion === 'skipped') continue;
      f.github.get = async (path) => {
        const result = await original(path);
        if (!path.includes('/repos/acme/root/') || !path.includes('/check-runs')) return result;
        return { ...result, check_runs: result.check_runs.map((check) => check.name === name
          ? { ...check, status: conclusion ? 'completed' : 'in_progress', conclusion } : check) };
      };
      const blocked = await f.serviceApi.perform('preview', { change, candidate: '001' });
      assert.equal(blocked.ready, false, `${name}: ${conclusion}`);
      assert.equal(blocked.rows[0].ci.state, conclusion === 'failure' ? 'failed' : 'pending');
    }
  }
  for (const missing of ['pull-request', 'planning-ui']) {
    f.github.get = async (path) => {
      const result = await original(path);
      if (!path.includes('/repos/acme/root/') || !path.includes('/check-runs')) return result;
      const check_runs = result.check_runs.filter((check) => check.name !== missing);
      return { total_count: check_runs.length, check_runs };
    };
    const blocked = await f.serviceApi.perform('preview', { change, candidate: '001' });
    assert.equal(blocked.ready, false, `missing ${missing}`);
    assert.equal(blocked.rows[0].ci.state, 'pending');
  }
});

test('Skipped service checks remain blocking even alongside a successful check', async (t) => {
  const f = fixture(t);
  const original = f.github.get;
  f.github.get = async (path) => {
    const result = await original(path);
    if (!path.includes('/repos/acme/api/') || !path.includes('/check-runs')) return result;
    return { total_count: 2, check_runs: [...result.check_runs, { name: 'main', status: 'completed', conclusion: 'skipped' }] };
  };
  const blocked = await f.serviceApi.perform('preview', { change, candidate: '001' });
  assert.equal(blocked.rows[0].ci.state, 'passed');
  assert.equal(blocked.rows[1].ci.state, 'pending');
  assert.equal(blocked.ready, false);
});

test('Candidate stops when Root base changes after approval', async (t) => {
  const f = fixture(t);
  await approved(f);
  writeFileSync(join(f.root, 'another.txt'), 'another root commit\n');
  f.git(['add', 'another.txt']);
  f.git(['commit', '-qm', 'root changed']);
  f.git(['update-ref', 'refs/remotes/origin/main', f.git(['rev-parse', 'HEAD'])]);
  const state = await done(f.serviceApi, 'prepare');
  assert.match(state.job.error, /Root base SHA/);
  assert.equal(existsSync(state.workspace), false);
});

test('Candidate prepares a separate clone, preserves Writer changes and resumes on reconnect', async (t) => {
  const f = fixture(t);
  writeFileSync(join(f.service, 'writer-work.txt'), 'keep\n');
  const state = await prepared(f);
  assert.notEqual(state.workspace, f.root);
  assert.equal(readFileSync(join(f.service, 'writer-work.txt'), 'utf8'), 'keep\n');
  assert.equal(f.git(['rev-parse', 'HEAD']), f.rootHead);
  const prs = YAML.parse(readFileSync(join(state.workspace, `changes/${change}/PRS.yaml`), 'utf8'));
  assert.equal(prs.prs[0].number, 3);
  assert.equal(prs.prs[1].merge_sha, f.serviceHead);
  const reconnected = createCandidateService({ root: f.root, github: f.github, execute: f.execute });
  assert.equal(reconnected.status('candidate-run').phase, 'prepared');
  assert.equal(reconnected.status().runs.length, 1);
});

test('Candidate preserves a failed preparation and safely retries without reset', async (t) => {
  const f = fixture(t);
  let fail = true;
  const execute = async (command, args, options) => {
    if (fail && command === 'npm' && args[0] === 'ci') {
      fail = false;
      return { status: 1, stdout: '', stderr: 'install unavailable' };
    }
    return f.execute(command, args, options);
  };
  const api = createCandidateService({ root: f.root, github: f.github, execute });
  const preview = await api.perform('preview', { change, candidate: '001' });
  await api.perform('approve', { revision: preview.revision, run: 'candidate-run' });
  const failed = await done(api, 'prepare');
  assert.equal(failed.phase, 'prepare-failed');
  assert.equal(existsSync(join(failed.workspace, '.git')), true);
  const resumed = await done(api, 'prepare');
  assert.equal(resumed.phase, 'prepared', JSON.stringify(resumed));
  assert.ok(!f.calls.some((call) => Array.isArray(call) && call[0] === 'git' && call[1][0] === 'reset'));
});

test('Candidate does not overwrite workspace edits made after failed preparation', async (t) => {
  const f = fixture(t);
  const execute = async (command, args, options) => command === 'npm' && args[0] === 'ci'
    ? { status: 1, stdout: '', stderr: 'install unavailable' } : f.execute(command, args, options);
  const api = createCandidateService({ root: f.root, github: f.github, execute });
  const preview = await api.perform('preview', { change, candidate: '001' });
  await api.perform('approve', { revision: preview.revision, run: 'candidate-run' });
  const failed = await done(api, 'prepare');
  const file = join(failed.workspace, `changes/${change}/STATUS.md`);
  writeFileSync(file, 'Human edits must survive\n');
  const resumed = await done(api, 'prepare');
  assert.match(resumed.job.error, /덮어쓰지/);
  assert.equal(readFileSync(file, 'utf8'), 'Human edits must survive\n');
});

test('Agent packet grants only E2E paths and blocks concurrent workspace mutation until handoff', async (t) => {
  const f = fixture(t);
  const state = await prepared(f);
  await assert.rejects(() => f.serviceApi.perform('pr', { run: state.run }), /검증/);
  const packet = await f.serviceApi.perform('packet', { run: state.run });
  assert.match(packet.packet.content, /Allowed paths:\n  - e2e\/\*\*/);
  assert.doesNotMatch(packet.packet.content, /gh api|git push|GH_TOKEN|COORDINATION_GITHUB_TOKEN/);
  assert.equal(f.serviceApi.status(state.run).phase, 'agent');
  await assert.rejects(() => f.serviceApi.perform('verify', { run: state.run }), /Agent/);
  addE2e(state);
  await f.serviceApi.perform('handoff', { run: state.run });
  const verified = await done(f.serviceApi, 'verify');
  assert.equal(verified.phase, 'verified', JSON.stringify(verified));
});

test('Candidate blocks missing product E2E and publishes only after human evidence and final HEAD checks', async (t) => {
  const f = fixture(t);
  const state = await prepared(f);
  const missing = await done(f.serviceApi, 'verify');
  assert.equal(missing.phase, 'verification-failed');
  assert.match(missing.error, /제품 E2E/);
  addE2e(state);
  const verified = await done(f.serviceApi, 'verify');
  assert.equal(verified.phase, 'verified', JSON.stringify(verified));
  const links = [{ criterion: 'AC-001', checkIds: [verified.checks.find((check) => check.command === 'npm run test:e2e').id], note: 'Actual product result inspected', confirmed: true }];
  await assert.rejects(() => f.serviceApi.perform('evidence', { run: state.run, links: [] }), /모든/);
  await f.serviceApi.perform('evidence', { run: state.run, links });
  const published = await done(f.serviceApi, 'pr');
  assert.equal(published.phase, 'pr-created', JSON.stringify(published));
  assert.equal(published.pr.number, 10);
  assert.equal(published.gates.merged, false);
  assert.equal(published.gates.mainCiPassed, false);
  assert.equal(f.git(['status', '--porcelain'], state.workspace), '');
  assert.notEqual(published.verifiedHead, f.rootHead);
  assert.ok(f.calls.some((call) => Array.isArray(call) && call[0] === 'git' && call[1][0] === 'push'));
  assert.ok(!f.calls.some((call) => Array.isArray(call) && call[1].includes('--force')));
});

test('Root post-merge CI excludes the skipped PR job but requires successful main and UI checks', async (t) => {
  const f = fixture(t);
  const state = await prepared(f);
  addE2e(state);
  const verified = await done(f.serviceApi, 'verify');
  await f.serviceApi.perform('evidence', { run: state.run, links: [{
    criterion: 'AC-001', checkIds: [verified.checks[0].id], note: 'Inspected result', confirmed: true,
  }] });
  const published = await done(f.serviceApi, 'pr');
  assert.equal(published.phase, 'pr-created', JSON.stringify(published));
  const original = f.github.get;
  let check_runs = [
    { name: 'pull-request', status: 'completed', conclusion: 'skipped' },
    { name: 'planning-ui', status: 'completed', conclusion: 'success' },
    { name: 'main', status: 'completed', conclusion: 'success' },
  ];
  f.github.get = async (path) => {
    if (path.endsWith('/pulls/10')) return {
      number: 10, merged_at: '2026-10-07', merge_commit_sha: 'a'.repeat(40),
      head: { ref: published.approval.branch, sha: published.pr.headSha },
    };
    if (path.includes('/repos/acme/root/') && path.includes('/check-runs')) return { total_count: check_runs.length, check_runs };
    return original(path);
  };
  const passing = await f.serviceApi.perform('remote-status', { run: state.run });
  assert.equal(passing.gates.merged, true);
  assert.equal(passing.gates.mainCiPassed, true);
  const success = check_runs;
  for (const name of ['main', 'planning-ui', 'pull-request']) {
    for (const conclusion of ['failure', 'skipped', null]) {
      if (name === 'pull-request' && conclusion === 'skipped') continue;
      check_runs = success.map((check) => check.name === name
        ? { ...check, status: conclusion ? 'completed' : 'in_progress', conclusion } : check);
      const blocked = await f.serviceApi.perform('remote-status', { run: state.run });
      assert.equal(blocked.gates.merged, true);
      assert.equal(blocked.gates.mainCiPassed, false, `${name}: ${conclusion}`);
    }
  }
  for (const missing of ['main', 'planning-ui']) {
    check_runs = success.filter((check) => check.name !== missing);
    const blocked = await f.serviceApi.perform('remote-status', { run: state.run });
    assert.equal(blocked.gates.mainCiPassed, false, `missing ${missing}`);
  }
});

test('Candidate rejects file changes after verification and evidence linkage', async (t) => {
  const f = fixture(t);
  const state = await prepared(f);
  addE2e(state);
  const verified = await done(f.serviceApi, 'verify');
  await f.serviceApi.perform('evidence', { run: state.run, links: [{
    criterion: 'AC-001', checkIds: [verified.checks[0].id], note: 'Inspected result', confirmed: true,
  }] });
  writeFileSync(join(state.workspace, 'e2e/product.test.mjs'), '// changed\n');
  const failed = await done(f.serviceApi, 'pr');
  assert.match(failed.job.error, /변경/);
  assert.equal(failed.pr, undefined);
});

test('a failing product E2E never becomes passing Candidate or PR evidence', async (t) => {
  const f = fixture(t);
  const state = await prepared(f);
  mkdirSync(join(state.workspace, 'e2e'), { recursive: true });
  writeFileSync(join(state.workspace, 'e2e/failing.test.mjs'), "import test from 'node:test'; test('product failure', () => { throw new Error('product is broken'); });\n");
  const verified = await done(f.serviceApi, 'verify');
  assert.equal(verified.phase, 'verification-failed');
  assert.equal(verified.checks.find((check) => check.command === 'npm run test:e2e').exitCode, 1);
  await assert.rejects(() => f.serviceApi.perform('pr', { run: state.run }), /검증/);
});
test('Candidate fails unavailable checks, excludes secrets from local checks and blocks duplicate jobs', async (t) => {
  const f = fixture(t);
  let fail = false;
  let unblock;
  const hold = new Promise((done) => { unblock = done; });
  const execute = async (command, args, options) => {
    if (fail && command === 'npm test') {
      assert.equal(options.env.GH_TOKEN, undefined);
      assert.equal(options.env.API_SECRET, undefined);
      await hold;
      return { status: 127, stdout: '', stderr: 'check unavailable' };
    }
    return f.execute(command, args, options);
  };
  const api = createCandidateService({ root: f.root, github: f.github, execute, env: { ...process.env, GH_TOKEN: 'fixture-secret', API_SECRET: 'fixture-secret' } });
  const preview = await api.perform('preview', { change, candidate: '001' });
  await api.perform('approve', { revision: preview.revision, run: 'candidate-run' });
  const state = await done(api, 'prepare');
  addE2e(state);
  fail = true;
  await api.perform('verify', { run: state.run });
  await assert.rejects(() => api.perform('verify', { run: state.run }), /이미|실행할/);
  unblock();
  for (let count = 0; count < 100 && api.status(state.run).job.running; count += 1) await new Promise((done) => setTimeout(done, 10));
  assert.equal(api.status(state.run).phase, 'verification-failed');
  assert.ok(api.status(state.run).checks.some((check) => check.exitCode === 127));
  await assert.rejects(() => api.perform('pr', { run: state.run }), /검증/);
});

test('Candidate rejects scope expansion, Root record edits and approval-copy tampering', async (t) => {
  const f = fixture(t);
  const state = await prepared(f);
  const result = await f.serviceApi.perform('packet', { run: state.run });
  const checker = (extra = []) => defaultRun(process.execPath, [join(source, 'scripts/workflow-check.mjs'),
    '--change', change, '--unit', 'candidate-integration', '--plan-sha', f.rootHead,
    '--repo-path', state.workspace, '--candidate-approval', join(f.root, '.task-packets/candidate-run.candidate-approval.json'),
    '--candidate-role', 'agent', ...extra], { cwd: f.root });
  addE2e(state);
  assert.equal(checker().status, 0);
  assert.equal(checker(['--expected-branch', 'main']).status, 1);
  const record = join(state.workspace, `changes/${change}/STATUS.md`);
  const before = readFileSync(record);
  writeFileSync(record, 'tampered\n');
  assert.equal(checker().status, 1);
  await assert.rejects(() => f.serviceApi.perform('handoff', { run: state.run }), /Root 기록/);
  writeFileSync(record, before);
  const copy = join(state.workspace, '.task-packets/candidate-run.candidate-approval.json');
  writeFileSync(copy, 'tampered\n');
  assert.equal(checker().status, 1);
  assert.match(result.packet.content, /candidate-role agent/);
});

test('all Candidate API routes require the local session token and reject command/path injection', async (t) => {
  const f = fixture(t);
  const server = createOrchestrationServer({ root: f.root, token: 'session', candidate: f.serviceApi });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => server.close(done)));
  const url = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${url}/api/candidate/status`)).status, 403);
  const injected = await fetch(`${url}/api/candidate/verify`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-coordination-token': 'session' },
    body: JSON.stringify({ run: 'candidate-run', command: 'echo injected' }) });
  assert.equal(injected.status, 422);
  assert.equal((await fetch(`${url}/api/candidate/status`, { headers: { 'x-coordination-token': 'session' } })).status, 200);
});

test('the Coordinator types no identifiers: candidate number and run id are derived', async (t) => {
  const f = fixture(t);
  const preview = await f.serviceApi.perform('preview', { change });
  assert.equal(preview.ready, true, JSON.stringify(preview.blockers));
  assert.equal(preview.candidate, '001');
  const started = await f.serviceApi.perform('start', { change });
  assert.equal(started.run, `run-${change}-candidate-001`);
  for (let attempts = 0; attempts < 200 && f.serviceApi.status(started.run).job?.running; attempts += 1) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  const state = f.serviceApi.status(started.run);
  // One press ran approve and prepare, then stopped at the honest blocker instead of
  // recording a verification failure for a suite that was never written.
  assert.equal(state.phase, 'prepared', JSON.stringify(state.job ?? state.error));
  assert.equal(state.hasProductE2e, false);
  assert.equal(state.approval.candidate, '001');
});

test('start refuses while results are still blocked', async (t) => {
  const f = fixture(t);
  f.pulls[1].merged_at = null;
  await assert.rejects(f.serviceApi.perform('start', { change }), /막고 있는 항목/);
});

test('evidence is suggested from passing checks but never pre-confirmed', async (t) => {
  const f = fixture(t);
  const prepare = await prepared(f);
  addE2e(prepare);
  const state = await done(f.serviceApi, 'verify');
  assert.equal(state.phase, 'verified', JSON.stringify(state.checks?.filter((check) => check.exitCode !== 0)));
  assert.equal(state.suggestions.length, state.approval.criteria.length);
  const [suggestion] = state.suggestions;
  assert.equal(suggestion.criterion, 'AC-001');
  assert.ok(suggestion.checkIds.length);
  assert.ok(suggestion.note.includes('exit 0'));
  assert.equal(suggestion.suggested, true);
  // A suggestion is not a confirmation: the saved link still needs the human flag.
  await assert.rejects(f.serviceApi.perform('evidence', { run: 'candidate-run',
    links: [{ criterion: 'AC-001', checkIds: suggestion.checkIds, note: suggestion.note, confirmed: false }] }), /사람이 확인/);
});

async function published(f, t) {
  const prepare = await prepared(f);
  addE2e(prepare);
  const verified = await done(f.serviceApi, 'verify');
  assert.equal(verified.phase, 'verified', JSON.stringify(verified.checks?.filter((check) => check.exitCode !== 0)));
  const [suggestion] = verified.suggestions;
  await f.serviceApi.perform('evidence', { run: 'candidate-run',
    links: [{ criterion: 'AC-001', checkIds: suggestion.checkIds, note: '실제 결과를 확인했다.', confirmed: true }] });
  const created = await done(f.serviceApi, 'pr');
  assert.equal(created.phase, 'pr-created', JSON.stringify(created.error));
  return created;
}
function mergeCandidate(f, state, { mainCi = 'success' } = {}) {
  const mergeSha = state.verifiedHead;
  f.pulls.push({ number: 10, merged_at: '2026-10-02', merge_commit_sha: mergeSha,
    head: { ref: state.approval.branch, sha: state.verifiedHead }, base: { ref: 'main', sha: f.rootHead },
    html_url: 'https://github.com/acme/root/pull/10' });
  const inner = f.github.get;
  f.github.get = async (path) => {
    if (path.includes(`/commits/${mergeSha}/check-runs`)) {
      const check_runs = [
        { name: 'main', status: 'completed', conclusion: mainCi },
        { name: 'planning-ui', status: 'completed', conclusion: 'success' },
        { name: 'pull-request', status: 'completed', conclusion: 'skipped' },
      ];
      return { total_count: check_runs.length, check_runs };
    }
    return inner(path);
  };
  f.git(['update-ref', 'refs/remotes/origin/main', mergeSha], state.workspace);
  return mergeSha;
}

test('closing needs a merged Candidate, a passing main CI and a human environment confirmation', async (t) => {
  const f = fixture(t);
  const created = await published(f, t);
  const environment = { note: '실습 환경에서 등록과 새로고침을 확인했다.', confirmed: true };
  // Not yet merged.
  await assert.rejects(f.serviceApi.perform('close', { run: 'candidate-run', environment }), /병합과 main CI/);
  mergeCandidate(f, created, { mainCi: 'failure' });
  await f.serviceApi.perform('remote-status', { run: 'candidate-run' });
  assert.equal(f.serviceApi.status('candidate-run').gates.mainCiPassed, false);
  await assert.rejects(f.serviceApi.perform('close', { run: 'candidate-run', environment }), /병합과 main CI/);
});

test('closing refuses an unconfirmed or empty integration environment', async (t) => {
  const f = fixture(t);
  const created = await published(f, t);
  mergeCandidate(f, created);
  await f.serviceApi.perform('remote-status', { run: 'candidate-run' });
  await assert.rejects(f.serviceApi.perform('close', { run: 'candidate-run', environment: { note: '확인함', confirmed: false } }), /직접 확인했음/);
  await assert.rejects(f.serviceApi.perform('close', { run: 'candidate-run', environment: { note: '   ', confirmed: true } }), /직접 확인했음/);
  assert.equal(f.serviceApi.status('candidate-run').phase, 'pr-created');
});

test('closing records the post-merge gates and marks the change complete', async (t) => {
  const f = fixture(t);
  const created = await published(f, t);
  const mergeSha = mergeCandidate(f, created);
  await f.serviceApi.perform('remote-status', { run: 'candidate-run' });
  const note = '실습 환경에서 작업 등록과 새로고침을 직접 확인했다.';
  await f.serviceApi.perform('close', { run: 'candidate-run', environment: { note, confirmed: true } });
  let state = f.serviceApi.status('candidate-run');
  for (let attempts = 0; attempts < 300 && state.job?.running; attempts += 1) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    state = f.serviceApi.status('candidate-run');
  }
  // Creating the closure PR is not closing the change.
  assert.equal(state.phase, 'closure-pr-created', JSON.stringify(state.error));
  assert.equal(state.gates.integrationEnvironment, 'confirmed');
  assert.equal(state.gates.closurePrCreated, true);
  assert.equal(state.gates.closureMerged, false);
  assert.equal(state.gates.closed, false);
  const prefix = join(state.workspace, 'changes', change);
  const manifest = YAML.parse(readFileSync(join(prefix, 'WORK_UNITS.yaml'), 'utf8'));
  assert.equal(manifest.state, 'complete');
  assert.equal(manifest.work_units.find((unit) => unit.id === 'candidate-integration').state, 'merged');
  const closure = manifest.work_units.find((unit) => unit.id === 'candidate-closure');
  assert.equal(closure.state, 'merged');
  assert.equal(closure.branch, `change/${change}/candidate-closure`);
  const release = YAML.parse(readFileSync(join(prefix, 'releases/candidate-001.yaml'), 'utf8'));
  assert.equal(release.state, 'complete');
  assert.equal(release.closure.candidate_merge_sha, mergeSha);
  assert.equal(release.closure.environment.note, note);
  assert.ok(readFileSync(join(prefix, 'STATUS.md'), 'utf8').includes('**State:** COMPLETE'));
  // The closure rides its own declared branch, never a second commit on the candidate branch.
  assert.equal(f.git(['branch', '--show-current'], state.workspace), `change/${change}/candidate-closure`);
  assert.equal(f.git(['log', '-1', '--format=%s'], state.workspace), `chore(${change}): close change`);
}, { skip: false });

test('the change is closed only when the closure PR is merged, not when it is created', async (t) => {
  const f = fixture(t);
  const created = await published(f, t);
  mergeCandidate(f, created);
  await f.serviceApi.perform('remote-status', { run: 'candidate-run' });
  await f.serviceApi.perform('close', { run: 'candidate-run',
    environment: { note: '실습 환경을 직접 확인했다.', confirmed: true } });
  let state = f.serviceApi.status('candidate-run');
  for (let attempts = 0; attempts < 300 && state.job?.running; attempts += 1) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    state = f.serviceApi.status('candidate-run');
  }
  assert.equal(state.phase, 'closure-pr-created');
  const closureBranch = `change/${change}/candidate-closure`;
  const closureSha = f.git(['rev-parse', 'HEAD'], state.workspace);
  f.pulls.push({ number: 11, merged_at: null, merge_commit_sha: null,
    head: { ref: closureBranch, sha: closureSha }, base: { ref: 'main', sha: f.rootHead },
    html_url: 'https://github.com/acme/root/pull/11' });

  // Still open: polling must not promote the run to closed.
  await f.serviceApi.perform('remote-status', { run: 'candidate-run' });
  assert.equal(f.serviceApi.status('candidate-run').phase, 'closure-pr-created');
  assert.equal(f.serviceApi.status('candidate-run').gates.closed, false);

  // Pressing close again while its PR is open opens no second PR.
  const repeated = await f.serviceApi.perform('close', { run: 'candidate-run',
    environment: { note: '다시 눌렀다.', confirmed: true } });
  assert.equal(repeated.phase, 'closure-pr-created');
  assert.equal(repeated.closure.pr.number, state.closure.pr.number);

  f.pulls.find((pull) => pull.number === 11).merged_at = '2026-10-03';
  f.pulls.find((pull) => pull.number === 11).merge_commit_sha = closureSha;
  const closed = await f.serviceApi.perform('remote-status', { run: 'candidate-run' });
  assert.equal(closed.phase, 'closed');
  assert.equal(closed.gates.closureMerged, true);
  assert.equal(closed.gates.closed, true);
});

test('a plan that declares no product E2E verifies and publishes without one', async (t) => {
  const f = fixture(t);
  // Drop the declaration the fixture plan makes: this change needs no cross-service suite.
  const manifestPath = join(f.root, 'changes', change, 'WORK_UNITS.yaml');
  const manifest = YAML.parse(readFileSync(manifestPath, 'utf8'));
  const candidate = manifest.work_units.find((unit) => unit.id === 'candidate-integration');
  candidate.verify = candidate.verify.filter((command) => !command.startsWith('npm run test:e2e'));
  writeFileSync(manifestPath, YAML.stringify(manifest));
  f.git(['commit', '-qam', 'plan without product e2e']);
  f.git(['update-ref', 'refs/remotes/origin/main', f.git(['rev-parse', 'HEAD'])]);
  f.pulls[0].merge_commit_sha = f.git(['rev-parse', 'HEAD']);
  f.pulls[0].head.sha = f.git(['rev-parse', 'HEAD']);

  const prepare = await prepared(f);
  assert.equal(prepare.needsProductE2e, false);
  assert.equal(prepare.hasProductE2e, false);
  // No suite exists, yet verification completes because the plan asked for none.
  const state = await done(f.serviceApi, 'verify');
  assert.equal(state.phase, 'verified', JSON.stringify(state.checks?.filter((check) => check.exitCode !== 0)));
  assert.ok(!state.checks.some((check) => /test:e2e/.test(check.command)), 'no product E2E check should run');
});

test('an undeclared product suite still runs so its evidence is never silently dropped', async (t) => {
  const f = fixture(t);
  const manifestPath = join(f.root, 'changes', change, 'WORK_UNITS.yaml');
  const manifest = YAML.parse(readFileSync(manifestPath, 'utf8'));
  const candidate = manifest.work_units.find((unit) => unit.id === 'candidate-integration');
  candidate.verify = candidate.verify.filter((command) => !command.startsWith('npm run test:e2e'));
  writeFileSync(manifestPath, YAML.stringify(manifest));
  f.git(['commit', '-qam', 'plan without product e2e']);
  f.git(['update-ref', 'refs/remotes/origin/main', f.git(['rev-parse', 'HEAD'])]);
  f.pulls[0].merge_commit_sha = f.git(['rev-parse', 'HEAD']);
  f.pulls[0].head.sha = f.git(['rev-parse', 'HEAD']);

  const prepare = await prepared(f);
  assert.equal(prepare.needsProductE2e, false, 'the plan does not require one');
  addE2e(prepare);
  const state = await done(f.serviceApi, 'verify');
  assert.equal(state.phase, 'verified', JSON.stringify(state.checks?.filter((check) => check.exitCode !== 0)));
  // Not required, but present — so it runs and its result is available as evidence.
  assert.ok(state.checks.some((check) => /test:e2e/.test(check.command)), 'an existing suite must still run');
});

test('a plan that declares product E2E still blocks until the suite exists', async (t) => {
  const f = fixture(t);
  const prepare = await prepared(f);
  assert.equal(prepare.needsProductE2e, true);
  assert.equal(prepare.hasProductE2e, false);
  await assert.rejects(verifyFails(f), /제품 E2E/);
  addE2e(prepare);
  const state = await done(f.serviceApi, 'verify');
  assert.equal(state.phase, 'verified', JSON.stringify(state.checks?.filter((check) => check.exitCode !== 0)));
  assert.ok(state.checks.some((check) => /test:e2e/.test(check.command)), 'declared product E2E must run');
});
async function verifyFails(f) {
  const state = await done(f.serviceApi, 'verify');
  if (state.phase === 'verified') throw new Error('verification should not have passed');
  throw new Error(state.job?.error ?? state.error ?? 'unknown');
}

test('a run whose Root base moved reports itself stale instead of only failing actions', async (t) => {
  const f = fixture(t);
  await prepared(f);
  assert.equal(f.serviceApi.status('candidate-run').stale, false);

  // Someone merged something else into main after this run was approved.
  writeFileSync(join(f.root, 'moved.txt'), 'after approval\n');
  f.git(['add', 'moved.txt']);
  f.git(['commit', '-qm', 'unrelated main commit']);
  f.git(['update-ref', 'refs/remotes/origin/main', f.git(['rev-parse', 'HEAD'])]);

  assert.equal(f.serviceApi.status('candidate-run').stale, true);
  // The actions still refuse, which is why the screen needs the flag to offer a way out.
  const state = await done(f.serviceApi, 'verify');
  assert.notEqual(state.phase, 'verified');
  assert.match(state.job?.error ?? state.error ?? '', /Root base SHA/);
});

test('a new run inherits the product suite source from a prior run but not its evidence', async (t) => {
  const f = fixture(t);
  const first = await prepared(f);
  addE2e(first);
  const verified = await done(f.serviceApi, 'verify');
  assert.equal(verified.phase, 'verified', JSON.stringify(verified.checks?.filter((c) => c.exitCode !== 0)));

  // Abandon that run and approve a second candidate for the same change.
  const preview = await f.serviceApi.perform('preview', { change });
  assert.equal(preview.candidate, '002', 'the used number is not reissued');
  await f.serviceApi.perform('approve', { revision: preview.revision, run: 'candidate-run-2' });
  const second = await done(f.serviceApi, 'prepare', 'candidate-run-2');
  assert.equal(second.phase, 'prepared', JSON.stringify(second.error));

  // Source carried forward, so nobody rewrites the suite by hand.
  assert.equal(second.hasProductE2e, true);
  assert.equal(second.inheritedProductE2e.run, 'candidate-run');
  assert.ok(existsSync(join(second.workspace, 'e2e/product.test.mjs')));
  // Evidence is not carried: this run starts with no checks and no linked evidence.
  assert.deepEqual(second.checks, []);
  assert.deepEqual(second.evidence, []);
  assert.equal(second.linkedChecks, undefined);
});

test('a published run is not stale when main moves: that is what merging it does', async (t) => {
  const f = fixture(t);
  const prepare = await prepared(f);
  addE2e(prepare);
  const verified = await done(f.serviceApi, 'verify');
  assert.equal(verified.phase, 'verified', JSON.stringify(verified.checks?.filter((c) => c.exitCode !== 0)));
  const [suggestion] = verified.suggestions;
  await f.serviceApi.perform('evidence', { run: 'candidate-run',
    links: [{ criterion: 'AC-001', checkIds: suggestion.checkIds, note: '확인했다.', confirmed: true }] });
  const created = await done(f.serviceApi, 'pr');
  assert.equal(created.phase, 'pr-created', JSON.stringify(created.error));
  assert.equal(created.stale, false);

  // Merging the Candidate PR necessarily moves main past the approved base.
  writeFileSync(join(f.root, 'merged.txt'), 'candidate merged\n');
  f.git(['add', 'merged.txt']);
  f.git(['commit', '-qm', 'merge candidate']);
  f.git(['update-ref', 'refs/remotes/origin/main', f.git(['rev-parse', 'HEAD'])]);

  // That must not read as an expiry, or the closing form would be hidden.
  assert.equal(f.serviceApi.status('candidate-run').stale, false);
  assert.equal(f.serviceApi.status('candidate-run').phase, 'pr-created');
});

test('closing still works after other changes land on main', async (t) => {
  const f = fixture(t);
  const created = await published(f, t);
  const mergeSha = mergeCandidate(f, created);
  await f.serviceApi.perform('remote-status', { run: 'candidate-run' });

  // Somebody else merges while the Coordinator checks the integration environment:
  // a real commit descending from the Candidate merge, with no branch or worktree touched.
  const workspace = f.serviceApi.status('candidate-run').workspace;
  const tree = f.git(['rev-parse', `${mergeSha}^{tree}`], workspace);
  const moved = f.git(['commit-tree', tree, '-p', mergeSha, '-m', 'unrelated change'], workspace);
  f.git(['update-ref', 'refs/remotes/origin/main', moved], workspace);

  const note = '실습 환경에서 등록과 새로고침을 직접 확인했다.';
  await f.serviceApi.perform('close', { run: 'candidate-run', environment: { note, confirmed: true } });
  let state = f.serviceApi.status('candidate-run');
  for (let attempts = 0; attempts < 300 && state.job?.running; attempts += 1) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    state = f.serviceApi.status('candidate-run');
  }
  assert.equal(state.phase, 'closure-pr-created', JSON.stringify(state.error));
  const release = YAML.parse(readFileSync(join(state.workspace, `changes/${change}/releases/candidate-001.yaml`), 'utf8'));
  // The record still cites the Candidate's own merge, not whatever main drifted to.
  assert.equal(release.closure.candidate_merge_sha, mergeSha);
  // The branch is based on current main so the closure PR merges cleanly.
  const manifest = YAML.parse(readFileSync(join(state.workspace, `changes/${change}/WORK_UNITS.yaml`), 'utf8'));
  assert.equal(manifest.work_units.find((unit) => unit.id === 'candidate-closure').base_sha, moved);
});
