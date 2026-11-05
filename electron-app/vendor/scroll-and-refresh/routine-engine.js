import { sameWebsite, samePage, alarmFor, validPosition } from './core.js';
import { validateRoutine, stepLabel } from './routines.js';

// All calls run inside background.js's per-tab queue. Durable state precedes
// navigation/click dispatch, so a new document cannot repeat the previous step.
export function routineEngine({ read, save, tell, inject, watch, stop, networkGate }) {
  const token = () => crypto.randomUUID();
  async function put(id, state, event) {
    state = { ...state, event };
    const r = state.routine;
    state.detail = state.error || `${r.definition.name} · ${r.preview ? 'Preview' : `Cycle ${r.cycles + 1}`} · Step ${Math.min(r.index + 1, r.definition.steps.length)}/${r.definition.steps.length}: ${stepLabel(r.definition.steps[r.index] || r.definition.steps.at(-1))}`;
    await save(id, state);
    return state;
  }
  async function hold(id, state, phase, error = '') {
    const stored = await read(id);
    if (state.phase === phase && state.error === error && stored?.documentId === state.documentId && stored?.workDirty === state.workDirty) return state;
    await tell(id, { type: 'CANCEL', keepMonitoring: true }, state.documentId).catch(() => {});
    let pending = state.routine.pending;
    if (pending && ['wait', 'scroll'].includes(pending.kind)) pending = null;
    if (pending?.kind === 'click' && !pending.committed && ['verification', 'work', 'paused', 'reconnecting'].includes(phase)) pending = null;
    state = await put(id, { ...state, phase, error, token: token(), routine: { ...state.routine, pending } });
    await watch(id);
    return state;
  }
  async function countdown(id, state) {
    const next = await put(id, { ...state, phase: 'countdown', error: '', token: token(),
      deadline: Date.now() + (state.remainingMs ?? state.interval), remainingMs: null,
      routine: { ...state.routine, stage: 'countdown', pending: null } });
    await chrome.alarms.create(alarmFor(id), { when: next.deadline });
    await tell(id, { type: 'ARM', token: next.token, deadline: next.deadline }, next.documentId);
    return next;
  }
  async function finishStep(id, state) {
    const r = { ...state.routine, index: state.routine.index + 1, pending: null };
    state = await put(id, { ...state, routine: r, token: token(), error: '' }, 'Step finished');
    if (r.index < r.definition.steps.length) return reconcile(id);
    if (r.preview) {
      await chrome.alarms.clear(alarmFor(id));
      state = await put(id, { ...state, running: false, phase: 'complete' }, 'Preview completed');
      await tell(id, { type: 'CANCEL' }, state.documentId).catch(() => {});
      return state;
    }
    state.routine = { ...r, index: 0, cycles: r.cycles + 1, stage: 'countdown', began: false };
    return countdown(id, state);
  }
  async function navigate(id, state, url, kind) {
    state = await put(id, { ...state, phase: 'loading', token: token(), error: '',
      routine: { ...state.routine, pending: { kind, url, from: state.documentId, started: Date.now() } } }, kind === 'return' ? 'Returning to starting page' : 'Opening routine page');
    await watch(id);
    await chrome.tabs.update(id, { url });
    return state;
  }
  async function execute(id, state) {
    let r = state.routine;
    if (r.index === 0 && !r.began) {
      state = await put(id, { ...state, routine: { ...r, began: true } });
      r = state.routine;
      const tab = await chrome.tabs.get(id);
      if (!samePage(r.definition.startUrl, tab.url)) return navigate(id, state, r.definition.startUrl, 'return');
    }
    const step = r.definition.steps[r.index];
    if (step.type === 'navigate') return navigate(id, state, step.url, 'navigate');
    if (step.type === 'refresh') {
      const tab = await chrome.tabs.get(id);
      if (r.index === r.definition.steps.length - 1 && r.definition.destination === 'start' && !samePage(r.definition.startUrl, tab.url)) {
        return navigate(id, state, r.definition.startUrl, 'return');
      }
      const response = await tell(id, { type: 'POSITION' }, state.documentId);
      state = await put(id, { ...state, phase: 'loading', refreshes: state.refreshes + 1, token: token(),
        routine: { ...r, pending: { kind: 'refresh', from: state.documentId, url: tab.url,
          position: validPosition(response?.position), started: Date.now() } } }, 'Page refresh requested');
      await watch(id);
      await chrome.tabs.reload(id);
      return state;
    }
    state = await put(id, { ...state, phase: 'routine', error: '', token: token(),
      routine: { ...r, pending: { kind: step.type, from: state.documentId, started: Date.now() } } }, stepLabel(step));
    await watch(id);
    await tell(id, { type: 'RUN_STEP', token: state.token, step, origin: state.origin }, state.documentId);
    return state;
  }
  async function reconcile(id) {
    let state = await read(id);
    if (!state?.running || state.mode !== 'routine') return state;
    const waiting = await networkGate(id, state);
    if (waiting) return waiting;
    const tab = await chrome.tabs.get(id);
    if (!sameWebsite(state.origin, tab.url)) return hold(id, state, tab.url ? 'away' : 'reconnecting');
    const documentId = await inject(id);
    const status = await tell(id, { type: 'MONITOR' }, documentId);
    const previousDocument = state.documentId;
    state.documentId = documentId;
    if (state.userPaused) return hold(id, state, 'paused');
    if (status?.challenge) return hold(id, state, 'verification');
    if (status?.editing || status?.dirty) {
      state.workDirty = !!status.dirty;
      return hold(id, state, 'work');
    }
    if (!status?.ready || tab.pendingUrl || (tab.status === 'loading' && state.routine.pending?.from === documentId)) return hold(id, state, 'loading');
    if (['missing', 'confirmation'].includes(state.phase)) return state;
    const r = state.routine, p = r.pending;
    if (p) {
      if (p.kind === 'refresh' && p.from !== documentId) {
        if (p.position && samePage(p.url, tab.url) && Date.now() - p.started < 120000) {
          if (state.phase === 'restoring' && p.restoring === documentId && Date.now() - p.restoreAttempt < 10000) return state;
          state = await put(id, { ...state, phase: 'restoring', token: token(), routine: { ...r, pending: { ...p, restoring: documentId, restoreAttempt: Date.now() } } });
          await tell(id, { type: 'RESTORE', token: state.token, position: p.position }, documentId);
          return state;
        }
        return finishStep(id, state);
      }
      if (['navigate', 'return'].includes(p.kind) && (p.from !== documentId || samePage(p.url, tab.url))) {
        if (p.kind === 'navigate') return finishStep(id, state);
        state = await put(id, { ...state, routine: { ...r, pending: null } });
        if (r.stage === 'countdown') return countdown(id, state);
        return execute(id, state);
      }
      if (p.kind === 'click' && p.committed && (p.from !== documentId || ['verification', 'away', 'loading'].includes(state.phase))) return finishStep(id, state);
      if (p.from !== documentId) {
        state = await put(id, { ...state, routine: { ...r, pending: null } });
        return execute(id, state);
      }
      if (Date.now() - p.started > (r.definition.steps[r.index].seconds || 0) * 1000 + 45000) {
        return hold(id, state, 'missing', p.committed ? 'The click may have completed. Check the page, then retry this step or skip it in Routines.' : 'This step did not finish. Check the page, then retry.');
      }
      return state;
    }
    if (r.stage === 'countdown') {
      if (state.phase === 'countdown' && previousDocument === documentId) return state;
      return countdown(id, state);
    }
    return execute(id, state);
  }
  async function recover(id) {
    try { return await reconcile(id); }
    catch {
      const state = await read(id);
      return state?.running ? hold(id, state, 'reconnecting') : state;
    }
  }
  async function handle(id, message, sender) {
    let state = await read(id);
    if (message.type === 'ROUTINE_START') {
      const definition = validateRoutine(message.routine);
      const tab = await chrome.tabs.get(id);
      if (!sameWebsite(definition.startUrl, tab.url)) throw new Error('Open this routine’s website in the selected tab first.');
      await stop(id);
      state = await put(id, { running: true, mode: 'routine', origin: new URL(definition.startUrl).origin,
        interval: definition.interval, refreshes: 0, token: token(), phase: 'loading',
        routine: { definition, index: 0, cycles: 0, preview: !!message.preview, stage: message.preview ? 'steps' : 'countdown', pending: null } }, message.preview ? 'Preview started' : 'Routine started');
      // A routine always begins at its saved starting page, including previews.
      if (!samePage(tab.url, definition.startUrl)) return navigate(id, state, definition.startUrl, 'return');
      return recover(id);
    }
    if (!state?.running || state.mode !== 'routine') return state;
    if (sender.tab && (sender.documentId !== state.documentId || (message.type !== 'PAGE_STATUS' && message.token !== state.token))) return state;
    const p = state.routine.pending;
    if (message.type === 'STOP') return stop(id);
    if (message.type === 'GET' || message.type === 'PAGE_STATUS') return recover(id);
    if (message.type === 'PAUSE') {
      state.remainingMs = state.phase === 'countdown' ? Math.max(1000, state.deadline - Date.now()) : null;
      state.userPaused = true;
      return hold(id, state, 'paused');
    }
    if (message.type === 'WORK_RESUME') {
      await tell(id, { type: 'CLEAR_WORK' }, state.documentId);
      return recover(id);
    }
    if (message.type === 'RESUME') {
      state.userPaused = false;
      if (state.phase === 'paused' && p?.kind === 'click' && p.committed && p.from === state.documentId) {
        return hold(id, state, 'missing', 'The click may have completed before pausing. Check the page, then retry this step or skip it in Routines.');
      }
      if (state.phase === 'missing') state.routine = { ...state.routine, pending: null };
      state = await put(id, { ...state, phase: 'loading', error: '' });
      return recover(id);
    }
    if (message.type === 'ROUTINE_SKIP' && state.phase === 'missing') return finishStep(id, state);
    if (message.type === 'ROUTINE_CONFIRM' && state.phase === 'confirmation') {
      state = await put(id, { ...state, phase: 'routine', error: '', token: token(),
        routine: { ...state.routine, pending: { ...p, started: Date.now() } } });
      await tell(id, { type: 'RUN_STEP', token: state.token, step: state.routine.definition.steps[state.routine.index], origin: state.origin, confirmed: true }, state.documentId);
      return state;
    }
    if (message.type === 'DUE' && state.phase === 'countdown' && Date.now() >= state.deadline) {
      state = await put(id, { ...state, routine: { ...state.routine, stage: 'steps' } });
      return recover(id);
    }
    if (message.type === 'STEP_COMMIT' && state.phase === 'routine' && p?.kind === 'click') {
      const status = await tell(id, { type: 'MONITOR' }, state.documentId);
      if (status.challenge || status.editing || status.dirty) return recover(id);
      if (p.committed) return state;
      state = await put(id, { ...state, routine: { ...state.routine, pending: { ...p, committed: true } } });
      return state;
    }
    if (message.type === 'STEP_DONE' && state.phase === 'routine' && p) return finishStep(id, state);
    if (message.type === 'RESTORED' && state.phase === 'restoring') return finishStep(id, state);
    if (message.type === 'STEP_CONFIRM' && state.phase === 'routine') return hold(id, state, 'confirmation', `Confirm this button click: ${state.routine.definition.steps[state.routine.index].target.label}`);
    if (message.type === 'STEP_MISSING' && state.phase === 'routine') return hold(id, state, 'missing', String(message.error || 'Selected target not found.').slice(0, 250));
    return state;
  }
  return { handle, recover };
}
