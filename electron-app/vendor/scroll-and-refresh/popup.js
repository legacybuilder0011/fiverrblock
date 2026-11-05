import { intervalFrom, pageOrigin, remaining, keyFor, sameWebsite, sitePermissions } from './core.js';
const $ = (id) => document.getElementById(id);
let tabId;
let state = null;
let available = false;
let busy = false;
let currentUrl;
let renderedHistory;
function error(message = '') {
  $('error').textContent = message;
  $('error').hidden = !message;
}
function render() {
  const running = state?.running;
  $('minutes').disabled = $('seconds').disabled = !!running || busy;
  document.querySelectorAll('[data-seconds]').forEach((button) => { button.disabled = !!running || busy; });
  const resumable = running && ['loading', 'verification', 'reconnecting', 'away', 'work', 'paused', 'missing', 'confirmation'].includes(state.phase);
  $('start').disabled = (!!running && !resumable) || busy || !available || (running && !sameWebsite(state.origin, currentUrl));
  $('start').textContent = resumable ? (state.phase === 'verification' ? "I've finished — resume" : state.phase === 'work' ? 'Saved — resume' : 'Resume timer') : 'Start refreshing ↻';
  if (state?.mode === 'routine' && resumable) $('start').textContent = state.phase === 'confirmation' ? 'Confirm click' : state.phase === 'missing' ? 'Retry step' : state.phase === 'work' ? 'Saved — resume' : 'Resume routine';
  $('routines').disabled = !available;
  $('stop').disabled = !running || busy;
  $('pause').disabled = !running || state?.userPaused || busy;
  $('refreshes').textContent = `${state?.refreshes || 0} refresh${state?.refreshes === 1 ? '' : 'es'}`;
  const phases = { countdown: ['NEXT SCROLL IN', 'Then scroll, refresh, and repeat'],
    scrolling: ['SCROLLING THE PAGE', 'A little movement before a fresh start'],
    loading: ['REFRESHING', 'Checking when the page is ready'],
    verification: ['VERIFICATION NEEDED', 'Complete the check on the website'],
    reconnecting: ['RECONNECTING', 'Timer saved. Retrying automatically.'],
    network: ['NETWORK ISSUE · RETRY IN', 'Reloading automatically, even in the background'],
    away: ['WAITING FOR YOUR WEBSITE', 'Timer saved. Return after verification.'],
    paused: ['PAUSED BY YOU', 'Resume when you are ready'],
    work: ['UNFINISHED WORK PROTECTED', state?.workDirty ? 'Save your work, then choose Saved — resume' : 'Waiting until you finish editing'],
    restoring: ['RESTORING YOUR POSITION', 'Returning to where you were reading'],
    routine: ['RUNNING ROUTINE', state?.detail], missing: ['STEP NEEDS ATTENTION', state?.error],
    confirmation: ['CONFIRM BUTTON CLICK', state?.error] };
  const phase = running ? phases[state.phase] : null;
  $('phase').textContent = phase?.[0] || 'READY WHEN YOU ARE';
  $('hint').textContent = phase?.[1] || 'Set your pace below';
  if (running) {
    $('countdown').textContent = state.phase === 'countdown' ? remaining(state.deadline) : state.phase === 'paused' ? remaining(state.remainingMs || 0, 0) : ['verification', 'work'].includes(state.phase) ? 'Ⅱ' : state.phase === 'scrolling' ? '⇅' : '↻';
    if (state.phase === 'network') $('countdown').textContent = remaining(state.networkRetryAt);
    $('progress').style.width = `${state.phase === 'countdown' ? Math.max(0, Math.min(100, 100 * (1 - (state.deadline - Date.now()) / state.interval))) : 100}%`;
  } else {
    const seconds = Math.max(0, (Number($('minutes').value) * 60 + Number($('seconds').value)) || 0);
    $('countdown').textContent = remaining(seconds * 1000, 0);
    $('progress').style.width = '0%';
  }
  const signature = JSON.stringify(state?.history || []);
  if (signature !== renderedHistory) {
    renderedHistory = signature;
    $('history-list').replaceChildren();
    const history = state?.history || [];
    $('history-empty').hidden = history.length > 0;
    $('clear-history').disabled = history.length === 0;
    for (const item of [...history].reverse()) {
      const row = document.createElement('li');
      const time = document.createElement('time');
      time.textContent = new Date(item.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      time.dateTime = new Date(item.at).toISOString();
      const label = document.createElement('span');
      label.textContent = item.event;
      row.append(time, label); $('history-list').append(row);
    }
  }
}
async function request(type, data = {}) {
  const result = await chrome.runtime.sendMessage({ type, tabId, ...data });
  if (!result?.ok) throw new Error(result?.error || 'Could not reach the extension. Please reopen it.');
  return result.state;
}
$('form').addEventListener('submit', async (event) => {
  event.preventDefault();
  error();
  try {
    if (state?.running && ['loading', 'verification', 'reconnecting', 'away', 'work', 'paused', 'missing', 'confirmation'].includes(state.phase)) {
      busy = true; render();
      const granted = await chrome.permissions.request({ origins: sitePermissions(state.origin) });
      if (!granted) throw new Error('Allow access to this website so the saved timer can reconnect automatically.');
      state = await request(state.phase === 'work' ? 'WORK_RESUME' : state.phase === 'confirmation' ? 'ROUTINE_CONFIRM' : 'RESUME');
      error(state?.error || '');
      return;
    }
    const minutes = Number($('minutes').value);
    const seconds = Number($('seconds').value);
    intervalFrom(minutes, seconds);
    busy = true; render();
    // Called directly from the submit gesture, before any other awaited work.
    const granted = await chrome.permissions.request({ origins: sitePermissions(currentUrl) });
    if (!granted) throw new Error('Allow access to this website to resume automatically after verification.');
    state = await request('START', { minutes, seconds });
  } catch (failure) { error(failure.message); }
  finally { busy = false; render(); }
});
$('stop').addEventListener('click', async () => {
  busy = true; render(); error();
  try { state = await request('STOP'); }
  catch (failure) { error(failure.message); }
  finally { busy = false; render(); }
});
$('pause').addEventListener('click', async () => {
  busy = true; render();
  try { state = await request('PAUSE'); }
  catch (failure) { error(failure.message); }
  finally { busy = false; render(); }
});
$('open-history').addEventListener('click', () => {
  $('timer-panel').hidden = true; $('history-panel').hidden = false; $('back').focus();
});
$('routines').addEventListener('click', async () => {
  await chrome.tabs.create({ url: chrome.runtime.getURL(`routines.html?tab=${tabId}&url=${encodeURIComponent(currentUrl)}`) });
  window.close();
});
$('back').addEventListener('click', () => {
  $('history-panel').hidden = true; $('timer-panel').hidden = false; $('open-history').focus();
});
$('clear-history').addEventListener('click', async () => {
  try { state = await request('CLEAR_HISTORY'); render(); }
  catch (failure) { error(failure.message); }
});
document.querySelectorAll('[data-seconds]').forEach((button) => button.addEventListener('click', () => {
  const total = Number(button.dataset.seconds);
  $('minutes').value = Math.floor(total / 60);
  $('seconds').value = total % 60;
  error(); render();
}));
$('form').addEventListener('input', () => { error(); render(); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes[keyFor(tabId)]) {
    state = changes[keyFor(tabId)].newValue;
    error(state?.error || ''); render();
  }
});
try {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id;
  currentUrl = tab?.url;
  available = !!pageOrigin(tab?.url);
  $('site').textContent = available ? new URL(tab.url).hostname : 'Unsupported page';
  const settings = (await chrome.storage.local.get('settings')).settings;
  state = await request('GET');
  const interval = state?.interval;
  $('minutes').value = interval ? Math.floor(interval / 60000) : settings?.minutes ?? 1;
  $('seconds').value = interval ? (interval / 1000) % 60 : settings?.seconds ?? 0;
  error(!available ? 'Open a regular website to start refreshing.' : state?.error || '');
} catch (failure) { error(failure.message); }
render();
$('version').textContent = `v${chrome.runtime.getManifest().version}`;
setInterval(render, 200);
// Opening the popup and periodic checks also recover a missed load event.
let checking = false;
setInterval(async () => {
  if (checking || busy || !state?.running || !['loading', 'verification', 'reconnecting', 'away', 'work'].includes(state.phase)) return;
  checking = true;
  try { state = await request('GET'); render(); }
  catch { /* Next check retries after a worker restart. */ }
  finally { checking = false; }
}, 2000);
