export function initializeCandidate({ token }) {
  const $ = (id) => document.querySelector(`#candidate-${id}`);
  let preview = null;
  let execution = null;
  let selections = {};
  let timer = null;
  let generation = 0;

  // Four fixed rows. The twelve internal phases map onto them so the layout never
  // changes shape, and no phase name reaches the primary surface.
  const ROWS = [
    { key: 'collect', title: '결과 모으기' },
    { key: 'verify', title: '통합 검증' },
    { key: 'criteria', title: '완료 기준 확인' },
    { key: 'close', title: '마감' },
  ];
  const ROW_OF = {
    approved: 'collect', preparing: 'collect', 'prepare-failed': 'collect', prepared: 'verify',
    agent: 'verify', verifying: 'verify', 'verification-failed': 'verify', 'verification-interrupted': 'verify',
    verified: 'criteria', publishing: 'close', 'pr-failed': 'close', 'pr-created': 'close', closing: 'close',
    'closure-pr-created': 'close', closed: 'close',
  };
  const RETRY = { 'prepare-failed': 'prepare', 'verification-failed': 'verify', 'verification-interrupted': 'verify', 'pr-failed': 'pr' };

  function node(tag, text, className) {
    const item = document.createElement(tag);
    if (text !== undefined) item.textContent = text;
    if (className) item.className = className;
    return item;
  }
  function message(text, error = false) {
    $('message').textContent = text;
    $('message').hidden = !text;
    $('message').className = `message ${error ? 'error' : 'success'}`;
  }
  const short = (sha) => String(sha ?? '').slice(0, 7);
  function copyButton(label, value) {
    const button = node('button', label, 'quiet');
    button.type = 'button';
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(value);
        message(`${label.replace(' 복사', '')}을 복사했습니다.`);
      } catch { message('복사할 수 없습니다. 기술 상세에서 직접 선택하세요.', true); }
    });
    return button;
  }
  function link(label, href) {
    const anchor = node('a', label, 'publish-link');
    anchor.href = href;
    anchor.target = '_blank';
    anchor.rel = 'noreferrer';
    return anchor;
  }
  async function api(action, body) {
    const response = await fetch(`/api/candidate/${action}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json', 'x-coordination-token': token },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? '마감 작업에 실패했습니다.');
    return result;
  }
  async function updateRuns() {
    const result = await api('status');
    const changes = result.changes ?? [];
    $('change').replaceChildren(...changes.map((change) => new Option(change, change)));
    if (!changes.length && !result.runs.length) {
      message('마감할 작업이 없습니다. 계획 PR을 병합한 뒤 다시 열어 주세요.');
      return;
    }
    await selectChange();
  }
  // Opening the screen answers the first question without a button press.
  async function selectChange() {
    const change = $('change').value;
    const result = await api('status');
    const mine = (result.runs ?? []).filter((run) => run.change === change);
    $('run-field').hidden = mine.length < 2;
    $('run').replaceChildren(...mine.map((run) => new Option(run.run, run.run)));
    generation += 1;
    clearTimeout(timer);
    if (mine.length) {
      $('run').value = mine.at(-1).run;
      $('summary').hidden = true;
      await refresh();
      return;
    }
    execution = null;
    $('execution').hidden = true;
    await loadSummary();
  }
  async function startFresh() {
    generation += 1;
    clearTimeout(timer);
    execution = null;
    $('run').value = '';
    $('execution').hidden = true;
    message('');
    await loadSummary();
  }
  function freshButton(label) {
    const button = node('button', label, 'primary');
    button.type = 'button';
    button.addEventListener('click', () => {
      button.disabled = true;
      startFresh().catch((error) => { message(error.message, true); button.disabled = false; });
    });
    return button;
  }
  async function loadSummary() {
    const change = $('change').value;
    if (!change) return;
    $('summary').hidden = false;
    $('prs').replaceChildren(node('p', '병합 결과를 확인하고 있습니다…'));
    $('blockers').replaceChildren();
    $('start').disabled = true;
    preview = await api('preview', { change, selections });
    renderSummary();
  }
  async function refresh() {
    const id = $('run').value;
    if (!id) return;
    const version = generation;
    const result = await api(`status?run=${encodeURIComponent(id)}`);
    if (version !== generation || $('run').value !== id) return;
    execution = result;
    renderExecution();
    clearTimeout(timer);
    // Merge and main CI are read-only lookups; poll them instead of asking for a press.
    if (execution.job?.running) timer = setTimeout(() => refresh().catch((error) => message(error.message, true)), 1200);
    else if ((execution.phase === 'pr-created' && !execution.gates.mainCiPassed)
      || execution.phase === 'closure-pr-created') {
      timer = setTimeout(() => api('remote-status', { run: id }).then(refresh).catch(() => {}), 15000);
    }
  }
  async function perform(action, extra = {}) {
    message('');
    const result = await api(action, { run: execution.run, ...extra });
    if (result.run && result.run !== $('run').value) {
      $('run').append(new Option(result.run, result.run));
      $('run').value = result.run;
    }
    await refresh();
  }
  function action(label, name, extra = {}) {
    const button = node('button', label, 'secondary');
    button.type = 'button';
    button.addEventListener('click', () => {
      button.disabled = true;
      perform(name, extra).catch((error) => { message(error.message, true); refresh().catch(() => {}); });
    });
    return button;
  }

  function renderSummary() {
    $('start').disabled = !preview.ready;
    $('prs').replaceChildren(...preview.rows.map((row) => {
      const wrapper = node('article', undefined, 'candidate-pr-row');
      wrapper.append(node('strong', `${row.unit} · ${row.repo}`));
      const detail = row.state === 'merged'
        ? `PR #${row.number} 병합됨 · CI ${row.ci?.state === 'passed' ? '통과' : row.ci?.state === 'failed' ? '실패' : '진행 중'} · ${short(row.mergeSha)}`
        : row.state === 'missing' ? `${row.branch} 브랜치에 PR이 없습니다`
          : row.state === 'ambiguous' ? '같은 브랜치에 PR이 여러 개입니다. 통합할 PR을 고르세요'
            : `PR #${row.number}이 아직 병합되지 않았습니다`;
      wrapper.append(node('span', detail));
      if (row.url) wrapper.append(link('PR 열기', row.url));
      if (row.mergeSha) wrapper.append(copyButton('SHA 복사', row.mergeSha));
      if (row.options.length > 1) {
        const label = node('label', '통합할 PR');
        const select = node('select');
        select.append(new Option('PR을 선택하세요', ''), ...row.options.map((pull) => new Option(`#${pull.number} · ${pull.state}`, pull.number)));
        select.value = selections[row.unit] ?? '';
        select.addEventListener('change', () => {
          if (select.value) selections[row.unit] = Number(select.value);
          else delete selections[row.unit];
          loadSummary().catch((error) => message(error.message, true));
        });
        label.append(select);
        wrapper.append(label);
      }
      return wrapper;
    }));
    $('blockers').replaceChildren(...(preview.blockers.length
      ? preview.blockers.map((text) => node('p', text))
      : [node('p', `서비스 기록 ${preview.files.length}개와 포인터를 이 결과로 고정합니다. 계획 ${short(preview.planSha)} 기준입니다.`)]));
    $('preview-detail').textContent = `${JSON.stringify({ candidate: preview.candidate, planSha: preview.planSha,
      rootBase: preview.baseSha, branch: preview.branch, writer: preview.writer, services: preview.services,
      writePaths: preview.writePaths, files: preview.files, agentPaths: ['e2e/**'] }, null, 2)}\n\n${(preview.diffs ?? []).map((file) => `${file.path}\n${file.diff}`).join('\n\n')}`;
  }

  function rowState(key) {
    const current = ROW_OF[execution.phase];
    const order = ROWS.map((row) => row.key);
    if (execution.phase === 'closed') return 'done';
    const index = order.indexOf(key);
    const at = order.indexOf(current);
    if (index < at) return 'done';
    if (index > at) return 'pending';
    if (execution.job?.error || execution.error || RETRY[execution.phase]) return 'blocked';
    if (key === 'verify' && execution.phase === 'prepared' && execution.needsProductE2e && !execution.hasProductE2e) return 'blocked';
    if (execution.job?.running) return 'active';
    return 'attention';
  }
  function rowBody(key, state) {
    const parts = [];
    const checks = execution.checks ?? [];
    if (key === 'collect') {
      const rows = execution.approval.rows ?? [];
      parts.push(node('span', state === 'active' ? '전용 작업 폴더를 준비하고 있습니다.'
        : rows.map((row) => `${row.unit} #${row.number}`).join(' · ')));
    }
    if (key === 'verify') {
      if (execution.phase === 'prepared' && execution.needsProductE2e && !execution.hasProductE2e) {
        parts.push(node('span', '제품 E2E 테스트가 없어 이 조합을 검증할 수 없습니다. Agent에게 맡기거나 직접 e2e/*.test.mjs를 작성하세요.'));
        if (!execution.packetDigest) parts.push(action('Agent에게 E2E 맡기기', 'packet'));
        else {
          parts.push(copyButton('지시서 복사', execution.packet?.content ?? ''), copyButton('작업 폴더 경로 복사', execution.workspace));
        }
      } else if (execution.phase === 'agent') {
        parts.push(node('span', 'Agent가 작업 폴더를 쓰고 있습니다. 실제 handoff를 받은 뒤 확인하세요.'),
          copyButton('지시서 복사', execution.packet?.content ?? ''), copyButton('작업 폴더 경로 복사', execution.workspace),
          action('Agent 작업 끝났음', 'handoff'));
      } else {
        const passed = checks.filter((check) => check.exitCode === 0).length;
        parts.push(node('span', checks.length ? `검사 ${checks.length}개 중 ${passed}개 통과` : '선언된 검사와 제품 E2E를 실행합니다.'));
      }
    }
    if (key === 'criteria') {
      const count = execution.approval.criteria?.length ?? 0;
      parts.push(node('span', execution.evidence?.length
        ? `완료 기준 ${count}개를 확인했습니다.`
        : `완료 기준 ${count}개를 사람이 확인해야 합니다.`));
    }
    if (key === 'close') {
      const gates = execution.gates;
      parts.push(node('span', [
        `PR ${gates.prCreated ? `#${execution.pr.number} 생성됨` : '대기'}`,
        `병합 ${gates.merged ? '완료' : '대기'}`,
        `main CI ${gates.mainCiPassed ? '통과' : '대기'}`,
        `통합 환경 ${gates.integrationEnvironment === 'confirmed' ? '확인됨' : '사람 확인 필요'}`,
      ].join(' · ')));
      if (execution.pr) parts.push(link(`PR #${execution.pr.number} 열기`, execution.pr.url));
      if (!gates.prCreated && execution.phase === 'verified' && execution.evidence?.length) parts.push(action('Candidate PR 만들기', 'pr'));
      if (gates.prCreated && !gates.merged) parts.push(node('span', 'GitHub에서 diff·CI·증거를 확인하고 병합하세요.'));
      if (gates.merged && gates.mainCiPassed && !gates.closurePrCreated) parts.push(closeForm());
      if (gates.closurePrCreated) {
        parts.push(node('span', gates.closureMerged
          ? `마감 기록이 main에 반영되었습니다. 이 작업은 닫혔습니다.`
          : `마감 PR #${execution.closure.pr.number}을 사람이 확인하고 병합해야 이 작업이 닫힙니다.`));
        parts.push(link(`마감 PR #${execution.closure.pr.number} 열기`, execution.closure.pr.url));
        if (gates.closureMerged) parts.push(freshButton('새 실행 시작'));
      }
    }
    // A run can fail without throwing: checks simply came back non-zero. Name the failing
    // check so the row never reads as "blocked" with no reason and no way forward.
    const failed = checks.filter((check) => check.exitCode !== undefined && check.exitCode !== 0);
    const failure = execution.job?.error ?? execution.error
      ?? (failed.length ? `${failed.map((check) => `${check.repo} · ${check.command}`).join(', ')} 실패. 로그를 확인하고 원인을 고친 뒤 다시 시도하세요.` : null);
    if (state === 'blocked') {
      if (failure) parts.push(node('p', failure, 'row-error'));
      const retry = RETRY[execution.phase];
      if (retry) parts.push(action('다시 시도', retry));
    }
    if (checks.length && key === 'verify') {
      const details = node('details');
      details.append(node('summary', '검사 기록'));
      for (const check of checks) {
        const entry = node('details');
        entry.append(node('summary', `${check.repo} · ${check.command} — ${check.exitCode === undefined ? '진행 중' : `exit ${check.exitCode}`}`),
          node('pre', check.output ?? '실행 중'));
        details.append(entry);
      }
      parts.push(details);
    }
    return parts;
  }
  function closeForm() {
    const wrapper = node('div', undefined, 'candidate-close-form');
    const field = node('label', '통합 환경에서 무엇을 확인했습니까?');
    const input = node('textarea');
    input.id = 'candidate-environment-note';
    input.rows = 2;
    field.append(input);
    const confirm = node('label', undefined, 'check-card');
    const box = node('input');
    box.type = 'checkbox';
    confirm.append(box, node('span', '통합 환경을 직접 확인했습니다.'));
    const submit = node('button', '작업 마감', 'primary');
    submit.type = 'button';
    submit.disabled = true;
    const sync = () => { submit.disabled = !box.checked || !input.value.trim(); };
    box.addEventListener('change', sync);
    input.addEventListener('input', sync);
    submit.addEventListener('click', () => {
      submit.disabled = true;
      perform('close', { environment: { note: input.value.trim(), confirmed: box.checked } })
        .catch((error) => { message(error.message, true); refresh().catch(() => {}); });
    });
    wrapper.append(field, confirm, submit);
    return wrapper;
  }
  function renderEvidence() {
    const open = execution.phase === 'verified' && !execution.evidence?.length;
    $('evidence').hidden = !open;
    if (!open) return;
    const passing = (execution.checks ?? []).filter((check) => check.exitCode === 0 && !check.command.startsWith('CI '));
    const byCriterion = new Map((execution.suggestions ?? []).map((item) => [item.criterion, item]));
    $('evidence-fields').replaceChildren(...execution.approval.criteria.map((criterion) => {
      const suggestion = byCriterion.get(criterion.id) ?? { checkIds: [], note: '' };
      const wrapper = node('article', undefined, 'candidate-evidence-row');
      wrapper.dataset.criterion = criterion.id;
      wrapper.append(node('strong', `${criterion.id} — ${criterion.text}`));
      const picked = passing.filter((check) => suggestion.checkIds.includes(check.id));
      wrapper.append(node('p', picked.length
        ? `근거  ${picked.map((check) => `${check.repo} · ${check.command} (exit ${check.exitCode})`).join(' / ')}`
        : '근거를 직접 고르세요.', 'evidence-suggestion'));
      const change = node('details');
      change.append(node('summary', '바꾸기'));
      for (const check of passing) {
        const label = node('label', undefined, 'check-card');
        const input = node('input');
        input.type = 'checkbox';
        input.value = check.id;
        input.dataset.checkId = '';
        input.checked = suggestion.checkIds.includes(check.id);
        label.append(input, node('span', `${check.repo} · ${check.command}`));
        change.append(label);
      }
      const note = node('label', '이 결과가 기준을 입증하는 이유');
      const textarea = node('textarea');
      textarea.value = suggestion.note ?? '';
      note.append(textarea);
      change.append(note);
      const confirm = node('label', undefined, 'check-card');
      const checkbox = node('input');
      checkbox.type = 'checkbox';
      checkbox.dataset.confirmed = '';
      confirm.append(checkbox, node('span', '실제 결과를 확인했고 이 기준을 입증함을 확인합니다.'));
      wrapper.append(change, confirm);
      return wrapper;
    }));
  }
  function renderExecution() {
    $('execution').hidden = false;
    $('summary').hidden = true;
    if (execution.stale) {
      // Every action would fail its freshness gate; offer the only move that works.
      const notice = node('li', undefined, 'candidate-row blocked');
      const head = node('div', undefined, 'candidate-row-head');
      head.append(node('strong', '만료된 실행'), node('span', '막힘', 'candidate-row-state'));
      notice.append(head, node('p', 'Root main이 이 실행을 승인한 이후로 바뀌었습니다. 이전 증거는 재사용하지 않고 새 실행으로 다시 시작하세요.', 'row-error'),
        freshButton('새 실행 시작'));
      $('track').replaceChildren(notice);
      $('evidence').hidden = true;
      $('logs').textContent = JSON.stringify({ run: execution.run, phase: execution.phase,
        approvedBase: execution.approval.baseSha, workspace: execution.workspace }, null, 2);
      return;
    }
    $('track').replaceChildren(...ROWS.map((row) => {
      const state = rowState(row.key);
      const item = node('li', undefined, `candidate-row ${state}`);
      const head = node('div', undefined, 'candidate-row-head');
      head.append(node('strong', row.title), node('span', {
        done: '완료', active: '진행', attention: '확인 필요', blocked: '막힘', pending: '대기',
      }[state], 'candidate-row-state'));
      item.append(head, ...rowBody(row.key, state));
      return item;
    }));
    $('logs').textContent = JSON.stringify({ run: execution.run, candidate: execution.candidate, phase: execution.phase,
      workspace: execution.workspace, approvalDigest: execution.approvalDigest, packetDigest: execution.packetDigest,
      planSha: execution.approval.planSha, rootBase: execution.approval.baseSha, services: execution.approval.services,
      verifiedHead: execution.verifiedHead, remote: execution.remote, closure: execution.closure, steps: execution.steps }, null, 2);
    renderEvidence();
  }

  $('open').addEventListener('click', async () => {
    document.querySelector('.shell').hidden = true;
    $('screen').hidden = false;
    $('title').focus();
    try { await updateRuns(); } catch (error) { message(error.message, true); }
  });
  $('close').addEventListener('click', () => {
    $('screen').hidden = true;
    document.querySelector('.shell').hidden = false;
    clearTimeout(timer);
    generation += 1;
    $('open').focus();
  });
  $('change').addEventListener('change', () => {
    preview = null;
    selections = {};
    message('');
    selectChange().catch((error) => message(error.message, true));
  });
  $('run').addEventListener('change', () => {
    generation += 1;
    clearTimeout(timer);
    refresh().catch((error) => message(error.message, true));
  });
  $('start').addEventListener('click', async () => {
    $('start').disabled = true;
    message('');
    try {
      const started = await api('start', { change: $('change').value });
      $('run').append(new Option(started.run, started.run));
      $('run').value = started.run;
      $('summary').hidden = true;
      await refresh();
    } catch (error) { message(error.message, true); $('start').disabled = false; }
  });
  $('save-evidence').addEventListener('click', async () => {
    $('save-evidence').disabled = true;
    try {
      const links = [...$('evidence-fields').children].map((row) => ({
        criterion: row.dataset.criterion, checkIds: [...row.querySelectorAll('[data-check-id]:checked')].map((item) => item.value),
        note: row.querySelector('textarea').value, confirmed: row.querySelector('[data-confirmed]').checked,
      }));
      await perform('evidence', { links });
      message('완료 기준 확인을 저장했습니다.');
    } catch (error) { message(error.message, true); }
    finally { $('save-evidence').disabled = false; }
  });
}
