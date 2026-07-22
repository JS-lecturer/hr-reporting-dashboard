/* agent.js — THE CORE LOOP (section 1). Runs every scanInterval seconds while
   the tab is open. Five stages, all logged. Reads DataStore live (same object
   chat mutates) so writes are visible on the very next tick. */

const Agent = {
  rules: [],
  timerHandle: null,
  log: [],

  init() {
    this.rules = Store.get("rules", null) || [this.defaultRule()];
    this.log = Store.get("agentLog", []);
    this.start();
    document.addEventListener("hrdash:settings-saved", () => this.restart());
  },

  defaultRule() {
    return {
      id: HRDASH.DEFAULT_RULE_ID,
      text: "if 12-month attrition crosses 15%, investigate which department is driving it, draft an analysis, and email me",
      condition: {
        conditionType: "RATE", metric: "attrition12m",
        scopeField: null, scopeValue: null,
        op: ">", threshold: 15, thresholdDisplay: "15%",
        description: "12-month attrition crosses 15%"
      },
      action: { type: "email" },
      enabled: true,
      createdAt: nowStamp(),
      lastTriggeredState: false,
    };
  },

  addRule(rule) {
    this.rules.push(rule);
    this.persistRules();
  },

  removeRule(id) {
    this.rules = this.rules.filter(r => r.id !== id);
    this.persistRules();
  },

  persistRules() { Store.set("rules", this.rules); },

  persistLog() {
    // cap log size to keep localStorage sane
    if (this.log.length > 500) this.log = this.log.slice(-500);
    Store.set("agentLog", this.log);
  },

  addLogEntry(entry) {
    entry.timestamp = nowStamp();
    this.log.push(entry);
    this.persistLog();
    document.dispatchEvent(new CustomEvent("hrdash:agent-log", { detail: entry }));
  },

  start() {
    this.stop();
    const interval = (Settings.active().scanInterval || HRDASH.SCAN_INTERVAL_DEFAULT) * 1000;
    this.timerHandle = setInterval(() => this.tick(), interval);
    // Also run one immediately so the UI isn't empty for 30s on load.
    this.tick();
  },

  stop() {
    if (this.timerHandle) clearInterval(this.timerHandle);
    this.timerHandle = null;
  },

  restart() { this.start(); },

  async tick() {
    if (!DataStore.employees.length) return; // data not loaded yet

    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      await this.evaluateRule(rule);
    }
  },

  async evaluateRule(rule) {
    // 1. PERCEIVE
    const evalResult = RuleEngine.evaluate(rule.condition);

    // 2. DECIDE — low-noise: only log when state changes, or periodically as a heartbeat
    const wasTriggered = rule.lastTriggeredState;
    const nowTriggered = evalResult.triggered;
    const stateChanged = wasTriggered !== nowTriggered;

    if (stateChanged) {
      this.addLogEntry({
        stage: "DECIDE", ruleId: rule.id, ruleText: rule.text,
        message: nowTriggered
          ? `Condition now TRUE — ${evalResult.detail}`
          : `Condition returned to FALSE — ${evalResult.detail}`,
        triggered: nowTriggered
      });
    } else {
      // Low-noise heartbeat: log a "no action needed" roughly once every 20 ticks (~10 min at 30s)
      rule._heartbeatCount = (rule._heartbeatCount || 0) + 1;
      if (rule._heartbeatCount % 20 === 0) {
        this.addLogEntry({ stage: "DECIDE", ruleId: rule.id, ruleText: rule.text, message: `No action needed — ${evalResult.detail}`, triggered: false, heartbeat: true });
      }
    }

    rule.lastTriggeredState = nowTriggered;
    this.persistRules();

    if (!nowTriggered || !stateChanged) return; // only act on a fresh transition into "triggered"

    // 3. INVESTIGATE — run a real query to find the actual driver
    let investigation = "";
    let investigationData = null;
    if (rule.condition.conditionType === "RATE" && rule.condition.metric === "attrition12m") {
      const byDept = attritionRateByGroup("Department");
      investigationData = byDept;
      const driver = byDept[0];
      investigation = `Highest-attrition department is ${driver.group} at ${driver.rate.toFixed(1)}% (${driver.exits} exits / ${driver.activeHeadcount} active). Full breakdown: ` +
        byDept.slice(0, 5).map(d => `${d.group} ${d.rate.toFixed(1)}%`).join(", ") + ".";
    } else if (evalResult.matches) {
      investigationData = evalResult.matches.slice(0, 20).map(r => `${r["First Name"]} ${r["Last Name"]} (${r["Office (City)"]}, ${r["Department"]})`);
      investigation = `Matching records: ${investigationData.join("; ")}${evalResult.matches.length > 20 ? ", ..." : ""}.`;
    } else {
      investigation = evalResult.detail;
    }

    this.addLogEntry({ stage: "INVESTIGATE", ruleId: rule.id, ruleText: rule.text, message: investigation });

    // 4. ACT — draft analysis via Gemini (or template), then send email if configured
    let draft;
    const s = Settings.active();
    if (s.geminiApiKey) {
      const prompt = `You are an HR analytics agent. A watch rule just triggered: "${rule.condition.description}".
Investigation findings: ${investigation}
Write a short, plain-language analysis (4-6 sentences) suitable for an email to an HR leader, explaining what triggered, the likely driver, and one concrete recommended next step. Use only the facts given — do not invent numbers.`;
      const gen = await callGeminiDetailed(prompt);
      if (gen.ok) {
        draft = gen.text;
      } else {
        this.addLogEntry({ stage: "ACT", ruleId: rule.id, ruleText: rule.text, message: `Gemini draft failed: ${gen.error} — using template instead.` });
      }
    }
    if (!draft) {
      draft = `[template — configure a Gemini key for real analysis]\n\nWatch rule triggered: ${rule.condition.description}.\n${investigation}\nRecommended next step: review retention drivers in the highlighted segment.`;
    }

    let actionMessage;
    if (rule.action.type === "email") {
      const result = await EmailSender.send({
        subject: `HR Watch Rule Triggered: ${rule.condition.description}`,
        body: draft,
        meta: { ruleId: rule.id }
      });
      actionMessage = (result.ok === true ? "Email sent successfully. " : result.ok === false ? "Email FAILED: " + result.message + " " : "Email request sent (unconfirmed delivery). ") + `[mode: ${result.mode}]`;
      this.addLogEntry({ stage: "ACT", ruleId: rule.id, ruleText: rule.text, message: `Drafted analysis and attempted email. ${actionMessage}`, draft });
    } else {
      actionMessage = "No email action configured for this rule — logged only.";
      this.addLogEntry({ stage: "ACT", ruleId: rule.id, ruleText: rule.text, message: actionMessage, draft });
    }

    // 5. REPORT
    this.addLogEntry({
      stage: "REPORT", ruleId: rule.id, ruleText: rule.text,
      message: `Detected: ${rule.condition.description}. Investigated: ${investigation.slice(0, 200)}${investigation.length > 200 ? "..." : ""}. Action: ${actionMessage}`
    });
  }
};
