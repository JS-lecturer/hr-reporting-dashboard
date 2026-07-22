/* data.js — loads data/*.json into a single live in-memory store.
   This IS the shared live state: chat writes mutate this object directly,
   and the agent loop reads the SAME object on its next tick. No stale copies. */

const DataStore = {
  employees: [],       // live array of employee records (mutable)
  exEmployees: [],
  metrics: [],
  versions: { employees: null, ex_employees: null, metrics: null },
  loadedAt: null,
  fields: { employees: [], exEmployees: [] },

  async loadAll() {
    const [emp, ex, met] = await Promise.all([
      this._fetchJSON("data/employees.json"),
      this._fetchJSON("data/ex_employees.json"),
      this._fetchJSON("data/metrics_dictionary.json"),
    ]);

    if (emp) {
      this.employees = emp.records;
      this.versions.employees = emp.version;
      this.fields.employees = Object.keys(emp.records[0] || {});
    }
    if (ex) {
      this.exEmployees = ex.records;
      this.versions.ex_employees = ex.version;
      this.fields.exEmployees = Object.keys(ex.records[0] || {});
    }
    if (met) {
      this.metrics = met.records;
      this.versions.metrics = met.version;
    }
    this.loadedAt = new Date();
    document.dispatchEvent(new CustomEvent("hrdash:data-loaded"));
    return { emp, ex, met };
  },

  async _fetchJSON(path) {
    try {
      const res = await fetch(path, { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.json();
    } catch (e) {
      console.error("Failed to load", path, e);
      UI.showLoadError(path, e.message);
      return null;
    }
  },

  // Poll the JSON files' embedded version field to detect changes on disk.
  // Does NOT touch live in-memory data — only tells the user a refresh is available.
  async checkForUpdates() {
    const [emp, ex, met] = await Promise.all([
      this._fetchJSON("data/employees.json"),
      this._fetchJSON("data/ex_employees.json"),
      this._fetchJSON("data/metrics_dictionary.json"),
    ]);
    const changed =
      (emp && emp.version !== this.versions.employees) ||
      (ex && ex.version !== this.versions.ex_employees) ||
      (met && met.version !== this.versions.metrics);
    if (changed) {
      UI.showUpdateBanner();
    }
    return changed;
  },

  dataset(name) {
    // "active" | "ex" | "both"
    if (name === "active") return this.employees;
    if (name === "ex") return this.exEmployees;
    if (name === "both") return this.employees.concat(this.exEmployees);
    return this.employees;
  }
};
