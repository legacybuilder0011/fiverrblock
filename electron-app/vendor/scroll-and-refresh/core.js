export const keyFor = (tabId) => `tab:${tabId}`;
export const alarmFor = (tabId) => `refresh:${tabId}`;

export function intervalFrom(minutes, seconds) {
  if (!Number.isInteger(minutes) || !Number.isInteger(seconds) ||
      minutes < 0 || minutes > 1440 || seconds < 0 || seconds > 59) {
    throw new Error('Enter whole minutes (0–1440) and seconds (0–59).');
  }
  const interval = (minutes * 60 + seconds) * 1000;
  if (interval < 1000 || interval > 86400000) {
    throw new Error('Choose an interval between 1 second and 24 hours.');
  }
  return interval;
}

export function pageOrigin(url) {
  try {
    const parsed = new URL(url);
    return ['https:', 'http:'].includes(parsed.protocol) ? parsed.origin : null;
  } catch { return null; }
}

// Only www/bare aliases count as the same site. Never use a suffix match:
// fiverr.com.example.org and unrelated subdomains must not inherit a timer.
export function sameWebsite(original, candidate) {
  if (!pageOrigin(original) || !pageOrigin(candidate)) return false;
  const a = new URL(original);
  const b = new URL(candidate);
  return a.hostname.replace(/^www\./, '') === b.hostname.replace(/^www\./, '') &&
    a.port === b.port && (a.protocol === b.protocol || (a.protocol === 'http:' && b.protocol === 'https:'));
}

export function sitePermissions(url) {
  if (!pageOrigin(url)) return [];
  const parsed = new URL(url);
  const bare = parsed.hostname.replace(/^www\./, '');
  const hosts = bare.includes('.') && !/^[\d.]+$/.test(bare) ? [bare, `www.${bare}`] : [bare];
  const schemes = parsed.protocol === 'http:' ? ['http:', 'https:'] : ['https:'];
  // Chrome host patterns do not scope grants to a port. Session matching does.
  return schemes.flatMap((scheme) => hosts.map((host) => `${scheme}//${host}/*`));
}

export function remaining(deadline, now = Date.now()) {
  const total = Math.max(0, Math.ceil((deadline - now) / 1000));
  return `${Math.floor(total / 60).toString().padStart(2, '0')}:${(total % 60).toString().padStart(2, '0')}`;
}

export function samePage(a, b) {
  if (!sameWebsite(a, b)) return false;
  const first = new URL(a), second = new URL(b);
  return first.pathname === second.pathname && first.search === second.search && first.hash === second.hash;
}

export function validPosition(value) {
  const coordinate = (number) => Number.isFinite(number) && number >= 0 && number <= 10000000;
  if (!value || !coordinate(value.top) || !coordinate(value.left)) return null;
  const result = { top: value.top, left: value.left };
  if (value.target && typeof value.target.selector === 'string' && value.target.selector.length <= 512 &&
      coordinate(value.target.top) && coordinate(value.target.left)) {
    result.target = { selector: value.target.selector, top: value.target.top, left: value.target.left };
  }
  return result;
}
