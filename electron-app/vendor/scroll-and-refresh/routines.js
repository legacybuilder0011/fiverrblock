import { pageOrigin, sameWebsite } from './core.js';

export const routineKey = 'routines';
export function validateRoutine(input) {
  if (!input || typeof input.name !== 'string' || !input.name.trim()) throw new Error('Give this routine a name.');
  if (!pageOrigin(input.startUrl)) throw new Error('Choose a regular website as the starting page.');
  const start = new URL(input.startUrl);
  if (start.username || start.password) throw new Error('URLs containing credentials cannot be saved.');
  if (!Number.isInteger(input.interval) || input.interval < 1000 || input.interval > 86400000) throw new Error('Choose a cycle interval from 1 second to 24 hours.');
  if (!['final', 'start'].includes(input.destination)) throw new Error('Choose where to refresh.');
  if (!Array.isArray(input.steps) || !input.steps.length || input.steps.length > 30) throw new Error('Use between 1 and 30 steps.');
  const steps = input.steps.map((step) => {
    if (!['click', 'navigate', 'wait', 'scroll', 'refresh'].includes(step.type)) throw new Error('Unknown routine action.');
    const clean = { id: typeof step.id === 'string' ? step.id.slice(0, 80) : crypto.randomUUID(), type: step.type };
    if (step.type === 'navigate') {
      if (!sameWebsite(input.startUrl, step.url)) throw new Error('Navigation steps must stay on the starting website.');
      const url = new URL(step.url);
      if (url.username || url.password) throw new Error('URLs containing credentials cannot be saved.');
      clean.url = url.href;
    }
    if (step.type === 'wait') {
      if (!Number.isInteger(step.seconds) || step.seconds < 1 || step.seconds > 300) throw new Error('Wait steps must be 1–300 seconds.');
      clean.seconds = step.seconds;
    }
    if (step.type === 'click' || (step.type === 'wait' && step.target)) {
      const t = step.target;
      if (!t || typeof t.selector !== 'string' || !t.selector || t.selector.length > 512 ||
          typeof t.tag !== 'string' || !/^[a-z][a-z0-9-]*$/.test(t.tag) || typeof t.text !== 'string' || t.text.length > 160) {
        throw new Error('Select a target for each click step.');
      }
      clean.target = { selector: t.selector, tag: t.tag, text: t.text, role: String(t.role || '').slice(0, 80),
        href: typeof t.href === 'string' ? t.href.slice(0, 4096) : '', label: String(t.label || t.text || t.tag).slice(0, 160) };
      if (clean.target.href && !sameWebsite(input.startUrl, clean.target.href)) throw new Error('Selected links must stay on the starting website.');
    }
    return clean;
  });
  if (steps.at(-1).type !== 'refresh') throw new Error('Keep a Refresh step at the end of the routine.');
  return { id: typeof input.id === 'string' ? input.id.slice(0, 80) : crypto.randomUUID(),
    name: input.name.trim().slice(0, 80), startUrl: start.href, interval: input.interval, destination: input.destination, steps };
}

export function stepLabel(step) {
  return { click: `Click ${step.target?.label || 'selected element'}`, navigate: `Open ${step.url || 'page'}`,
    wait: step.target ? `Wait for ${step.target.label}` : `Wait ${step.seconds || 1} seconds`,
    scroll: 'Scroll with reading pauses', refresh: 'Refresh page' }[step.type];
}
