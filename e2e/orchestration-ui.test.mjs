import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import YAML from 'yaml';
import { recordPrNumber } from '../scripts/orchestration/plan-pr.mjs';
import { createOrchestrationServer } from '../scripts/orchestration/server.mjs';

let root;
let server;
let origin;

test.beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'orchestration-browser-'));
  mkdirSync(join(root, 'changes'), { recursive: true });
  mkdirSync(join(root, 'changes/CHG-EXISTING-001'), { recursive: true });
  writeFileSync(join(root, 'changes/CHG-EXISTING-001/WORK_UNITS.yaml'), `schema_version: 1
change_id: CHG-EXISTING-001
state: approved
work_units: []
`);
  mkdirSync(join(root, 'services/api'), { recursive: true });
  mkdirSync(join(root, 'services/web'), { recursive: true });
  writeFileSync(join(root, 'services/registry.yaml'), `version: 2
github:
  host: github.com
services:
  - id: api
    path: services/api
    repo: https://github.com/acme/api.git
    owners: [acme/api]
    verify: [npm test]
  - id: web
    path: services/web
    repo: https://github.com/acme/web.git
    owners: [acme/web]
    verify: [npm test]
`);
  writeFileSync(join(root, '.gitmodules'), `[submodule "services/api"]
  path = services/api
  url = https://github.com/acme/api.git
[submodule "services/web"]
  path = services/web
  url = https://github.com/acme/web.git
`);
  for (const directory of [join(root, 'services/api'), join(root, 'services/web'), root]) {
    execFileSync('git', ['init', '-qb', 'main'], { cwd: directory });
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: directory });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: directory });
    execFileSync('git', ['config', 'advice.addEmbeddedRepo', 'false'], { cwd: directory });
    if (directory !== root) writeFileSync(join(directory, 'README.md'), `${directory.split('/').at(-1)}\n`);
    execFileSync('git', ['add', '.'], { cwd: directory });
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: directory });
  }
  server = createOrchestrationServer({ root, uiRoot: join(import.meta.dirname, '../ui') });
  await new Promise((resolvePromise) => server.listen(0, '127.0.0.1', resolvePromise));
  origin = `http://127.0.0.1:${server.address().port}`;
});

test.afterAll(async () => {
  if (server) await new Promise((resolvePromise) => server.close(resolvePromise));
  if (root) rmSync(root, { recursive: true, force: true });
});

test.afterEach(() => {
  rmSync(join(root, 'changes/CHG-BROWSER-001'), { recursive: true, force: true });
  rmSync(join(root, 'changes/CHG-RESUME-001'), { recursive: true, force: true });
});

test('meeting flow captures multiple goals and optional scope details before saving', async ({ page }) => {
  await page.goto(origin);
  await expect(page.getByRole('heading', { name: '협업 계획 세우기' })).toBeVisible();
  await expect(page.locator('#dispatch-open')).toBeVisible();
  await expect(page.locator('#dispatch-open')).toBeEnabled();
  await page.locator('#dispatch-open').click();
  await expect(page.getByRole('dialog', { name: '작업 지시서 만들기' })).toBeVisible();
  await page.getByRole('button', { name: '닫기' }).click();
  await expect(page.getByLabel('참여 팀 또는 그룹')).toHaveCount(0);
  await expect(page.locator('#repo-status')).toHaveCount(0);
  await expect(page.getByText('실행 원칙', { exact: true })).toHaveCount(0);
  await expect(page.locator('.required').first()).toHaveText('*');
  const requiredAlignment = await page.locator('.field-label').first().evaluate((label) => {
    const marker = label.querySelector('.required').getBoundingClientRect();
    const caption = label.getBoundingClientRect();
    return { markerTop: marker.top, markerBottom: marker.bottom, captionTop: caption.top, captionBottom: caption.bottom };
  });
  assert.ok(requiredAlignment.markerTop < requiredAlignment.captionBottom);
  assert.ok(requiredAlignment.markerBottom > requiredAlignment.captionTop);
  await page.getByRole('button', { name: '다음' }).click();
  await expect(page.getByText('필수 항목을 확인해 주세요.')).toBeVisible();

  await page.getByLabel('계획 ID').first().fill('CHG-BROWSER-001');
  await page.getByLabel('계획 제목').fill('브라우저 계획');
  await page.getByLabel('계획 진행자').fill('jpyoon');
  await page.getByLabel('목표 제목').fill('계획 작성 자동화');
  await page.getByLabel('기대 결과').fill('회의 결과를 작업 문서로 저장한다.');
  await page.getByRole('button', { name: '목표 추가' }).click();
  await page.getByLabel('목표 제목').nth(1).fill('실행 준비 단순화');
  await page.getByLabel('기대 결과').nth(1).fill('작업자가 승인된 범위를 바로 확인한다.');
  await page.getByRole('button', { name: '다음' }).click();
  await expect(page.getByRole('group', { name: /영향을 받는 서비스/ })).toBeVisible();
  const serviceLegendY = await page.getByRole('group', { name: /영향을 받는 서비스/ }).evaluate((node) => node.getBoundingClientRect().top);
  const nonGoalsY = await page.getByText('제외 범위', { exact: true }).evaluate((node) => node.getBoundingClientRect().top);
  assert.ok(serviceLegendY < nonGoalsY);

  await page.getByLabel('제외 범위 없음').check();
  await expect(page.getByPlaceholder(/한 줄에 한 단계씩 입력해 주세요/)).toBeHidden();
  await page.getByRole('textbox', { name: '완료 기준 필수' }).fill('계획 파일이 생성된다.\n승인 전 작업 지시서 생성은 차단된다.');
  await page.getByLabel('api').check();
  await expect(page.getByText('services/api', { exact: true })).toBeVisible();
  await expect(page.getByText('https://github.com/acme/api.git', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '서비스 등록' }).click();
  await expect(page.getByRole('dialog', { name: '서비스 등록' })).toBeVisible();
  await expect(page.getByRole('button', { name: '등록 전 확인 다시 실행' })).toBeVisible();
  await page.getByRole('button', { name: '서비스 등록 닫기' }).click();
  await page.getByRole('button', { name: '다음' }).click();

  await page.getByRole('button', { name: '작업 추가' }).click();
  await expect(page.getByText('자동 생성', { exact: true }).first()).toBeVisible();
  await page.getByLabel('연결 목표').selectOption('GOAL-001');
  await page.getByLabel('이 작업의 목표').fill('API 변경을 구현한다.');
  await page.getByRole('combobox', { name: '서비스', exact: true }).selectOption('api');
  await page.getByLabel('담당자').fill('alice');
  await expect(page.getByRole('textbox', { name: '수정 경로 1', exact: true })).toHaveValue('');
  await expect(page.getByLabel('저장소 전체를 수정 범위로 사용')).toBeVisible();
  await page.getByLabel('저장소 전체를 수정 범위로 사용').check();
  await expect(page.getByRole('textbox', { name: '수정 경로 1', exact: true })).toHaveValue('**');
  await expect(page.getByRole('textbox', { name: '수정 경로 1', exact: true })).toBeDisabled();
  await page.getByLabel('저장소 전체를 수정 범위로 사용').uncheck();
  await expect(page.getByRole('textbox', { name: '수정 경로 1', exact: true })).toBeEnabled();
  await page.getByRole('textbox', { name: '수정 경로 1', exact: true }).fill('src/api/**');
  await page.getByRole('button', { name: '경로 추가' }).click();
  await page.getByRole('textbox', { name: '수정 경로 2', exact: true }).fill('tests/**');
  await page.getByRole('button', { name: '작업 추가' }).click();
  await expect(page.locator('[data-unit-toggle]').first()).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('[data-unit-toggle]').nth(1)).toHaveAttribute('aria-expanded', 'true');
  await page.locator('[data-unit-toggle]').first().click();
  await expect(page.locator('[data-unit-toggle]').first()).toHaveAttribute('aria-expanded', 'true');
  await page.getByRole('button', { name: /작업 삭제/ }).nth(1).click();
  await page.getByRole('button', { name: '다음' }).click();
  await expect(page.getByRole('heading', { name: '서비스가 함께 지킬 계약을 연결하세요' })).toBeVisible();
  await expect(page.getByLabel('공유 계약 없음')).toBeChecked();
  await page.getByRole('button', { name: '다음' }).click();
  await expect(page.getByRole('heading', { name: '저장 전에 실행 가능한 계획인지 확인하세요' })).toBeVisible();
  await expect(page.locator('#save-guidance')).toContainText('검토를 통과하면');
  await expect(page.locator('#dispatch-open')).toBeEnabled();
  await page.getByRole('button', { name: '계획 검토하기' }).click();
  await expect(page.locator('#validation-summary')).toContainText('검사 통과');
  await expect(page.locator('#save-guidance')).toContainText('저장할 수 있습니다');
  await expect(page.getByRole('tab', { name: 'WORK_UNITS.yaml' })).toBeVisible();
  await expect(page.locator('.file-preview-help')).toContainText('목표와 범위');
  await page.getByRole('tab', { name: 'WORK_UNITS.yaml' }).click();
  await expect(page.locator('.file-preview-help')).toContainText('작업 단위');
  await page.getByRole('button', { name: '계획 초안 저장' }).click();
  await expect(page.getByText('계획 초안을 저장했습니다.')).toBeVisible();
  await expect(page.getByLabel('계획 ID').first()).toHaveJSProperty('readOnly', true);
  await expect(page.locator('#dispatch-open')).toBeEnabled();
  assert.equal(existsSync(join(root, 'changes/CHG-BROWSER-001/WORK_UNITS.yaml')), true);

  await page.locator('#dispatch-open').click();
  await expect(page.getByText('병합된 계획을 고르면 실행 가능한 작업을 확인하고 담당자별 지시서를 만듭니다.')).toBeVisible();
  await page.getByLabel('승인된 계획 커밋 SHA').fill('a'.repeat(40));
  await page.getByLabel('계획 ID').last().fill('CHG-BROWSER-001');
  await page.getByRole('button', { name: '실행 가능한 작업 확인' }).click();
  await expect(page.locator('#dispatch-result')).toContainText('승인된 계획');
});

test('contract editor imports Markdown or JSON and maps participating repositories', async ({ page }) => {
  await page.goto(origin);
  await page.getByLabel('계획 ID').first().fill('CHG-CONTRACT-001');
  await page.getByLabel('계획 제목').fill('서비스 계약 계획');
  await page.getByLabel('계획 진행자').fill('jpyoon');
  await page.getByLabel('목표 제목').fill('계약 명확화');
  await page.getByLabel('기대 결과').fill('서비스가 같은 요청 규칙을 사용한다.');
  await page.getByRole('button', { name: '다음' }).click();
  await page.getByLabel('제외 범위 없음').check();
  await page.getByRole('textbox', { name: '완료 기준 필수' }).fill('계약 파일에 참여 저장소가 기록된다.');
  await page.getByLabel('api').check();
  await page.getByLabel('web').check();
  await page.getByRole('button', { name: '다음' }).click();
  await page.getByRole('button', { name: '작업 추가' }).click();
  await page.getByLabel('연결 목표').selectOption('GOAL-001');
  await page.getByRole('combobox', { name: '서비스', exact: true }).selectOption('api');
  await page.getByLabel('이 작업의 목표').fill('계약을 구현한다.');
  await page.getByLabel('담당자').fill('alice');
  await page.getByLabel('저장소 전체를 수정 범위로 사용').check();
  await page.getByRole('button', { name: '다음' }).click();
  await page.getByLabel('공유 계약 없음').uncheck();
  await expect(page.getByRole('button', { name: '계약 추가' })).toBeVisible();
  await page.getByLabel('계약 파일 업로드').setInputFiles({
    name: 'openapi.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{"openapi":"3.1.0"}\n'),
  });
  await expect(page.getByLabel('계약 파일 이름')).toHaveValue('openapi.json');
  await expect(page.getByLabel('계약 내용')).toHaveValue('{"openapi":"3.1.0"}\n');
  await expect(page.getByText('2개 이상', { exact: true })).toBeVisible();
  await page.getByLabel('api 계약 참여').check();
  await page.getByLabel('web 계약 참여').check();
  await expect(page.getByText('Upload', { exact: true })).toBeVisible();

  await expect(page.locator('[data-contract-summary]').first()).toHaveText('api, web · 내용 작성됨');
  await page.locator('[data-contract-toggle]').first().click();
  await expect(page.locator('[data-contract-toggle]').first()).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByLabel('계약 내용')).toBeHidden();
  await page.getByRole('button', { name: '계약 추가' }).click();
  await expect(page.locator('[data-contract-toggle]').first()).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('[data-contract-toggle]').nth(1)).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('[data-contract-summary]').nth(1)).toHaveText('참여 서비스 미지정 · 내용 미작성');
  await page.locator('[data-contract-toggle]').first().click();
  await expect(page.locator('[data-contract-toggle]').first()).toHaveAttribute('aria-expanded', 'true');
});

test('service registration detects the stack, applies only after preview, and refreshes the list', async ({ page }) => {
  const remoteRoot = mkdtempSync(join(tmpdir(), 'orchestration-browser-service-'));
  const source = join(remoteRoot, 'source');
  const bare = join(remoteRoot, 'payments-api.git');
  const previousEnv = {
    count: process.env.GIT_CONFIG_COUNT,
    key: process.env.GIT_CONFIG_KEY_0,
    value: process.env.GIT_CONFIG_VALUE_0,
    protocols: process.env.GIT_ALLOW_PROTOCOL,
  };
  try {
    mkdirSync(source, { recursive: true });
    execFileSync('git', ['init', '-qb', 'main'], { cwd: source });
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: source });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: source });
    writeFileSync(join(source, 'package.json'), '{"name":"payments-api"}\n');
    execFileSync('git', ['add', '.'], { cwd: source });
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: source });
    execFileSync('git', ['clone', '--bare', source, bare]);
    process.env.GIT_CONFIG_COUNT = '1';
    process.env.GIT_CONFIG_KEY_0 = `url.file://${remoteRoot}/.insteadOf`;
    process.env.GIT_CONFIG_VALUE_0 = 'https://github.com/acme/';
    process.env.GIT_ALLOW_PROTOCOL = 'file:https';

    await page.goto(origin);
    await page.getByLabel('계획 ID').first().fill('CHG-SERVICE-001');
    await page.getByLabel('계획 제목').fill('서비스 등록');
    await page.getByLabel('계획 진행자').fill('jpyoon');
    await page.getByLabel('목표 제목').fill('서비스 연결');
    await page.getByLabel('기대 결과').fill('새 저장소를 계획에 연결한다.');
    await page.getByRole('button', { name: '다음' }).click();
    await page.getByRole('button', { name: '서비스 등록' }).click();
    await expect(page.getByRole('button', { name: '등록 전 확인', exact: true })).toBeDisabled();
    await page.getByLabel('GitHub URL').fill('https://github.com/acme/payments-api.git/');
    await page.getByRole('button', { name: '등록 전 확인', exact: true }).click();
    await expect(page.locator('#service-preview-result')).toContainText('payments-api');
    await expect(page.locator('#service-preview-result')).toContainText('package.json 감지');
    await expect(page.locator('#service-preview-result')).toContainText('등록 시 생략 가능');
    await expect(page.getByLabel('기술 스택')).toHaveValue('node');
    await expect(page.getByLabel('GitHub URL')).toHaveValue('https://github.com/acme/payments-api.git');
    await expect(page.locator('#service-register')).toBeEnabled();
    await page.locator('#service-register').click();
    await expect(page.getByLabel('payments-api')).toBeChecked();
    await expect(page.locator('#service-list').getByText('services/payments-api', { exact: true })).toBeVisible();
    await expect(page.getByText('payments-api 서비스를 등록하고 선택했습니다.')).toBeVisible();
  } finally {
    for (const [key, value] of Object.entries({
      GIT_CONFIG_COUNT: previousEnv.count,
      GIT_CONFIG_KEY_0: previousEnv.key,
      GIT_CONFIG_VALUE_0: previousEnv.value,
      GIT_ALLOW_PROTOCOL: previousEnv.protocols,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(remoteRoot, { recursive: true, force: true });
  }
});

test('service registration ignores a preview response after the URL changes', async ({ page }) => {
  let releasePreview;
  let markStarted;
  const previewReleased = new Promise((resolvePromise) => { releasePreview = resolvePromise; });
  const previewStarted = new Promise((resolvePromise) => { markStarted = resolvePromise; });
  await page.route('**/api/services/preview', async (route) => {
    markStarted();
    await previewReleased;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        service: {
          repo: 'https://github.com/acme/review-first.git',
          id: 'review-first',
          path: 'services/review-first',
          stack: 'node',
          detected: true,
          marker: 'package.json',
        },
        dryRun: { exitCode: 0, output: 'ok' },
      }),
    });
  });

  await page.goto(origin);
  await page.getByLabel('계획 ID').first().fill('CHG-STALE-PREVIEW-001');
  await page.getByLabel('계획 제목').fill('서비스 등록 응답');
  await page.getByLabel('계획 진행자').fill('jpyoon');
  await page.getByLabel('목표 제목').fill('최신 URL 보존');
  await page.getByLabel('기대 결과').fill('변경된 URL이 이전 응답으로 덮이지 않는다.');
  await page.getByRole('button', { name: '다음' }).click();
  await page.getByRole('button', { name: '서비스 등록' }).click();
  const repoInput = page.getByLabel('GitHub URL');
  await repoInput.fill('https://github.com/acme/review-first.git');
  const previewResponse = page.waitForResponse('**/api/services/preview');
  await page.getByRole('button', { name: '등록 전 확인', exact: true }).click();
  await previewStarted;
  await repoInput.fill('https://github.com/acme/review-second.git');
  releasePreview();
  await previewResponse;
  await expect(repoInput).toHaveValue('https://github.com/acme/review-second.git');
  await expect(page.locator('#service-register')).toBeDisabled();
});

test('a single saved draft is restored into every planning step on startup', async ({ page }) => {
  const change = join(root, 'changes/CHG-RESUME-001');
  mkdirSync(join(change, 'contracts'), { recursive: true });
  writeFileSync(join(change, 'PLAN.md'), `# CHG-RESUME-001 — 이어서 작성할 계획

## State

- Status: DRAFT
- Coordinator: jpyoon

## Goals

### GOAL-001 — 계획 이어쓰기

저장된 내용을 다시 편집한다.

## Non-goals

- 배포는 하지 않는다.

## User flow

1. 초안을 불러온다.
2. 내용을 수정한다.

## Acceptance criteria

- [AC-001] 모든 단계가 복원된다.

## Contracts

- Shared snapshots: \`contracts/api.md\` (api ↔ web)
`);
  writeFileSync(join(change, 'WORK_UNITS.yaml'), `schema_version: 1
change_id: CHG-RESUME-001
state: draft
work_units:
  - id: contract-and-plan
    repo: root
    state: in_progress
    goal: approve
    branch: change/CHG-RESUME-001/coordination
    writer: jpyoon
    write_paths: [changes/CHG-RESUME-001/**]
    depends_on: []
    verify: [npm test]
  - id: api-change
    goal_id: GOAL-001
    repo: api
    state: draft
    goal: API를 수정한다.
    branch: feat/CHG-RESUME-001/api-change
    writer: alice
    write_paths: [src/api/**]
    depends_on: [contract-and-plan]
    verify: []
  - id: candidate-integration
    repo: root
    state: draft
    goal: integrate
    branch: change/CHG-RESUME-001/candidate-integration
    writer: jpyoon
    write_paths: [changes/CHG-RESUME-001/**]
    depends_on: [api-change]
    verify: [npm test]
`);
  writeFileSync(join(change, 'contracts/api.md'), '# API contract\n');

  await page.goto(origin);
  await expect(page.getByText('CHG-RESUME-001 초안을 불러왔습니다.')).toBeVisible();
  await expect(page.getByLabel('계획 ID').first()).toHaveValue('CHG-RESUME-001');
  await expect(page.getByLabel('목표 제목')).toHaveValue('계획 이어쓰기');
  await page.getByRole('button', { name: '2단계 범위와 완료 기준' }).click();
  await expect(page.getByRole('checkbox', { name: 'api', exact: true })).toBeChecked();
  await expect(page.getByRole('textbox', { name: '완료 기준 필수' })).toHaveValue('모든 단계가 복원된다.');
  await page.getByRole('button', { name: '3단계 작업 나누기' }).click();
  await expect(page.getByLabel('이 작업의 목표')).toHaveValue('API를 수정한다.');
  await expect(page.getByLabel('담당자')).toHaveValue('alice');
  await expect(page.getByRole('textbox', { name: '수정 경로 1', exact: true })).toHaveValue('src/api/**');
  await page.getByRole('button', { name: '4단계 서비스 간 계약' }).click();
  await expect(page.getByLabel('계약 파일 이름')).toHaveValue('api.md');
  await expect(page.getByLabel('계약 내용')).toHaveValue('# API contract\n');
  await expect(page.getByLabel('api 계약 참여')).toBeChecked();
  await expect(page.getByLabel('web 계약 참여')).toBeChecked();
  await page.getByRole('button', { name: '1단계 목표 정하기' }).click();
  await page.getByLabel('계획 제목').fill('새로 수정한 제목');
  await page.getByRole('button', { name: '2단계 범위와 완료 기준' }).click();
  await page.getByRole('button', { name: '서비스 목록 새로고침' }).click();
  await page.getByRole('button', { name: '1단계 목표 정하기' }).click();
  await expect(page.getByLabel('계획 제목')).toHaveValue('새로 수정한 제목');
});

test('generated goal IDs stay stable after deletion', async ({ page }) => {
  await page.goto(origin);
  await page.getByRole('button', { name: '목표 추가' }).click();
  await page.getByRole('button', { name: '목표 추가' }).click();
  await expect(page.locator('.generated-id[data-goal-id]')).toHaveText(['GOAL-001', 'GOAL-002', 'GOAL-003']);
  await page.getByRole('button', { name: 'GOAL-001 삭제' }).click();
  await expect(page.locator('.generated-id[data-goal-id]')).toHaveText(['GOAL-002', 'GOAL-003']);
});

test('mobile navigation keeps accessible names and does not overflow', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(origin);
  await expect(page.getByRole('button', { name: '1단계 목표 정하기' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '협업 계획 세우기' })).toBeAttached();
  const widths = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  assert.equal(widths.scroll, widths.client);
});

test('an approved plan is published through the planning PR panel', async ({ page }) => {
  const change = 'CHG-PUBLISH-001';
  const branch = `change/${change}/coordination`;
  const mergeSha = 'f'.repeat(40);
  const planPr = {
    preflight: (input) => ({
      change: input,
      branch,
      host: 'github.com',
      approval: 'approved',
      currentBranch: 'main',
      pendingPaths: [`changes/${input}/PLAN.md`],
      committed: false,
      branchExists: false,
      remoteBranchExists: false,
      gh: { installed: true, authenticated: true },
      blockers: [],
      ready: true,
      steps: [`git switch -c ${branch} origin/main`, `gh pr create --base main --head ${branch}`],
    }),
    execute: (input) => {
      recordPrNumber(root, input, 42, 'd'.repeat(40));
      return {
        change: input,
        branch,
        prNumber: 42,
        prUrl: 'https://github.com/acme/root/pull/42',
        headSha: 'd'.repeat(40),
        steps: [{ label: 'PR 생성', command: 'gh pr create', exitCode: 0 }],
      };
    },
    status: (input, number) => ({
      change: input,
      number,
      state: 'MERGED',
      url: 'https://github.com/acme/root/pull/42',
      reviewDecision: 'APPROVED',
      mergeSha,
      fetched: true,
    }),
    candidates: (input) => ({ change: input, ref: 'origin/main', candidates: [] }),
  };
  const publishServer = createOrchestrationServer({
    root,
    uiRoot: join(import.meta.dirname, '../ui'),
    planPr,
    token: 'e2e-token',
  });
  await new Promise((resolvePromise) => publishServer.listen(0, '127.0.0.1', resolvePromise));
  const publishOrigin = `http://127.0.0.1:${publishServer.address().port}`;

  try {
    await page.goto(`${publishOrigin}/#token=e2e-token`);
    await page.getByLabel('계획 ID').first().fill(change);
    await page.getByLabel('계획 제목').fill('계획 공개 흐름');
    await page.getByLabel('계획 진행자').fill('jpyoon');
    await page.getByLabel('목표 제목').fill('계획 승인 자동화');
    await page.getByLabel('기대 결과').fill('승인 값과 계획 PR을 UI에서 처리한다.');
    await page.getByRole('button', { name: '다음' }).click();
    await page.getByLabel('제외 범위 없음').check();
    await page.getByRole('textbox', { name: '완료 기준 필수' }).fill('계획 PR이 열린다.');
    await page.getByRole('checkbox', { name: 'api', exact: true }).check();
    await page.getByRole('button', { name: '다음' }).click();
    await page.getByRole('button', { name: '작업 추가' }).click();
    await page.getByLabel('연결 목표').selectOption('GOAL-001');
    await page.getByRole('combobox', { name: '서비스', exact: true }).selectOption('api');
    await page.getByLabel('이 작업의 목표').fill('API 변경을 구현한다.');
    await page.getByLabel('담당자').fill('alice');
    await page.getByRole('textbox', { name: '수정 경로 1', exact: true }).fill('src/api/**');
    await page.getByRole('button', { name: '다음' }).click();
    await page.getByRole('button', { name: '다음' }).click();
    await page.getByRole('button', { name: '계획 검토하기' }).click();
    await expect(page.locator('#validation-summary')).toContainText('검사 통과');
    await page.getByRole('button', { name: '계획 초안 저장' }).click();
    await expect(page.getByText('계획 초안을 저장했습니다.')).toBeVisible();

    await expect(page.locator('#publish')).toBeVisible();
    await expect(page.locator('[data-approve-state]')).toHaveText('필요');
    await expect(page.locator('#plan-pr-check')).toBeDisabled();

    await page.getByRole('button', { name: '승인 요청으로 확정' }).click();
    await expect(page.locator('[data-approve-state]')).toHaveText('완료');
    assert.equal(YAML.parse(readFileSync(join(root, `changes/${change}/WORK_UNITS.yaml`), 'utf8')).state, 'approved');

    await page.getByRole('button', { name: '실행 전 확인' }).click();
    await expect(page.locator('#plan-pr-result')).toContainText('계획 브랜치 change/CHG-PUBLISH-001/coordination');
    await expect(page.locator('#plan-pr-run')).toBeEnabled();

    await page.getByRole('button', { name: '계획 PR 올리기' }).click();
    await expect(page.locator('#plan-pr-result')).toContainText('PR #42 생성됨');
    await expect(page.locator('[data-pr-state]')).toHaveText('PR #42');

    await page.getByRole('button', { name: '병합 상태 확인' }).click();
    await expect(page.locator('#plan-merge-result')).toContainText(mergeSha);
    await page.getByRole('button', { name: '작업 지시서 만들기' }).last().click();
    await expect(page.getByRole('dialog', { name: '작업 지시서 만들기' })).toBeVisible();
    await expect(page.getByLabel('승인된 계획 커밋 SHA')).toHaveValue(mergeSha);
  } finally {
    await new Promise((resolvePromise) => publishServer.close(resolvePromise));
    rmSync(join(root, `changes/${change}`), { recursive: true, force: true });
  }
});
