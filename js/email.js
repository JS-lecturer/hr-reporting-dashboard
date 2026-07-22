/* email.js — sends email via mailto or the user's deployed Apps Script webhook.
   Matches the exact contract in section 6 of the brief. Whichever mode is
   ACTIVE (saved) is the one that fires — always reads Settings.active(). */

const EmailSender = {

  // Returns { ok, mode, message, raw? } — never assumes success.
  async send({ subject, body, meta }) {
    const s = Settings.active(); // the single source of truth — never a stale copy
    const to = s.emailRecipient;

    if (!to || to.includes("YOUR_EMAIL_HERE")) {
      return { ok: false, mode: s.emailMode, message: "No recipient email configured in Settings. Set your own address first." };
    }

    if (s.emailMode === "webhook") {
      return this._sendWebhook(s.webhookUrl, to, subject, body, meta);
    }
    return this._sendMailto(to, subject, body);
  },

  _sendMailto(to, subject, body) {
    const url = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    try {
      window.location.href = url;
      return { ok: true, mode: "mailto", message: `Mail client opened with a prefilled draft to ${to}. Delivery depends on you hitting send in your mail app.` };
    } catch (e) {
      return { ok: false, mode: "mailto", message: "Could not open mail client: " + e.message };
    }
  },

  async _sendWebhook(webhookUrl, to, subject, body, meta) {
    if (!webhookUrl || webhookUrl.includes("PASTE_YOUR_DEPLOYED")) {
      return { ok: false, mode: "webhook", message: "Webhook URL is still a placeholder. Deploy your Apps Script and paste the URL into Settings." };
    }
    const payload = JSON.stringify({ to, subject, body, meta: meta || null });

    try {
      // Content-Type: text/plain avoids a CORS preflight; Apps Script still
      // parses the JSON string fine server-side.
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: payload
      });
      let json;
      try {
        json = await res.json();
      } catch (parseErr) {
        return { ok: false, mode: "webhook", message: "Request sent — check your inbox, delivery confirmation isn't available from this browser (response wasn't readable)." };
      }
      if (json && json.ok === true) {
        return { ok: true, mode: "webhook", message: "Email sent via webhook.", raw: json };
      }
      // Real error surfaced from the Apps Script — e.g. rate limit or disallowed recipient
      return { ok: false, mode: "webhook", message: (json && json.error) ? json.error : "Webhook reported failure.", raw: json };
    } catch (networkErr) {
      // Likely a CORS/opaque-response situation — fall back to no-cors fire-and-forget
      try {
        await fetch(webhookUrl, {
          method: "POST",
          mode: "no-cors",
          headers: { "Content-Type": "text/plain" },
          body: payload
        });
        return { ok: null, mode: "webhook", message: "Request sent — check your inbox, delivery confirmation isn't available from this browser." };
      } catch (e2) {
        return { ok: false, mode: "webhook", message: "Webhook request failed entirely: " + e2.message };
      }
    }
  }
};
