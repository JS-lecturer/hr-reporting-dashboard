/* ruleEngine.js — parses plain-language watch rules (section 8) into a
   structured condition, and evaluates that condition against DataStore's
   live in-memory data. Deterministic, no LLM. */

const RuleEngine = {

  // Parse free text into a structured rule condition.
  // Throws-free: returns a best-effort structure with a `parseNote` if unsure.
  parse(text) {
    const t = text.toLowerCase();

    // (a) RATE — "if 12-month attrition crosses 15%"
    let m = t.match(/(12.?month\s+)?attrition.*?(crosses|exceeds|above|goes above|reaches|is above)?\s*(\d+(\.\d+)?)\s*%/);
    if (/attrition/.test(t) && m) {
      const threshold = parseFloat(m[3]);
      let scopeField = null, scopeValue = null;
      const dept = findValueMatch(DataStore.employees, "Department", t);
      if (dept) { scopeField = "Department"; scopeValue = dept; }
      return {
        conditionType: "RATE",
        metric: "attrition12m",
        scopeField, scopeValue,
        op: ">", threshold, thresholdDisplay: `${threshold}%`,
        description: `12-month attrition${scopeValue ? ` in ${scopeValue}` : ""} crosses ${threshold}%`
      };
    }

    // (c) COUNT/EXISTENCE — "if there are no employees with compa-ratio less than 1"
    m = t.match(/if there are no employees with\s+(.+?)\s+(less than|below|under)\s+(-?\d+(\.\d+)?)/);
    if (m) {
      const field = findFieldInText(m[1], "active") || resolveField(m[1], "active");
      const rawVal = parseFloat(m[3]);
      const norm = normalizeValueForField(field, rawVal, /%/.test(m[0]));
      return {
        conditionType: "COUNT_EXISTENCE",
        field, filterOp: "<", filterValue: norm.value,
        op: "==", threshold: 0,
        thresholdDisplay: `COUNT(${field} < ${norm.value}) == 0`,
        converted: norm.converted, originalValue: norm.converted ? norm.original : undefined,
        description: `No employees have ${field} < ${norm.value}${norm.converted ? ` (converted from ${norm.original})` : ""}`
      };
    }

    // (d) COUNT vs threshold — "if fewer than 5 employees have engagement score below 3"
    m = t.match(/if\s+fewer than\s+(\d+)\s+employees have\s+(.+?)\s+(below|less than|under)\s+(-?\d+(\.\d+)?)/);
    if (m) {
      const countThreshold = parseInt(m[1], 10);
      const field = findFieldInText(m[2], "active") || resolveField(m[2], "active");
      const rawVal = parseFloat(m[4]);
      const norm = normalizeValueForField(field, rawVal, /%/.test(m[0]));
      return {
        conditionType: "COUNT_THRESHOLD",
        field, filterOp: "<", filterValue: norm.value,
        op: "<", threshold: countThreshold,
        thresholdDisplay: `COUNT(${field} < ${norm.value}) < ${countThreshold}`,
        converted: norm.converted, originalValue: norm.converted ? norm.original : undefined,
        description: `Fewer than ${countThreshold} employees have ${field} < ${norm.value}${norm.converted ? ` (converted from ${norm.original})` : ""}`
      };
    }

    // (e) MIN/MAX — "if the lowest compa-ratio in any department drops below 0.75"
    m = t.match(/if the\s+(lowest|highest)\s+(.+?)\s+in any\s+(department|office|country)\s+(drops below|falls below|exceeds|goes above)\s+(-?\d+(\.\d+)?)/);
    if (m) {
      const minmax = m[1] === "lowest" ? "min" : "max";
      const field = findFieldInText(m[2], "active") || resolveField(m[2], "active");
      const groupField = m[3] === "department" ? "Department" : (m[3] === "office" ? "Office (City)" : "Country of Residence");
      const rawVal = parseFloat(m[5]);
      const norm = normalizeValueForField(field, rawVal, /%/.test(m[0]));
      const op = /drops below|falls below/.test(m[4]) ? "<" : ">";
      return {
        conditionType: "MINMAX",
        field, groupField, minmax, op, threshold: norm.value,
        thresholdDisplay: `${minmax.toUpperCase()}(${field} by ${groupField}) ${op} ${norm.value}`,
        converted: norm.converted, originalValue: norm.converted ? norm.original : undefined,
        description: `The ${m[1]} ${field} in any ${groupField.toLowerCase()} ${m[4]} ${norm.value}${norm.converted ? ` (converted from ${norm.original})` : ""}`
      };
    }

    // (f) EQUALS/AT-LEAST — "if any employee compa-ratio is 2" / "reaches 2" / "is exactly 2"
    m = t.match(/if any employee(?:'s)?\s+(.+?)\s+(is exactly|is|reaches|hits)\s+(-?\d+(\.\d+)?)\s*%?/);
    if (m) {
      const field = findFieldInText(m[1], "active") || resolveField(m[1], "active");
      const exact = /is exactly/.test(m[2]);
      const rawVal = parseFloat(m[3]);
      const norm = normalizeValueForField(field, rawVal, /%/.test(m[0]));
      const op = exact ? "==" : ">="; // default AT-LEAST unless "exactly" — per section 8(f)
      return {
        conditionType: "COUNT_EXISTENCE",
        field, filterOp: op, filterValue: norm.value,
        op: ">=", threshold: 1,
        thresholdDisplay: `ANY employee ${field} ${op} ${norm.value}${norm.converted ? ` (converted from ${norm.original}${/%/.test(m[0]) ? "%" : ""})` : ""} — using ${exact ? "EXACT" : "AT-LEAST"} semantics${exact ? "" : " (default)"}`,
        converted: norm.converted, originalValue: norm.converted ? norm.original : undefined,
        description: `Any employee's ${field} ${op === ">=" ? "reaches (≥)" : "equals exactly"} ${norm.value}${norm.converted ? ` (converted from ${norm.original})` : ""}`
      };
    }

    // (b) AVERAGE — "if average burnout risk in Operations exceeds 3.5"
    m = t.match(/if average\s+(.+?)\s+in\s+(.+?)\s+(exceeds|is above|goes above|drops below|falls below|is below)\s+(-?\d+(\.\d+)?)/);
    if (m) {
      const field = findFieldInText(m[1], "active") || resolveField(m[1], "active");
      const scopeValue = findValueMatch(DataStore.employees, "Department", m[2]) || findValueMatch(DataStore.employees, "Office (City)", m[2]) || m[2];
      const scopeField = DataStore.employees.some(e => e["Department"] === scopeValue) ? "Department" : "Office (City)";
      const op = /exceeds|is above|goes above/.test(m[3]) ? ">" : "<";
      const threshold = parseFloat(m[4]);
      return {
        conditionType: "AVERAGE",
        field, scopeField, scopeValue, op, threshold,
        thresholdDisplay: `AVERAGE(${field}) in ${scopeValue} ${op} ${threshold}`,
        description: `Average ${field} in ${scopeValue} ${m[3]} ${threshold}`
      };
    }

    // Fallback: generic AVERAGE without explicit scope — "if average engagement exceeds/drops below X"
    m = t.match(/if average\s+(.+?)\s+(exceeds|is above|goes above|drops below|falls below|is below)\s+(-?\d+(\.\d+)?)/);
    if (m) {
      const field = findFieldInText(m[1], "active") || resolveField(m[1], "active");
      const op = /exceeds|is above|goes above/.test(m[2]) ? ">" : "<";
      const threshold = parseFloat(m[3]);
      return {
        conditionType: "AVERAGE",
        field, scopeField: null, scopeValue: null, op, threshold,
        thresholdDisplay: `AVERAGE(${field}) company-wide ${op} ${threshold}`,
        description: `Company-wide average ${field} ${m[2]} ${threshold}`
      };
    }

    return { conditionType: "UNPARSED", description: text, parseNote: "Could not confidently parse this rule into a structured condition. It will not be evaluated until rephrased." };
  },

  // Evaluate a parsed condition against the CURRENT live DataStore. Returns
  // { triggered, currentValue, detail }.
  evaluate(cond) {
    if (cond.conditionType === "UNPARSED") return { triggered: false, currentValue: null, detail: "Unparsed rule — not evaluated." };

    if (cond.conditionType === "RATE") {
      const r = attritionRate12M(cond.scopeField, cond.scopeValue);
      const triggered = applyOp(r.rate, cond.op, cond.threshold);
      return { triggered, currentValue: r.rate, detail: `12-month attrition${cond.scopeValue ? ` in ${cond.scopeValue}` : ""} is currently ${r.rate.toFixed(2)}% (${r.exits} exits / ${r.activeHeadcount} active).` };
    }

    if (cond.conditionType === "AVERAGE") {
      let rows = DataStore.employees;
      if (cond.scopeField && cond.scopeValue) rows = rows.filter(r => r[cond.scopeField] === cond.scopeValue);
      const a = avg(rows, cond.field);
      const triggered = applyOp(a, cond.op, cond.threshold);
      return { triggered, currentValue: a, detail: `Average ${cond.field}${cond.scopeValue ? ` in ${cond.scopeValue}` : " company-wide"} is currently ${a.toFixed(2)}.` };
    }

    if (cond.conditionType === "COUNT_EXISTENCE") {
      const matches = DataStore.employees.filter(r => applyOp(Number(r[cond.field]), cond.filterOp, cond.filterValue));
      const triggered = applyOp(matches.length, cond.op, cond.threshold);
      return { triggered, currentValue: matches.length, detail: `${matches.length} employee(s) currently have ${cond.field} ${cond.filterOp} ${cond.filterValue}.`, matches };
    }

    if (cond.conditionType === "COUNT_THRESHOLD") {
      const matches = DataStore.employees.filter(r => applyOp(Number(r[cond.field]), cond.filterOp, cond.filterValue));
      const triggered = applyOp(matches.length, cond.op, cond.threshold);
      return { triggered, currentValue: matches.length, detail: `${matches.length} employee(s) currently have ${cond.field} ${cond.filterOp} ${cond.filterValue} (threshold: ${cond.op} ${cond.threshold}).`, matches };
    }

    if (cond.conditionType === "MINMAX") {
      const groups = groupBy(DataStore.employees, cond.groupField);
      let worst = null;
      for (const [g, rows] of groups) {
        const val = cond.minmax === "min" ? minOf(rows, cond.field) : maxOf(rows, cond.field);
        if (val === null) continue;
        if (worst === null || (cond.minmax === "min" ? val < worst.val : val > worst.val)) worst = { group: g, val };
      }
      const triggered = worst ? applyOp(worst.val, cond.op, cond.threshold) : false;
      return { triggered, currentValue: worst ? worst.val : null, detail: worst ? `${cond.minmax === "min" ? "Lowest" : "Highest"} ${cond.field} is in ${worst.group} at ${worst.val}.` : "No data." };
    }

    return { triggered: false, currentValue: null, detail: "Unknown condition type." };
  }
};
