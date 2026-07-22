/* ui.js — renders every view. Reads live DataStore + Settings + Agent state. */

const UI = {
  currentTab: "exec",

  init() {
    document.querySelectorAll(".tab-btn").forEach(btn => {
      btn.addEventListener("click", () => this.switchTab(btn.dataset.tab));
    });
    document.getElementById("refresh-btn").addEventListener("click", () => this.manualRefresh());
    document.addEventListener("hrdash:data-loaded", () => this.renderAll());
    document.addEventListener("hrdash:data-mutated", () => this.renderAll());
    document.addEventListener("hrdash:agent-log", () => { if (this.currentTab === "agent") this.renderAgentTab(); });
    document.addEventListener("hrdash:settings-saved", () => { this.renderSettingsBadge(); });
    this.switchTab("exec");
  },

  switchTab(tab) {
    this.currentTab = tab;
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
    document.querySelectorAll(".tab-panel").forEach(p => p.classList.toggle("active", p.id === "panel-" + tab));
    this.renderTab(tab);
  },

  renderTab(tab) {
    if (!DataStore.employees.length) return;
    switch (tab) {
      case "exec": this.renderExec(); break;
      case "workforce": this.renderWorkforce(); break;
      case "attrition": this.renderAttrition(); break;
      case "compensation": this.renderCompensation(); break;
      case "tables": this.renderTables(); break;
      case "agent": this.renderAgentTab(); break;
      case "chat": this.renderChatTab(); break;
      case "settings": this.renderSettingsTab(); break;
    }
  },

  renderAll() {
    this.renderTab(this.currentTab);
    this.renderSettingsBadge();
  },

  async manualRefresh() {
    await DataStore.loadAll();
    document.getElementById("update-banner").classList.remove("show");
    this.renderAll();
  },

  showUpdateBanner() {
    document.getElementById("update-banner").classList.add("show");
  },

  showLoadError(path, message) {
    const el = document.getElementById("load-error-banner");
    el.textContent = `⚠ Failed to load ${path}: ${message}`;
    el.classList.add("show");
  },

  // ---------------- EXECUTIVE SUMMARY ----------------
  renderExec() {
    const facts = Layer1.facts();
    const el = document.getElementById("panel-exec");
    const topFlag = facts.riskFlags[0];
    el.innerHTML = `
      <div class="card-grid">
        <div class="metric-card"><div class="metric-label">Active headcount</div><div class="metric-value">${facts.headcount.toLocaleString()}</div></div>
        <div class="metric-card"><div class="metric-label">12-month attrition</div><div class="metric-value">${facts.attrition12m.rate.toFixed(1)}%</div><div class="metric-sub">${facts.attrition12m.exits} exits / ${facts.attrition12m.activeHeadcount} active</div></div>
        <div class="metric-card"><div class="metric-label">Avg compa-ratio</div><div class="metric-value">${facts.avgCompaRatio.toFixed(2)}</div></div>
        <div class="metric-card"><div class="metric-label">Avg engagement</div><div class="metric-value">${facts.avgEngagement.toFixed(2)}/5</div></div>
      </div>
      <h3>Top risk flags</h3>
      <div class="risk-flags">
        ${facts.riskFlags.map((f, i) => `
          <div class="risk-flag ${i === 0 ? "risk-flag-top" : ""}">
            <div class="risk-flag-name">${i === 0 ? "🚩 " : ""}${escapeHtml(f.name)}</div>
            <div class="risk-flag-detail">${escapeHtml(f.detail)}</div>
          </div>`).join("")}
      </div>
      <p class="note">Methodology: 12-month attrition = exits in trailing 12 months ÷ (current active headcount + those exits). This is an approximation since no historical headcount snapshots are stored.</p>
    `;
  },

  // ---------------- WORKFORCE ----------------
  renderWorkforce() {
    const el = document.getElementById("panel-workforce");
    const byOffice = [...groupBy(DataStore.employees, "Office (City)")].map(([g, r]) => ({ label: g, value: r.length })).sort((a,b)=>b.value-a.value);
    const byDept = [...groupBy(DataStore.employees, "Department")].map(([g, r]) => ({ label: g, value: r.length })).sort((a,b)=>b.value-a.value);
    const byCountry = [...groupBy(DataStore.employees, "Country of Residence")].map(([g, r]) => ({ label: g, value: r.length })).sort((a,b)=>b.value-a.value);
    const byTitle = [...groupBy(DataStore.employees, "Job Title")].map(([g, r]) => ({ label: g, value: r.length })).sort((a,b)=>b.value-a.value).slice(0, 10);

    el.innerHTML = `
      <div class="chart-grid">
        <div class="chart-card"><h3>Headcount by office</h3>${Charts.bar(byOffice)}</div>
        <div class="chart-card"><h3>Headcount by country</h3>${Charts.pie(byCountry)}</div>
        <div class="chart-card"><h3>Headcount by department</h3>${Charts.bar(byDept, { height: 320 })}</div>
        <div class="chart-card"><h3>Top 10 job titles</h3>${Charts.bar(byTitle, { height: 320 })}</div>
      </div>
    `;
  },

  // ---------------- ATTRITION ----------------
  renderAttrition() {
    const el = document.getElementById("panel-attrition");
    const byDept = attritionRateByGroup("Department");
    const byOffice = attritionRateByGroup("Office (City)");
    const byReason = [...groupBy(DataStore.exEmployees, "Exit Reason")].map(([g, r]) => ({ label: g || "Unspecified", value: r.length })).sort((a,b)=>b.value-a.value);

    // exits by month (trend), based on Exit Date
    const monthMap = new Map();
    DataStore.exEmployees.forEach(r => {
      if (!r["Exit Date"]) return;
      const d = new Date(r["Exit Date"]);
      const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`;
      monthMap.set(key, (monthMap.get(key) || 0) + 1);
    });
    const months = [...monthMap.keys()].sort().slice(-18);
    const trend = months.map(m => ({ label: m.slice(2), value: monthMap.get(m) }));

    el.innerHTML = `
      <div class="chart-grid">
        <div class="chart-card"><h3>12-month attrition rate by department</h3>${Charts.bar(byDept.map(d => ({ label: d.group, value: +d.rate.toFixed(1) })), { height: 320 })}</div>
        <div class="chart-card"><h3>12-month attrition rate by office</h3>${Charts.bar(byOffice.map(d => ({ label: d.group, value: +d.rate.toFixed(1) })))}</div>
        <div class="chart-card"><h3>Exits by reason (all-time)</h3>${Charts.pie(byReason)}</div>
        <div class="chart-card"><h3>Exit trend (last 18 months on record)</h3>${Charts.line(trend)}</div>
      </div>
    `;
  },

  // ---------------- COMPENSATION / RISK ----------------
  renderCompensation() {
    const el = document.getElementById("panel-compensation");
    const compaValues = DataStore.employees.map(e => e["Compa-Ratio"]).filter(v => typeof v === "number");
    const below85 = DataStore.employees.filter(e => e["Compa-Ratio"] < 0.85);
    const byDeptCost = [...groupBy(DataStore.employees, "Department")].map(([g, r]) => ({ label: g, value: sum(r, "Total Labor Cost (SGD)") })).sort((a,b)=>b.value-a.value);

    el.innerHTML = `
      <div class="chart-grid">
        <div class="chart-card"><h3>Compa-ratio distribution</h3>${Charts.histogram(compaValues)}</div>
        <div class="chart-card"><h3>Labor cost by department (SGD)</h3>${Charts.bar(byDeptCost, { height: 320 })}</div>
      </div>
      <h3>Employees below 0.85 compa-ratio (${below85.length})</h3>
      ${this.simpleTable(below85.slice(0, 100), ["Employee ID","First Name","Last Name","Office (City)","Department","Compa-Ratio","Annual Salary (SGD)"])}
    `;
  },

  simpleTable(rows, cols) {
    if (!rows.length) return `<p class="empty-note">No matching records.</p>`;
    return `<div class="table-wrap"><table><thead><tr>${cols.map(c=>`<th>${escapeHtml(c)}</th>`).join("")}</tr></thead><tbody>
      ${rows.map(r => `<tr>${cols.map(c => `<td>${escapeHtml(String(r[c] ?? ""))}</td>`).join("")}</tr>`).join("")}
    </tbody></table></div>`;
  },

  // ---------------- TABLES ----------------
  renderTables() {
    const el = document.getElementById("panel-tables");
    if (!el.dataset.bound) {
      el.innerHTML = `
        <div class="table-controls">
          <select id="table-dataset-select">
            <option value="active">Active employees</option>
            <option value="ex">Ex-employees</option>
          </select>
          <input id="table-filter-input" type="text" placeholder="Filter (any column contains...)" />
          <span class="table-count" id="table-count"></span>
        </div>
        <div id="table-render-target"></div>
      `;
      el.dataset.bound = "1";
      document.getElementById("table-dataset-select").addEventListener("change", () => this.renderDataTable());
      document.getElementById("table-filter-input").addEventListener("input", () => this.renderDataTable());
    }
    this.renderDataTable();
  },

  _tableSort: { col: null, dir: 1 },

  renderDataTable() {
    const dsSel = document.getElementById("table-dataset-select").value;
    const filterText = document.getElementById("table-filter-input").value.toLowerCase();
    let rows = dsSel === "ex" ? DataStore.exEmployees : DataStore.employees;
    const cols = dsSel === "ex" ? DataStore.fields.exEmployees : DataStore.fields.employees;
    if (filterText) {
      rows = rows.filter(r => cols.some(c => String(r[c] ?? "").toLowerCase().includes(filterText)));
    }
    if (this._tableSort.col) {
      const { col, dir } = this._tableSort;
      rows = [...rows].sort((a, b) => {
        const av = a[col], bv = b[col];
        if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
        return String(av ?? "").localeCompare(String(bv ?? "")) * dir;
      });
    }
    document.getElementById("table-count").textContent = `${rows.length} of ${dsSel === "ex" ? DataStore.exEmployees.length : DataStore.employees.length}`;
    const shown = rows.slice(0, 200);
    const target = document.getElementById("table-render-target");
    target.innerHTML = `<div class="table-wrap"><table><thead><tr>
      ${cols.map(c => `<th class="sortable" data-col="${escapeHtml(c)}">${escapeHtml(c)}${this._tableSort.col===c ? (this._tableSort.dir>0?" ▲":" ▼"):""}</th>`).join("")}
    </tr></thead><tbody>
      ${shown.map(r => `<tr>${cols.map(c => `<td>${escapeHtml(String(r[c] ?? ""))}</td>`).join("")}</tr>`).join("")}
    </tbody></table></div>${rows.length > 200 ? `<p class="note">Showing first 200 of ${rows.length} matching rows.</p>` : ""}`;
    target.querySelectorAll("th.sortable").forEach(th => {
      th.addEventListener("click", () => {
        const col = th.dataset.col;
        this._tableSort.dir = (this._tableSort.col === col) ? -this._tableSort.dir : 1;
        this._tableSort.col = col;
        this.renderDataTable();
      });
    });
  },

  // ---------------- AGENT TAB ----------------
  renderAgentTab() {
    const el = document.getElementById("panel-agent");
    const rulesHtml = Agent.rules.map(r => `
      <div class="rule-card">
        <div class="rule-header">
          <span class="rule-badge ${r.lastTriggeredState ? "triggered" : ""}">${r.lastTriggeredState ? "TRIGGERED" : "watching"}</span>
          <strong>${escapeHtml(r.text)}</strong>
        </div>
        <div class="rule-sub">Condition: <code>${escapeHtml(r.condition.thresholdDisplay || r.condition.description)}</code> · Action: ${r.action.type} · ${r.enabled ? "enabled" : "disabled"}</div>
        <button class="btn-small" data-rule-toggle="${r.id}">${r.enabled ? "Disable" : "Enable"}</button>
        ${r.id !== HRDASH.DEFAULT_RULE_ID ? `<button class="btn-small btn-danger" data-rule-remove="${r.id}">Remove</button>` : ""}
      </div>
    `).join("");

    const logHtml = [...Agent.log].reverse().slice(0, 100).map(e => `
      <div class="log-entry stage-${e.stage.toLowerCase()}">
        <span class="log-time">${fmtStamp(e.timestamp)}</span>
        <span class="log-stage">${e.stage}</span>
        <span class="log-msg">${escapeHtml(e.message)}</span>
      </div>
    `).join("");

    el.innerHTML = `
      <p class="active-summary">${escapeHtml(Settings.activeSummaryText())} · Scan interval: ${Settings.active().scanInterval}s</p>
      <h3>Watch rules</h3>
      <div id="rules-list">${rulesHtml}</div>
      <details class="add-rule">
        <summary>+ Add a watch rule (plain language)</summary>
        <textarea id="new-rule-text" placeholder='e.g. "if average burnout risk in Operations exceeds 3.5, email me"'></textarea>
        <button id="add-rule-btn" class="btn-small">Parse &amp; preview</button>
        <div id="add-rule-preview"></div>
      </details>
      <h3>Agent log</h3>
      <div class="log-list">${logHtml || '<p class="empty-note">No log entries yet.</p>'}</div>
    `;

    el.querySelectorAll("[data-rule-toggle]").forEach(btn => btn.addEventListener("click", () => {
      const r = Agent.rules.find(x => x.id === btn.dataset.ruleToggle);
      r.enabled = !r.enabled; Agent.persistRules(); UI.renderAgentTab();
    }));
    el.querySelectorAll("[data-rule-remove]").forEach(btn => btn.addEventListener("click", () => {
      Agent.removeRule(btn.dataset.ruleRemove); UI.renderAgentTab();
    }));
    const addBtn = el.querySelector("#add-rule-btn");
    if (addBtn) addBtn.addEventListener("click", () => {
      const text = el.querySelector("#new-rule-text").value.trim();
      if (!text) return;
      const cond = RuleEngine.parse(text);
      const preview = el.querySelector("#add-rule-preview");
      preview.innerHTML = `<p><strong>Parsed as:</strong> ${escapeHtml(cond.description)}</p><p><code>${escapeHtml(cond.thresholdDisplay || "")}</code></p><button id="confirm-add-rule" class="btn-small">Save rule</button>`;
      preview.querySelector("#confirm-add-rule").addEventListener("click", () => {
        Agent.addRule({ id: "rule-" + Date.now(), text, condition: cond, action: { type: "email" }, enabled: true, createdAt: nowStamp(), lastTriggeredState: false });
        el.querySelector("#new-rule-text").value = "";
        preview.innerHTML = "";
        UI.renderAgentTab();
      });
    });
  },

  // ---------------- CHAT TAB ----------------
  renderChatTab() {
    const el = document.getElementById("panel-chat");
    if (!el.dataset.bound) {
      el.innerHTML = `
        <p class="active-summary" id="chat-active-summary"></p>
        <div id="chat-messages" class="chat-messages"></div>
        <div class="chat-input-row">
          <input id="chat-input" type="text" placeholder="Ask about the data, request an analysis, or set a watch rule..." />
          <button id="chat-send-btn">Send</button>
        </div>
        <div class="trace-panel" id="trace-panel"></div>
      `;
      el.dataset.bound = "1";
      const send = async () => {
        const input = document.getElementById("chat-input");
        const text = input.value.trim();
        if (!text) return;
        input.value = "";
        this.appendChatMessage("user", text);
        this.appendChatMessage("assistant", "…thinking…", true);
        const result = await processMessage(text);
        this.replaceLastAssistantMessage(result.text);
        this.renderTracePanel(result.trace);
      };
      document.getElementById("chat-send-btn").addEventListener("click", send);
      document.getElementById("chat-input").addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });
    }
    document.getElementById("chat-active-summary").textContent = Settings.activeSummaryText();
  },

  appendChatMessage(role, text, pending) {
    const container = document.getElementById("chat-messages");
    const div = document.createElement("div");
    div.className = `chat-msg chat-${role}` + (pending ? " pending" : "");
    div.innerHTML = `<span class="chat-role">${role === "user" ? "You" : "Agent"}</span><div class="chat-text">${escapeHtml(text).replace(/\n/g, "<br>")}</div>`;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  },

  replaceLastAssistantMessage(text) {
    const container = document.getElementById("chat-messages");
    const msgs = container.querySelectorAll(".chat-assistant.pending");
    const last = msgs[msgs.length - 1];
    if (last) {
      last.classList.remove("pending");
      last.querySelector(".chat-text").innerHTML = escapeHtml(text).replace(/\n/g, "<br>");
    }
  },

  renderTracePanel(trace) {
    const el = document.getElementById("trace-panel");
    if (!trace) { el.innerHTML = ""; return; }
    el.innerHTML = `<details open><summary>Trace (what was computed / sent)</summary><pre>${escapeHtml(JSON.stringify(trace, null, 2)).slice(0, 4000)}</pre></details>`;
  },

  // ---------------- SETTINGS TAB ----------------
  renderSettingsTab() {
    const el = document.getElementById("panel-settings");
    const d = Settings.draft();
    el.innerHTML = `
      <p class="active-summary">${escapeHtml(Settings.activeSummaryText())}</p>
      <div id="unsaved-badge" class="unsaved-badge" style="display:none">Unsaved changes — not yet active</div>

      <label>Gemini API key <span class="hint">(stored client-side only in this browser's localStorage — visible to anyone with access to this browser profile)</span></label>
      <input id="s-gemini-key" type="password" value="${escapeHtml(d.geminiApiKey)}" placeholder="AIza..." />

      <label>Gemini model</label>
      <input id="s-gemini-model" type="text" value="${escapeHtml(d.geminiModel)}" placeholder="gemini-2.0-flash" />

      <label>Email mode</label>
      <select id="s-email-mode">
        <option value="mailto" ${d.emailMode==="mailto"?"selected":""}>mailto (opens your mail client)</option>
        <option value="webhook" ${d.emailMode==="webhook"?"selected":""}>webhook (your Apps Script)</option>
      </select>

      <label>Email recipient (must be your own address)</label>
      <input id="s-email-recipient" type="text" value="${escapeHtml(d.emailRecipient)}" placeholder="[YOUR_EMAIL_HERE]" />

      <label>Webhook URL</label>
      <input id="s-webhook-url" type="text" value="${escapeHtml(d.webhookUrl)}" placeholder="[PASTE_YOUR_DEPLOYED_APPS_SCRIPT_WEB_APP_URL_HERE]" />
      <div id="webhook-warning" class="warning-line" style="display:none">⚠ Webhook URL still looks like a placeholder — sends will fail until you paste your deployed Apps Script URL.</div>

      <label>Scan interval (seconds)</label>
      <input id="s-scan-interval" type="number" min="5" value="${d.scanInterval}" />

      <p class="note">Watch rules only run while this browser tab is open. For always-on scanning, deploy the same rule logic as a time-based trigger in Google Apps Script (see README) — not built into this static site.</p>

      <div class="settings-actions">
        <button id="settings-save-btn">Save</button>
        <button id="settings-discard-btn" class="btn-secondary">Discard changes</button>
      </div>
    `;

    const fields = [
      ["s-gemini-key", "geminiApiKey"], ["s-gemini-model", "geminiModel"],
      ["s-email-mode", "emailMode"], ["s-email-recipient", "emailRecipient"],
      ["s-webhook-url", "webhookUrl"], ["s-scan-interval", "scanInterval"]
    ];
    const updateUnsaved = () => {
      document.getElementById("unsaved-badge").style.display = Settings.isDirty() ? "block" : "none";
      const url = document.getElementById("s-webhook-url").value;
      const mode = document.getElementById("s-email-mode").value;
      document.getElementById("webhook-warning").style.display = (mode === "webhook" && (!url || url.includes("PASTE_YOUR_DEPLOYED"))) ? "block" : "none";
    };
    fields.forEach(([id, key]) => {
      document.getElementById(id).addEventListener("input", (e) => {
        let v = e.target.value;
        if (key === "scanInterval") v = parseInt(v, 10) || HRDASH.SCAN_INTERVAL_DEFAULT;
        Settings.setDraftField(key, v);
        updateUnsaved();
      });
    });
    updateUnsaved();

    document.getElementById("settings-save-btn").addEventListener("click", () => {
      Settings.save();
      this.renderSettingsTab();
      this.renderSettingsBadge();
    });
    document.getElementById("settings-discard-btn").addEventListener("click", () => {
      Settings.discardDraft();
      this.renderSettingsTab();
    });
  },

  renderSettingsBadge() {
    const badge = document.getElementById("global-active-summary");
    if (badge) badge.textContent = Settings.activeSummaryText();
  }
};
