The browser process holds one config record per profile and projects it onto the
four renderer command-line switches shown in flagAndSeed. Suggested wire format
(JSON), plus the field -> switch -> consuming-hook mapping.

JSON the browser stores / passes per profile:
{
  "profileId": "acc_8842",
  "antidetect": {
    "enabled": true,
    "sessionToken": "10743920164556128377",   // decimal uint64 STRING (required)
    "hardwareConcurrency": 8,                  // unsigned > 0, optional
    "platform": "Win32",                       // string, optional
    "userAgent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "uaMetadata": {                            // optional; RendererPreferences.ua_metadata_override
      "brands": [
        {"brand": "Chromium", "version": "126"},
        {"brand": "Google Chrome", "version": "126"},
        {"brand": "Not-A.Brand", "version": "24"}
      ],
      "platform": "Windows",
      "platformVersion": "15.0.0",
      "architecture": "x86",
      "bitness": "64",
      "mobile": false
    },
    "webrtcMode": "proxy_only"                 // informational; presence of token
                                               // + kFarbleWebRTC drives suppression
  }
}

Field -> command-line switch -> hook that consumes it:
| JSON field                    | switch (--...)              | hook / file                                   | how used                          |
|-------------------------------|-----------------------------|-----------------------------------------------|-----------------------------------|
| antidetect.sessionToken       | antidetect-session-token    | FarbleSessionCache (canvas), Should...WebRTC, | canvas: uint64 -> HMAC seed;      |
|                               |                             | AntidetectNavigatorConfig (navigator)         | webrtc/navigator: presence gate   |
| antidetect.hardwareConcurrency| antidetect-hw-concurrency   | navigator_concurrent_hardware.cc              | navigator.hardwareConcurrency     |
| antidetect.platform           | antidetect-platform         | navigator_id.cc::platform()                   | navigator.platform                |
| antidetect.userAgent          | antidetect-user-agent       | navigator_base.cc::userAgent()                | navigator.userAgent -> appVersion |
| antidetect.uaMetadata + userAgent (recommended header path) | (not a switch) RendererPreferences.ua_string_override / ua_metadata_override | content UA override | User-Agent + Sec-CH-UA request headers |
| antidetect.enabled + feature flags | --enable-features=FarbleCanvas,FarbleWebRTC,SpoofNavigator | FeatureList (process-global) | master kill-switch |

Rules the browser side must enforce:
  * sessionToken is REQUIRED whenever enabled==true and must be a nonzero decimal
    uint64 string (canvas HMAC-seeds from it; 0/empty disables all three hooks).
  * All four values must form a coherent identity (platform<->UA<->uaMetadata<->
    core count<->milestone). The patch trusts this table; it does not validate it.
  * Feature flags are per-BROWSER (whole process), token+values are per-PROFILE
    (per renderer). A profile without a token is a strict no-op even with flags on.