/* layer2.js — LAYER 0 (routing) + LAYER 2 (Gemini-driven general layer + actions).
   Exactly two hardcoded routing checks per section 7; everything else falls
   through to Layer 2 general, unconditionally. */

const ChatState = {
  history: [],           // [{role:"user"|"assistant", text}]
  pendingWrite: null,     // set when Layer1 previews a write, waiting for "confirm"
  pendingRule: null,      // set when a rule is being confirmed before saving
};

// Returns { ok, text, error } — never collapses distinct failure causes into
// one generic message. `error` always contains the real, specific reason
// (bad key, bad model name, network/CORS block, rate limit, empty response...)
// so both the user and any future debugging can tell what actually happened.
async function callGeminiDetailed(prompt) {
  const s = Settings.active();
  if (!s.geminiApiKey) return { ok: false, text: null, error: "No Gemini API key configured." };
  const model = s.geminiModel || "gemini-2.0-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(s.geminiApiKey)}`;

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    });
  } catch (networkErr) {
    // fetch() itself threw — this is a network/CORS/DNS-level failure, not an API error.
    const msg = `Network request to the Gemini API never completed (${networkErr.message}). This usually means it was blocked (CORS/ad-blocker/offline), not that the key or model is wrong.`;
    console.error("Gemini network error", networkErr);
    return { ok: false, text: null, error: msg };
  }

  let data;
  try {
    data = await res.json();
  } catch (parseErr) {
    const msg = `Gemini responded with HTTP ${res.status} but the body wasn't valid JSON.`;
    console.error("Gemini response parse error", parseErr);
    return { ok: false, text: null, error: msg };
  }

  if (!res.ok) {
    // Surface the API's own error message — this is where "bad model name" and
    // "bad/expired API key" show up, and they look very different from each other.
    const apiMsg = data?.error?.message || JSON.stringify(data);
    const msg = `Gemini API returned HTTP ${res.status}: ${apiMsg}` +
      (res.status === 404 ? ` — the model name "${model}" is likely wrong or unavailable for this API version. Check Settings → Gemini model.` : "") +
      (res.status === 400 || res.status === 403 ? " — check that the API key in Settings is valid and has access to this model." : "") +
      (res.status === 429 ? " — you've hit a rate limit or quota." : "");
    console.error("Gemini API error", data);
    return { ok: false, text: null, error: msg };
  }

  const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join("") || null;
  if (!text) {
    const blockReason = data?.promptFeedback?.blockReason;
    const msg = blockReason
      ? `Gemini returned no text — the prompt was blocked (reason: ${blockReason}).`
      : `Gemini returned HTTP 200 but no candidate text was present. Raw response: ${JSON.stringify(data).slice(0, 300)}`;
    console.warn("Gemini returned no usable text", data);
    return { ok: false, text: null, error: msg };
  }
  return { ok: true, text, error: null };
}

// Back-compat convenience wrapper for callers that just want text-or-null,
// but callers that need to explain a failure should use callGeminiDetailed.
async function callGemini(prompt) {
  const r = await callGeminiDetailed(prompt);
  return r.ok ? r.text : null;
}

// ---------------- LAYER 0: ROUTING (the only rule-based part) ----------------
function routeMessage(text) {
  const t = text.toLowerCase();

  // If we're mid-confirmation of a pending write/rule, treat short confirmations specially.
  if (ChatState.pendingWrite && /^(confirm|yes|apply|do it|go ahead)\b/.test(t.trim())) {
    return "confirm_write";
  }
  if (ChatState.pendingRule && /^(confirm|yes|save it|go ahead)\b/.test(t.trim())) {
    return "confirm_rule";
  }

  // (b) write/action request?
  const isWrite = /\b(raise|update|set|change|increase|decrease)\b.*\b(to|by)\b\s*-?\d/.test(t) && /employee|compa|salary|score|everyone|department|office/.test(t);
  const isEmailAction = /\bemail me\b|\bsend (me )?an? email\b|\bsend this\b/.test(t);
  const isRuleCreation = /\b(watch rule|create a rule|alert me if|notify me if|email me if)\b/.test(t) || (/^if\b/.test(t.trim()) && /email|alert|notify/.test(t));
  if (isWrite || isEmailAction || isRuleCreation) return "action";

  // (a) pure data lookup?
  const l1 = Layer1Answer.answer(text);
  if (l1) return { route: "layer1", trace: l1 };

  // (c) everything else -> Layer 2 general
  return "layer2_general";
}

// ---------------- ACTION PATH ----------------
async function handleAction(text) {
  const t = text.toLowerCase();

  // Rule creation
  if (/\b(watch rule|create a rule|alert me if|notify me if|email me if)\b/.test(t) || /^if\b/.test(t.trim())) {
    const cond = RuleEngine.parse(text);
    const rule = {
      id: "rule-" + Date.now(),
      text,
      condition: cond,
      action: { type: /email/.test(t) ? "email" : "log" },
      enabled: true,
      createdAt: nowStamp(),
      lastTriggeredState: false,
    };
    ChatState.pendingRule = rule;
    return {
      kind: "rule_preview",
      text: `Parsed this as a **${cond.conditionType}** rule: ${cond.description}.` +
            (cond.thresholdDisplay ? `\n\nCondition as evaluated: \`${cond.thresholdDisplay}\`` : "") +
            (cond.conditionType === "UNPARSED" ? "\n\n⚠️ I couldn't confidently parse this — try rephrasing with a clearer metric and threshold." : "") +
            `\n\nAction on trigger: ${rule.action.type === "email" ? "send an email (to " + Settings.active().emailRecipient + ")" : "log only"}.\n\nReply "confirm" to save this watch rule.`,
      trace: { parsedIntent: cond }
    };
  }

  // Email-my-conversation-summary action
  if (/\bemail (me )?a summary of (our|this) conversation\b/.test(t) || /email me a summary/.test(t)) {
    const transcript = ChatState.history.map(h => `${h.role}: ${h.text}`).join("\n");
    let body;
    const s = Settings.active();
    if (s.geminiApiKey) {
      const gen = await callGeminiDetailed(`Summarize this HR-dashboard chat conversation in plain, professional prose (5-8 sentences), for an email body:\n\n${transcript}`);
      body = gen.ok ? gen.text : `[Gemini call failed: ${gen.error}]\n\nTemplate summary (raw transcript):\n` + transcript.slice(0, 500);
    } else {
      body = "Template — configure a Gemini key for real analysis.\n\nConversation summary (raw):\n" + transcript.slice(0, 1000);
    }
    const result = await EmailSender.send({ subject: "HR Dashboard — Conversation Summary", body, meta: { source: "chat-summary" } });
    return {
      kind: "email_result",
      text: (result.ok === true ? "✅ " : result.ok === false ? "❌ " : "ℹ️ ") + result.message,
      trace: { config: Settings.active(), result }
    };
  }

  // Generic write: "raise everyone in X with FIELD below V to NEWV" — Layer1 already builds preview
  const l1 = Layer1Answer.answer(text);
  if (l1 && l1.pendingWrite) {
    ChatState.pendingWrite = l1.pendingWrite;
    return {
      kind: "write_preview",
      text: l1.answer + "\n\n" + l1.calculation,
      trace: l1
    };
  }

  // Fall through: didn't match a concrete action shape — hand to Layer 2 general with a note
  return await handleLayer2General(text, { actionAttempted: true });
}

async function handleConfirmWrite() {
  const pw = ChatState.pendingWrite;
  if (!pw) return { kind: "info", text: "There's no pending write to confirm." };
  const dataset = pw.datasetName === "ex" ? DataStore.exEmployees : DataStore.employees;
  let updated = 0;
  for (const row of dataset) {
    if (pw.matchIds.includes(row["Employee ID"])) {
      row[pw.field] = pw.newValue;
      updated++;
    }
  }
  ChatState.pendingWrite = null;
  document.dispatchEvent(new CustomEvent("hrdash:data-mutated"));
  return { kind: "write_applied", text: `✅ Applied: ${updated} employee(s) updated — ${pw.field} → ${pw.newValue}. This is live in memory and will be reflected on the agent's next scan.` };
}

async function handleConfirmRule() {
  const rule = ChatState.pendingRule;
  if (!rule) return { kind: "info", text: "There's no pending rule to confirm." };
  Agent.addRule(rule);
  ChatState.pendingRule = null;
  return { kind: "rule_saved", text: `✅ Watch rule saved and active: ${rule.condition.description}` };
}

// ---------------- LAYER 2: GENERAL / ADVISORY ----------------
async function handleLayer2General(text, opts) {
  opts = opts || {};
  const s = Settings.active();
  const looksHRRelated = /attrition|compa|salary|engagement|burnout|headcount|employee|department|office|hr\b|retention|turnover|performance|strateg/i.test(text) || opts.actionAttempted;

  let facts = null;
  if (looksHRRelated) {
    facts = Layer1.facts();
  }

  if (!s.geminiApiKey) {
    // Clearly labeled template fallback — never silently pretend to reason.
    if (looksHRRelated && facts) {
      const top = facts.riskFlags[0];
      return {
        kind: "template",
        text: `**[template — configure a Gemini key for real analysis]**\n\nBased on computed facts: overall 12-month attrition is ${facts.attrition12m.rate.toFixed(1)}%, average compa-ratio ${facts.avgCompaRatio.toFixed(2)}, average engagement ${facts.avgEngagement.toFixed(2)}/5, average burnout ${facts.avgBurnout.toFixed(2)}/5. The most out-of-range flag right now is **${top.name}** (${top.detail})`,
        trace: { computedFacts: facts }
      };
    }
    return {
      kind: "template",
      text: `**[template — configure a Gemini key for real analysis]** I can only do a plain lookup right now for HR questions, or a canned note for anything else. This looks like a general question — once a Gemini key is set in Settings, I'll respond to this naturally.`,
      trace: {}
    };
  }

  // Build the prompt: give Gemini ONLY computed facts (never let it invent numbers) + recent history.
  const historyText = ChatState.history.slice(-8).map(h => `${h.role}: ${h.text}`).join("\n");
  let prompt;
  if (looksHRRelated && facts) {
    prompt = `You are an HR analytics assistant embedded in a dashboard for Parumleo Orient, a Singaporean shipping company (~1000 active employees, offices in Singapore, Nagoya, Shanghai, Hong Kong, Mundra).
You must ONLY use the computed facts below — never invent numbers.
Computed facts (JSON): ${JSON.stringify(facts)}

Recent conversation:
${historyText}

User's message: "${text}"

Write a natural, direct, non-generic response using the computed facts above. If asked for a strategy, give a specific numbered plan referencing the real numbers. Keep it concise (under ~180 words) unless a longer breakdown is clearly needed.`;
  } else {
    prompt = `You are a helpful, honest assistant embedded in an HR dashboard for Parumleo Orient (a shipping company). The user's message below is NOT about the HR data. Answer it briefly and naturally like a competent assistant would — you may mention in passing that you're mainly here to help with the HR dashboard, but vary your phrasing naturally; do not use a canned refusal.

User's message: "${text}"`;
  }

  const gen = await callGeminiDetailed(prompt);
  if (!gen.ok) {
    return {
      kind: "error",
      text: `⚠ Gemini call failed: ${gen.error}\n\nFalling back to template: ` + (facts ? `most out-of-range flag is ${facts.riskFlags[0].name} (${facts.riskFlags[0].detail})` : "no computed facts available for this question."),
      trace: { computedFacts: facts, geminiError: gen.error }
    };
  }
  return { kind: "layer2", text: gen.text, trace: { computedFacts: facts, promptSentToGemini: prompt } };
}

// ---------------- MAIN ENTRY ----------------
async function processMessage(text) {
  ChatState.history.push({ role: "user", text });
  const route = routeMessage(text);

  let result;
  if (route === "confirm_write") result = await handleConfirmWrite();
  else if (route === "confirm_rule") result = await handleConfirmRule();
  else if (route === "action") result = await handleAction(text);
  else if (route && route.route === "layer1") {
    const trace = route.trace;
    result = { kind: "layer1", text: trace.answer + (trace.calculation ? "\n\n_" + trace.calculation + "_" : ""), trace };
  } else {
    result = await handleLayer2General(text);
  }

  ChatState.history.push({ role: "assistant", text: result.text });
  return result;
}
