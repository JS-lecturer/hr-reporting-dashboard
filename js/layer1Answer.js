/* layer1Answer.js — turns a natural-language DATA question into a deterministic
   answer using queryEngine.js primitives. This is Layer 1's public "answer" API.
   No LLM calls happen anywhere in this file. */

function detectDataset(text) {
  const t = text.toLowerCase();
  if (/ex-?employee|exited|former|left the company|who left/.test(t)) return "ex";
  if (/\bboth\b|active and ex|current and former/.test(t)) return "both";
  return "active";
}

function detectTopN(text) {
  const m = text.toLowerCase().match(/top\s+(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

function buildRowSummary(row, fieldsOfInterest) {
  const base = {
    "Employee ID": row["Employee ID"],
    "Name": [row["First Name"], row["Last Name"]].filter(Boolean).join(" "),
    "Office": row["Office (City)"],
    "Department": row["Department"],
    "Job Title": row["Job Title"],
  };
  for (const f of fieldsOfInterest) if (row[f] !== undefined) base[f] = row[f];
  return base;
}

const Layer1Answer = {
  // Main entry: try to deterministically answer a data question.
  // Returns a structured trace object for the acceptance-test UI, or null if
  // this doesn't look like a clean data lookup (caller should route to Layer 2).
  answer(question) {
    const t = question.toLowerCase().trim();
    const datasetName = detectDataset(t);
    const rows = DataStore.dataset(datasetName);
    const trace = { question, dataset: datasetName, fields: [], filters: [], calculation: "", answer: null, table: null };

    // ---- 1. "which X has the most/highest/lowest employees" (grouped count) ----
    let m = t.match(/which\s+(country|office|department|location|city)\s+has\s+the\s+(most|highest|fewest|lowest)\s+employees/);
    if (m) {
      const dimText = m[1] === "location" || m[1] === "city" ? "office" : m[1];
      const field = resolveField(dimText, datasetName) || (dimText === "office" ? "Office (City)" : "Country of Residence");
      trace.fields = [field];
      const groups = groupBy(rows, field);
      const counts = [...groups.entries()].map(([g, r]) => ({ group: g, count: r.length })).sort((a, b) => b.count - a.count);
      const pick = m[2].includes("most") || m[2].includes("highest") ? counts[0] : counts[counts.length - 1];
      trace.calculation = `Grouped ${datasetName} employees by "${field}" and counted rows per group.`;
      trace.table = counts;
      trace.answer = `${pick.group} has the ${m[2]} employees (${pick.count}).`;
      return trace;
    }

    // ---- 2. "how many employees are in each office/department/country" ----
    m = t.match(/how many employees (?:are\s+)?in each\s+(office|department|country|location|job level|level)/);
    if (m) {
      const dimRaw = m[1] === "location" ? "office" : m[1];
      const field = resolveField(dimRaw, datasetName) || "Office (City)";
      trace.fields = [field];
      const groups = groupBy(rows, field);
      const counts = [...groups.entries()].map(([g, r]) => ({ group: g, count: r.length })).sort((a, b) => b.count - a.count);
      trace.calculation = `Grouped ${datasetName} employees by "${field}" and counted rows per group.`;
      trace.table = counts;
      trace.answer = counts.map(c => `${c.group}: ${c.count}`).join(", ");
      return trace;
    }

    // ---- 3. "how many employees are in <office> <department>" (specific segment count) ----
    m = t.match(/how many employees (?:are\s+)?in\s+([a-z\s&\/-]+?)\??$/);
    if (m && !/each/.test(t)) {
      const segment = m[1].trim();
      const office = findValueMatch(rows, "Office (City)", segment);
      const dept = findValueMatch(rows, "Department", segment);
      const filters = [];
      if (office) filters.push({ field: "Office (City)", value: office });
      if (dept) filters.push({ field: "Department", value: dept });
      if (filters.length) {
        let filtered = rows;
        for (const f of filters) filtered = filtered.filter(r => r[f.field] === f.value);
        trace.filters = filters;
        trace.fields = filters.map(f => f.field);
        trace.calculation = `Filtered ${datasetName} employees where ` + filters.map(f => `${f.field} = "${f.value}"`).join(" AND ") + ", then counted.";
        trace.answer = `${filtered.length} employees match (${filters.map(f => f.value).join(" / ")}).`;
        return trace;
      }
    }

    // ---- 4. "which department has the highest/lowest 12-month attrition" ----
    m = t.match(/which\s+(department|office|country)\s+has\s+the\s+(highest|lowest)\s+(?:12.?month\s+)?attrition/);
    if (m) {
      const field = m[1] === "department" ? "Department" : (m[1] === "office" ? "Office (City)" : "Country of Residence");
      trace.fields = [field];
      const byGroup = attritionRateByGroup(field);
      const pick = m[2] === "highest" ? byGroup[0] : byGroup[byGroup.length - 1];
      trace.calculation = `Computed 12-month attrition rate = exits in trailing 12 months / (current headcount + those exits), per ${field}.`;
      trace.table = byGroup;
      trace.answer = `${pick.group} has the ${m[2]} 12-month attrition rate at ${pick.rate.toFixed(1)}% (${pick.exits} exits vs ${pick.activeHeadcount} active).`;
      return trace;
    }

    // ---- 5. "who has compa-ratio below X" (row-level filter list) ----
    m = t.match(/who\s+has\s+(.+?)\s*(below|less than|under|above|over|greater than|exceeding)\s*(-?\d+(\.\d+)?)/);
    if (m) {
      const fieldText = m[1];
      const field = findFieldInText(fieldText, datasetName) || resolveField(fieldText, datasetName);
      if (field) {
        const cmp = parseComparison(t);
        const norm = normalizeValueForField(field, cmp.value, cmp.isPercent);
        const filtered = rows.filter(r => applyOp(Number(r[field]), cmp.op, norm.value));
        trace.fields = [field];
        trace.filters = [{ field, op: cmp.op, value: norm.value, convertedFrom: norm.converted ? norm.original : undefined }];
        trace.calculation = `Filtered ${datasetName} employees where ${field} ${cmp.op} ${norm.value}${norm.converted ? ` (converted from ${norm.original})` : ""}.`;
        trace.table = filtered.map(r => buildRowSummary(r, [field]));
        trace.answer = `${filtered.length} employee(s) match: ` + filtered.slice(0, 20).map(r => `${r["First Name"]} ${r["Last Name"]} (${r["Employee ID"]})`).join(", ") + (filtered.length > 20 ? ", ..." : "");
        return trace;
      }
    }

    // ---- 6. "average FIELD (score) by location/department/office/country" ----
    m = t.match(/average\s+(.+?)\s+by\s+(location|office|department|country|city|job level|level)/);
    if (m) {
      const field = findFieldInText(m[1], datasetName) || resolveField(m[1], datasetName);
      const dimRaw = m[2] === "location" || m[2] === "city" ? "office" : m[2];
      const groupField = resolveField(dimRaw, datasetName) || "Office (City)";
      if (field) {
        trace.fields = [field, groupField];
        const groups = groupBy(rows, groupField);
        const result = [...groups.entries()].map(([g, r]) => ({ group: g, average: avg(r, field) })).sort((a, b) => b.average - a.average);
        trace.calculation = `Grouped by ${groupField}, averaged ${field} within each group.`;
        trace.table = result;
        trace.answer = result.map(r => `${r.group}: ${r.average.toFixed(2)}`).join(", ");
        return trace;
      }
    }

    // ---- 7. "which office/department has the highest/lowest burnout risk" (grouped average) ----
    m = t.match(/which\s+(office|department|country|location)\s+has\s+the\s+(highest|lowest)\s+(.+)/);
    if (m) {
      const dimRaw = m[1] === "location" ? "office" : m[1];
      const groupField = resolveField(dimRaw, datasetName) || "Office (City)";
      const field = findFieldInText(m[3], datasetName) || resolveField(m[3], datasetName);
      if (field) {
        trace.fields = [field, groupField];
        const groups = groupBy(rows, groupField);
        const result = [...groups.entries()].map(([g, r]) => ({ group: g, average: avg(r, field) })).sort((a, b) => b.average - a.average);
        const pick = m[2] === "highest" ? result[0] : result[result.length - 1];
        trace.calculation = `Grouped ${datasetName} employees by ${groupField}, averaged ${field}, picked the ${m[2]}.`;
        trace.table = result;
        trace.answer = `${pick.group} has the ${m[2]} average ${field} at ${pick.average.toFixed(2)}.`;
        return trace;
      }
    }

    // ---- 8. "top N departments/offices by labor cost/salary/etc" (ranking, aggregated) ----
    m = t.match(/top\s+(\d+)\s+(department|office|country)s?\s+by\s+(.+)/);
    if (m) {
      const n = parseInt(m[1], 10);
      const groupField = m[2] === "department" ? "Department" : (m[2] === "office" ? "Office (City)" : "Country of Residence");
      const field = findFieldInText(m[3], datasetName) || resolveField(m[3], datasetName);
      if (field) {
        trace.fields = [field, groupField];
        const groups = groupBy(rows, groupField);
        const result = [...groups.entries()].map(([g, r]) => ({ group: g, total: sum(r, field) })).sort((a, b) => b.total - a.total).slice(0, n);
        trace.calculation = `Grouped ${datasetName} employees by ${groupField}, summed ${field}, took top ${n}.`;
        trace.table = result;
        trace.answer = result.map((r, i) => `${i + 1}. ${r.group}: ${r.total.toLocaleString()}`).join("; ");
        return trace;
      }
    }

    // ---- 9. "compare attrition between A and B" ----
    m = t.match(/compare\s+attrition\s+between\s+([a-z\s]+?)\s+and\s+([a-z\s]+)/);
    if (m) {
      const aVal = findValueMatch(DataStore.employees.concat(DataStore.exEmployees), "Office (City)", m[1].trim())
        || findValueMatch(DataStore.employees.concat(DataStore.exEmployees), "Department", m[1].trim());
      const bVal = findValueMatch(DataStore.employees.concat(DataStore.exEmployees), "Office (City)", m[2].trim())
        || findValueMatch(DataStore.employees.concat(DataStore.exEmployees), "Department", m[2].trim());
      const field = DataStore.employees.some(e => e["Office (City)"] === aVal) ? "Office (City)" : "Department";
      const a = attritionRate12M(field, aVal);
      const b = attritionRate12M(field, bVal);
      trace.fields = [field];
      trace.filters = [{ field, value: aVal }, { field, value: bVal }];
      trace.calculation = `Computed 12-month attrition rate independently for ${aVal} and ${bVal} (exits / (active + exits)).`;
      trace.table = [{ group: aVal, ...a }, { group: bVal, ...b }];
      trace.answer = `${aVal}: ${a.rate.toFixed(1)}% (${a.exits} exits / ${a.activeHeadcount} active) vs ${bVal}: ${b.rate.toFixed(1)}% (${b.exits} exits / ${b.activeHeadcount} active).`;
      return trace;
    }

    // ---- 10. "raise everyone in X with FIELD below V to NEWV" (write preview) ----
    m = t.match(/raise\s+everyone\s+in\s+(.+?)\s+with\s+(.+?)\s+(below|less than|under)\s+(-?\d+(\.\d+)?)\s+to\s+(-?\d+(\.\d+)?)/);
    if (m) {
      const segmentText = m[1];
      const fieldText = m[2];
      const threshold = parseFloat(m[4]);
      const newValue = parseFloat(m[6]);
      const field = findFieldInText(fieldText, datasetName) || resolveField(fieldText, datasetName);
      const office = findValueMatch(rows, "Office (City)", segmentText);
      const dept = findValueMatch(rows, "Department", segmentText);
      const filters = [];
      if (office) filters.push({ field: "Office (City)", value: office });
      if (dept) filters.push({ field: "Department", value: dept });
      if (field) filters.push({ field, op: "<", value: threshold });
      let affected = rows;
      for (const f of filters) {
        affected = affected.filter(r => f.op ? applyOp(Number(r[f.field]), f.op, f.value) : r[f.field] === f.value);
      }
      trace.fields = [field, "Office (City)", "Department"].filter(Boolean);
      trace.filters = filters;
      trace.calculation = `Filtered ${datasetName} employees matching segment + ${field} ${filters.find(f=>f.op) ? filters.find(f=>f.op).op : "<"} ${threshold}. Would set ${field} = ${newValue} on each match. PREVIEW ONLY — not yet applied.`;
      trace.table = affected.map(r => buildRowSummary(r, [field]));
      trace.answer = `${affected.length} employee(s) would be updated (${field} → ${newValue}). Reply "confirm" to apply.`;
      trace.pendingWrite = { field, newValue, matchIds: affected.map(r => r["Employee ID"]), datasetName };
      return trace;
    }

    // ---- 11. "which employee has the lowest/highest FIELD" (row-level ranking with full detail) ----
    m = t.match(/which employee has the\s+(lowest|highest)\s+(.+)/);
    if (m) {
      const field = findFieldInText(m[2], datasetName) || resolveField(m[2], datasetName);
      if (field) {
        const sorted = [...rows].sort((a, b) => m[1] === "lowest" ? Number(a[field]) - Number(b[field]) : Number(b[field]) - Number(a[field]));
        const pick = sorted[0];
        trace.fields = [field];
        trace.calculation = `Sorted all ${datasetName} employees by ${field} ${m[1] === "lowest" ? "ascending" : "descending"}, took row 0.`;
        trace.table = [buildRowSummary(pick, [field, "Annual Salary (SGD)"])];
        trace.answer = `${pick["First Name"]} ${pick["Last Name"]} (${pick["Employee ID"]}) — ${pick["Office (City)"]}, ${pick["Department"]}, ${pick["Job Title"]}, salary ${Number(pick["Annual Salary (SGD)"]).toLocaleString()} SGD, ${field}: ${pick[field]}.`;
        return trace;
      }
    }

    // ---- fallback generic: "how many / count" with any categorical value mentioned ----
    if (/how many|count/.test(t)) {
      const cat = findCategoricalMention(t, datasetName);
      if (cat) {
        const filtered = rows.filter(r => r[cat.field] === cat.value);
        trace.fields = [cat.field];
        trace.filters = [{ field: cat.field, value: cat.value }];
        trace.calculation = `Filtered ${datasetName} employees where ${cat.field} = "${cat.value}", counted.`;
        trace.answer = `${filtered.length} employees.`;
        return trace;
      }
    }

    return null; // not a clean data lookup — Layer 2 should handle it
  }
};

// Fuzzy match a free-text segment against the unique values of a field.
function findValueMatch(rows, field, text) {
  const t = text.toLowerCase();
  const values = [...new Set(rows.map(r => r[field]))];
  let best = null, bestLen = 0;
  for (const v of values) {
    if (v === null || v === undefined) continue;
    const vs = String(v).toLowerCase();
    if (t.includes(vs) && vs.length > bestLen) { best = v; bestLen = vs.length; }
  }
  return best;
}
