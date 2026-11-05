(() => {
  if (globalThis.__scrollRefreshRoutines) return;
  globalThis.__scrollRefreshRoutines = true;
  const api = globalThis.__scrollRefreshPage;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const send = message => chrome.runtime.sendMessage(message).catch(() => null);
  const text = node => (node.getAttribute('aria-label') || node.innerText || node.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 160);
  const own = node => !!node?.closest?.('#scroll-refresh-indicator, #scroll-refresh-picker');
  const visible = node => {
    const box = node.getBoundingClientRect(), style = getComputedStyle(node);
    return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  };
  function describe(node) {
    return { selector: api.selectorFor(node), tag: node.tagName.toLowerCase(), text: text(node),
      role: node.getAttribute('role') || '', href: node.tagName === 'A' ? node.href : '', label: text(node) || node.id || node.tagName.toLowerCase() };
  }
  function find(target) {
    const matches = node => !own(node) && visible(node) && node.tagName.toLowerCase() === target.tag &&
      text(node) === target.text && (node.getAttribute('role') || '') === target.role && (!target.href || node.href === target.href);
    let exact;
    try { exact = [...document.querySelectorAll(target.selector)].filter(matches); } catch { return null; }
    if (exact.length === 1) return exact[0];
    // If a site regenerated its ID, require a unique semantic match. Never use
    // screen coordinates or pick the first of several identical buttons.
    const fallback = [...document.querySelectorAll(target.tag)].filter(matches);
    return fallback.length === 1 ? fallback[0] : null;
  }
  function navigation(node, origin) {
    if (node.tagName !== 'A' || !node.href || node.download || (node.target && node.target !== '_self')) return false;
    try {
      const a = new URL(origin), b = new URL(node.href);
      return ['http:', 'https:'].includes(b.protocol) && !b.username && !b.password &&
        a.hostname.replace(/^www\./, '') === b.hostname.replace(/^www\./, '') && a.port === b.port &&
        (a.protocol === b.protocol || a.protocol === 'http:' && b.protocol === 'https:');
    } catch { return false; }
  }
  function prohibited(node) {
    return node.closest('#px-captcha, #challenge-stage, #challenge-running, [data-testid="captcha-challenge"]') ||
      node.matches('button[type="submit"], input[type="submit"], input[type="image"]') ||
      (node.tagName === 'BUTTON' && node.form && node.type === 'submit');
  }
  let picker;
  function stopPicker() { if (picker) picker(); picker = null; }
  function pick(token, kind) {
    stopPicker();
    const host = document.createElement('div'); host.id = 'scroll-refresh-picker';
    host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>*{box-sizing:border-box}.banner{position:fixed;left:50%;top:16px;transform:translateX(-50%);width:min(580px,90vw);padding:14px 18px;background:#153e34;color:white;font:14px/1.5 system-ui;border-radius:12px;box-shadow:0 4px 24px #0004;pointer-events:auto;display:flex;gap:16px;align-items:center}button{margin-left:auto;border:0;border-radius:6px;padding:8px;cursor:pointer;background:#cbed9f}.outline{position:fixed;border:3px solid #249775;border-radius:4px;background:#bdec8b22;pointer-events:none}</style><div class="outline" hidden></div><div class="banner"><span>Select a ${kind === 'wait' ? 'visible element to wait for' : 'link, tab, or button'}. This selection does not click it. Esc cancels.</span><button>Cancel</button></div>`;
    document.documentElement.append(host);
    const outline = root.querySelector('.outline'), label = root.querySelector('span');
    const choose = event => {
      let node = event.composedPath().find(n => n instanceof Element && !own(n));
      if (!node || event.composedPath().includes(host)) return null;
      if (kind !== 'wait') node = node.closest('a, button, [role="tab"], [role="button"], [role="link"]');
      return node && node.getRootNode() === document && !own(node) ? node : null;
    };
    const move = event => {
      const node = choose(event); outline.hidden = !node;
      if (node) {
        const b = node.getBoundingClientRect();
        Object.assign(outline.style, { top: `${b.top}px`, left: `${b.left}px`, width: `${b.width}px`, height: `${b.height}px` });
      }
    };
    const cancel = () => { stopPicker(); void send({ type: 'PICK_CANCEL', token }); };
    const click = event => {
      if (!event.isTrusted || event.composedPath().includes(host)) return;
      event.preventDefault(); event.stopImmediatePropagation();
      const node = choose(event);
      if (!node) { label.textContent = 'Choose a link, tab, or button in the main page. Esc cancels.'; return; }
      if (api.pageStatus().challenge || prohibited(node)) { label.textContent = 'Choose a navigation control outside verification and form submission.'; return; }
      const target = describe(node);
      if (!target.selector) { label.textContent = 'This element cannot be identified reliably. Choose another.'; return; }
      stopPicker(); void send({ type: 'PICK_RESULT', token, target });
    };
    const key = event => { if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); cancel(); } };
    const suppress = event => { if (!event.composedPath().includes(host)) { event.preventDefault(); event.stopImmediatePropagation(); } };
    addEventListener('pointermove', move, true);
    addEventListener('pointerdown', suppress, true); addEventListener('mousedown', suppress, true);
    addEventListener('click', click, true); addEventListener('keydown', key, true);
    root.querySelector('button').addEventListener('click', cancel);
    picker = () => {
      host.remove(); removeEventListener('pointermove', move, true); removeEventListener('pointerdown', suppress, true);
      removeEventListener('mousedown', suppress, true); removeEventListener('click', click, true); removeEventListener('keydown', key, true);
    };
  }
  let lastRun;
  async function run(message) {
    if (lastRun?.token === message.token && lastRun.generation === api.generation()) return;
    api.cancel(true); api.startMonitor();
    const generation = api.generation();
    lastRun = { token: message.token, generation };
    const active = () => generation === api.generation() && !api.blocked();
    const step = message.step;
    if (step.type === 'scroll') { void api.scroll(message.token, 'STEP_DONE'); return; }
    let node;
    if (step.target) {
      const end = Date.now() + (step.type === 'wait' ? step.seconds * 1000 : 20000);
      while (active()) {
        node = find(step.target);
        if (node && !node.disabled && node.getAttribute('aria-disabled') !== 'true') break;
        if (Date.now() >= end) {
          await send({ type: 'STEP_MISSING', token: message.token, error: `Cannot find a unique, ready target: “${step.target.label}”. Check the page, then retry or select it again.` });
          return;
        }
        await delay(200);
      }
      if (!active()) return;
      node.scrollIntoView({ block: 'center', behavior: 'instant' });
      const previous = node.style.outline;
      node.style.outline = '3px solid #249775';
      await delay(700);
      node.style.outline = previous;
      if (!active()) return;
    } else {
      const end = Date.now() + step.seconds * 1000;
      while (Date.now() < end) { if (!active()) return; await delay(Math.min(200, end - Date.now())); }
    }
    if (step.type === 'click') {
      if (!node.isConnected || prohibited(node)) {
        await send({ type: 'STEP_MISSING', token: message.token, error: 'This target changed or is a protected submission/verification control. Select a navigation link or tab.' }); return;
      }
      const isNavigation = navigation(node, message.origin);
      // Reject external/new-tab links even if the element changed after saving.
      if (node.tagName === 'A' && !isNavigation) {
        await send({ type: 'STEP_MISSING', token: message.token, error: 'This link leaves the selected website or opens a new tab. Select a link that stays in this tab.' }); return;
      }
      if (!isNavigation && node.getAttribute('role') !== 'tab' && !message.confirmed) {
        await send({ type: 'STEP_CONFIRM', token: message.token }); return;
      }
      const committed = await send({ type: 'STEP_COMMIT', token: message.token });
      if (!active() || committed?.state?.token !== message.token || !committed?.state?.routine?.pending?.committed) return;
      node.click();
      // Full navigations are resumed from the saved pending step in the worker.
      // This short settling period also supports tabs and SPA route changes.
      await delay(900);
      if (!active()) return;
    }
    if (active()) await send({ type: 'STEP_DONE', token: message.token });
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (message.type === 'PICK_START') pick(message.token, message.kind);
    else if (message.type === 'RUN_STEP') void run(message).catch(() => send({ type: 'STEP_MISSING', token: message.token, error: 'The target changed while running this step. Check the page and retry.' }));
    else if (message.type === 'POSITION') { respond({ ok: true, position: api.position() }); return false; }
    else if (message.type === 'CANCEL') { stopPicker(); return false; }
    else return false;
    respond({ ok: true }); return false;
  });
  addEventListener('pagehide', stopPicker);
})();
