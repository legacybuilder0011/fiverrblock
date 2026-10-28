"use strict";

// One language, then its base language, then English when the profile is not
// already English. Never repeat a tag. en-US used to become en-US,en,en-US,en.
function acceptLanguagesFromLang(lang) {
  const value = String(lang || "").trim();
  if (!value) return "en-US,en";
  const list = [];
  const add = (item) => { if (item && !list.includes(item)) list.push(item); };
  const primary = value.split("-")[0];
  add(value);
  add(primary);
  if (primary !== "en") add("en");
  return list.join(",");
}

module.exports = { acceptLanguagesFromLang };
