# Privacy Shield alert and isolation review — 14 October 2026

Reviewed Claude's unfinished changes from desktop version 1.18.23. The original deployment had completed, but it did not fully fix alerts or legacy cloud ownership.

## Fixed

- Legacy cloud profile alerts now sign phone links with the saved owner, instead of an empty Docker owner label.
- Cloud access checks enforce saved ownership, including after container removal. Unassigned legacy data requires administrator assignment; visiting a URL cannot claim it. Docker inspection errors fail closed.
- Claimed legacy profiles appear in their owner's cloud list.
- Failed notification publishes are retried instead of suppressing alerts for ten minutes. Test notification failures return an error. Watcher executions cannot overlap.
- Tunnel observation waits until forwarding is ready and handles split CONNECT lines. The earlier observer could consume data before a PC tunnel was available.
- Challenge-host matching rejects suffix lookalikes. Network matches are presented as possible human checks, not proof that a challenge is on screen.
- The desktop cloud VPN guard now includes external Chrome, Brave, Patched Chromium and Camoufox instances. Existing local shared-IP warnings and their explicit override remain unchanged.

## Verified

- Seven regression tests pass locally; five runner tests also pass on the Linux server.
- Temporary Electron profiles had separate cookies, localStorage, IndexedDB, CacheStorage and service-worker registrations. Reopening a profile retained its own storage.
- A request with an unavailable proxy failed with `ERR_PROXY_CONNECTION_FAILED`; the destination received no direct fallback request.
- The live runner lists the existing legacy profile for its owner and returns HTTP 403 for a different signed-in identity.
- The live test-notification endpoint returned HTTP 200 after the notification service accepted the publish. Receipt on the phone is unconfirmed. An immediate notification-feed query returned no messages, so it is not independent delivery confirmation.

## Current profile inventory

Read-only inventory: 33 profiles; 23 proxy, 8 VPN, 2 direct. No duplicate profile IDs, normalized storage-path collisions, identical full proxy configurations, invalid enabled proxies or custom external proxy bypass rules were found.

New Profile 21 and New Profile 22 share their **last recorded** public IP. Ten profiles use the system network. Separate browser storage does not provide separate public IPs. Different proxy credentials also do not guarantee different current exit IPs.

This review did not relaunch all 33 accounts or measure every profile's current exit IP, DNS, IPv6 and WebRTC behavior. The live storage test used Electron; other engines' separate data-directory construction and the stored profile IDs were inspected. The existing VPN watcher polls network state rather than installing an OS firewall kill switch, so it is not a zero-gap network isolation guarantee. Historical IP reuse, account data and other site-visible signals can still connect sessions.

Fingerprint variation and the earlier `deviceMemory` readings are not evidence that storage leaks between profiles. No changes were made to fingerprint seeds, account cookies, or challenge-solving behavior.

## Deployment and recovery

Runner SHA-256: `d42f0fdccd51e2c304461b37a272d0a0b6ad461e6a228d61111458fab1cfd78e`.

Server rollback files: `/opt/ps-cloud/backups/alerts-20261014T224159Z/`.
Cloud image rollback tags: `ps-runner:pre-alert-fix-20261014` and `ps-runner-rtc:pre-alert-fix-20261014`.

Desktop version 1.18.24 contains the external-browser network-guard correction. Build output is under `dist/alerts-1.18.24/`; the running desktop application has not been replaced. Install the new build to activate that desktop correction. The cloud runner fix is already active. The existing cloud browser was not recreated.

Existing unrelated working-tree changes were preserved. No GitHub release was published.

The supplied Claude transcript contains a plaintext proxy credential. Rotate that credential with the proxy provider; this review did not repeat it or change provider credentials.
