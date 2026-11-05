(() => {
  if (globalThis.__scrollRefreshInstalled) return;
  globalThis.__scrollRefreshInstalled = true;
  let generation = 0;
  let timer;
  let activeToken = null;
  let scrolling = false;
  let target = null;
  let monitor;
  let lastStatus = '';
  let ignoreChallenge = false;
  let restoring = false;
  let restorationInterrupted = false;
  const dirtyFields = new Set();
  let ignoredFocus = null;
  let view = null;
  let indicator = null;
  let indicatorTimer;
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const send = async (message) => {
    try { return await chrome.runtime.sendMessage(message); }
    catch { return null; }
  };

  function editable(node) {
    if (!node || node === indicator || indicator?.contains(node)) return false;
    if (node.isContentEditable) return true;
    return node.matches?.('textarea, select, input:not([type="hidden"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="image"])') && !node.disabled && !node.readOnly;
  }
  function activeEditor() {
    let node = document.activeElement;
    while (node?.shadowRoot?.activeElement) node = node.shadowRoot.activeElement;
    return editable(node) ? node : null;
  }
  function edited(event) {
    if (!event.isTrusted) return;
    const node = event.composedPath().find(editable);
    if (!node) return;
    dirtyFields.add(node);
    ignoredFocus = null;
    if (activeToken || restoring) cancel(true);
    void checkStatus(true);
  }
  function finishForm(event) {
    queueMicrotask(() => {
      if (event.defaultPrevented) return;
      for (const node of dirtyFields) {
        if (node.form === event.target || event.target.contains?.(node)) dirtyFields.delete(node);
      }
      ignoredFocus = activeEditor();
      void checkStatus(true);
    });
  }
  addEventListener('input', edited, true);
  addEventListener('change', edited, true);
  addEventListener('focusin', () => { void checkStatus(true); }, true);
  addEventListener('focusout', () => { ignoredFocus = null; queueMicrotask(() => { void checkStatus(true); }); }, true);
  addEventListener('submit', finishForm, true);
  addEventListener('reset', finishForm, true);
  for (const event of ['wheel', 'pointerdown', 'keydown']) {
    addEventListener(event, (input) => { if (input.isTrusted && restoring) restorationInterrupted = true; }, { capture: true, passive: true });
  }

  function renderIndicator() {
    if (!view?.running || !document.body) { indicator?.remove(); indicator = null; return; }
    if (!indicator?.isConnected) {
      indicator = document.createElement('div');
      indicator.id = 'scroll-refresh-indicator';
      indicator.style.setProperty('all', 'initial', 'important');
      for (const [key, value] of Object.entries({ position: 'fixed', bottom: '16px', right: '16px',
        'z-index': '2147483647', width: '250px', 'max-width': 'calc(100vw - 32px)' })) indicator.style.setProperty(key, value, 'important');
      const shadow = indicator.attachShadow({ mode: 'open' });
      shadow.innerHTML = `<style>
        *{box-sizing:border-box} .box{font:12px/1.4 system-ui,sans-serif;background:#153e34;color:#f4faef;border:1px solid #547362;border-radius:13px;box-shadow:0 5px 24px #0003;padding:11px 12px}
        .row{display:flex;align-items:center;justify-content:space-between;gap:10px} .label{font-size:10px;color:#c0d7c5} strong{font-size:16px;font-variant-numeric:tabular-nums} .controls{display:flex;gap:7px;margin-top:8px}
        button{font:600 11px system-ui,sans-serif;border:0;border-radius:6px;padding:7px 10px;cursor:pointer;background:#cbed9f;color:#193b28} #toggle{flex:1} #stop{background:#365a49;color:#fff} button:focus-visible{outline:2px solid white;outline-offset:2px} button:disabled{opacity:.5;cursor:default}
      </style><div class="box" role="region" aria-label="Scroll and Refresh controls"><div class="row"><span class="label">Scroll &amp; Refresh</span><strong id="time" role="timer"></strong></div><div id="status" class="label" role="status"></div><div class="controls"><button id="toggle" type="button">Pause</button><button id="stop" type="button">Stop</button></div></div>`;
      shadow.getElementById('toggle').addEventListener('click', async (event) => {
        if (!event.isTrusted || !view?.running) return;
        const type = view.phase === 'work' ? 'WORK_RESUME' : view.phase === 'confirmation' ? 'ROUTINE_CONFIRM' : ['paused', 'missing'].includes(view.phase) ? 'RESUME' : 'PAUSE';
        cancel(true);
        const result = await send({ type, token: view.token });
        if (result?.state) { view = result.state; renderIndicator(); }
      });
      shadow.getElementById('stop').addEventListener('click', async (event) => {
        if (!event.isTrusted || !view?.running) return;
        const token = view.token;
        cancel();
        await send({ type: 'STOP', token });
      });
      document.documentElement.append(indicator);
    }
    const root = indicator.shadowRoot;
    const labels = { countdown: 'Next scroll in', scrolling: 'Scrolling and reading', loading: 'Waiting for page',
      verification: 'Complete verification on the website', work: view.workDirty ? 'Unfinished work protected' : 'Paused while editing',
      paused: 'Paused by you', restoring: 'Restoring your reading position', reconnecting: 'Reconnecting', away: 'Waiting for your website', network: 'Network issue · automatic retry in' };
    const milliseconds = view.phase === 'network' ? Math.max(0, view.networkRetryAt - Date.now()) : view.phase === 'countdown' ? Math.max(0, view.deadline - Date.now()) : view.remainingMs;
    const seconds = Math.ceil((milliseconds || 0) / 1000);
    root.getElementById('time').textContent = ['countdown', 'paused', 'network'].includes(view.phase)
      ? `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}` : '•••';
    root.getElementById('status').textContent = view.mode === 'routine' ? `${labels[view.phase] || 'Routine'} · ${view.detail || ''}` : labels[view.phase] || 'Timer active';
    root.getElementById('toggle').textContent = view.phase === 'work' ? 'Saved — resume' : view.phase === 'confirmation' ? 'Confirm click' : view.phase === 'missing' ? 'Retry step' : view.phase === 'paused' ? 'Resume' : 'Pause';
  }

  function showState(state) {
    view = state;
    renderIndicator();
    if (state.running && !indicatorTimer) indicatorTimer = setInterval(renderIndicator, 250);
    if (!state.running) { clearInterval(indicatorTimer); indicatorTimer = null; }
  }

  function visible(node) {
    const box = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return box.width > 20 && box.height > 20 && style.display !== 'none' &&
      style.visibility !== 'hidden' && style.opacity !== '0' && node.getClientRects().length > 0;
  }
  function pageStatus() {
    // Observe only. Never click, press, or attempt to solve verification UI.
    const solved = [...document.querySelectorAll('textarea[name="g-recaptcha-response"], textarea[name="h-captcha-response"]')]
      .some((node) => node.value.trim());
    const containers = '#px-captcha, #challenge-stage, #challenge-running, [data-testid="captcha-challenge"]';
    const frames = 'iframe[src*="recaptcha"][src*="bframe"], iframe[src*="captcha"], iframe[title*="challenge" i]';
    const challengeElement = [...document.querySelectorAll(containers)].some(visible) ||
      (!solved && [...document.querySelectorAll(frames)].some((node) => visible(node) && node.getBoundingClientRect().height > 70));
    const title = document.title || '';
    const body = document.body?.innerText || '';
    const challengeText = /(?:verify|confirm|prove) (?:that )?you(?:'re| are) (?:a )?human|press\s*(?:and|&)\s*hold|i(?:'|’)?m not a robot|are you a robot|complete the (?:security check|captcha)/i;
    const editor = activeEditor();
    return { ok: true, ready: !!document.body && document.readyState !== 'loading',
      dirty: dirtyFields.size > 0, editing: !!editor && editor !== ignoredFocus,
      challenge: challengeElement || /just a moment|human verification|robot or human|access to this page has been denied/i.test(title) ||
        (!solved && body.length < 6000 && challengeText.test(body)) };
  }
  async function checkStatus(force = false) {
    if (!monitor) return;
    const status = pageStatus();
    if (!status.challenge) ignoreChallenge = false;
    if (((status.challenge && !ignoreChallenge) || status.editing || status.dirty) && (activeToken || restoring)) cancel(true);
    const signature = `${status.ready}:${status.challenge}:${status.editing}:${status.dirty}`;
    if (force || signature !== lastStatus) {
      lastStatus = signature;
      const response = await send({ type: 'PAGE_STATUS' });
      if (!response?.ok) lastStatus = ''; // Retry if a worker was restarting.
    }
  }
  function startMonitor() {
    if (!monitor) monitor = setInterval(() => { void checkStatus(); }, 1000);
  }
  function blocked() {
    const status = pageStatus();
    if ((ignoreChallenge || !status.challenge) && !status.editing && !status.dirty) return false;
    cancel(true);
    void checkStatus(true);
    return true;
  }

  function cancel(keepMonitoring = false) {
    generation++;
    clearTimeout(timer);
    activeToken = null;
    scrolling = false;
    restoring = false;
    // Cancel any smooth movement already in progress.
    if (target) target.scrollTo({ top: target.scrollTop, behavior: 'instant' });
    target = null;
    if (!keepMonitoring) {
      clearInterval(monitor);
      monitor = null;
      lastStatus = '';
      ignoreChallenge = false;
      view = null;
      indicator?.remove(); indicator = null;
      clearInterval(indicatorTimer); indicatorTimer = null;
    }
  }

  function selectorFor(node) {
    if (node.id) return `#${CSS.escape(node.id)}`;
    const parts = [];
    for (let item = node; item && item !== document.documentElement; item = item.parentElement) {
      const siblings = [...item.parentElement.children].filter((child) => child.tagName === item.tagName);
      parts.unshift(`${item.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(item) + 1})`);
      if (parts.join(' > ').length > 480) return null;
    }
    return parts.join(' > ');
  }
  function capturePosition(node) {
    const root = document.scrollingElement || document.documentElement;
    const position = { top: root.scrollTop, left: root.scrollLeft || 0 };
    if (node !== root) {
      const selector = selectorFor(node);
      if (selector) position.target = { selector, top: node.scrollTop, left: node.scrollLeft || 0 };
    }
    return position;
  }
  async function animate(node, top, duration, current, reduced) {
    const start = node.scrollTop;
    const end = Math.max(0, Math.min(top, node.scrollHeight - node.clientHeight));
    if (reduced) { node.scrollTo({ top: end, behavior: 'instant' }); return; }
    const started = Date.now();
    while (current === generation) {
      const elapsed = Math.min(1, (Date.now() - started) / duration);
      node.scrollTo({ top: start + (end - start) * globalThis.__scrollRefreshMotion.ease(elapsed), behavior: 'instant' });
      if (elapsed === 1) return;
      await delay(16);
    }
  }
  async function restore(token, position) {
    if (restoring && activeToken === token) return;
    if (blocked()) return;
    cancel(true);
    activeToken = token;
    restoring = true;
    restorationInterrupted = false;
    const current = generation;
    const root = document.scrollingElement || document.documentElement;
    // Retry briefly for late layout/content, then give control back to the user.
    for (let attempt = 0; attempt < 6; attempt++) {
      await delay(attempt === 0 ? 150 : 400);
      if (current !== generation || blocked()) return;
      if (restorationInterrupted) break;
      root.scrollTo({ top: position.top, left: position.left, behavior: 'instant' });
      let complete = Math.abs(root.scrollTop - position.top) < 3;
      if (position.target) {
        let node;
        try { node = document.querySelector(position.target.selector); } catch { /* Invalid/changed selector. */ }
        if (node) {
          node.scrollTo({ top: position.target.top, left: position.target.left, behavior: 'instant' });
          complete = complete && Math.abs(node.scrollTop - position.target.top) < 3;
        } else complete = false;
      }
      if (complete && attempt >= 1) break;
    }
    if (current !== generation) return;
    restoring = false;
    await send({ type: 'RESTORED', token });
  }
  function scrollTarget() {
    const root = document.scrollingElement || document.documentElement;
    if (root.scrollHeight > root.clientHeight + 5) return root;
    // Support common apps whose main viewport is a nested scrolling panel.
    let best = root;
    let area = 0;
    for (const node of document.querySelectorAll('main, [role="main"], section, div')) {
      if (node.scrollHeight <= node.clientHeight + 5 || node.clientHeight < 160) continue;
      const box = node.getBoundingClientRect();
      if (box.bottom <= 0 || box.top >= innerHeight || box.right <= 0 || box.left >= innerWidth) continue;
      if (!/auto|scroll/.test(getComputedStyle(node).overflowY)) continue;
      const visibleArea = Math.min(box.width, innerWidth) * Math.min(box.height, innerHeight);
      if (visibleArea > area) { best = node; area = visibleArea; }
    }
    return best;
  }
  async function scroll(token, doneType = 'SCROLLED') {
    if (scrolling && activeToken === token) return;
    if (blocked()) return;
    cancel(true);
    activeToken = token;
    scrolling = true;
    const current = generation;
    target = scrollTarget();
    const original = target.scrollTop;
    const position = capturePosition(target);
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const steps = globalThis.__scrollRefreshMotion.plan(original, target.clientHeight, Math.max(0, target.scrollHeight - target.clientHeight));
    for (const step of steps) {
      if (current !== generation || blocked()) return;
      await animate(target, step.top, step.duration, current, reduced);
      if (current !== generation || blocked()) return;
      await delay(step.pause);
    }
    if (current !== generation || blocked()) return;
    await send({ type: doneType, token, position });
    if (current === generation) scrolling = false;
  }

  globalThis.__scrollRefreshPage = { pageStatus, cancel, blocked, startMonitor, scroll, selectorFor,
    position: () => capturePosition(scrollTarget()), generation: () => generation };

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (message.type === 'MONITOR') {
      const status = pageStatus();
      startMonitor();
      lastStatus = `${status.ready}:${status.challenge}:${status.editing}:${status.dirty}`;
      respond(status);
      return false;
    }
    if (message.type === 'STATE') showState(message.state);
    else if (message.type === 'CLEAR_WORK') {
      dirtyFields.clear(); ignoredFocus = activeEditor();
    }
    else if (message.type === 'RESTORE') { void restore(message.token, message.position); }
    else if (message.type === 'CANCEL') cancel(!!message.keepMonitoring);
    else if (message.type === 'ARM') {
      cancel(true);
      startMonitor();
      ignoreChallenge = !!message.ignoreChallenge;
      activeToken = message.token;
      timer = setTimeout(() => { if (!blocked()) void send({ type: 'DUE', token: message.token }); },
        Math.max(0, message.deadline - Date.now()));
    } else if (message.type === 'SCROLL') {
      void scroll(message.token);
    } else return false;
    respond({ ok: true });
    return false;
  });
  addEventListener('pagehide', () => cancel());
  addEventListener('pageshow', () => { void checkStatus(true); });
  addEventListener('load', () => { void checkStatus(true); });
})();
