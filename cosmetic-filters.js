// cosmetic-filters.js - Hides visual ad leftovers that DNR can't remove.
// Runs in the ISOLATED world at document_idle (after DOM is ready).

(function () {
  "use strict";

  // ---- YouTube ----
  const YT_SELECTORS = [
    "ytd-promoted-sparkles-web-renderer",
    "ytd-promoted-video-renderer",
    "ytd-display-ad-renderer",
    "ytd-ad-slot-renderer",
    "ytd-in-feed-ad-layout-renderer",
    "ytd-banner-promo-renderer",
    "ytd-statement-banner-renderer",
    "ytd-rich-item-renderer:has(.ytd-ad-slot-renderer)",
    "ytd-rich-section-renderer:has(ytd-statement-banner-renderer)",
    "#player-ads",
    "#masthead-ad",
    "#panels > ytd-engagement-panel-section-list-renderer[target-id=\"engagement-panel-ads\"]",
    ".ytp-ad-module",
    ".ytp-ad-overlay-container",
    ".ytp-ad-skip-button-container",
    ".video-ads",
    "tp-yt-paper-dialog:has(#mealbar-promo-renderer)",
    "ytd-companion-slot-renderer",
    "ytd-action-companion-ad-renderer",
    "ytd-player-legacy-desktop-watch-ads-renderer",
    ".ytd-merch-shelf-renderer",
    "ytd-merch-shelf-renderer",
    "div#offer-module",
    ".ytp-ad-text",
    ".ytp-ad-image-overlay",
    ".ytp-ad-player-overlay",
    ".ytp-ad-player-overlay-instream-info"
  ];

  // ---- Facebook / Meta ----
  const FB_SELECTORS = [
    // Sponsored posts in feed
    "div[data-pagelet^=\"FeedUnit\"]:has(a[href*=\"/ads/\"])",
    "div[data-pagelet^=\"FeedUnit\"]:has(span:has-text(\"Sponsored\"))",
    // Right column ads
    "div[data-pagelet=\"RightColumn\"] div[data-testid=\"ads_sidebar\"]",
    // Marketplace ads
    "div[data-pagelet*=\"MarketplaceAd\"]",
    // Audience Network
    "div[data-ad-preview]",
    "div[data-ad-comet-preview]",
    "iframe[src*=\"facebook.com/plugins/\"]"
  ];

  // ---- Generic news / content sites ----
  const GENERIC_SELECTORS = [
    // Common ad container class/id patterns
    "div[id^=\"div-gpt-ad\"]",
    "div[class*=\"ad-container\"]",
    "div[class*=\"ad-wrapper\"]",
    "div[class*=\"ad-slot\"]",
    "div[class*=\"ad-unit\"]",
    "div[class*=\"adsbygoogle\"]",
    "ins.adsbygoogle",
    "div[id*=\"google_ads\"]",
    "div[data-ad-slot]",
    "div[data-google-query-id]",
    "div[id^=\"rcjsload_\"]",
    "div[id^=\"taboola-\"]",
    "div[id^=\"outbrain_\"]",
    "div[class*=\"taboola\"]",
    "div[class*=\"outbrain\"]",
    "div[data-outbrain-widget-id]",
    "div[class*=\"mgid\"]",
    "div[id^=\"mgid_\"]",
    "div[class*=\"revcontent\"]",
    // Sponsored content labels
    "section[data-component=\"MostPopularAd\"]",
    "aside[id*=\"sidebar\"] div[class*=\"ad\"]",
    // Common popup/overlay ads
    "div[class*=\"interstitial-ad\"]",
    "div[class*=\"overlay-ad\"]",
    "div[class*=\"popup-ad\"]",
    // Anti-adblock nags (only safe generic patterns)
    "div[class*=\"adblock-notice\"]"
  ];

  const host = location.hostname.replace(/^www\./, "");

  function getSelectors() {
    const out = [...GENERIC_SELECTORS];
    if (host.includes("youtube.com") || host.includes("youtu.be")) {
      out.push(...YT_SELECTORS);
    }
    if (host.includes("facebook.com") || host.includes("fb.com")) {
      out.push(...FB_SELECTORS);
    }
    return out;
  }

  function buildCSS(selectors) {
    return selectors
      .map(
        (s) =>
          s +
          "{display:none!important;visibility:hidden!important;height:0!important;max-height:0!important;overflow:hidden!important;pointer-events:none!important;}"
      )
      .join("\n");
  }

  function injectStylesheet(css) {
    const style = document.createElement("style");
    style.setAttribute("data-privacy-shield-cosmetic", "1");
    style.textContent = css;
    (document.head || document.documentElement).appendChild(style);
  }

  // YouTube mid-roll / pre-roll ad skipper (clicks the skip button when it
  // appears and fast-forwards the ad video).
  function watchYouTubeAds() {
    if (!host.includes("youtube.com")) return;
    const obs = new MutationObserver(() => {
      // Skip button
      const skip =
        document.querySelector(".ytp-ad-skip-button") ||
        document.querySelector(".ytp-ad-skip-button-modern") ||
        document.querySelector("button.ytp-skip-ad-button");
      if (skip) {
        try {
          skip.click();
        } catch (_) {}
      }
      // If an ad is playing, try to fast-forward it.
      const video = document.querySelector("video.html5-main-video");
      const ad = document.querySelector(".ad-showing");
      if (video && ad && video.duration && isFinite(video.duration)) {
        video.currentTime = video.duration;
      }
    });
    obs.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  // ---- Facebook "Sponsored" text detection ----
  // Facebook renders "Sponsored" as individual <span> characters or uses
  // encoded Unicode. This walks the feed and hides matching posts.
  function watchFacebookSponsored() {
    if (!host.includes("facebook.com") && !host.includes("fb.com")) return;
    const SPONSORED = /^sponsored$/i;
    function findAndHide(root) {
      const links = (root || document).querySelectorAll(
        'a[href*="/ads/about"], a[href*="about/ads"], a[aria-label="Sponsored"]'
      );
      for (const link of links) {
        let post = link.closest(
          "div[data-pagelet^=\"FeedUnit\"], div[role=\"article\"]"
        );
        if (post) post.style.display = "none";
      }
      // Also look for visible "Sponsored" text spans
      const spans = (root || document).querySelectorAll(
        "span[dir=\"auto\"], use[*|href]"
      );
      for (const s of spans) {
        const text = (s.textContent || "").trim();
        if (SPONSORED.test(text)) {
          let post = s.closest(
            "div[data-pagelet^=\"FeedUnit\"], div[role=\"article\"]"
          );
          if (post) post.style.display = "none";
        }
      }
    }
    findAndHide();
    const obs = new MutationObserver(() => findAndHide());
    obs.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  // ---- Bootstrap ----
  // Check config to see if blockAds is enabled.
  function shouldRun() {
    try {
      const attr = document.documentElement.getAttribute("data-privacy-shield");
      if (!attr) return true;
      const cfg = JSON.parse(attr);
      if (cfg.enabled === false) return false;
      if (cfg.blockAds === false) return false;
    } catch (_) {}
    return true;
  }

  if (!shouldRun()) return;

  const selectors = getSelectors();
  injectStylesheet(buildCSS(selectors));
  if (document.body) {
    watchYouTubeAds();
    watchFacebookSponsored();
  } else {
    document.addEventListener("DOMContentLoaded", () => {
      watchYouTubeAds();
      watchFacebookSponsored();
    });
  }
})();
