// Minimal service worker: open the SafeScreen side panel from the toolbar icon.
// All pipeline state lives in the side panel and the content script, never here,
// because MV3 service workers can be terminated while idle.
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
