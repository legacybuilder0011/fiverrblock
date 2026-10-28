# Desktop browser startup fix ? 1.18.25

Reported symptom: New Profile 2 using Patched Chromium is shown as running on another user's PC, but no browser window appears. The affected PC's logs were not available; its exact cause remains unconfirmed.

Confirmed code defects: launch returned success immediately after spawning, without waiting for an asynchronous error or a window. Starting an already-running profile returned success without restoring/focusing it.

The Windows launch now waits up to 15 seconds for that process's main window, restores minimized windows, moves off-screen title bars back onto an attached monitor, and requests foreground focus. Windows may still restrict foreground focus. A failed window check or early process exit returns a visible launch error. A stalled owned process is stopped and its proxy bridge released. Concurrent Starts share one launch; callbacks from a previous process cannot clear a replacement session. Pending launches are excluded from the session window map. Other platforms retain their existing process-based readiness behavior.

The helper uses Windows PowerShell and user32, runs with its console hidden, and is scoped to the launched process ID. Environments blocking PowerShell receive an explicit error. Saved profiles, cookies, proxy configuration and fingerprint configuration are not reset. No other Chrome process is selected for recovery.

Validation: regression checks cover async spawn errors, early exits, missing windows, helper failures, concurrent Starts, readiness, restoration, stale callbacks and bridge cleanup. Password preference regression passes. A real installed Patched Chromium with a temporary blank profile passed startup, recovery from (-24000,-24000), minimized-window recovery and missing-PID rejection. The first smoke run passed its assertions but failed Node directory cleanup; the temporary data was then removed with PowerShell and the test cleanup updated accordingly. The repeated smoke test then passed with successful cleanup.

The build is prepared locally; installation and confirmation on the affected PC are still required. No cloud deployment is part of this change.
