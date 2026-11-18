"use strict";

const NEWS_TOOL_NAMES = [
  "news_open_browser",
  "news_navigate",
  "news_search_web",
  "news_search_x",
  "news_click",
  "news_type",
  "news_read_page",
  "news_screenshot",
  "news_scroll",
  "news_evaluate",
  "news_import_cookies",
  "news_import_browser_cookies",
  "news_list_cookie_sources",
  "news_ask_user",
  "news_close_browser",
];

// The built-in Chromium browser as a work target, next to local:this-computer
// and the VM ids from machine control.
const BROWSER_TARGET_ID = "browser:chromium";

function isBrowserTarget(id) {
  return String(id || "") === BROWSER_TARGET_ID;
}

module.exports = {
  BROWSER_TARGET_ID,
  NEWS_TOOL_NAMES,
  isBrowserTarget,
};
