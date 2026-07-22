/* main.js — boot sequence */

document.addEventListener("DOMContentLoaded", async () => {
  Settings.load();
  UI.init();
  UI.renderSettingsBadge();

  await DataStore.loadAll();
  UI.renderAll();

  Agent.init();

  // Periodic change-detection poll (section 4) — separate from the agent's
  // own scan interval, fixed at 30s per spec.
  setInterval(() => DataStore.checkForUpdates(), HRDASH.DATA_CHECK_INTERVAL * 1000);

  document.getElementById("dismiss-load-error").addEventListener("click", () => {
    document.getElementById("load-error-banner").classList.remove("show");
  });
});
