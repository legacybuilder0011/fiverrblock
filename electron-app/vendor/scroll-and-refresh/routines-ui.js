import { intervalFrom, keyFor, sitePermissions, remaining } from './core.js';
import { validateRoutine, routineKey, stepLabel } from './routines.js';
const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search), tabId = Number(params.get('tab'));
let saved = [], draft, state, busy = false, lastPick, dirty = false, activitySignature;
const step = type => ({ id: crypto.randomUUID(), type, ...(type === 'wait' ? { seconds: 3 } : {}) });
function error(text = '') { $('error').hidden = !text; $('error').textContent = text; }
async function request(type, data = {}) {
  const result = await chrome.runtime.sendMessage({ type, tabId, ...data });
  if (!result?.ok) throw new Error(result?.error || 'Could not reach the website tab.');
  return result.state;
}
function changed() {
  dirty = true; $('saved').textContent = 'Unsaved changes';
  void chrome.storage.session.set({ [`draft:${tabId}`]: draft });
}
function readFields() {
  draft.name = $('name').value; draft.startUrl = $('start-url').value;
  draft.interval = (Number($('minutes').value) * 60 + Number($('seconds').value)) * 1000;
  draft.destination = $('destination').value;
}
function library() {
  $('library').replaceChildren(); $('library-empty').hidden = saved.length > 0;
  for (const item of saved) {
    const button = document.createElement('button'); button.textContent = item.name;
    button.className = item.id === draft?.id ? 'selected' : '';
    const small = document.createElement('small'); small.textContent = `${new URL(item.startUrl).hostname} · ${item.steps.length} steps`;
    button.append(small); button.disabled = !!state?.running;
    button.addEventListener('click', () => { draft = structuredClone(item); dirty = false; renderEditor(); error(); });
    $('library').append(button);
  }
}
function renderSteps() {
  $('steps').replaceChildren();
  draft.steps.forEach((item, index) => {
    const row = document.createElement('li'); row.dataset.stepId = item.id;
    const top = document.createElement('div'); top.className = 'step-top';
    const title = document.createElement('strong'); title.textContent = { click: 'Click an element', navigate: 'Navigate to a page', wait: 'Wait until ready', scroll: 'Scroll the page', refresh: 'Refresh the page' }[item.type];
    const tools = document.createElement('div'); tools.className = 'step-tools';
    for (const [label, offset] of [['↑', -1], ['↓', 1], ['×', 0]]) {
      const button = document.createElement('button'); button.textContent = label;
      button.title = offset === 0 ? 'Remove step' : offset === -1 ? 'Move step up' : 'Move step down';
      button.setAttribute('aria-label', `${button.title}: ${index + 1}`);
      button.disabled = !!state?.running || (offset && (index + offset < 0 || index + offset >= draft.steps.length));
      button.addEventListener('click', () => {
        if (offset) [draft.steps[index], draft.steps[index + offset]] = [draft.steps[index + offset], draft.steps[index]];
        else draft.steps.splice(index, 1);
        changed(); renderSteps();
      }); tools.append(button);
    }
    top.append(title, tools); row.append(top);
    const body = document.createElement('div'); body.className = 'step-body';
    const description = document.createElement('p'); description.textContent = stepLabel(item); body.append(description);
    if (['click', 'wait'].includes(item.type)) {
      const select = document.createElement('button'); select.textContent = item.target ? 'Select a different target' : item.type === 'click' ? 'Select a button' : 'Select an element to wait for';
      select.className = 'pick'; select.disabled = !!state?.running;
      select.addEventListener('click', async () => {
        error(); readFields(); changed();
        try {
          const granted = await chrome.permissions.request({ origins: sitePermissions(draft.startUrl) });
          if (!granted) throw new Error('Allow access to this website to select an element.');
          await request('SELECT_TARGET', { stepId: item.id, kind: item.type });
        } catch (failure) { error(failure.message); }
      }); body.append(select);
      if (item.type === 'wait' && item.target) {
        const clear = document.createElement('button'); clear.textContent = 'Use a timed wait';
        clear.addEventListener('click', () => { delete item.target; changed(); renderSteps(); }); body.append(clear);
      }
    }
    if (['navigate', 'wait'].includes(item.type)) {
      const label = document.createElement('label'), input = document.createElement('input');
      label.textContent = item.type === 'navigate' ? 'Page URL' : item.target ? 'Maximum wait (seconds)' : 'Pause (seconds)';
      input.type = item.type === 'navigate' ? 'url' : 'number'; input.value = item.type === 'navigate' ? item.url || '' : item.seconds;
      if (item.type === 'wait') { input.min = '1'; input.max = '300'; }
      input.disabled = !!state?.running;
      input.addEventListener('input', () => { item[item.type === 'navigate' ? 'url' : 'seconds'] = item.type === 'navigate' ? input.value : Number(input.value); changed(); });
      label.append(input); body.append(label);
    }
    row.append(body); $('steps').append(row);
  });
}
function renderEditor() {
  $('name').value = draft.name; $('start-url').value = draft.startUrl;
  $('minutes').value = Math.floor(draft.interval / 60000); $('seconds').value = draft.interval / 1000 % 60;
  $('destination').value = draft.destination;
  $('saved').textContent = dirty ? 'Unsaved changes' : saved.some(item => item.id === draft.id) ? 'Saved' : 'New routine';
  library(); renderSteps(); renderStatus();
}
function renderStatus() {
  const running = !!state?.running;
  for (const id of ['name', 'start-url', 'minutes', 'seconds', 'destination', 'new', 'save', 'preview', 'start']) $(id).disabled = running || busy;
  $('delete').disabled = running || busy || !saved.some(item => item.id === draft?.id);
  document.querySelectorAll('[data-add]').forEach(button => { button.disabled = running; });
  $('stop').disabled = !running || busy; $('pause').disabled = !running || busy;
  $('pause').textContent = state?.phase === 'confirmation' ? 'Confirm click' : state?.phase === 'work' ? 'Saved — resume' : ['paused', 'missing'].includes(state?.phase) ? 'Resume / retry' : 'Pause';
  $('skip').hidden = !running || state.phase !== 'missing';
  $('phase').textContent = running ? state.phase.toUpperCase() : state?.phase === 'complete' ? 'PREVIEW COMPLETE' : 'READY';
  $('clock').textContent = running && state.phase === 'countdown' ? remaining(state.deadline) : state?.phase === 'paused' && state.remainingMs ? remaining(state.remainingMs, 0) : state?.phase === 'complete' ? '✓' : '—';
  if (running && state.phase === 'network') $('clock').textContent = remaining(state.networkRetryAt);
  $('status').textContent = running ? [state.phase === 'verification' ? 'Complete verification on the website.' : '', state.error || state.detail || 'Timer active'].filter(Boolean).join(' ') : state?.phase === 'complete' ? 'One cycle finished. Start repeating when you are ready.' : 'Save a routine or try the steps above.';
  if (running && state.phase === 'network') $('status').textContent = 'The page failed to load. Retrying automatically in the background; your routine step is saved.';
  const signature = JSON.stringify(state?.history || []);
  if (signature !== activitySignature) {
    activitySignature = signature; $('activity').replaceChildren();
    for (const item of [...(state?.history || [])].reverse().slice(0, 15)) {
      const li = document.createElement('li'), time = document.createElement('time');
      time.textContent = new Date(item.at).toLocaleTimeString(); li.append(time, document.createTextNode(item.event)); $('activity').append(li);
    }
  }
}
async function persist() {
  readFields(); intervalFrom(Number($('minutes').value), Number($('seconds').value));
  draft = validateRoutine(draft);
  const current = (await chrome.storage.local.get(routineKey))[routineKey] || [];
  saved = [...current.filter(item => item.id !== draft.id), draft];
  await chrome.storage.local.set({ [routineKey]: saved }); dirty = false; renderEditor();
}
function fresh() {
  draft = { id: crypto.randomUUID(), name: 'My routine', startUrl: params.get('url') || '', interval: 60000, destination: 'final', steps: [step('scroll'), step('refresh')] };
  dirty = false; renderEditor(); error();
}
document.querySelectorAll('[data-add]').forEach(button => button.addEventListener('click', () => {
  const item = step(button.dataset.add);
  if (item.type === 'navigate') item.url = draft.startUrl;
  draft.steps.splice(Math.max(0, draft.steps.length - 1), 0, item); changed(); renderSteps();
}));
for (const id of ['name', 'start-url', 'minutes', 'seconds', 'destination']) $(id).addEventListener('input', () => { readFields(); changed(); });
$('new').addEventListener('click', fresh);
$('save').addEventListener('click', () => persist().catch(failure => error(failure.message)));
$('delete').addEventListener('click', async () => {
  saved = ((await chrome.storage.local.get(routineKey))[routineKey] || []).filter(item => item.id !== draft.id);
  await chrome.storage.local.set({ [routineKey]: saved }); fresh();
});
$('show-page').addEventListener('click', () => chrome.tabs.update(tabId, { active: true }).catch(() => error('The website tab was closed. Open Routines again from the website.')));
for (const id of ['preview', 'start']) $(id).addEventListener('click', async () => {
  error(); busy = true; renderStatus();
  try {
    readFields(); validateRoutine(draft);
    const granted = await chrome.permissions.request({ origins: sitePermissions(draft.startUrl) });
    if (!granted) throw new Error('Allow access to the selected website to run this routine.');
    await persist();
    state = await request('ROUTINE_START', { routine: draft, preview: id === 'preview' });
    await chrome.tabs.update(tabId, { active: true });
  } catch (failure) { error(failure.message); }
  finally { busy = false; renderEditor(); }
});
for (const id of ['pause', 'stop', 'skip']) $(id).addEventListener('click', async () => {
  try {
    const type = id === 'stop' ? 'STOP' : id === 'skip' ? 'ROUTINE_SKIP' : state.phase === 'confirmation' ? 'ROUTINE_CONFIRM' : state.phase === 'work' ? 'WORK_RESUME' : ['paused', 'missing'].includes(state.phase) ? 'RESUME' : 'PAUSE';
    state = await request(type); renderStatus();
  } catch (failure) { error(failure.message); }
});
async function picked(pick) {
  if (!pick?.done || pick.token === lastPick) return;
  lastPick = pick.token;
  const item = draft.steps.find(item => item.id === pick.stepId);
  if (item && pick.target) { item.target = pick.target; changed(); renderSteps(); }
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes[keyFor(tabId)]) {
    const wasRunning = !!state?.running; state = changes[keyFor(tabId)].newValue;
    if (wasRunning !== !!state?.running) { renderSteps(); library(); }
    renderStatus();
  }
  if (area === 'session' && changes[`pick:${tabId}`]) void picked(changes[`pick:${tabId}`].newValue);
});
try {
  saved = (await chrome.storage.local.get(routineKey))[routineKey] || [];
  state = await request('GET');
  const stored = await chrome.storage.session.get([`draft:${tabId}`, `pick:${tabId}`]);
  draft = stored[`draft:${tabId}`] || (state?.mode === 'routine' ? structuredClone(state.routine.definition) : null);
  if (draft) renderEditor(); else fresh();
  $('site').textContent = new URL(params.get('url') || draft.startUrl).hostname.toUpperCase();
  await picked(stored[`pick:${tabId}`]);
} catch (failure) { if (!draft) fresh(); error(failure.message); }
setInterval(renderStatus, 250);
let checking = false;
setInterval(async () => {
  if (checking || !state?.running) return;
  checking = true;
  try { state = await request('GET'); renderStatus(); } catch { /* Retry while the worker reconnects. */ }
  finally { checking = false; }
}, 1500);
