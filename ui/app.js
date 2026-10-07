const state = {
  status: null,
  step: 0,
  revision: null,
  files: [],
  activeFile: null,
  token: readToken(),
  planPr: null,
};

function readToken() {
  const match = location.hash.match(/token=([A-Za-z0-9_-]+)/);
  if (!match) return '';
  history.replaceState(null, '', `${location.pathname}${location.search}`);
  return match[1];
}

const form = document.querySelector('#meeting-form');
const message = document.querySelector('#message');
const goals = document.querySelector('#goals');
const goalTemplate = document.querySelector('#goal-template');
const workUnits = document.querySelector('#work-units');
const unitTemplate = document.querySelector('#unit-template');
const contracts = document.querySelector('#contracts');
const contractTemplate = document.querySelector('#contract-template');
const serviceDialog = document.querySelector('#service-dialog');
const serviceForm = document.querySelector('#service-form');
let unitPanelSequence = 0;
let contractPanelSequence = 0;
let servicePreviewVersion = 0;

function lines(value) {
  return String(value ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
}

function showMessage(text, kind = 'error') {
  message.textContent = text;
  message.className = `message ${kind}`;
  message.hidden = false;
  message.focus();
}

function clearMessage() {
  message.hidden = true;
  message.textContent = '';
}

function fieldValue(name) {
  return String(form.elements[name]?.value ?? '').trim();
}

function setFieldInvalid(control, invalid) {
  control?.setAttribute('aria-invalid', String(invalid));
  return !invalid;
}

function validateStep(index) {
  const invalid = [];
  const requireText = (control) => {
    if (!control || !String(control.value).trim()) invalid.push(control);
  };

  if (index === 0) {
    ['changeId', 'title', 'coordinator'].forEach((name) => requireText(form.elements[name]));
    if (!goals.querySelector('.goal-card')) invalid.push(document.querySelector('#add-goal'));
    goals.querySelectorAll('.goal-card').forEach((card) => {
      requireText(card.querySelector('[data-goal="title"]'));
      requireText(card.querySelector('[data-goal="outcome"]'));
    });
  }
  if (index === 1) {
    if (!form.elements.noNonGoals.checked) requireText(form.elements.nonGoals);
    if (form.elements.hasUserFlow.checked) requireText(form.elements.userFlow);
    requireText(form.elements.acceptanceCriteria);
    if (!selectedServices().length) invalid.push(document.querySelector('#service-list input') || document.querySelector('#service-list'));
  }
  if (index === 2) {
    if (!workUnits.querySelector('.unit-card')) invalid.push(document.querySelector('#add-unit'));
    workUnits.querySelectorAll('.unit-card').forEach((card) => {
      ['goalId', 'service', 'goal', 'writer'].forEach((name) => requireText(card.querySelector(`[data-unit="${name}"]`)));
      const paths = [...card.querySelectorAll('[data-path]')];
      if (!paths.length || paths.every((input) => !input.value.trim())) invalid.push(card.querySelector('.add-path'));
    });
  }
  if (index === 3 && !form.elements.noSharedContract.checked) {
    if (!contracts.querySelector('.contract-card')) invalid.push(document.querySelector('#add-contract'));
    contracts.querySelectorAll('.contract-card').forEach((card) => {
      requireText(card.querySelector('[data-contract="name"]'));
      requireText(card.querySelector('[data-contract="content"]'));
      if (card.querySelectorAll('[data-contract-service]:checked').length < 2) invalid.push(card.querySelector('[data-contract-service]') || card);
    });
  }

  form.querySelectorAll('[aria-invalid="true"]').forEach((control) => control.setAttribute('aria-invalid', 'false'));
  invalid.forEach((control) => control?.setAttribute?.('aria-invalid', 'true'));
  return invalid;
}

function refreshStepAvailability() {
  document.querySelectorAll('[data-step-target]').forEach((button) => {
    const target = Number(button.dataset.stepTarget);
    button.disabled = target > state.step + 1;
  });
}

function showStep(index, { force = false } = {}) {
  const target = Number(index);
  if (!force && target > state.step) {
    const invalid = validateStep(state.step);
    if (invalid.length) {
      showMessage('필수 항목을 확인해 주세요. 표시된 내용을 완성하면 다음 단계로 이동할 수 있습니다.');
      invalid[0]?.focus?.();
      return false;
    }
  }
  state.step = target;
  document.querySelectorAll('.step-panel').forEach((panel) => {
    panel.hidden = Number(panel.dataset.step) !== state.step;
  });
  document.querySelectorAll('[data-step-target]').forEach((button) => {
    const step = Number(button.dataset.stepTarget);
    if (step === state.step) button.setAttribute('aria-current', 'step');
    else button.removeAttribute('aria-current');
    button.classList.toggle('complete', step < state.step);
  });
  refreshStepAvailability();
  clearMessage();
  document.querySelector(`[data-step="${state.step}"] h2`)?.focus?.();
  window.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  return true;
}

async function request(url, options) {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) {
    const error = new Error(body.error || body.errors?.map(({ message: item }) => item).join('\n') || '요청을 완료하지 못했습니다.');
    error.body = body;
    throw error;
  }
  return body;
}

async function loadStatus() {
  const hadStatus = Boolean(state.status);
  state.status = await request('/api/status');
  renderServiceChoices();
  renderPublish();
  if (!hadStatus && state.status.activeDraft) hydrateDraft(state.status.activeDraft);
  else {
    document.querySelectorAll('.unit-card').forEach(refreshUnitServices);
    document.querySelectorAll('.contract-card').forEach(renderContractServices);
  }
}

function selectedServices() {
  return [...form.querySelectorAll('[name="services"]:checked')].map(({ value }) => value);
}

function renderServiceChoices() {
  const serviceList = document.querySelector('#service-list');
  const serviceHelp = document.querySelector('#service-help');
  if (!state.status?.services.length) {
    serviceHelp.textContent = '등록된 서비스가 없습니다. GitHub 저장소를 먼저 등록해 주세요.';
    serviceList.replaceChildren();
    return;
  }
  serviceHelp.textContent = '이번 계획에서 수정하거나 계약으로 연결할 서비스를 선택하세요.';
  const selected = new Set(selectedServices());
  serviceList.replaceChildren(...state.status.services.map((service) => {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.name = 'services';
    input.value = service.id;
    input.checked = selected.has(service.id);
    input.setAttribute('aria-label', service.id);
    const copy = document.createElement('span');
    const name = document.createElement('strong');
    name.textContent = service.id;
    const path = document.createElement('small');
    path.textContent = service.path;
    copy.append(name, path);
    label.append(input, copy);
    return label;
  }));
}

function resetServiceRegistration() {
  servicePreviewVersion += 1;
  serviceForm.reset();
  delete serviceForm.dataset.previewRepo;
  serviceForm.elements.serviceStack.disabled = true;
  document.querySelector('#service-preview').disabled = true;
  document.querySelector('#service-refresh').disabled = true;
  document.querySelector('#service-register').disabled = true;
  const status = document.createElement('span');
  status.textContent = 'GitHub URL을 입력하면 등록 전 확인을 실행할 수 있습니다.';
  document.querySelector('#service-preview-result').replaceChildren(status);
}

function renderServicePreview(service, dryRun) {
  const container = document.querySelector('#service-preview-result');
  const rows = [
    ['서비스 ID', service.id],
    ['등록 경로', service.path],
    ['기술 스택', service.detected ? `${service.stack} · ${service.marker} 감지` : '자동 감지 실패 · 직접 입력 필요'],
    ['검증 명령', '등록 시 생략 가능 · 비우면 Work Unit은 초안'],
  ];
  container.replaceChildren(...rows.map(([label, value]) => {
    const row = document.createElement('div');
    const term = document.createElement('strong');
    const detail = document.createElement('span');
    term.textContent = label;
    detail.textContent = value;
    row.append(term, detail);
    return row;
  }));
  const result = document.createElement('small');
  result.textContent = `등록 전 확인 통과 · 종료 코드 ${dryRun.exitCode}`;
  container.append(result);
}

async function previewServiceRegistration() {
  const previewButton = document.querySelector('#service-preview');
  const registerButton = document.querySelector('#service-register');
  const repo = String(serviceForm.elements.serviceRepo.value ?? '').trim();
  const requestVersion = ++servicePreviewVersion;
  previewButton.disabled = true;
  previewButton.setAttribute('aria-busy', 'true');
  registerButton.disabled = true;
  try {
    const result = await request('/api/services/preview', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repo }),
    });
    if (requestVersion !== servicePreviewVersion || serviceForm.elements.serviceRepo.value.trim() !== repo || !serviceDialog.open) return;
    renderServicePreview(result.service, result.dryRun);
    serviceForm.elements.serviceStack.disabled = false;
    serviceForm.elements.serviceStack.value = result.service.stack === 'unspecified' ? '' : result.service.stack;
    serviceForm.elements.serviceRepo.value = result.service.repo;
    serviceForm.dataset.previewRepo = result.service.repo;
    document.querySelector('#service-refresh').disabled = false;
    registerButton.disabled = !serviceForm.elements.serviceStack.value.trim();
  } catch (error) {
    if (requestVersion !== servicePreviewVersion) return;
    document.querySelector('#service-preview-result').textContent = error.message;
    serviceForm.elements.serviceStack.disabled = true;
  } finally {
    if (requestVersion === servicePreviewVersion) {
      previewButton.disabled = false;
      previewButton.removeAttribute('aria-busy');
    }
  }
}

async function registerService() {
  const button = document.querySelector('#service-register');
  const repo = String(serviceForm.elements.serviceRepo.value ?? '').trim();
  const stack = String(serviceForm.elements.serviceStack.value ?? '').trim();
  if (repo !== serviceForm.dataset.previewRepo) {
    document.querySelector('#service-preview-result').textContent = 'URL이 변경되었습니다. 등록 전 확인을 다시 실행하세요.';
    button.disabled = true;
    return;
  }
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  try {
    const result = await request('/api/services', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ repo, stack }),
    });
    await loadStatus();
    const input = form.querySelector(`[name="services"][value="${CSS.escape(result.service.id)}"]`);
    if (input) {
      input.checked = true;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    serviceDialog.close();
    showMessage(`${result.service.id} 서비스를 등록하고 선택했습니다.`, 'success');
  } catch (error) {
    document.querySelector('#service-preview-result').textContent = error.message;
  } finally {
    button.removeAttribute('aria-busy');
  }
}

function goalOptions() {
  return [...goals.querySelectorAll('.goal-card')].map((card, index) => ({
    id: card.dataset.goalId,
    title: card.querySelector('[data-goal="title"]').value.trim() || `목표 ${index + 1}`,
  }));
}

function refreshGoalIndexes() {
  goals.querySelectorAll('.goal-card').forEach((card, index) => {
    const id = card.dataset.goalId;
    card.querySelector('[data-goal-id]').textContent = id;
    card.querySelector('[data-goal-heading]').textContent = card.querySelector('[data-goal="title"]').value.trim() || `목표 ${index + 1}`;
    card.querySelector('.remove').setAttribute('aria-label', `${id} 삭제`);
  });
  document.querySelectorAll('.unit-card').forEach(refreshUnitGoals);
}

function addGoal(value = {}) {
  const card = goalTemplate.content.firstElementChild.cloneNode(true);
  const used = new Set(goalOptions().map(({ id }) => id));
  let sequence = 1;
  while (used.has(`GOAL-${String(sequence).padStart(3, '0')}`)) sequence += 1;
  card.dataset.goalId = value.id || `GOAL-${String(sequence).padStart(3, '0')}`;
  card.querySelector('[data-goal="title"]').value = value.title ?? '';
  card.querySelector('[data-goal="outcome"]').value = value.outcome ?? '';
  card.querySelector('.remove').addEventListener('click', () => {
    if (goals.querySelectorAll('.goal-card').length === 1) {
      showMessage('계획에는 목표가 하나 이상 필요합니다.');
      return;
    }
    const linked = [...workUnits.querySelectorAll('[data-unit="goalId"]')].some(({ value }) => value === card.dataset.goalId);
    if (linked) {
      showMessage('이 목표에 연결된 작업이 있습니다. 작업을 다른 목표로 옮긴 뒤 삭제하세요.');
      return;
    }
    card.remove();
    refreshGoalIndexes();
    invalidatePreview();
  });
  card.querySelector('[data-goal="title"]').addEventListener('input', refreshGoalIndexes);
  goals.append(card);
  refreshGoalIndexes();
  if (goals.children.length > 1) card.querySelector('[data-goal="title"]').focus();
  invalidatePreview();
}

function refreshUnitServices(card) {
  const select = card.querySelector('[data-unit="service"]');
  const current = select.value;
  const services = selectedServices();
  select.replaceChildren(new Option('서비스 선택', ''), ...services.map((id) => new Option(id, id)));
  if ([...select.options].some(({ value }) => value === current)) select.value = current;
  else if (services.length === 1) select.value = services[0];
  updateUnitIdentity(card);
}

function refreshUnitGoals(card) {
  const select = card.querySelector('[data-unit="goalId"]');
  const current = select.value;
  select.replaceChildren(new Option('목표 선택', ''), ...goalOptions().map(({ id, title }) => new Option(`${id} · ${title}`, id)));
  if ([...select.options].some(({ value }) => value === current)) select.value = current;
}

function suggestedUnitId(card) {
  const existing = card.dataset.unitId;
  if (existing) return existing;
  const service = card.querySelector('[data-unit="service"]').value;
  if (!service) return '자동 생성';
  const used = new Set([...workUnits.querySelectorAll('.unit-card')].filter((candidate) => candidate !== card).map((candidate) => candidate.dataset.unitId).filter(Boolean));
  let sequence = 1;
  let id = service;
  while (used.has(id)) {
    sequence += 1;
    const suffix = `-${sequence}`;
    id = `${service.slice(0, 128 - suffix.length)}${suffix}`;
  }
  card.dataset.unitId = id;
  return id;
}

function updateUnitIdentity(card) {
  const id = suggestedUnitId(card);
  card.querySelector('[data-unit-id]').textContent = id;
  card.querySelector('[data-unit-heading]').textContent = card.querySelector('[data-unit="goal"]').value.trim() || '새 작업';
  card.querySelector('.remove').setAttribute('aria-label', `${id} 작업 삭제`);
  const service = card.querySelector('[data-unit="service"]').value;
  const writer = card.querySelector('[data-unit="writer"]').value.trim();
  card.querySelector('[data-unit-summary]').textContent = [service || '서비스 미지정', writer ? `담당 ${writer}` : '담당자 미지정'].join(' · ');
  const toggle = card.querySelector('[data-unit-toggle]');
  toggle.setAttribute('aria-label', `${id} 작업 ${toggle.getAttribute('aria-expanded') === 'true' ? '접기' : '펼치기'}`);
}

function applyCollapsed(card, toggle, body, collapsed) {
  body.hidden = collapsed;
  card.classList.toggle('is-collapsed', collapsed);
  toggle.setAttribute('aria-expanded', String(!collapsed));
}

function setUnitCollapsed(card, collapsed) {
  applyCollapsed(card, card.querySelector('[data-unit-toggle]'), card.querySelector('[data-unit-body]'), collapsed);
  updateUnitIdentity(card);
}

function fullScopeEligible(card) {
  const serviceId = card.querySelector('[data-unit="service"]').value;
  const service = state.status?.services.find(({ id }) => id === serviceId);
  const serviceCards = [...workUnits.querySelectorAll('.unit-card')]
    .filter((candidate) => candidate.querySelector('[data-unit="service"]').value === serviceId);
  const firstForService = serviceCards[0] === card;
  const cardsById = new Map([...workUnits.querySelectorAll('.unit-card')]
    .map((candidate) => [candidate.dataset.unitId, candidate]));
  const followsSameServiceWork = (id, seen = new Set()) => {
    if (seen.has(id)) return false;
    seen.add(id);
    const dependency = cardsById.get(id);
    if (!dependency) return false;
    if (dependency.querySelector('[data-unit="service"]').value === serviceId) return true;
    return lines(dependency.querySelector('[data-unit="dependsOn"]').value)
      .some((dependencyId) => followsSameServiceWork(dependencyId, seen));
  };
  const hasSameServicePredecessor = lines(card.querySelector('[data-unit="dependsOn"]').value)
    .some((id) => followsSameServiceWork(id));
  return Boolean(service?.bootstrapEligible && firstForService && !hasSameServicePredecessor);
}

function syncFullScope(card, { preserveValue = false } = {}) {
  const checkbox = card.querySelector('[data-full-scope]');
  const listNode = card.querySelector('.path-list');
  const addButton = card.querySelector('.add-path');
  if (checkbox.checked) {
    while (listNode.children.length > 1) listNode.lastElementChild.remove();
    const input = listNode.querySelector('[data-path]');
    input.value = '**';
    input.disabled = true;
    addButton.hidden = true;
  } else {
    listNode.querySelectorAll('[data-path]').forEach((input) => {
      input.disabled = false;
      if (!preserveValue && input.value.trim() === '**') input.value = '';
    });
    addButton.hidden = false;
  }
}

function refreshFullScopeOptions({ preserveValues = false } = {}) {
  workUnits.querySelectorAll('.unit-card').forEach((card) => {
    const option = card.querySelector('.scope-all-option');
    const checkbox = card.querySelector('[data-full-scope]');
    const eligible = fullScopeEligible(card);
    option.hidden = !eligible;
    checkbox.disabled = !eligible;
    if (!eligible && checkbox.checked) checkbox.checked = false;
    syncFullScope(card, { preserveValue: preserveValues });
  });
}

function addPath(card, value = '') {
  const listNode = card.querySelector('.path-list');
  const row = document.createElement('div');
  row.className = 'path-row';
  const input = document.createElement('input');
  input.dataset.path = '';
  input.value = value;
  input.placeholder = 'src/feature/**';
  const position = listNode.children.length + 1;
  input.setAttribute('aria-label', `수정 경로 ${position}`);
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'quiet icon-button';
  remove.setAttribute('aria-label', `수정 경로 ${position} 삭제`);
  remove.textContent = '×';
  remove.addEventListener('click', () => {
    if (listNode.children.length === 1) input.value = '';
    else row.remove();
    [...listNode.querySelectorAll('[data-path]')].forEach((control, index) => control.setAttribute('aria-label', `수정 경로 ${index + 1}`));
    invalidatePreview();
  });
  row.append(input, remove);
  listNode.append(row);
}

function addUnit(value = {}) {
  workUnits.querySelectorAll('.unit-card').forEach((existing) => setUnitCollapsed(existing, true));
  const card = unitTemplate.content.firstElementChild.cloneNode(true);
  unitPanelSequence += 1;
  const body = card.querySelector('[data-unit-body]');
  body.id = `unit-panel-${unitPanelSequence}`;
  const toggle = card.querySelector('[data-unit-toggle]');
  toggle.setAttribute('aria-controls', body.id);
  toggle.addEventListener('click', () => setUnitCollapsed(card, toggle.getAttribute('aria-expanded') === 'true'));
  refreshUnitGoals(card);
  refreshUnitServices(card);
  card.querySelector('[data-unit="service"]').addEventListener('change', () => {
    updateUnitIdentity(card);
    refreshFullScopeOptions();
  });
  card.querySelector('[data-unit="goal"]').addEventListener('input', () => updateUnitIdentity(card));
  card.querySelector('[data-unit="writer"]').addEventListener('input', () => updateUnitIdentity(card));
  card.querySelector('[data-full-scope]').addEventListener('change', () => {
    syncFullScope(card);
    invalidatePreview();
  });
  card.querySelector('.add-path').addEventListener('click', () => addPath(card));
  card.querySelector('.remove').addEventListener('click', () => {
    card.remove();
    if (!workUnits.querySelector('.unit-card')) workUnits.innerHTML = '<div class="empty-state"><strong>아직 작업이 없습니다</strong><span>목표를 구현할 첫 작업 단위를 추가해 주세요.</span></div>';
    document.querySelectorAll('.unit-card').forEach(updateUnitIdentity);
    refreshFullScopeOptions();
    invalidatePreview();
  });
  workUnits.querySelector('.empty-state')?.remove();
  workUnits.append(card);
  addPath(card);
  if (value.id) card.dataset.unitId = value.id;
  card.querySelector('[data-unit="goalId"]').value = value.goalId ?? '';
  card.querySelector('[data-unit="service"]').value = value.service ?? '';
  card.querySelector('[data-unit="goal"]').value = value.goal ?? '';
  card.querySelector('[data-unit="writer"]').value = value.writer ?? '';
  card.querySelector('[data-unit="dependsOn"]').value = (value.dependsOn ?? []).join('\n');
  card.querySelector('[data-unit="verify"]').value = (value.verify ?? []).join('\n');
  const paths = value.writePaths ?? [];
  if (paths.length) {
    card.querySelector('[data-path]').value = paths[0];
    for (const path of paths.slice(1)) addPath(card, path);
  }
  refreshFullScopeOptions({ preserveValues: paths.length > 0 });
  if (paths.length === 1 && paths[0] === '**' && fullScopeEligible(card)) {
    card.querySelector('[data-full-scope]').checked = true;
    syncFullScope(card);
  }
  updateUnitIdentity(card);
  setUnitCollapsed(card, false);
  card.querySelector('[data-unit="goalId"]').focus();
  invalidatePreview();
}

function renderContractServices(card) {
  const container = card.querySelector('.contract-services');
  const selected = new Set([...container.querySelectorAll('[data-contract-service]:checked')].map(({ value }) => value));
  container.replaceChildren(...selectedServices().map((id) => {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = id;
    input.dataset.contractService = '';
    input.checked = selected.has(id);
    input.setAttribute('aria-label', `${id} 계약 참여`);
    label.append(input, document.createTextNode(id));
    return label;
  }));
  updateContractSummary(card);
}

function updateContractSummary(card) {
  const services = [...card.querySelectorAll('[data-contract-service]:checked')].map(({ value }) => value);
  const written = card.querySelector('[data-contract="content"]').value.trim();
  card.querySelector('[data-contract-summary]').textContent = [
    services.length ? services.join(', ') : '참여 서비스 미지정',
    written ? '내용 작성됨' : '내용 미작성',
  ].join(' · ');
  const toggle = card.querySelector('[data-contract-toggle]');
  const id = card.querySelector('[data-contract-id]').textContent;
  toggle.setAttribute('aria-label', `${id} 계약 ${toggle.getAttribute('aria-expanded') === 'true' ? '접기' : '펼치기'}`);
}

function setContractCollapsed(card, collapsed) {
  applyCollapsed(card, card.querySelector('[data-contract-toggle]'), card.querySelector('[data-contract-body]'), collapsed);
  updateContractSummary(card);
}

function refreshContractIndexes() {
  contracts.querySelectorAll('.contract-card').forEach((card, index) => {
    const id = `CONTRACT-${String(index + 1).padStart(3, '0')}`;
    card.querySelector('[data-contract-id]').textContent = id;
    card.querySelector('[data-contract-heading]').textContent = card.querySelector('[data-contract="name"]').value.trim() || `계약 ${index + 1}`;
    card.querySelector('.remove').setAttribute('aria-label', `${id} 삭제`);
    updateContractSummary(card);
  });
}

function addContract(value = {}) {
  contracts.querySelectorAll('.contract-card').forEach((existing) => setContractCollapsed(existing, true));
  const card = contractTemplate.content.firstElementChild.cloneNode(true);
  contractPanelSequence += 1;
  const body = card.querySelector('[data-contract-body]');
  body.id = `contract-panel-${contractPanelSequence}`;
  const toggle = card.querySelector('[data-contract-toggle]');
  toggle.setAttribute('aria-controls', body.id);
  toggle.addEventListener('click', () => setContractCollapsed(card, toggle.getAttribute('aria-expanded') === 'true'));
  renderContractServices(card);
  card.querySelector('[data-contract="name"]').addEventListener('input', refreshContractIndexes);
  card.querySelector('.contract-services').addEventListener('change', () => updateContractSummary(card));
  card.querySelector('[data-contract="content"]').addEventListener('input', () => updateContractSummary(card));
  card.querySelector('[data-contract="file"]').addEventListener('change', async ({ target }) => {
    const file = target.files?.[0];
    if (!file) return;
    if (!/\.(?:md|json)$/i.test(file.name)) {
      target.value = '';
      showMessage('Markdown(.md) 또는 JSON(.json) 파일만 불러올 수 있습니다.');
      return;
    }
    const content = await file.text();
    if (file.name.toLowerCase().endsWith('.json')) {
      try {
        JSON.parse(content);
      } catch {
        target.value = '';
        showMessage('올바른 JSON 파일이 아닙니다. 문법을 확인해 주세요.');
        return;
      }
    }
    card.querySelector('[data-contract="name"]').value = file.name;
    card.querySelector('[data-contract="content"]').value = content;
    refreshContractIndexes();
    invalidatePreview();
  });
  card.querySelector('.remove').addEventListener('click', () => {
    card.remove();
    refreshContractIndexes();
    invalidatePreview();
  });
  contracts.append(card);
  card.querySelector('[data-contract="name"]').value = value.name ?? '';
  card.querySelector('[data-contract="content"]').value = value.content ?? '';
  const selected = new Set(value.serviceIds ?? []);
  card.querySelectorAll('[data-contract-service]').forEach((input) => { input.checked = selected.has(input.value); });
  refreshContractIndexes();
  setContractCollapsed(card, false);
  card.querySelector('[data-contract="name"]').focus();
  invalidatePreview();
}

function hydrateDraft(draft) {
  state.revision = null;
  form.elements.changeId.value = draft.changeId;
  form.elements.changeId.readOnly = true;
  form.elements.title.value = draft.title;
  form.elements.coordinator.value = draft.coordinator;

  goals.replaceChildren();
  for (const goal of draft.goals) addGoal(goal);

  form.elements.noNonGoals.checked = draft.noNonGoals;
  document.querySelector('#non-goals-field').hidden = draft.noNonGoals;
  form.elements.nonGoals.value = draft.nonGoals.join('\n');
  form.elements.hasUserFlow.checked = draft.hasUserFlow;
  document.querySelector('#user-flow-field').hidden = !draft.hasUserFlow;
  form.elements.userFlow.value = draft.userFlow.join('\n');
  form.elements.acceptanceCriteria.value = draft.acceptanceCriteria.join('\n');
  const selected = new Set(draft.services);
  form.querySelectorAll('[name="services"]').forEach((input) => { input.checked = selected.has(input.value); });

  workUnits.replaceChildren();
  for (const unit of draft.workUnits) addUnit(unit);

  form.elements.noSharedContract.checked = draft.noSharedContract;
  document.querySelector('#contract-fields').hidden = draft.noSharedContract;
  contracts.replaceChildren();
  for (const contract of draft.contracts) addContract(contract);

  refreshGoalIndexes();
  refreshFullScopeOptions({ preserveValues: true });
  showStep(0, { force: true });
  showMessage(`${draft.changeId} 초안을 불러왔습니다.`, 'success');
}

function collectDraft() {
  const data = new FormData(form);
  return {
    changeId: data.get('changeId'),
    title: data.get('title'),
    coordinator: data.get('coordinator'),
    goals: [...goals.querySelectorAll('.goal-card')].map((card) => ({
      id: card.dataset.goalId,
      title: card.querySelector('[data-goal="title"]').value,
      outcome: card.querySelector('[data-goal="outcome"]').value,
    })),
    noNonGoals: Boolean(data.get('noNonGoals')),
    nonGoals: data.get('noNonGoals') ? [] : lines(data.get('nonGoals')),
    hasUserFlow: Boolean(data.get('hasUserFlow')),
    userFlow: data.get('hasUserFlow') ? lines(data.get('userFlow')) : [],
    acceptanceCriteria: lines(data.get('acceptanceCriteria')),
    services: selectedServices(),
    noSharedContract: Boolean(data.get('noSharedContract')),
    contracts: data.get('noSharedContract') ? [] : [...contracts.querySelectorAll('.contract-card')].map((card) => ({
      name: card.querySelector('[data-contract="name"]').value,
      content: card.querySelector('[data-contract="content"]').value,
      serviceIds: [...card.querySelectorAll('[data-contract-service]:checked')].map(({ value }) => value),
    })),
    workUnits: [...workUnits.querySelectorAll('.unit-card')].map((card) => ({
      id: card.dataset.unitId || '',
      goalId: card.querySelector('[data-unit="goalId"]').value,
      service: card.querySelector('[data-unit="service"]').value,
      goal: card.querySelector('[data-unit="goal"]').value,
      writer: card.querySelector('[data-unit="writer"]').value,
      writePaths: [...card.querySelectorAll('[data-path]')].map(({ value }) => value).filter((value) => value.trim()),
      dependsOn: lines(card.querySelector('[data-unit="dependsOn"]').value),
      verify: lines(card.querySelector('[data-unit="verify"]').value),
    })),
  };
}

function renderFiles(files) {
  const filePurpose = (path) => {
    if (path === 'DRAFT.json') return 'UI에서 활성 초안을 손실 없이 다시 불러오기 위한 구조화된 편집 상태입니다.';
    if (path === 'PLAN.md') return '목표와 범위, 완료 기준, 계약을 사람이 검토하는 계획 문서입니다.';
    if (path === 'WORK_UNITS.yaml') return '작업 단위별 저장소, 담당자, 경로, 의존성과 실행 상태를 정의합니다.';
    if (path === 'PRS.yaml') return '작업별 PR 번호와 기준·작업·병합 SHA를 기록하는 추적 문서입니다.';
    if (path === 'STATUS.md') return '전체 계획의 현재 상태, 작업 진행도와 다음 승인 단계를 요약합니다.';
    if (path.startsWith('releases/')) return '서비스별 검증 대상 SHA와 후보 통합 상태를 고정합니다.';
    if (path.startsWith('contracts/')) return '서비스 사이에서 함께 지킬 API·이벤트·데이터 계약을 기록합니다.';
    return '계획을 실행하고 검증하는 데 필요한 생성 파일입니다.';
  };
  state.files = files;
  state.activeFile = files[0]?.path;
  const tabs = document.querySelector('#file-tabs');
  const preview = document.querySelector('#file-preview');
  const select = (path) => {
    state.activeFile = path;
    tabs.querySelectorAll('button').forEach((button) => {
      const selected = button.dataset.path === path;
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
      if (selected) preview.setAttribute('aria-labelledby', button.id);
    });
    preview.textContent = files.find((file) => file.path === path)?.diff ?? '';
    document.querySelector('.file-preview-help').textContent = filePurpose(path);
  };
  tabs.replaceChildren(...files.map(({ path }, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.role = 'tab';
    button.id = `file-tab-${index + 1}`;
    button.setAttribute('aria-controls', 'file-preview');
    button.dataset.path = path;
    button.textContent = path;
    button.addEventListener('click', () => select(path));
    button.addEventListener('keydown', ({ key }) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key)) return;
      const buttons = [...tabs.querySelectorAll('[role="tab"]')];
      const currentIndex = buttons.indexOf(button);
      const targetIndex = key === 'Home' ? 0
        : key === 'End' ? buttons.length - 1
          : (currentIndex + (key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
      select(buttons[targetIndex].dataset.path);
      buttons[targetIndex].focus();
    });
    return button;
  }));
  if (state.activeFile) select(state.activeFile);
}

function renderErrors(errors) {
  const summary = document.querySelector('#validation-summary');
  summary.className = 'validation-summary error';
  const title = document.createElement('strong');
  title.textContent = '저장 전 확인이 필요합니다';
  const list = document.createElement('ul');
  for (const error of errors) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'error-link';
    button.textContent = error.message;
    button.addEventListener('click', () => focusError(error.field));
    item.append(button);
    list.append(item);
  }
  summary.replaceChildren(title, list);
}

function focusError(field) {
  const [topLevel, rawIndex, property] = field.split('.');
  const stepByField = {
    changeId: 0, title: 0, coordinator: 0, goals: 0,
    nonGoals: 1, userFlow: 1, acceptanceCriteria: 1, services: 1,
    workUnits: 2, contracts: 3, review: 4,
  };
  showStep(stepByField[topLevel] ?? 4, { force: true });
  let target = form.elements[topLevel];
  const index = Number(rawIndex);
  if (topLevel === 'goals') target = goals.querySelectorAll('.goal-card')[index]?.querySelector(`[data-goal="${property}"]`) || goals.querySelector('[data-goal]');
  if (topLevel === 'workUnits') {
    const card = workUnits.querySelectorAll('.unit-card')[index];
    if (card) setUnitCollapsed(card, false);
    target = property === 'writePaths' ? card?.querySelector('[data-path]') : card?.querySelector(`[data-unit="${property}"]`);
    target ||= workUnits.querySelector('[data-unit]');
  }
  if (topLevel === 'services') target = form.querySelector('[name="services"]');
  if (topLevel === 'contracts') {
    const card = contracts.querySelectorAll('.contract-card')[index];
    if (card) setContractCollapsed(card, false);
    target = property === 'serviceIds' ? card?.querySelector('[data-contract-service]') : card?.querySelector(`[data-contract="${property}"]`);
    target ||= form.elements.noSharedContract;
  }
  target?.focus();
}

function invalidatePreview() {
  state.revision = null;
  document.querySelector('#save').disabled = true;
  const summary = document.querySelector('#validation-summary');
  if (!document.querySelector('#review').hidden) {
    summary.className = 'validation-summary stale';
    summary.textContent = '입력이 변경되었습니다. 저장 전에 계획 검토를 다시 실행하세요.';
    document.querySelector('#save-guidance').textContent = '입력이 변경되어 저장을 잠갔습니다. 계획 검토를 다시 실행하세요.';
  }
}

async function preview() {
  clearMessage();
  for (let step = 0; step < 4; step += 1) {
    const invalid = validateStep(step);
    if (invalid.length) {
      showStep(step, { force: true });
      showMessage('검토 전에 표시된 필수 항목을 완성해 주세요.');
      invalid[0]?.focus?.();
      return;
    }
  }
  state.revision = null;
  const previewButton = document.querySelector('#preview');
  const saveButton = document.querySelector('#save');
  const requestVersion = JSON.stringify(collectDraft());
  previewButton.disabled = true;
  previewButton.setAttribute('aria-busy', 'true');
  saveButton.disabled = true;
  document.querySelector('#save-guidance').textContent = '저장소 규칙을 검사하고 있습니다.';
  document.querySelector('#review-empty').hidden = true;
  document.querySelector('#review').hidden = false;
  try {
    const result = await request('/api/changes/preview', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: requestVersion,
    });
    if (requestVersion !== JSON.stringify(collectDraft())) return;
    state.revision = result.revision;
    const summary = document.querySelector('#validation-summary');
    summary.className = 'validation-summary success';
    const title = document.createElement('strong');
    title.textContent = '저장 준비 완료';
    const resultLine = document.createElement('span');
    resultLine.textContent = `저장소 규칙 검사 통과 · 종료 코드 ${result.validation.exitCode}`;
    const note = document.createElement('small');
    note.textContent = '계획 승인은 별도로 받아야 합니다.';
    summary.replaceChildren(title, resultLine, note);
    renderFiles(result.files);
    saveButton.disabled = false;
    document.querySelector('#save-guidance').textContent = '검토를 통과했습니다. 현재 내용을 계획 초안으로 저장할 수 있습니다.';
  } catch (error) {
    renderErrors(error.body?.errors ?? [{ message: error.message }]);
    document.querySelector('#file-tabs').replaceChildren();
    document.querySelector('#file-preview').textContent = '';
    document.querySelector('#save-guidance').textContent = '검토 오류를 수정한 뒤 계획 검토를 다시 실행하세요.';
  } finally {
    previewButton.disabled = false;
    previewButton.removeAttribute('aria-busy');
  }
}

async function save() {
  const saveButton = document.querySelector('#save');
  saveButton.disabled = true;
  saveButton.setAttribute('aria-busy', 'true');
  document.querySelector('#save-guidance').textContent = '계획 초안을 저장하고 있습니다.';
  try {
    const result = await request('/api/changes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ draft: collectDraft(), revision: state.revision }),
    });
    showMessage(`계획 초안을 저장했습니다. 파일 ${result.files.length}개를 만들었습니다. 다음 단계는 계획 PR 검토입니다.`, 'success');
    document.querySelector('#save-guidance').textContent = `저장 완료 · 파일 ${result.files.length}개를 만들었습니다.`;
    form.elements.changeId.readOnly = true;
    await loadStatus();
    renderPublish();
  } catch (error) {
    state.revision = null;
    showMessage(error.message);
    document.querySelector('#save-guidance').textContent = `${error.message} 계획 검토를 다시 실행해 주세요.`;
  } finally {
    saveButton.removeAttribute('aria-busy');
  }
}

function currentChangeId() {
  return String(form.elements.changeId.value ?? '').trim().toUpperCase();
}

function changeSummary() {
  return state.status?.changeStates?.[currentChangeId()] ?? null;
}

function publishLines(node, lines) {
  node.replaceChildren(...lines.map(({ text, kind }) => {
    const line = document.createElement('p');
    line.className = kind === 'error' ? 'publish-line is-error' : 'publish-line';
    line.textContent = text;
    return line;
  }));
}

function commandList(node, commands) {
  const list = document.createElement('pre');
  list.className = 'publish-commands';
  list.textContent = commands.join('\n');
  node.append(list);
}

function renderPublish() {
  const panel = document.querySelector('#publish');
  const summary = changeSummary();
  panel.hidden = !summary;
  if (!summary) return;
  const approved = ['approved', 'active'].includes(summary.state);
  const pr = summary.planningPr;
  document.querySelector('[data-approve-state]').textContent = approved ? '완료' : '필요';
  document.querySelector('#approve-change').hidden = approved;
  document.querySelector('[data-pr-state]').textContent = pr ? `PR #${pr.number}` : (approved ? '준비됨' : '대기');
  document.querySelector('#plan-pr-check').disabled = !approved;
  const runButton = document.querySelector('#plan-pr-run');
  runButton.hidden = Boolean(pr);
  runButton.disabled = !approved || !state.planPr?.ready;
  document.querySelector('[data-merge-state]').textContent = pr ? '확인 가능' : '대기';
  document.querySelector('#plan-merge-check').disabled = !pr;
}

async function approveChange() {
  const button = document.querySelector('#approve-change');
  const result = document.querySelector('#approve-result');
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  publishLines(result, [{ text: '승인 값을 기록하고 저장소 규칙을 검사하고 있습니다.' }]);
  try {
    const response = await request('/api/changes/approval', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ changeId: currentChangeId() }),
    });
    const lines = [{ text: `승인 요청으로 확정했습니다. 발급 가능한 작업 ${response.units.filter(({ state: unitState }) => unitState === 'ready').length}개.` }];
    for (const unit of response.waiting) lines.push({ text: `${unit.id}: ${unit.reason}` });
    publishLines(result, lines);
    showMessage('승인 값을 계획 파일에 기록했습니다. 이제 계획 PR을 올릴 수 있습니다.', 'success');
    await loadStatus();
    renderPublish();
  } catch (error) {
    const lines = [{ text: error.message, kind: 'error' }];
    for (const unit of error.body?.units ?? []) lines.push({ text: `${unit.id}: ${unit.reason}`, kind: 'error' });
    publishLines(result, lines);
    button.disabled = false;
  } finally {
    button.removeAttribute('aria-busy');
  }
}

async function checkPlanPr() {
  const button = document.querySelector('#plan-pr-check');
  const result = document.querySelector('#plan-pr-result');
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  publishLines(result, [{ text: '저장소 상태를 확인하고 있습니다.' }]);
  try {
    const preflight = await request(`/api/plan-pr/preflight?change=${encodeURIComponent(currentChangeId())}`);
    state.planPr = preflight;
    const lines = [
      { text: `현재 브랜치 ${preflight.currentBranch} · 계획 브랜치 ${preflight.branch}` },
      { text: preflight.pendingPaths.length
        ? `커밋할 계획 파일 ${preflight.pendingPaths.length}개`
        : '계획 파일이 이미 커밋되어 있습니다.' },
      { text: preflight.gh.authenticated ? `gh 인증됨 (${preflight.host})` : `gh 인증 필요 (${preflight.host})` },
    ];
    for (const blocker of preflight.blockers) lines.push({ text: blocker.message, kind: 'error' });
    if (!state.token) lines.push({ text: '접근 토큰이 없습니다. 서버가 출력한 주소로 다시 접속하세요.', kind: 'error' });
    publishLines(result, lines);
    commandList(result, preflight.steps);
    const runButton = document.querySelector('#plan-pr-run');
    runButton.hidden = false;
    runButton.disabled = !preflight.ready || !state.token;
  } catch (error) {
    state.planPr = null;
    publishLines(result, [{ text: error.message, kind: 'error' }]);
  } finally {
    button.disabled = false;
    button.removeAttribute('aria-busy');
  }
}

async function runPlanPr() {
  const button = document.querySelector('#plan-pr-run');
  const result = document.querySelector('#plan-pr-result');
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  publishLines(result, [{ text: '계획 브랜치를 만들고 PR을 올리는 중입니다.' }]);
  try {
    const response = await request('/api/plan-pr', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-coordination-token': state.token },
      body: JSON.stringify({ changeId: currentChangeId() }),
    });
    const lines = response.steps.map((step) => ({ text: `${step.label} · exit ${step.exitCode}` }));
    lines.push({ text: `PR #${response.prNumber} 생성됨 · 리뷰와 병합은 GitHub에서 진행합니다.` });
    publishLines(result, lines);
    if (response.prUrl) {
      const link = document.createElement('a');
      link.className = 'publish-link';
      link.href = response.prUrl;
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.textContent = response.prUrl;
      result.append(link);
    }
    showMessage(`계획 PR #${response.prNumber}을 올렸습니다. 리뷰어 승인과 병합 후 병합 확인을 누르세요.`, 'success');
    await loadStatus();
    renderPublish();
  } catch (error) {
    const lines = (error.body?.steps ?? []).map((step) => ({ text: `${step.label} · exit ${step.exitCode}` }));
    lines.push({ text: error.message, kind: 'error' });
    publishLines(result, lines);
    button.disabled = false;
  } finally {
    button.removeAttribute('aria-busy');
  }
}

async function checkPlanMerge() {
  const button = document.querySelector('#plan-merge-check');
  const result = document.querySelector('#plan-merge-result');
  const summary = changeSummary();
  if (!summary?.planningPr) return;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  publishLines(result, [{ text: 'PR 상태를 확인하고 있습니다.' }]);
  try {
    const change = currentChangeId();
    const response = await request(`/api/plan-pr/status?change=${encodeURIComponent(change)}&number=${summary.planningPr.number}`);
    if (!response.mergeSha) {
      publishLines(result, [{ text: `PR #${response.number} 상태 ${response.state}${response.reviewDecision ? ` · 리뷰 ${response.reviewDecision}` : ''}. 병합 후 다시 확인하세요.` }]);
      return;
    }
    publishLines(result, [{ text: `병합 완료 · 계획 SHA ${response.mergeSha}` }]);
    document.querySelector('[data-merge-state]').textContent = '병합됨';
    const dispatchForm = document.querySelector('#dispatch-form');
    dispatchForm.elements.dispatchChange.value = change;
    dispatchForm.elements.planSha.value = response.mergeSha;
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'primary';
    open.textContent = '작업 지시서 만들기';
    open.addEventListener('click', () => document.querySelector('#dispatch-dialog').showModal());
    result.append(open);
  } catch (error) {
    publishLines(result, [{ text: error.message, kind: 'error' }]);
  } finally {
    button.disabled = false;
    button.removeAttribute('aria-busy');
  }
}

async function loadPlanCandidates() {
  const dispatchForm = document.querySelector('#dispatch-form');
  const change = String(dispatchForm.elements.dispatchChange.value ?? '').trim();
  const field = document.querySelector('#plan-sha-choice');
  const select = dispatchForm.elements.planShaChoice;
  const resultNode = document.querySelector('#dispatch-result');
  try {
    const response = await request(`/api/plan-candidates?change=${encodeURIComponent(change)}`);
    if (!response.candidates.length) {
      field.hidden = true;
      resultNode.textContent = `${change} 계획이 아직 ${response.ref}에 병합되지 않았습니다.`;
      return;
    }
    select.replaceChildren(...response.candidates.map((candidate) => new Option(
      `${candidate.date} · ${candidate.state || '상태 없음'} · ${candidate.subject}`,
      candidate.sha,
    )));
    field.hidden = false;
    dispatchForm.elements.planSha.value = select.value;
    resultNode.textContent = `${response.candidates.length}개의 병합 커밋을 찾았습니다.`;
  } catch (error) {
    field.hidden = true;
    resultNode.textContent = error.message;
  }
}

function packetForm(unit, change, planSha) {
  const wrapper = document.createElement('div');
  wrapper.className = 'dispatch-unit';
  const title = document.createElement('strong');
  title.textContent = unit.id;
  const goal = document.createElement('p');
  goal.textContent = unit.goal;
  const metadata = document.createElement('p');
  metadata.className = 'help';
  metadata.textContent = `담당자 ${unit.writer} · ${unit.repo}`;
  wrapper.append(title, goal, metadata);
  const runLabel = document.createElement('label');
  runLabel.textContent = 'Run ID';
  const run = document.createElement('input');
  run.value = `run-${change}-${unit.id}-001`;
  runLabel.append(run);
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'primary';
  button.textContent = '작업 지시서 만들기';
  button.disabled = !unit.eligible;
  button.addEventListener('click', async () => {
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    try {
      const result = await request('/api/packets', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ change, planSha, unit: unit.id, writer: unit.writer, run: run.value }),
      });
      const receipt = document.createElement('p');
      receipt.className = 'help';
      receipt.textContent = `생성 완료: ${result.path} · sha256:${result.digest}`;
      const packet = document.createElement('pre');
      packet.setAttribute('aria-label', `${unit.id} 작업 지시서 내용`);
      packet.textContent = result.content;
      const download = document.createElement('a');
      download.className = 'publish-link';
      download.href = `/api/packets/${encodeURIComponent(run.value)}`;
      download.setAttribute('download', `${run.value}.md`);
      download.textContent = '지시서 내려받기';
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'quiet compact';
      copy.textContent = '내용 복사';
      copy.addEventListener('click', async () => {
        await navigator.clipboard.writeText(result.content);
        copy.textContent = '복사됨';
      });
      wrapper.append(receipt, download, copy, packet);
    } catch (error) {
      button.disabled = !unit.eligible;
      showMessage(error.message);
    } finally {
      button.removeAttribute('aria-busy');
    }
  });
  wrapper.append(runLabel, button);
  return wrapper;
}

async function checkDispatch() {
  const data = new FormData(document.querySelector('#dispatch-form'));
  const change = String(data.get('dispatchChange') ?? '').trim();
  const planSha = String(data.get('planSha') ?? '').trim();
  const resultNode = document.querySelector('#dispatch-result');
  const checkButton = document.querySelector('#check-dispatch');
  resultNode.textContent = '확인 중…';
  checkButton.disabled = true;
  checkButton.setAttribute('aria-busy', 'true');
  try {
    const result = await request(`/api/dispatch?change=${encodeURIComponent(change)}&planSha=${encodeURIComponent(planSha)}`);
    resultNode.replaceChildren(...result.units.map((unit) => packetForm(unit, change, planSha)));
    if (!result.units.length) resultNode.textContent = '지시서를 만들 수 있는 작업이 없습니다.';
  } catch (error) {
    resultNode.textContent = error.message;
  } finally {
    checkButton.disabled = false;
    checkButton.removeAttribute('aria-busy');
  }
}

document.querySelectorAll('[data-next]').forEach((button) => button.addEventListener('click', () => showStep(button.dataset.next)));
document.querySelectorAll('[data-back]').forEach((button) => button.addEventListener('click', () => showStep(button.dataset.back, { force: true })));
document.querySelectorAll('[data-step-target]').forEach((button) => button.addEventListener('click', () => showStep(button.dataset.stepTarget)));
document.querySelector('#add-goal').addEventListener('click', addGoal);
document.querySelector('#add-unit').addEventListener('click', addUnit);
document.querySelector('#add-contract').addEventListener('click', addContract);
document.querySelector('#preview').addEventListener('click', preview);
document.querySelector('#save').addEventListener('click', save);
document.querySelector('#service-register-open').addEventListener('click', () => {
  resetServiceRegistration();
  serviceDialog.showModal();
  serviceForm.elements.serviceRepo.focus();
});
document.querySelector('#service-preview').addEventListener('click', previewServiceRegistration);
document.querySelector('#service-refresh').addEventListener('click', previewServiceRegistration);
document.querySelector('#service-register').addEventListener('click', registerService);
serviceForm.elements.serviceRepo.addEventListener('input', () => {
  servicePreviewVersion += 1;
  const hasRepo = Boolean(serviceForm.elements.serviceRepo.value.trim());
  document.querySelector('#service-preview').disabled = !hasRepo;
  document.querySelector('#service-preview').removeAttribute('aria-busy');
  document.querySelector('#service-refresh').disabled = true;
  document.querySelector('#service-register').disabled = true;
  serviceForm.elements.serviceStack.disabled = true;
});
serviceDialog.addEventListener('close', () => { servicePreviewVersion += 1; });
serviceForm.elements.serviceStack.addEventListener('input', ({ target }) => {
  document.querySelector('#service-register').disabled = !target.value.trim();
});
document.querySelector('#refresh-services').addEventListener('click', async ({ currentTarget }) => {
  currentTarget.disabled = true;
  currentTarget.setAttribute('aria-busy', 'true');
  try {
    await loadStatus();
    showMessage('등록된 서비스 목록을 새로고침했습니다.', 'success');
  } catch (error) {
    showMessage(error.message);
  } finally {
    currentTarget.disabled = false;
    currentTarget.removeAttribute('aria-busy');
  }
});
document.querySelector('#dispatch-open').addEventListener('click', () => document.querySelector('#dispatch-dialog').showModal());
document.querySelector('#check-dispatch').addEventListener('click', checkDispatch);
document.querySelector('#approve-change').addEventListener('click', approveChange);
document.querySelector('#plan-pr-check').addEventListener('click', checkPlanPr);
document.querySelector('#plan-pr-run').addEventListener('click', runPlanPr);
document.querySelector('#plan-merge-check').addEventListener('click', checkPlanMerge);
document.querySelector('#load-candidates').addEventListener('click', loadPlanCandidates);
document.querySelector('#dispatch-form').elements.planShaChoice.addEventListener('change', ({ target }) => {
  document.querySelector('#dispatch-form').elements.planSha.value = target.value;
});
form.elements.noNonGoals.addEventListener('change', ({ target }) => {
  document.querySelector('#non-goals-field').hidden = target.checked;
  invalidatePreview();
});
form.elements.hasUserFlow.addEventListener('change', ({ target }) => {
  document.querySelector('#user-flow-field').hidden = !target.checked;
  if (target.checked) form.elements.userFlow.focus();
  invalidatePreview();
});
form.elements.noSharedContract.addEventListener('change', ({ target }) => {
  document.querySelector('#contract-fields').hidden = target.checked;
  if (!target.checked && !contracts.querySelector('.contract-card')) addContract();
  invalidatePreview();
});
form.addEventListener('input', invalidatePreview);
form.addEventListener('change', ({ target }) => {
  if (target.matches('[name="services"]')) {
    document.querySelectorAll('.unit-card').forEach(refreshUnitServices);
    document.querySelectorAll('.contract-card').forEach(renderContractServices);
    refreshFullScopeOptions();
  }
  if (target.matches('[data-goal="title"]')) document.querySelectorAll('.unit-card').forEach(refreshUnitGoals);
  invalidatePreview();
});

addGoal();
refreshStepAvailability();
loadStatus().catch((error) => showMessage(error.message));
