import { alarmFor, pageOrigin, samePage, sameWebsite } from './core.js';

export const networkKey = id => `network:${id}`;
export const networkAlarm = id => `network:${id}`;
export const retryDelay = attempts => Math.min(300000, 30000 * 2 ** Math.min(attempts, 4));
export const retryableError = error => /^net::ERR_(INTERNET_DISCONNECTED|NETWORK_CHANGED|NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED|DNS_TIMED_OUT|CONNECTION_(CLOSED|RESET|REFUSED|ABORTED|TIMED_OUT|FAILED)|TIMED_OUT|ADDRESS_UNREACHABLE|PROXY_CONNECTION_FAILED|TUNNEL_CONNECTION_FAILED|EMPTY_RESPONSE|HTTP2_PROTOCOL_ERROR|QUIC_PROTOCOL_ERROR)$/.test(error || '');

// A separate alarm is intentional: opening the popup or checking page status
// must not keep postponing the retry. All methods use the per-tab worker queue.
export function networkRecovery({ read, save, tell, inject, resume }) {
  const get = async id => (await chrome.storage.session.get(networkKey(id)))[networkKey(id)];
  async function clear(id) {
    await chrome.storage.session.remove(networkKey(id));
    await chrome.alarms.clear(networkAlarm(id));
  }
  async function store(id, value) {
    await chrome.storage.session.set({ [networkKey(id)]: value });
    await chrome.alarms.create(networkAlarm(id), { when: value.nextRetryAt });
  }
  const protectedState = state => state.userPaused || ['paused', 'verification', 'work', 'confirmation', 'missing'].includes(state.phase);
  async function show(id, state, recovery, event) {
    if (protectedState(state)) return state;
    if (state.phase === 'network' && state.networkRetryAt === recovery.nextRetryAt && !event) return state;
    await tell(id, { type: 'CANCEL', keepMonitoring: true }, state.documentId).catch(() => {});
    await chrome.alarms.clear(alarmFor(id));
    const next = { ...state, phase: 'network', deadline: null, token: crypto.randomUUID(),
      networkRetryAt: recovery.nextRetryAt, error: '', event };
    await save(id, next);
    return next;
  }
  async function before(details) {
    if (details.frameId !== 0) return;
    const id = details.tabId, state = await read(id);
    if (!state?.running) return;
    if (!sameWebsite(state.origin, details.url)) { await clear(id); return; }
    const old = await get(id);
    // Keep the retry budget when our retry causes another navigation event.
    const continuing = old && samePage(old.url, details.url);
    await store(id, { url: details.url, kind: 'loading', attempts: continuing ? old.attempts : 0,
      started: Date.now(), navigationStamp: details.timeStamp,
      protected: continuing ? old.protected : protectedState(state),
      nextRetryAt: continuing ? Math.max(old.nextRetryAt, Date.now() + 60000) : Date.now() + 60000 });
  }
  async function failed(details) {
    if (details.frameId !== 0 || !retryableError(details.error)) return;
    const id = details.tabId, state = await read(id);
    if (!state?.running || !sameWebsite(state.origin, details.url)) return;
    const old = await get(id), tab = await chrome.tabs.get(id);
    if (old && (old.url !== details.url || (old.navigationStamp && details.timeStamp < old.navigationStamp))) return;
    if (tab.pendingUrl && !samePage(tab.pendingUrl, details.url)) return;
    if (pageOrigin(tab.url) && !sameWebsite(state.origin, tab.url)) return;
    const attempts = old?.attempts || 0;
    const recovery = { ...old, url: details.url, kind: 'failed', error: details.error,
      protected: old?.protected ?? protectedState(state), attempts,
      started: Date.now(), nextRetryAt: old?.kind === 'failed' ? old.nextRetryAt : Date.now() + retryDelay(attempts) };
    await store(id, recovery);
    await show(id, state, recovery, old?.kind === 'failed' ? undefined : 'Network load failed; automatic retry scheduled');
  }
  async function completed(details) {
    if (details.frameId !== 0) return;
    const id = details.tabId, state = await read(id), recovery = await get(id);
    if (!recovery || !state?.running || !sameWebsite(state.origin, details.url)) return;
    if (recovery.navigationStamp && details.timeStamp < recovery.navigationStamp) return;
    if (!samePage(recovery.url, details.url)) return;
    await clear(id);
    await save(id, { ...state, phase: state.phase === 'network' ? 'loading' : state.phase,
      networkRetryAt: null, error: '', event: 'Connection restored; resuming session' });
    await resume(id);
  }
  async function gate(id, state) {
    const recovery = await get(id);
    if (!recovery || recovery.kind !== 'failed') return null;
    const tab = await chrome.tabs.get(id);
    const url = tab.pendingUrl || tab.url;
    if (pageOrigin(url) && !sameWebsite(state.origin, url)) { await clear(id); return null; }
    return show(id, state, recovery);
  }
  async function releaseProtection(id) {
    const recovery = await get(id);
    if (recovery?.protected) await store(id, { ...recovery, protected: false });
  }
  async function tick(id) {
    let state = await read(id), recovery = await get(id);
    if (!state?.running || !recovery) { await clear(id); return; }
    if (Date.now() < recovery.nextRetryAt) { await store(id, recovery); return; }
    if (protectedState(state) || recovery.protected) {
      // Continue checking without reloading a protected document.
      await store(id, { ...recovery, nextRetryAt: Date.now() + 30000 }); return;
    }
    const tab = await chrome.tabs.get(id), url = tab.pendingUrl || tab.url;
    if (pageOrigin(url) && !samePage(recovery.url, url)) { await clear(id); return; }
    if (!pageOrigin(url) && !/^(chrome-error|edge-error):\/\//.test(url || '')) {
      await store(id, { ...recovery, nextRetryAt: Date.now() + 30000 }); return;
    }
    // Lost site permission is not evidence of a failed network request.
    // Error-page retries require an observed main-frame network failure.
    let status;
    try {
      const documentId = await inject(id);
      status = await tell(id, { type: 'MONITOR' }, documentId);
    } catch { /* Native browser error pages cannot be scripted. */ }
    if (status?.challenge || status?.editing || status?.dirty) {
      await clear(id);
      await resume(id);
      return;
    }
    if (recovery.kind === 'loading' && status?.ready && !tab.pendingUrl) {
      await clear(id);
      await resume(id);
      return;
    }
    if (recovery.kind === 'loading' && !status && !tab.discarded) {
      // Do not turn a generic scripting/permission failure into reloads.
      await store(id, { ...recovery, nextRetryAt: Date.now() + 30000 }); return;
    }
    const attempts = recovery.attempts + 1;
    recovery = { ...recovery, kind: 'failed', attempts, nextRetryAt: Date.now() + retryDelay(attempts) };
    await store(id, recovery); // Persist before reload; a worker restart is safe.
    state = await show(id, state, recovery, `Retrying failed page load (attempt ${attempts})`);
    // Leave the selected tab in the background; never activate its window.
    try { await chrome.tabs.reload(id); }
    catch { /* The next persisted alarm retries if the tab still exists. */ }
  }
  return { before, failed, completed, gate, tick, clear, releaseProtection };
}
