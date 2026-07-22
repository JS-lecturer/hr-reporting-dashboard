/* config.js — shared constants, localStorage helpers, namespacing */

const HRDASH = {
  LS_PREFIX: "hrdash_",
  SCAN_INTERVAL_DEFAULT: 30, // seconds
  DATA_CHECK_INTERVAL: 30,   // seconds
  DEFAULT_RULE_ID: "default-attrition-watch",
};

function lsKey(k) { return HRDASH.LS_PREFIX + k; }

const Store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(lsKey(key));
      if (raw === null || raw === undefined) return fallback;
      return JSON.parse(raw);
    } catch (e) {
      console.warn("Store.get failed for", key, e);
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(lsKey(key), JSON.stringify(value));
      return true;
    } catch (e) {
      console.warn("Store.set failed for", key, e);
      return false;
    }
  },
  remove(key) {
    try { localStorage.removeItem(lsKey(key)); } catch (e) {}
  }
};

// Central, single source of truth for "active" settings.
// Everything (agent tab, chat tab, email sender) reads from this SAME object.
// Never a separately-derived copy.
const Settings = {
  _active: null, // the last SAVED settings object — this is what actually runs
  _draft: null,  // unsaved edits in the Settings form (UI only)

  defaults() {
    return {
      geminiApiKey: "",
      geminiModel: "gemini-2.0-flash",
      emailMode: "mailto", // "mailto" | "webhook"
      emailRecipient: "[YOUR_EMAIL_HERE]",
      webhookUrl: "[PASTE_YOUR_DEPLOYED_APPS_SCRIPT_WEB_APP_URL_HERE]",
      scanInterval: HRDASH.SCAN_INTERVAL_DEFAULT,
    };
  },

  load() {
    const saved = Store.get("settings", null);
    this._active = saved ? Object.assign(this.defaults(), saved) : this.defaults();
    this._draft = Object.assign({}, this._active);
    return this._active;
  },

  // The value actually used at runtime by agent + email + chat.
  active() {
    if (!this._active) this.load();
    return this._active;
  },

  // The value currently shown in the settings form (may be unsaved).
  draft() {
    if (!this._draft) this.load();
    return this._draft;
  },

  setDraftField(field, value) {
    if (!this._draft) this.load();
    this._draft[field] = value;
  },

  isDirty() {
    if (!this._active || !this._draft) return false;
    return JSON.stringify(this._active) !== JSON.stringify(this._draft);
  },

  save() {
    this._active = Object.assign({}, this._draft);
    Store.set("settings", this._active);
    document.dispatchEvent(new CustomEvent("hrdash:settings-saved", { detail: this._active }));
    return this._active;
  },

  discardDraft() {
    this._draft = Object.assign({}, this._active);
  },

  // Human-readable one-line summary of what will ACTUALLY fire right now.
  activeSummaryText() {
    const s = this.active();
    if (s.emailMode === "webhook") {
      const urlLooksPlaceholder = !s.webhookUrl || s.webhookUrl.includes("PASTE_YOUR_DEPLOYED");
      const dest = urlLooksPlaceholder ? "⚠ webhook URL not configured" : s.webhookUrl;
      return `Active email mode: webhook → ${s.emailRecipient} (${dest})`;
    }
    return `Active email mode: mailto → ${s.emailRecipient}`;
  }
};

function nowStamp() {
  return new Date().toISOString();
}

function fmtStamp(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleString();
  } catch (e) { return iso; }
}
