import { keyFor, alarmFor, intervalFrom, pageOrigin, sameWebsite, samePage, validPosition } from './core.js';
import { routineEngine } from './routine-engine.js';
import { networkRecovery } from './network-recovery.js';
const network = networkRecovery({ read, save, tell, inject, resume: async id =>
  (await read(id))?.mode === 'routine' ? routines.recover(id) : recover(id) });
const routines = routineEngine({ read, save, tell, inject, watch, stop, networkGate: (id, state) => network.gate(id, state) });

// Serialize transitions per tab. Long waits and scrolling happen in the page,
// never inside this queue or in an in-memory service-worker timer.
const queues = new Map();
function serialize(tabId, action) {
  const previous = queues.get(tabId) || Promise.resolve();
  const result = previous.catch(() => {}).then(action);
  queues.set(tabId, result);
  result.finally(() => {
    if (queues.get(tabId) === result) queues.delete(tabId);
  }).catch(() => {});
  return result;
}
async function read(tabId) {
  return (await chrome.storage.session.get(keyFor(tabId)))[keyFor(tabId)] || null;
}
async function save(tabId, state) {
  const previous = await read(tabId);
  const history = previous?.history || [];
  const labels = { countdown: 'Countdown started', scrolling: 'Scrolling with reading pauses',
    loading: 'Waiting for page readiness', verification: 'Verification needed', reconnecting: 'Reconnecting',
    away: 'Waiting for original website', paused: 'Paused by you', work: 'Paused to protect unfinished work',
    restoring: 'Restoring reading position', stopped: 'Timer stopped', missing: 'Routine paused: target or step needs attention',
    confirmation: 'Waiting for button confirmation', complete: 'Preview completed', routine: 'Continuing routine', network: 'Network issue; retry scheduled' };
  let event = state.event;
  delete state.event;
  if (!event) {
  if (state.running && !previous?.running) event = 'Timer started';
  else if (state.refreshes > (previous?.refreshes || 0)) event = 'Page refresh requested';
  else if (state.phase !== previous?.phase) {
    event = labels[state.phase];
    if (state.phase === 'countdown') {
      event = { verification: 'Verification cleared; countdown restarted',
        reconnecting: 'Reconnected; countdown restarted', away: 'Returned to website; countdown restarted',
        paused: 'Resumed by you', work: 'Form protection cleared; countdown restarted',
        restoring: 'Position restoration finished; countdown started' }[previous?.phase] || event;
    }
  }
  }
  state.history = (event ? [...history, { at: Date.now(), event }] : history).slice(-100);
  await chrome.storage.session.set({ [keyFor(tabId)]: state });
  await chrome.action.setBadgeText({ tabId, text: state.running ? (['verification', 'reconnecting', 'away', 'work', 'paused', 'missing', 'confirmation', 'network'].includes(state.phase) ? 'WAIT' : 'ON') : '' }).catch(() => {});
  await chrome.action.setBadgeBackgroundColor({ tabId, color: '#087f70' }).catch(() => {});
  await tell(tabId, { type: 'STATE', state: { running: state.running, phase: state.phase,
    deadline: state.deadline, remainingMs: state.remainingMs, token: state.token,
    workDirty: state.workDirty, mode: state.mode, detail: state.detail, networkRetryAt: state.networkRetryAt } }, state.documentId).catch(() => {});
}
async function tell(tabId, message, documentId) {
  return chrome.tabs.sendMessage(tabId, message, documentId ? { documentId } : { frameId: 0 });
}
async function stop(tabId, error = '') {
  const state = await read(tabId);
  await network.clear(tabId);
  await chrome.alarms.clear(alarmFor(tabId));
  await save(tabId, { ...state, running: false, phase: 'stopped', deadline: null,
    token: crypto.randomUUID(), error });
  await tell(tabId, { type: 'CANCEL' }).catch(() => {});
  return read(tabId);
}
async function inject(tabId) {
  const results = await chrome.scripting.executeScript({ target: { tabId }, files: ['motion.js', 'content.js', 'routine-content.js'], injectImmediately: true });
  return results.find((item) => item.frameId === 0)?.documentId;
}
async function arm(tabId, state, documentId) {
  const restore = state.restorePosition;
  if (restore && restore.documentId !== documentId) {
    const tab = await chrome.tabs.get(tabId);
    if (restore.expires > Date.now() && samePage(restore.url, tab.url)) {
      const next = { ...state, phase: 'restoring', documentId, token: crypto.randomUUID(), deadline: null };
      await save(tabId, next);
      await watch(tabId);
      await tell(tabId, { type: 'RESTORE', token: next.token, position: restore.position }, documentId);
      return next;
    }
    state = { ...state, restorePosition: null };
  }
  const next = { ...state, running: true, phase: 'countdown', documentId,
    token: crypto.randomUUID(), deadline: Date.now() + (state.resumeRemaining ?? state.interval),
    resumeRemaining: null, remainingMs: null, loadingSince: null, error: '' };
  await save(tabId, next);
  // Page timers support seconds; alarms are a fallback when the tab is throttled.
  await chrome.alarms.create(alarmFor(tabId), { when: next.deadline });
  const response = await tell(tabId, { type: 'ARM', token: next.token, deadline: next.deadline,
    ignoreChallenge: next.ignoreChallengeDocument === documentId }, documentId);
  if (!response?.ok) throw new Error('Could not start the page timer.');
  return next;
}

async function watch(tabId) {
  await chrome.alarms.create(alarmFor(tabId), { delayInMinutes: 0.5, periodInMinutes: 0.5 });
}

async function pause(tabId, state, phase, error = '') {
  const next = { ...state, running: true, phase, deadline: null,
    loadingSince: state.loadingSince || Date.now(), token: crypto.randomUUID(), error };
  await save(tabId, next);
  await tell(tabId, { type: 'CANCEL' }).catch(() => {});
  await watch(tabId);
  return next;
}

async function manualPause(tabId) {
  const state = await read(tabId);
  if (!state?.running || state.userPaused) return state;
  await tell(tabId, { type: 'CANCEL', keepMonitoring: true }, state.documentId).catch(() => {});
  const next = { ...state, userPaused: true, phase: 'paused', deadline: null,
    remainingMs: state.phase === 'countdown' ? Math.max(1000, state.deadline - Date.now()) : state.interval,
    restorePosition: null, token: crypto.randomUUID() };
  await save(tabId, next);
  await chrome.alarms.clear(alarmFor(tabId));
  return next;
}

// Verify the current document, rather than trusting the last onUpdated event.
// This also recovers when a challenge is removed without a navigation.
async function reconcile(tabId, { manual = false, senderDocumentId } = {}) {
  let state = await read(tabId);
  if (!state?.running) return state;
  if (manual && state.userPaused) {
    state = { ...state, userPaused: false, phase: 'loading', resumeRemaining: state.remainingMs || state.interval };
    await save(tabId, state);
  }
  const waiting = await network.gate(tabId, state);
  if (waiting) return waiting;
  const tab = await chrome.tabs.get(tabId);
  if (!pageOrigin(tab.url)) {
    return pause(tabId, state, 'reconnecting');
  }
  if (!sameWebsite(state.origin, tab.url)) {
    // Verification can visit another origin. Preserve the timer but do not
    // inject, scroll, or reload there. Resume only on the original website.
    return pause(tabId, state, 'away');
  }
  const documentId = await inject(tabId);
  if (senderDocumentId && senderDocumentId !== documentId) return state;
  const status = await tell(tabId, { type: 'MONITOR' }, documentId);
  if (!status?.ok) throw new Error('Could not check the current page.');
  if (manual && state.userPaused) {
    state = { ...state, userPaused: false, resumeRemaining: state.remainingMs || state.interval };
  }
  if (state.userPaused) {
    await tell(tabId, { type: 'CANCEL', keepMonitoring: true }, documentId);
    const next = { ...state, phase: 'paused', documentId };
    await save(tabId, next);
    await chrome.alarms.clear(alarmFor(tabId));
    return next;
  }
  if (manual && status.ready) {
    // The user confirms they finished verification; never interact with it.
    state = { ...state, ignoreChallengeDocument: status.challenge ? documentId : null };
  } else if (!status.challenge && state.ignoreChallengeDocument) {
    state = { ...state, ignoreChallengeDocument: null };
    await save(tabId, state);
  }
  if (status.challenge && state.ignoreChallengeDocument !== documentId) {
    if (state.phase !== 'verification' || state.documentId !== documentId) {
      await tell(tabId, { type: 'CANCEL', keepMonitoring: true }, documentId);
      state = { ...state, phase: 'verification', documentId, deadline: null,
        token: crypto.randomUUID(), ignoreChallengeDocument: null, error: '' };
      await save(tabId, state);
      await watch(tabId);
    }
    return state;
  }
  if (status.editing || status.dirty) {
    if (state.phase !== 'work' || state.documentId !== documentId || state.workDirty !== status.dirty) {
      await tell(tabId, { type: 'CANCEL', keepMonitoring: true }, documentId);
      state = { ...state, phase: 'work', workDirty: !!status.dirty, documentId, deadline: null,
        restorePosition: null, token: crypto.randomUUID() };
      await save(tabId, state);
      await watch(tabId);
    }
    return state;
  }
  // A document can be usable while an image/iframe keeps the tab loading.
  // Allow that fallback after 10 seconds, but never arm a still-parsing page.
  const ready = status.ready && !tab.pendingUrl && (manual || tab.status === 'complete' ||
    (state.documentId === documentId && ['countdown', 'scrolling', 'restoring'].includes(state.phase)) ||
    Date.now() - (state.loadingSince || Date.now()) >= 10000);
  if (!ready) {
    if (state.phase !== 'loading') {
      await tell(tabId, { type: 'CANCEL', keepMonitoring: true }, documentId);
      state = { ...state, phase: 'loading', deadline: null, loadingSince: Date.now(), token: crypto.randomUUID() };
      await save(tabId, state);
    }
    await watch(tabId);
    return state;
  }
  if (manual || ['loading', 'verification', 'reconnecting', 'away', 'work', 'paused'].includes(state.phase) ||
      (state.phase === 'restoring' && !state.restorePosition) || state.documentId !== documentId) {
    return arm(tabId, state, documentId);
  }
  return state;
}

async function recover(tabId, options) {
  try { return await reconcile(tabId, options); }
  catch {
    // Injection and messaging can race a redirect. Keep the session and retry.
    const state = await read(tabId);
    if (state?.running) {
      return pause(tabId, state, 'reconnecting');
    }
    return state;
  }
}
async function beginScroll(tabId, token, documentId) {
  let state = await read(tabId);
  if (!state?.running || state.phase !== 'countdown' || state.token !== token ||
      (documentId && documentId !== state.documentId) || Date.now() < state.deadline) return;
  state = await recover(tabId);
  if (!state?.running || state.phase !== 'countdown' || state.token !== token) return;
  await chrome.alarms.clear(alarmFor(tabId));
  await save(tabId, { ...state, phase: 'scrolling', deadline: null });
  // A delayed watchdog resumes a suspended sequence, rather than skipping it.
  await chrome.alarms.create(alarmFor(tabId), { delayInMinutes: 0.5 });
  const response = await tell(tabId, { type: 'SCROLL', token }, state.documentId);
  if (!response?.ok) throw new Error('Could not start scrolling.');
}
async function refresh(tabId, token, documentId, position) {
  let state = await read(tabId);
  if (!state?.running || state.phase !== 'scrolling' || state.token !== token ||
      documentId !== state.documentId) return;
  state = await recover(tabId);
  if (!state?.running || state.phase !== 'scrolling' || state.token !== token) return;
  await chrome.alarms.clear(alarmFor(tabId));
  const tab = await chrome.tabs.get(tabId);
  const snapshot = validPosition(position);
  await save(tabId, { ...state, phase: 'loading', deadline: null, loadingSince: Date.now(), token: crypto.randomUUID(),
    refreshes: state.refreshes + 1,
    restorePosition: snapshot ? { position: snapshot, url: tab.url, documentId, expires: Date.now() + 120000 } : null });
  await watch(tabId);
  await chrome.tabs.reload(tabId);
}
async function guarded(tabId, action) {
  try { return await action(); }
  catch (error) {
    const state = await read(tabId);
    if (state?.running) return pause(tabId, state, 'reconnecting');
    throw error;
  }
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  const isEditor = sender.url?.split('?')[0] === chrome.runtime.getURL('routines.html');
  const isPage = !isEditor && sender.tab && sender.frameId === 0;
  const isPopup = !sender.tab && sender.url === chrome.runtime.getURL('popup.html');
  if (!isPage && !isPopup && !isEditor) return false;
  const tabId = isPage ? sender.tab.id : message.tabId;
  if (!Number.isInteger(tabId)) return false;
  const permitted = isPage ? ['DUE', 'SCROLLED', 'PAGE_STATUS', 'PAUSE', 'RESUME', 'WORK_RESUME', 'STOP', 'RESTORED',
    'STEP_COMMIT', 'STEP_DONE', 'STEP_CONFIRM', 'STEP_MISSING', 'ROUTINE_CONFIRM', 'PICK_RESULT', 'PICK_CANCEL']
    : ['GET', 'START', 'STOP', 'RESUME', 'WORK_RESUME', 'PAUSE', 'CLEAR_HISTORY', 'ROUTINE_START', 'ROUTINE_SKIP', 'ROUTINE_CONFIRM', 'SELECT_TARGET'];
  if (!permitted.includes(message.type)) return false;
  serialize(tabId, async () => {
    if (message.type === 'SELECT_TARGET') {
      if (!isEditor) throw new Error('Open Routines to select an element.');
      if ((await read(tabId))?.running) throw new Error('Stop the current timer before selecting an element.');
      const documentId = await inject(tabId);
      const pick = { token: crypto.randomUUID(), documentId, stepId: message.stepId, editorId: sender.tab.id };
      await chrome.storage.session.set({ [`pick:${tabId}`]: pick });
      await tell(tabId, { type: 'PICK_START', token: pick.token, kind: message.kind }, documentId);
      await chrome.tabs.update(tabId, { active: true });
      return null;
    }
    if (['PICK_RESULT', 'PICK_CANCEL'].includes(message.type)) {
      const key = `pick:${tabId}`;
      const pick = (await chrome.storage.session.get(key))[key];
      if (!pick || pick.token !== message.token || pick.documentId !== sender.documentId || pick.done) return null;
      await chrome.storage.session.set({ [key]: { ...pick, done: true, target: message.type === 'PICK_RESULT' ? message.target : null } });
      await chrome.tabs.update(pick.editorId, { active: true }).catch(() => {});
      return null;
    }
    if (message.type === 'ROUTINE_START' || ((await read(tabId))?.mode === 'routine' && !['START', 'CLEAR_HISTORY'].includes(message.type))) {
      if (!isPage && ['RESUME', 'WORK_RESUME'].includes(message.type)) await network.releaseProtection(tabId);
      return routines.handle(tabId, message, isPage ? sender : {});
    }
    if (isPage && ['PAUSE', 'RESUME', 'WORK_RESUME', 'STOP', 'RESTORED'].includes(message.type)) {
      const state = await read(tabId);
      if (!state?.running || state.documentId !== sender.documentId || message.token !== state.token) return state;
    }
    if (['RESUME', 'WORK_RESUME'].includes(message.type)) await network.releaseProtection(tabId);
    if (message.type === 'GET') {
      const state = await read(tabId);
      return state?.running && ['loading', 'verification', 'reconnecting', 'away', 'work', 'paused', 'network'].includes(state.phase) ? recover(tabId) : state;
    }
    if (message.type === 'CLEAR_HISTORY') {
      const state = await read(tabId);
      if (state) { state.history = []; await chrome.storage.session.set({ [keyFor(tabId)]: state }); }
      return state;
    }
    if (message.type === 'PAUSE') return manualPause(tabId);
    if (message.type === 'WORK_RESUME') {
      const state = await read(tabId);
      if (!state?.running) return state;
      await tell(tabId, { type: 'CLEAR_WORK' }, state.documentId);
      return recover(tabId);
    }
    if (message.type === 'RESTORED') {
      const state = await read(tabId);
      if (state.phase !== 'restoring') return state;
      state.restorePosition = null;
      await save(tabId, state);
      return recover(tabId);
    }
    if (message.type === 'STOP') return stop(tabId);
    if (message.type === 'RESUME') return recover(tabId, { manual: true });
    if (message.type === 'PAGE_STATUS') return recover(tabId, { senderDocumentId: sender.documentId });
    if (message.type === 'START') {
      const interval = intervalFrom(message.minutes, message.seconds);
      const tab = await chrome.tabs.get(tabId);
      const origin = pageOrigin(tab.url);
      if (!origin) throw new Error('Open a regular http or https website first.');
      await stop(tabId);
      return guarded(tabId, async () => {
        await save(tabId, { interval, origin, refreshes: 0, running: true, phase: 'loading',
          loadingSince: Date.now(), token: crypto.randomUUID(), deadline: null });
        await watch(tabId);
        const state = await reconcile(tabId);
        await chrome.storage.local.set({ settings: { minutes: message.minutes, seconds: message.seconds } });
        return state;
      });
    }
    return guarded(tabId, () => message.type === 'DUE'
      ? beginScroll(tabId, message.token, sender.documentId)
      : refresh(tabId, message.token, sender.documentId, message.position));
  }).then((state) => respond({ ok: true, state }), (error) => respond({ ok: false, error: error.message }));
  return true;
});

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (!change.status && !change.url) return;
  serialize(tabId, async () => {
    const state = await read(tabId);
    if (!state?.running) return;
    if (await network.gate(tabId, state)) return;
    if (state.mode === 'routine') { await routines.recover(tabId); return; }
    if (change.status === 'loading') {
      await chrome.alarms.clear(alarmFor(tabId));
      await save(tabId, { ...state, phase: 'loading', deadline: null,
        loadingSince: state.phase === 'loading' ? state.loadingSince || Date.now() : Date.now(), token: crypto.randomUUID() });
      await tell(tabId, { type: 'CANCEL' }).catch(() => {});
      await watch(tabId);
    } else if (change.status === 'complete' || change.url) {
      await recover(tabId);
    }
  }).catch(() => {});
});

// Newly granted site access should reconnect pending sessions immediately.
chrome.permissions.onAdded.addListener(() => {
  chrome.storage.session.get(null).then((sessions) => {
    for (const [key, state] of Object.entries(sessions)) {
      if (key.startsWith('tab:') && state?.running) {
        const tabId = Number(key.slice(4));
        serialize(tabId, () => state.mode === 'routine' ? routines.recover(tabId) : recover(tabId)).catch(() => {});
      }
    }
  }).catch(() => {});
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name.startsWith('network:')) {
    const id = Number(alarm.name.slice(8));
    serialize(id, () => network.tick(id)).catch(() => {});
    return;
  }
  if (!alarm.name.startsWith('refresh:')) return;
  const tabId = Number(alarm.name.slice(8));
  serialize(tabId, () => guarded(tabId, async () => {
    const current = await read(tabId);
    if (current?.mode === 'routine') {
      const state = await routines.recover(tabId);
      if (state?.phase === 'countdown' && state.deadline <= Date.now()) await routines.handle(tabId, { type: 'DUE' }, {});
      return;
    }
    const state = await recover(tabId);
    if (!state?.running) return;
    if (state.phase === 'countdown') {
      await beginScroll(tabId, state.token);
    } else if (state.phase === 'scrolling') {
      await tell(tabId, { type: 'SCROLL', token: state.token }, state.documentId);
      await chrome.alarms.create(alarmFor(tabId), { delayInMinutes: 0.5 });
    } else if (state.phase === 'restoring' && state.restorePosition) {
      await tell(tabId, { type: 'RESTORE', token: state.token, position: state.restorePosition.position }, state.documentId);
    }
  })).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  serialize(tabId, async () => {
    await network.clear(tabId);
    await chrome.alarms.clear(alarmFor(tabId));
    await chrome.storage.session.remove(keyFor(tabId));
    await chrome.storage.session.remove(`pick:${tabId}`);
  }).catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  // Session storage clears on browser restart; do not resume old tab IDs.
  chrome.alarms.getAll().then((alarms) => Promise.all(alarms
    .filter((alarm) => /^(refresh|network):/.test(alarm.name))
    .map((alarm) => chrome.alarms.clear(alarm.name)))).catch(() => {});
});

for (const [event, method] of [['onBeforeNavigate', 'before'], ['onErrorOccurred', 'failed'],
  ['onDOMContentLoaded', 'completed'], ['onCompleted', 'completed']]) {
  chrome.webNavigation?.[event].addListener(details => {
    if (details.frameId === 0) serialize(details.tabId, () => network[method](details)).catch(() => {});
  });
}
