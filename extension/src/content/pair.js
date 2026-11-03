// Content script on the Chamber app's own queue page (requirements R9.17). The app embeds
// its API key in the page; hand it to the service worker so the site buttons can reach
// the app. Opening the queue page once in Chrome is all the pairing there is.
(() => {
  const key = document.querySelector('meta[name="chamber-key"]')?.content;
  if (key) chrome.runtime.sendMessage({ type: 'chamber:pair', key }).catch(() => {});
})();
