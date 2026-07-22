/* queryEngine.js — LAYER 1: deterministic data-query engine.
   No LLM involved anywhere in this file. Every function here computes a
   real answer from DataStore's live in-memory arrays. */

const FIELD_SYNONYMS = {
  // canonical field name (as it appears in the JSON) -> list of synonyms/aliases (lowercase)
  "Office (City)": ["office", "location", "city", "site", "work location"],
  "Country of Residence": ["country", "nation"],
  "Department": ["department", "dept", "team", "division", "business unit"],
  "Job Title": ["job title", "title", "role", "position"],
  "Job Level": ["job level", "level", "grade", "seniority", "band"],
  "Compa-Ratio": ["compa-ratio", "compa ratio", "comparatio", "pay ratio", "compa"],
  "Engagement Score (1-5)": ["engagement", "engagement score"],
  "Burnout Risk Score (1-5)": ["burnout", "burnout risk", "burnout score", "burnout risk score"],
  "Annual Salary (SGD)": ["salary", "annual salary", "base salary", "pay"],
  "Annual Bonus (SGD)": ["bonus", "annual bonus"],
  "Benefits Cost (SGD)": ["benefits cost"],
  "Total Labor Cost (SGD)": ["labor cost", "total labor cost", "cost", "total cost"],
  "Years of Tenure": ["tenure", "years of tenure", "years of service"],
  "Performance Rating (1-5)": ["performance", "performance rating"],
  "eNPS Response (0-10)": ["enps", "e-nps", "enps response"],
  "Manager Effectiveness Score (1-5)": ["manager effectiveness"],
  "Inclusion Score (1-5)": ["inclusion", "inclusion score"],
  "HR Service Satisfaction (1-5)": ["hr satisfaction", "hr service satisfaction"],
  "PTO Usage %": ["pto usage", "pto usage %", "leave usage"],
  "Absenteeism Rate": ["absenteeism", "absenteeism rate"],
  "ER Cases (12M)": ["er cases", "employee relations cases"],
  "HR Tickets Raised (12M)": ["hr tickets"],
  "Employment Status": ["employment status", "status"],
  "Employment Type": ["employment type", "worker type"],
  "Gender": ["gender", "sex"],
  "Nationality": ["nationality"],
  "Manager Employee ID": ["manager", "manager id"],
  "Employee ID": ["employee id", "id", "emp id"],
  // ex-employee specific
  "Exit Reason": ["exit reason", "reason for leaving"],
  "Exit Type": ["exit type"],
  "Regrettable Attrition": ["regrettable attrition", "regrettable"],
  "Exit Date": ["exit date", "departure date", "leave date"],
  "Tenure at Exit (Years)": ["tenure at exit"],
  "Annual Salary at Exit (SGD)": ["salary at exit", "exit salary"],
};

const GROUPABLE_FIELDS = [
  "Office (City)", "Country of Residence", "Department", "Job Title",
  "Job Level", "Gender", "Employment Type", "Exit Reason", "Exit Type"
];

function fieldsForDataset(datasetName) {
  return datasetName === "ex" ? DataStore.fields.exEmployees : DataStore.fields.employees;
}

// Resolve free text (e.g. "compa ratio", "office", "burnout risk in operations")
// to a canonical field name that exists in the given dataset. Returns null if no match.
function resolveField(text, datasetName) {
  const t = text.toLowerCase().trim();
  const available = fieldsForDataset(datasetName);
  // exact canonical match (case-insensitive, ignoring parenthetical units)
  for (const f of available) {
    const bare = f.toLowerCase().replace(/\s*\([^)]*\)/g, "").trim();
    if (t === f.toLowerCase() || t === bare) return f;
  }
  // synonym match — prefer longest synonym match to avoid partial collisions
  let best = null, bestLen = 0;
  for (const [canonical, syns] of Object.entries(FIELD_SYNONYMS)) {
    if (!available.includes(canonical)) continue;
    for (const s of syns) {
      if (t.includes(s) && s.length > bestLen) {
        best = canonical; bestLen = s.length;
      }
    }
  }
  return best;
}

function findFieldInText(text, datasetName) {
  const available = fieldsForDataset(datasetName);
  const t = text.toLowerCase();
  let best = null, bestLen = 0;
  for (const f of available) {
    const bare = f.toLowerCase().replace(/\s*\([^)]*\)/g, "").trim();
    if (t.includes(bare) && bare.length > bestLen) { best = f; bestLen = bare.length; }
  }
  for (const [canonical, syns] of Object.entries(FIELD_SYNONYMS)) {
    if (!available.includes(canonical)) continue;
    for (const s of syns) {
      if (t.includes(s) && s.length > bestLen) { best = canonical; bestLen = s.length; }
    }
  }
  return best;
}

// Detect a categorical value mentioned in text against a dataset's dimension fields
// (office, department, country, job title, gender, exit reason...).
// Returns {field, value} or null.
function findCategoricalMention(text, datasetName) {
  const t = text.toLowerCase();
  const available = fieldsForDataset(datasetName);
  const dims = GROUPABLE_FIELDS.filter(f => available.includes(f));
  let best = null, bestLen = 0;
  for (const f of dims) {
    const values = uniqueValues(DataStore.dataset(datasetName === "ex" ? "ex" : "active"), f);
    for (const v of values) {
      if (v === null || v === undefined) continue;
      const vs = String(v).toLowerCase();
      if (vs.length < 3) continue;
      if (t.includes(vs) && vs.length > bestLen) {
        best = { field: f, value: v }; bestLen = vs.length;
      }
    }
  }
  return best;
}

function uniqueValues(rows, field) {
  return [...new Set(rows.map(r => r[field]))].filter(v => v !== undefined);
}

// ---------- numeric comparison parsing ----------
// Returns {op, value} where op in [">","<",">=","<=","==","!="]
function parseComparison(text) {
  const t = text.toLowerCase();
  const numMatch = t.match(/(-?\d+(\.\d+)?)\s*%?/);
  if (!numMatch) return null;
  let value = parseFloat(numMatch[1]);
  const isPercent = /%/.test(numMatch[0]) || /percent/.test(t);

  let op = null;
  if (/exactly|is exactly/.test(t)) op = "==";
  else if (/at least|reaches|hits|is\b|equals?/.test(t) && !/below|less than|under|fewer|drops? below|crosses/.test(t)) {
    // "is 2", "reaches 2", "hits 2" -> default AT LEAST (>=) per spec 8(f)
    op = ">=";
  }
  if (/crosses|exceeds|above|greater than|more than|over\b/.test(t)) op = ">";
  if (/below|less than|under|drops? below|falls below/.test(t)) op = "<";
  if (/fewer than/.test(t)) op = "<";
  if (/at least|no less than|minimum of/.test(t)) op = ">=";
  if (/at most|no more than|maximum of/.test(t)) op = "<=";
  if (!op) op = ">="; // sensible default

  return { op, value, isPercent };
}

// Convert a percent-style number to the decimal scale a field actually uses,
// when the field is a ratio/decimal field (e.g. Compa-Ratio stored as 0.85, not 85).
const DECIMAL_SCALE_FIELDS = new Set(["Compa-Ratio", "Goal Completion %", "Training Completion %", "PTO Usage %", "Absenteeism Rate"]);

function normalizeValueForField(field, value, isPercent) {
  if (DECIMAL_SCALE_FIELDS.has(field) && isPercent) {
    return { value: value / 100, converted: true, original: value };
  }
  // Also handle "200%" style meaning 2.0 even without % sign for compa-ratio-like asks
  if (field === "Compa-Ratio" && value > 10) {
    return { value: value / 100, converted: true, original: value };
  }
  return { value, converted: false, original: value };
}

function applyOp(a, op, b) {
  switch (op) {
    case ">": return a > b;
    case "<": return a < b;
    case ">=": return a >= b;
    case "<=": return a <= b;
    case "==": return a === b;
    case "!=": return a !== b;
    default: return false;
  }
}

// ---------- aggregation primitives ----------
function sum(rows, field) { return rows.reduce((s, r) => s + (Number(r[field]) || 0), 0); }
function avg(rows, field) { return rows.length ? sum(rows, field) / rows.length : 0; }
function minOf(rows, field) { return rows.length ? Math.min(...rows.map(r => Number(r[field]))) : null; }
function maxOf(rows, field) { return rows.length ? Math.max(...rows.map(r => Number(r[field]))) : null; }

function groupBy(rows, field) {
  const map = new Map();
  for (const r of rows) {
    const k = r[field];
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  return map;
}

function filterRows(rows, filters) {
  return rows.filter(r => filters.every(f => applyOp(Number.isFinite(Number(r[f.field])) && f.numeric !== false ? Number(r[f.field]) : r[f.field], f.op, f.value)));
}

// ---------- attrition rate ----------
// 12-month attrition rate for a given department/office/country (or overall):
// exits in the trailing 12 months / (current active headcount in scope + those exits)
// Documented approximation — no historical headcount snapshots are available.
function attritionRate12M(scopeField, scopeValue) {
  const now = new Date();
  const cutoff = new Date(now); cutoff.setMonth(cutoff.getMonth() - 12);

  let exits = DataStore.exEmployees.filter(r => {
    const d = r["Exit Date"] ? new Date(r["Exit Date"]) : null;
    return d && d >= cutoff && d <= now;
  });
  let active = DataStore.employees;

  if (scopeField && scopeValue !== undefined) {
    exits = exits.filter(r => String(r[scopeField]) === String(scopeValue));
    active = active.filter(r => String(r[scopeField]) === String(scopeValue));
  }
  const denom = active.length + exits.length;
  const rate = denom > 0 ? (exits.length / denom) * 100 : 0;
  return { rate, exits: exits.length, activeHeadcount: active.length, denom };
}

function attritionRateByGroup(field) {
  const groups = uniqueValues(DataStore.employees.concat(DataStore.exEmployees), field);
  const out = [];
  for (const g of groups) {
    if (g === null || g === undefined) continue;
    const r = attritionRate12M(field, g);
    out.push({ group: g, ...r });
  }
  return out.sort((a, b) => b.rate - a.rate);
}

// ---------- Layer 1 public entry point ----------
// Attempts to answer a natural-language data question deterministically.
// Returns { handled: bool, dataset, fields, filters, calculation, answer, table? }
const Layer1 = {

  scanStandardRiskFlags() {
    // Used by Layer 2 when a question doesn't name a segment: identify which
    // of the standard risk flags is most "out of range" right now.
    const overallAttrition = attritionRate12M(null, undefined).rate;
    const avgCompa = avg(DataStore.employees, "Compa-Ratio");
    const avgEngagement = avg(DataStore.employees, "Engagement Score (1-5)");
    const avgBurnout = avg(DataStore.employees, "Burnout Risk Score (1-5)");
    const belowCompaCount = DataStore.employees.filter(e => e["Compa-Ratio"] < 0.85).length;

    const byDeptAttrition = attritionRateByGroup("Department");
    const byDeptBurnout = [...groupBy(DataStore.employees, "Department")].map(([g, rows]) => ({ group: g, avg: avg(rows, "Burnout Risk Score (1-5)") })).sort((a,b)=>b.avg-a.avg);
    const byDeptEngagement = [...groupBy(DataStore.employees, "Department")].map(([g, rows]) => ({ group: g, avg: avg(rows, "Engagement Score (1-5)") })).sort((a,b)=>a.avg-b.avg);

    const flags = [
      { name: "12-month attrition", value: overallAttrition, unit: "%", severity: overallAttrition > 15 ? (overallAttrition - 15) / 15 : overallAttrition / 15 * 0.5, top: byDeptAttrition[0], detail: `Overall 12-month attrition is ${overallAttrition.toFixed(1)}%. Highest department: ${byDeptAttrition[0]?.group} at ${byDeptAttrition[0]?.rate.toFixed(1)}%.` },
      { name: "Compa-ratio", value: avgCompa, unit: "x", severity: avgCompa < 0.9 ? (0.9 - avgCompa) / 0.9 : 0, top: null, detail: `Average compa-ratio is ${avgCompa.toFixed(2)}. ${belowCompaCount} employees sit below 0.85.` },
      { name: "Engagement", value: avgEngagement, unit: "/5", severity: avgEngagement < 3.5 ? (3.5 - avgEngagement) / 3.5 : 0, top: byDeptEngagement[0], detail: `Average engagement score is ${avgEngagement.toFixed(2)}/5. Lowest department: ${byDeptEngagement[0]?.group} at ${byDeptEngagement[0]?.avg.toFixed(2)}.` },
      { name: "Burnout risk", value: avgBurnout, unit: "/5", severity: avgBurnout > 3 ? (avgBurnout - 3) / 3 : 0, top: byDeptBurnout[0], detail: `Average burnout risk is ${avgBurnout.toFixed(2)}/5. Highest department: ${byDeptBurnout[0]?.group} at ${byDeptBurnout[0]?.avg.toFixed(2)}.` },
    ];
    flags.sort((a, b) => b.severity - a.severity);
    return flags;
  },

  facts() {
    return {
      headcount: DataStore.employees.length,
      exHeadcount: DataStore.exEmployees.length,
      attrition12m: attritionRate12M(null, undefined),
      avgCompaRatio: avg(DataStore.employees, "Compa-Ratio"),
      avgEngagement: avg(DataStore.employees, "Engagement Score (1-5)"),
      avgBurnout: avg(DataStore.employees, "Burnout Risk Score (1-5)"),
      byDeptAttrition: attritionRateByGroup("Department"),
      riskFlags: this.scanStandardRiskFlags(),
    };
  }
};
