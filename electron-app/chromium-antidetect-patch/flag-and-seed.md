Two halves. (A) declare/define the base::Feature flags (renderer, in the patch).
(B) plumb the per-profile seed/config from browser -> renderer (the half ALL
THREE reviewers flagged as missing — without it every hook is a silent no-op).

=== (A) FEATURE FLAG DECLARATION / DEFINITION (in the patch above) ===
WHERE declared: third_party/blink/public/common/features.h, inside
`namespace blink { namespace features {`
    BLINK_COMMON_EXPORT BASE_DECLARE_FEATURE(kFarbleCanvas);
    BLINK_COMMON_EXPORT BASE_DECLARE_FEATURE(kFarbleWebRTC);
    BLINK_COMMON_EXPORT BASE_DECLARE_FEATURE(kSpoofNavigator);
WHERE defined: third_party/blink/common/features.cc, same namespace
    BASE_FEATURE(kFarbleCanvas,   "FarbleCanvas",   base::FEATURE_DISABLED_BY_DEFAULT);
    BASE_FEATURE(kFarbleWebRTC,   "FarbleWebRTC",   base::FEATURE_DISABLED_BY_DEFAULT);
    BASE_FEATURE(kSpoofNavigator, "SpoofNavigator", base::FEATURE_DISABLED_BY_DEFAULT);
DEDUP: each is declared once / defined once (the three source patches each tried
to emit kFarbleCanvas/kSpoofNavigator -> duplicate-symbol link error; resolved).
The FeatureList is PROCESS-GLOBAL, so the feature is a whole-browser kill-switch;
per-profile granularity comes entirely from the session-token switch in (B).
Enable at browser launch: --enable-features=FarbleCanvas,FarbleWebRTC,SpoofNavigator
(Electron: app.commandLine.appendSwitch('enable-features', 'FarbleCanvas,FarbleWebRTC,SpoofNavigator')).

=== (B) PER-PROFILE SEED / CONFIG PLUMBING (NOT in the patch — you MUST add) ===
The renderer reads FOUR switches, all UNIFIED on one session-token name:
    --antidetect-session-token=<decimal uint64>   (presence gates all 3 hooks;
                                                    value is the canvas HMAC seed)
    --antidetect-hw-concurrency=<unsigned>
    --antidetect-platform=<string>
    --antidetect-user-agent=<string>
Readers: FarbleSessionCache::SessionToken() (canvas, parses uint64),
ShouldSuppressNonProxiedWebRTC() (webrtc, presence), AntidetectNavigatorConfig
(navigator, all four).

WHERE to append them: your fork's ContentBrowserClient override
`AppendExtraCommandLineSwitches(base::CommandLine*, int child_process_id)`
(Chromium: chrome/browser/chrome_content_browser_client.cc; Electron:
shell/browser/electron_browser_client.cc — same virtual). Map child_process_id
-> RenderProcessHost -> BrowserContext/Profile/Session -> your per-profile config
row, and append only for renderer processes:

  void YourContentBrowserClient::AppendExtraCommandLineSwitches(
      base::CommandLine* command_line, int child_process_id) {
    // ... call the base impl / existing body first ...
    if (command_line->GetSwitchValueASCII(switches::kProcessType) !=
        switches::kRendererProcess) {
      return;
    }
    content::RenderProcessHost* host =
        content::RenderProcessHost::FromID(child_process_id);
    if (!host) return;
    const AntidetectProfileConfig* cfg =
        GetAntidetectConfigFor(host->GetBrowserContext());  // your lookup
    if (!cfg || !cfg->enabled || cfg->session_token.empty()) return;

    command_line->AppendSwitchASCII("antidetect-session-token",
                                    cfg->session_token);      // decimal uint64
    if (cfg->hw_concurrency > 0) {
      command_line->AppendSwitchASCII(
          "antidetect-hw-concurrency",
          base::NumberToString(cfg->hw_concurrency));
    }
    if (!cfg->platform.empty())
      command_line->AppendSwitchASCII("antidetect-platform", cfg->platform);
    if (!cfg->user_agent.empty())
      command_line->AppendSwitchASCII("antidetect-user-agent", cfg->user_agent);
  }

RECOMMENDED for the UA/UA-CH HEADER surface (not just JS): ALSO set
blink::RendererPreferences.user_agent_override (ua_string_override +
ua_metadata_override) per profile so Sec-CH-UA / User-Agent REQUEST headers match
navigator.userAgent. The Blink userAgent() override in the patch only covers the
JS-visible surface; if you drive UA purely via RendererPreferences you may leave
--antidetect-user-agent empty and appVersion() still follows the overridden UA.

COHERENCE CONTRACT the browser side must honor (nothing in the patch enforces it):
  * session_token must be a decimal string parseable as uint64 (canvas seeds an
    HMAC key from it); 0 / empty == disabled.
  * Emit a self-consistent tuple: Win32 platform pairs with a Windows Chrome UA;
    hw_concurrency matches the claimed device class; UA engine version matches
    the actual Chromium milestone.
  * Set the token ONLY for proxied profiles — forcing disable_non_proxied_udp on
    a proxy-less profile emits zero ICE candidates, itself a "WebRTC disabled"
    fingerprint.