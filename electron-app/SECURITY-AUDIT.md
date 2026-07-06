# Privacy Shield — Security Audit & Fix Plan

**Date:** 2026-07-06
**Reviewer stance:** offensive mindset — what would an attacker actually use to read your users' data, escape the browser sandbox, steal proxy/account credentials, or take over your GitHub/Supabase.
**Scope:** Electron main + preload + renderer, the `psapp://` protocol, IPC surface, SSH/proxy code, GitHub repo/token, Supabase backend.

---

## TL;DR

Your fundamentals are **better than typical**: no secrets committed, Node integration off everywhere, browsing tabs don't expose IPC/Node to pages, SSH commands are shell-quoted, renderer output is HTML-escaped, Supabase RLS is on. Real issues found:

| # | Severity | Issue | Status |
|---|----------|-------|--------|
| 1 | **HIGH** | Path traversal in `psapp://` — reachable from untrusted web pages → arbitrary local file read | **FIXED** |
| 2 | **HIGH** | GitHub OAuth token embedded in git remote URL + exposed in chat | **ACTION REQUIRED (you)** |
| 3 | MEDIUM | Generic IPC pass-through (`invoke(anyChannel)`) — no channel allowlist | Documented (trusted-UI only) |
| 4 | MEDIUM | Supabase: leaked-password protection / password policy | **ACTION REQUIRED (dashboard)** |
| 5 | LOW | `safeStorage` `plain:` base64 fallback when DPAPI unavailable | Documented |
| 6 | LOW | `getUserDataDir`/download paths join unsanitized ids/names | Documented (local-only) |

---

## What's already solid (verified, not changed)

- **No secrets in the repo.** `git grep` for the GitHub token, `service_role`, private keys, `sk_live` → nothing tracked. Only the Supabase **anon/publishable** key is embedded, which is safe by design (RLS enforces per-user access server-side).
- **Electron hardening.** `nodeIntegration:false` on every window. Browsing tabs (`preload-fingerprint.js`) use `ipcRenderer` internally but never place `require`/`ipcRenderer` on `window`, and Node integration is off — so a malicious site can't reach Node or IPC. The generic `electronAPI.invoke` is only on trusted local UI windows.
- **Command injection.** `vps-proxy-manager.js` runs remote SSH commands through `shellQuote()` (proper POSIX single-quote escaping) — user data can't break out of the command.
- **Renderer XSS.** Profile `name`/`tags` are escaped with `escHtml()` before `innerHTML`. Notes aren't rendered in the list.
- **Supabase RLS.** `profiles`/`proxies`/`open_profiles` all have `auth.uid() = user_id` policies; an unauthenticated anon-key read returns zero rows.
- **Secrets at rest.** Proxy/SSH passwords are encrypted via Electron `safeStorage` (DPAPI on packaged Windows) before hitting disk, and stripped before cloud sync.

---

## Findings

### 1. HIGH — Path traversal in the `psapp://` protocol (FIXED)
**Where:** `app-protocol.js:29-31`, registered on **profile browsing sessions** at `session-manager.js:488`.
**Problem:** The handler did `path.join(app.getAppPath(), decodeURIComponent(url.pathname))` with no containment check. A path like `psapp:///../../../../<anything>` resolves **outside** the app directory. Because the protocol is registered on the *profile browsing sessions* (where arbitrary websites load), this is not just theoretical — a page the user visits could attempt to read local files: the user's `profiles.json` (encrypted proxy creds, fingerprints), `session.json`, Supabase session token, or OS files.
**Impact:** Arbitrary local file disclosure to a hostile web page = full compromise of stored profile/proxy data.
**Fix:** The handler now resolves the path with `path.resolve` (which collapses `..`) and **rejects anything not contained within the app root** with a 403, before any `readFileSync`. Traversal attempts are logged.

### 2. HIGH — GitHub OAuth token exposure (ACTION REQUIRED)
**Where:** `.git/config` remote URL (`https://gho_...@github.com/...`), not committed but printed repeatedly this session.
**Problem:** A `gho_` OAuth token embedded in the remote URL grants full push access to the repo. It has been surfaced many times in plaintext (chat/logs) and sits in cleartext in local git config.
**Action (you):** Rotate/revoke it — GitHub → Settings → Developer settings → revoke the token (or reinstall the auth). Then re-auth via **Git Credential Manager** instead of embedding the token in the remote URL: `git remote set-url origin https://github.com/legacybuilder0011/fiverrblock.git` and let the credential helper store it in the OS vault. Never paste tokens into chats.

### 3. MEDIUM — Generic IPC pass-through
**Where:** `renderer-preload.js:6` — `invoke: (type, data) => ipcRenderer.invoke(type, data)`.
**Problem:** Exposes *every* IPC channel to the renderer. It's mitigated because this preload runs **only on trusted local UI windows** (`profiles.html`, `tab-strip.html` served from `psapp://`), and browsing tabs don't get it. But it's a wide surface if any of those pages ever loaded untrusted content.
**Recommendation:** Move to an allowlist of channel names in the preload. Not changed now to avoid breaking the ~40 existing channels; do it as a focused follow-up. Keep the UI pages strictly local (never load remote URLs into them).

### 4. MEDIUM — Supabase auth policy (ACTION REQUIRED — dashboard)
**Recommendations:**
- Enable **Leaked Password Protection** (Auth → Policies) — checks new passwords against HaveIBeenPwned.
- Raise the **minimum password length** (app enforces ≥6 in `auth-store.js:33`; set Supabase's min to 8+).
- Keep an eye on **signup rate limits** (Auth → Rate Limits) since signup is public with the anon key — the anon key is safe, but open signup can be abused for spam accounts. Consider CAPTCHA (Supabase supports hCaptcha/Turnstile on auth) if you see abuse.

### 5. LOW — `safeStorage` cleartext fallback
**Where:** `profile-store.js:57` — when `safeStorage.isEncryptionAvailable()` is false, secrets are stored as `plain:<base64>` (base64 is **not** encryption).
**Reality:** On packaged Windows this path isn't taken (DPAPI is available), so live builds encrypt. The fallback only triggers in unsupported/dev environments.
**Recommendation:** Log a visible warning when the fallback is used so a misconfigured environment doesn't silently store cleartext.

### 6. LOW — Unsanitized ids/names in local paths
**Where:** `auth-store.js:26` (`getUserDataDir` joins `userId`), `session-manager.js:415` (download dir joins profile `name`).
**Reality:** `userId` is a Supabase UUID and `name` is the user's own — not attacker-controlled in normal flows. A tampered `session.json` with a `../` userId could escape the data dir, but that requires local file access (already game-over).
**Recommendation:** Sanitize both (strip `/\.` and path separators) as defense-in-depth.

---

## Fixes implemented in this pass

| # | Fix | File |
|---|-----|------|
| 1 | Path-traversal containment check (403 on escape) | `src/app-protocol.js` |

## Actions for you (can't be done from code)

1. **Rotate the GitHub token** and switch to a credential helper (Finding 2). Highest real-world priority.
2. **Supabase dashboard**: enable leaked-password protection, raise min password length, consider auth CAPTCHA (Finding 4).

## Follow-ups (documented, not bundled)

- IPC channel allowlist (Finding 3).
- `safeStorage` fallback warning (Finding 5).
- Path-component sanitization for ids/names (Finding 6).
