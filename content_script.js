const PF_STATE = {
  lastFocusedEditable: null,
  bypassUntil: 0,
  inFlight: false,
  // Behavioral signals (for invisible CAPTCHA)
  lastPasteAt: 0,
  pasteBurst: [],
  lastSendAt: 0,
  sendBurst: [],
  lastSendHash: "",
  repeatSendCount: 0,
  humanVerifiedUntil: 0,
  // Session-only safe substitution mapping
  substitutionCache: new Map(),
  substitutionSerial: {},
  runtimeInvalidated: false,
  runtimeInvalidatedNotified: false,
};

// Only run in the top frame (ChatGPT and similar apps can have sandboxed iframes).
const PF_TOP_FRAME = (() => {
  try {
    return window.top === window;
  } catch {
    return true;
  }
})();

const EDITABLE_SELECTOR =
  'textarea, [contenteditable]:not([contenteditable="false"])';
const CHAT_HOST_HINTS = ["chatgpt.com", "chat.openai.com", "gemini.google.com", "claude.ai", "perplexity.ai"];
const CHAT_INPUT_HINTS = ["prompt", "message", "chat", "ask", "assistant"];

// Mark page for quick debugging (visible from DevTools console).
try {
  document.documentElement.dataset.pfActive = "1";
  const v = globalThis?.chrome?.runtime?.getManifest?.()?.version || "";
  document.documentElement.dataset.pfVersion = String(v);
} catch {
  // no-op
}

if (!PF_TOP_FRAME) {
  // Skip event handlers in iframes.
  // Still allow the marker above for quick debugging if it runs.
} else {
document.addEventListener(
  "focusin",
  (e) => {
    const el = getEditableFromTarget(e.target);
    if (el) PF_STATE.lastFocusedEditable = el;
  },
  true
);

document.addEventListener(
  "keydown",
  (e) => {
    if (!shouldHandle(e)) return;
    // Allow plain Enter and Ctrl/Cmd+Enter (many chat apps support both).
    if (e.key !== "Enter" || e.shiftKey || e.altKey) return;
    if (e.isComposing) return;
    let el = getEditableFromTarget(e.target);
    if (!el && isKnownChatHost() && PF_STATE.lastFocusedEditable && document.contains(PF_STATE.lastFocusedEditable)) {
      el = PF_STATE.lastFocusedEditable;
    }
    if (!el || !isLikelyChatInput(el)) return;
    const text = getText(el);
    if (!text.trim()) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    void handleSend({ editable: el, originalText: text, triggerMeta: { type: "enter" } });
  },
  true
);

document.addEventListener(
  "click",
  (e) => {
    if (!shouldHandle(e)) return;
    const btn = getSendButton(e.target) || getHostHeuristicSendButton(e.target);
    if (!btn) return;
    const el = locateBestEditable(btn);
    if (!el || !isLikelyChatInput(el)) return;
    const text = getText(el);
    if (!text.trim()) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    void handleSend({ editable: el, originalText: text, triggerMeta: { type: "button", button: btn } });
  },
  true
);

document.addEventListener(
  "submit",
  (e) => {
    if (!shouldHandle(e)) return;
    const form = e.target;
    if (!(form instanceof HTMLFormElement)) return;
    const el = form.querySelector(EDITABLE_SELECTOR) || locateBestEditable(form);
    if (!el || !isLikelyChatInput(el)) return;
    const text = getText(el);
    if (!text.trim()) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    void handleSend({ editable: el, originalText: text, triggerMeta: { type: "form", form } });
  },
  true
);

document.addEventListener(
  "paste",
  (e) => {
    if (!shouldHandle(e)) return;
    const el = getEditableFromTarget(e.target);
    if (!el || !isLikelyChatInput(el) || !e.clipboardData) return;
    const pasted = e.clipboardData.getData("text/plain");
    if (!pasted) return;
    void handlePaste(e, el, pasted);
  },
  true
);
}

function shouldHandle(e) {
  return e.isTrusted && !PF_STATE.runtimeInvalidated && !PF_STATE.inFlight && Date.now() >= PF_STATE.bypassUntil;
}

function isKnownChatHost() {
  const host = location.hostname.toLowerCase();
  return CHAT_HOST_HINTS.some((h) => host === h || host.endsWith(`.${h}`));
}

// ─────────────────────────────────────────────
//  Core send handler
// ─────────────────────────────────────────────
async function handleSend({ editable, originalText, triggerMeta }) {
  PF_STATE.inFlight = true;
  try {
    // Invisible CAPTCHA: micro-challenge when automation-like behavior is detected.
    const captchaOk = await maybeRequireHumanVerification(originalText);
    if (!captchaOk) {
      toast("Send canceled.");
      await appendResolution({
        action: "CAPTCHA_FAILED",
        risk: 0,
        categories: [],
        counts: {},
        note: "Invisible CAPTCHA challenge not completed.",
      });
      return;
    }

    const resp = await sendMsg({
      type: "CLASSIFY_AND_REDACT",
      payload: {
        text: originalText,
        url: location.href,
        trigger: triggerMeta.type,
        meta: { timeSincePasteMs: getTimeSinceLastPasteMs() },
      },
    });

    if (!resp?.ok) {
      const errMsg = String(resp?.error || "");
      if (/extension context invalidated/i.test(errMsg)) {
        markRuntimeInvalidated(errMsg);
        toast("Prompt Firewall updated. Refresh this tab to send.", 4500);
        return;
      }
      toast("Prompt Firewall scan failed. Send blocked.", 3200);
      return;
    }

    const { analysis, decision, redactedText, redactions, policy, injectionResult } = resp;

    // ── Proxy chain ─────────────────────────────────────────────────────
    let textToSend = originalText;
    let proxyHops = null;

    if (policy?.proxyChainEnabled && Array.isArray(policy.proxyChain) && policy.proxyChain.length > 0) {
      // Always send the already-redacted text through hops (may equal original when no findings)
      const proxyInput = redactedText;
      const proxyResp = await sendMsg({
        type: "PROXY_CHAIN_EXECUTE",
        payload: { text: proxyInput, domain: location.hostname },
      });
      if (proxyResp?.ok && !proxyResp.skipped) {
        textToSend = proxyResp.finalText;
        proxyHops = proxyResp.hops;
        const failedHops = proxyResp.hops.filter((h) => !h.skipped && !h.success);
        if (failedHops.length > 0) toast(`${failedHops.length} proxy hop(s) failed — using fallback text.`);
        if (proxyResp.aborted) {
          toast("Proxy chain aborted — send cancelled.");
          return;
        }
      }
    }

    // ── Show injection warning banner if detected ───────────────────────
    if (injectionResult?.detected) {
      showInjectionBanner(injectionResult);
    }

    // ── Dispatch by decision ────────────────────────────────────────────
    if (decision.action === "ALLOW") {
      const finalText = proxyHops ? textToSend : originalText;
      await executeSend(editable, finalText, triggerMeta);
      if (proxyHops) showProxyToast(proxyHops);
      return;
    }

    const cats = Array.isArray(analysis?.categories) ? analysis.categories : [];
    const hasHardSecret = cats.includes("PRIVATE_KEY") || cats.includes("SECRET") || cats.includes("JWT");
    const decisionReasonCodes = Array.isArray(decision?.stepUpReasonCodes) && decision.stepUpReasonCodes.length > 0
      ? decision.stepUpReasonCodes
      : Array.isArray(decision?.reasons)
        ? decision.reasons.map((r) => r.code).filter(Boolean)
        : [];
    const decisionStepUpLevel = Number(decision?.stepUpLevel || decision?.stepUp?.level || 0) || 0;
    const decisionStepUpChallengeType =
      decision?.stepUpChallenge?.type || decision?.stepUp?.challenge?.type || "";

    if (decision.action === "STEP_UP") {
      const choice = await showBlockModal({
        mode: "STEP_UP",
        analysis,
        originalText,
        redactedText,
        redactions,
        canOverride: false,
        holdMs: policy?.holdToConfirmMs || 2000,
        stepUp: decision.stepUp || { level: decisionStepUpLevel || 1, required: true, methods: ["HOLD"], reason: "Verification required." },
        stepUpChallenge: decision.stepUpChallenge || decision?.stepUp?.challenge || null,
        stepUpReasonCodes: decisionReasonCodes,
        humanExplanation: decision?.humanExplanation || "",
        reasons: Array.isArray(decision?.reasons) ? decision.reasons : [],
        injectionResult,
        proxyHops,
        proxyFinalText: proxyHops ? textToSend : "",
      });

      if (choice === "STEP_UP_VERIFIED") {
        const isL2 = decisionStepUpLevel === 2;
        let finalText = proxyHops ? textToSend : originalText;
        if (isL2) {
          const safe = getL2SafeSendText({ redactedText, proxyHops, proxyText: textToSend });
          if (!safe.ok) {
            toast("L2 verified, but redacted text is unavailable. Send blocked.");
            await appendResolution({
              action: "STEP_UP_L2_FAIL_CLOSED",
              risk: analysis.risk,
              categories: analysis.categories,
              counts: analysis.counts,
              reasonCodes: decisionReasonCodes,
              stepUpLevel: decisionStepUpLevel || undefined,
              stepUpChallengeType: decisionStepUpChallengeType || undefined,
              automation: analysis?.automation || undefined,
              note: "L2 verification passed but redacted text missing; fail-closed.",
            });
            return;
          }
          finalText = safe.text;
        }
        await executeSend(editable, finalText, triggerMeta);
        if (isL2) await storeVaultEntries(redactions);
        await appendResolution({
          action: isL2 ? "STEP_UP_SEND_REDACTED" : "STEP_UP_SEND_ORIGINAL",
          risk: analysis.risk,
          categories: analysis.categories,
          counts: analysis.counts,
          reasonCodes: decisionReasonCodes,
          stepUpLevel: decisionStepUpLevel || undefined,
          stepUpChallengeType: decisionStepUpChallengeType || undefined,
          automation: analysis?.automation || undefined,
          note: isL2 ? "L2 step-up passed; sent redacted text." : "L1 step-up passed; sent original text.",
        });
        if (proxyHops) showProxyToast(proxyHops);
        return;
      }

      toast("Send canceled.");
      await appendResolution({
        action: "STEP_UP_CANCELLED",
        risk: analysis.risk,
        categories: analysis.categories,
        counts: analysis.counts,
        reasonCodes: decisionReasonCodes,
        stepUpLevel: decisionStepUpLevel || undefined,
        stepUpChallengeType: decisionStepUpChallengeType || undefined,
        automation: analysis?.automation || undefined,
        note: "User canceled required step-up verification.",
      });
      return;
    }

    // For hard secrets, always show a confirmation popup (demo-friendly).
    // This preserves productivity (send redacted/safe-sub) while still enabling step-up for sending original.
    if (decision.action === "AUTO_REDACT" && hasHardSecret) {
      const choice = await showBlockModal({
        mode: "BLOCK",
        analysis,
        originalText,
        redactedText,
        redactions,
        canOverride: Boolean(decision.canOverride),
        holdMs: policy?.holdToConfirmMs || 2000,
        stepUp: decision.stepUp || { level: 2, required: true, methods: ["OTP"], reason: "Hard secret detected." },
        stepUpChallenge: decision.stepUpChallenge || decision?.stepUp?.challenge || null,
        stepUpReasonCodes: decisionReasonCodes,
        humanExplanation: decision?.humanExplanation || "",
        reasons: Array.isArray(decision?.reasons) ? decision.reasons : [],
        injectionResult,
        proxyHops,
        proxyFinalText: proxyHops ? textToSend : "",
      });

      if (choice === "SEND_REDACTED") {
        const finalText = proxyHops ? textToSend : redactedText;
        await executeSend(editable, finalText, triggerMeta);
        await storeVaultEntries(redactions);
        await appendResolution({
          action: "SEND_REDACTED",
          risk: analysis.risk,
          categories: analysis.categories,
          counts: analysis.counts,
          note: "Secret flow: user chose redacted send.",
        });
        if (proxyHops) showProxyToast(proxyHops);
        return;
      }

      if (choice === "SEND_SAFE_SUBSTITUTED") {
        const substituted = buildSafeSubstitutedText(originalText, redactions || []);
        const finalText = proxyHops ? textToSend : substituted;
        await executeSend(editable, finalText, triggerMeta);
        await storeVaultEntries(redactions);
        await appendResolution({
          action: "SEND_SAFE_SUBSTITUTED",
          risk: analysis.risk,
          categories: analysis.categories,
          counts: analysis.counts,
          note: "Secret flow: user chose safe substitution send.",
        });
        if (proxyHops) showProxyToast(proxyHops);
        return;
      }

      if (choice === "SEND_REWRITE") {
        const rewrite = await sendMsg({ type: "SAFE_REWRITE", payload: { redactedText, categories: analysis.categories || [] } });
        const output = rewrite?.ok && rewrite.rewrittenText ? rewrite.rewrittenText : redactedText;
        const finalText = proxyHops ? textToSend : output;
        await executeSend(editable, finalText, triggerMeta);
        await storeVaultEntries(redactions);
        await appendResolution({
          action: "SEND_REWRITE",
          risk: analysis.risk,
          categories: analysis.categories,
          counts: analysis.counts,
          note: "Secret flow: user chose redacted + safe rewrite.",
        });
        return;
      }

      if (choice === "OVERRIDE_ORIGINAL") {
        if (!decision.canOverride) {
          toast("Override denied by policy for secret-class data.");
          await appendResolution({
            action: "OVERRIDE_DENIED",
            risk: analysis.risk,
            categories: analysis.categories,
            counts: analysis.counts,
            note: "Secret flow: policy denied secret override.",
          });
          return;
        }
        if (decisionStepUpLevel === 2) {
          const safe = getL2SafeSendText({ redactedText, proxyHops, proxyText: textToSend });
          if (!safe.ok) {
            toast("L2 verified, but redacted text is unavailable. Send blocked.");
            await appendResolution({
              action: "OVERRIDE_FAIL_CLOSED",
              risk: analysis.risk,
              categories: analysis.categories,
              counts: analysis.counts,
              reasonCodes: decisionReasonCodes,
              stepUpLevel: 2,
              stepUpChallengeType: decisionStepUpChallengeType || undefined,
              automation: analysis?.automation || undefined,
              note: "Blocked raw send after L2 because redacted text missing.",
            });
            return;
          }
          toast("L2 verified. Safety policy sent redacted text instead of original.");
          await executeSend(editable, safe.text, triggerMeta);
          await storeVaultEntries(redactions);
          await appendResolution({
            action: "OVERRIDE_REDIRECTED_TO_REDACTED",
            risk: analysis.risk,
            categories: analysis.categories,
            counts: analysis.counts,
            reasonCodes: decisionReasonCodes,
            stepUpLevel: 2,
            stepUpChallengeType: decisionStepUpChallengeType || undefined,
            automation: analysis?.automation || undefined,
            note: "L2 safety guarantee redirected override to redacted send.",
          });
          return;
        }
        await executeSend(editable, originalText, triggerMeta);
        await appendResolution({
          action: "OVERRIDE_ORIGINAL",
          risk: analysis.risk,
          categories: analysis.categories,
          counts: analysis.counts,
          note: "Secret flow: user completed step-up and sent original.",
        });
        return;
      }

      toast("Send canceled.");
      await appendResolution({
        action: "CANCELLED",
        risk: analysis.risk,
        categories: analysis.categories,
        counts: analysis.counts,
        note: "Secret flow: user canceled.",
      });
      return;
    }

    if (decision.action === "AUTO_REDACT") {
      const finalText = proxyHops ? textToSend : redactedText;
      toast(decision?.humanExplanation || `Sensitive data redacted (risk ${analysis.risk}/100).`);
      await executeSend(editable, finalText, triggerMeta);
      await storeVaultEntries(redactions);
      await appendResolution({
        action: "AUTO_REDACT_SENT",
        risk: analysis.risk,
        categories: analysis.categories,
        counts: analysis.counts,
        reasonCodes: Array.isArray(decision?.reasons) ? decision.reasons.map((r) => r.code).filter(Boolean) : [],
        automation: analysis?.automation || undefined,
        note: "Auto-redacted and sent.",
      });
      if (proxyHops) showProxyToast(proxyHops);
      return;
    }

    // BLOCK ── show modal
    const choice = await showBlockModal({
      mode: "BLOCK",
      analysis,
      originalText,
      redactedText,
      redactions,
      canOverride: decision.canOverride,
      holdMs: policy?.holdToConfirmMs || 2000,
      stepUp: decision.stepUp || null,
      stepUpChallenge: decision.stepUpChallenge || decision?.stepUp?.challenge || null,
      stepUpReasonCodes: decisionReasonCodes,
      humanExplanation: decision?.humanExplanation || "",
      reasons: Array.isArray(decision?.reasons) ? decision.reasons : [],
      injectionResult,
      proxyHops,
      proxyFinalText: proxyHops ? textToSend : "",
    });

    if (choice === "SEND_REDACTED") {
      const finalText = proxyHops ? textToSend : redactedText;
      await executeSend(editable, finalText, triggerMeta);
      await storeVaultEntries(redactions);
      await appendResolution({
        action: "SEND_REDACTED",
        risk: analysis.risk,
        categories: analysis.categories,
        counts: analysis.counts,
        note: "User chose redacted send.",
      });
      if (proxyHops) showProxyToast(proxyHops);
      return;
    }

    if (choice === "SEND_SAFE_SUBSTITUTED") {
      const substituted = buildSafeSubstitutedText(originalText, redactions || []);
      const finalText = proxyHops ? textToSend : substituted;
      await executeSend(editable, finalText, triggerMeta);
      await storeVaultEntries(redactions);
      await appendResolution({
        action: "SEND_SAFE_SUBSTITUTED",
        risk: analysis.risk,
        categories: analysis.categories,
        counts: analysis.counts,
        note: "User chose safe substitution send.",
      });
      if (proxyHops) showProxyToast(proxyHops);
      return;
    }

    if (choice === "SEND_REWRITE") {
      const rewrite = await sendMsg({ type: "SAFE_REWRITE", payload: { redactedText, categories: analysis.categories || [] } });
      const output = rewrite?.ok && rewrite.rewrittenText ? rewrite.rewrittenText : redactedText;
      const finalText = proxyHops ? textToSend : output;
      await executeSend(editable, finalText, triggerMeta);
      await storeVaultEntries(redactions);
      await appendResolution({
        action: "SEND_REWRITE",
        risk: analysis.risk,
        categories: analysis.categories,
        counts: analysis.counts,
        note: "User chose redacted + safe rewrite.",
      });
      return;
    }

    if (choice === "OVERRIDE_ORIGINAL") {
      if (!decision.canOverride) {
        toast("Override denied by policy for secret-class data.");
        await appendResolution({
          action: "OVERRIDE_DENIED",
          risk: analysis.risk,
          categories: analysis.categories,
          counts: analysis.counts,
          note: "Policy denied secret override.",
        });
        return;
      }
      if (decisionStepUpLevel === 2) {
        const safe = getL2SafeSendText({ redactedText, proxyHops, proxyText: textToSend });
        if (!safe.ok) {
          toast("L2 verified, but redacted text is unavailable. Send blocked.");
          await appendResolution({
            action: "OVERRIDE_FAIL_CLOSED",
            risk: analysis.risk,
            categories: analysis.categories,
            counts: analysis.counts,
            reasonCodes: decisionReasonCodes,
            stepUpLevel: 2,
            stepUpChallengeType: decisionStepUpChallengeType || undefined,
            automation: analysis?.automation || undefined,
            note: "Blocked raw send after L2 because redacted text missing.",
          });
          return;
        }
        toast("L2 verified. Safety policy sent redacted text instead of original.");
        await executeSend(editable, safe.text, triggerMeta);
        await storeVaultEntries(redactions);
        await appendResolution({
          action: "OVERRIDE_REDIRECTED_TO_REDACTED",
          risk: analysis.risk,
          categories: analysis.categories,
          counts: analysis.counts,
          reasonCodes: decisionReasonCodes,
          stepUpLevel: 2,
          stepUpChallengeType: decisionStepUpChallengeType || undefined,
          automation: analysis?.automation || undefined,
          note: "L2 safety guarantee redirected override to redacted send.",
        });
        return;
      }
      await executeSend(editable, originalText, triggerMeta);
      await appendResolution({
        action: "OVERRIDE_ORIGINAL",
        risk: analysis.risk,
        categories: analysis.categories,
        counts: analysis.counts,
        note: "User completed step-up and sent original.",
      });
      return;
    }

    toast("Send canceled.");
    await appendResolution({
      action: "CANCELLED",
      risk: analysis.risk,
      categories: analysis.categories,
      counts: analysis.counts,
      note: "User canceled blocked send.",
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "Unhandled error.";
    if (/extension context invalidated/i.test(errMsg)) {
      markRuntimeInvalidated(errMsg);
      toast("Prompt Firewall updated. Refresh this tab to send.", 4500);
      return;
    }
    toast("Prompt Firewall error. Send blocked.", 3200);
  } finally {
    PF_STATE.inFlight = false;
  }
}

async function handlePaste(event, editable, pastedText) {
  // Must cancel the browser paste synchronously; doing it after await causes
  // the original text to paste first and the sanitized text to be appended.
  event.preventDefault();

  PF_STATE.lastPasteAt = Date.now();
  PF_STATE.pasteBurst = pruneWindow([...PF_STATE.pasteBurst, PF_STATE.lastPasteAt], 1200);

  const resp = await sendMsg({
    type: "CLASSIFY_AND_REDACT",
    payload: { text: pastedText, url: location.href, trigger: "paste", meta: { timeSincePasteMs: null } },
  });

  if (!resp?.ok) {
    const errMsg = String(resp?.error || "");
    if (/extension context invalidated/i.test(errMsg)) {
      markRuntimeInvalidated(errMsg);
      toast("Prompt Firewall updated. Refresh this tab to paste.", 4500);
      return;
    }
    insertAtCursor(editable, pastedText);
    return;
  }

  if (!resp.policy?.clipboardProtection || resp.decision?.action === "ALLOW") {
    insertAtCursor(editable, pastedText);
    return;
  }

  const cats = Array.isArray(resp.analysis?.categories) ? resp.analysis.categories : [];
  const hasHardSecret = cats.includes("PRIVATE_KEY") || cats.includes("SECRET") || cats.includes("JWT");

  // For hard secrets, do NOT sanitize the paste. We want the send flow to show
  // the Step-Up modal (OTP) and allow safe substitution from the original.
  if (hasHardSecret) {
    insertAtCursor(editable, pastedText);
    toast("Hard secret detected — Step-Up required on send.", 3500);
    await appendResolution({
      action: "PASTE_HARD_SECRET",
      risk: resp.analysis?.risk || 0,
      categories: cats,
      counts: resp.analysis?.counts || {},
      note: "Clipboard protection allowed hard-secret paste; step-up enforced on send.",
    });
    return;
  }

  insertAtCursor(editable, resp.redactedText || pastedText);
  toast(`Paste sanitized (${resp.analysis?.risk || 0}/100).`);
  await storeVaultEntries(resp.redactions || []);
  await appendResolution({
    action: "PASTE_REDACTED",
    risk: resp.analysis?.risk || 0,
    categories: resp.analysis?.categories || [],
    counts: resp.analysis?.counts || {},
    note: "Clipboard protection sanitized paste.",
  });
}

// ─────────────────────────────────────────────
//  Data Vault helper
// ─────────────────────────────────────────────
async function storeVaultEntries(redactions) {
  if (!Array.isArray(redactions) || redactions.length === 0) return;
  const entries = redactions.map((r) => ({ placeholder: r.replacement, category: r.category }));
  await sendMsg({ type: "VAULT_STORE", payload: { entries } });
}

// ─────────────────────────────────────────────
//  Injection warning banner
// ─────────────────────────────────────────────
function showInjectionBanner(injectionResult) {
  const existing = document.getElementById("pf-injection-banner");
  if (existing) existing.remove();

  const signals = (injectionResult.signals || []).map((s) => s.signal.replace(/_/g, " ")).join(", ");
  const banner = document.createElement("div");
  banner.id = "pf-injection-banner";
  banner.style.cssText = [
    "position:fixed",
    "top:0",
    "left:0",
    "right:0",
    "z-index:2147483647",
    "background:#7c2d12",
    "color:#fff",
    "padding:10px 16px",
    "font:13px/1.4 system-ui,sans-serif",
    "display:flex",
    "align-items:center",
    "justify-content:space-between",
    "gap:12px",
    "box-shadow:0 2px 12px rgba(0,0,0,0.4)",
  ].join(";");
  banner.innerHTML = `
    <span><b>Prompt Injection Detected</b> — Signals: ${escHtml(signals)} (score: ${injectionResult.score}/100)</span>
    <button id="pf-banner-close" style="border:0;background:rgba(255,255,255,0.2);color:#fff;padding:4px 10px;border-radius:6px;cursor:pointer;font-weight:600;">Dismiss</button>
  `;
  document.body.appendChild(banner);
  banner.querySelector("#pf-banner-close").addEventListener("click", () => banner.remove());
  setTimeout(() => banner.remove(), 8000);
}

function showProxyToast(hops) {
  const ok = hops.filter((h) => h.success).length;
  const fail = hops.filter((h) => !h.skipped && !h.success).length;
  toast(`Proxy chain: ${ok} hop(s) OK${fail ? `, ${fail} failed (passthrough)` : ""}.`);
}

function getTimeSinceLastPasteMs() {
  if (!Number.isFinite(PF_STATE.lastPasteAt) || PF_STATE.lastPasteAt <= 0) return null;
  const delta = Date.now() - PF_STATE.lastPasteAt;
  if (!Number.isFinite(delta) || delta < 0) return null;
  return delta > 600000 ? null : delta;
}

function getL2SafeSendText({ redactedText, proxyHops, proxyText }) {
  if (proxyHops && Array.isArray(proxyHops) && proxyHops.length > 0) return { ok: true, text: proxyText || "" };
  if (typeof redactedText === "string" && redactedText.length > 0) return { ok: true, text: redactedText };
  return { ok: false, text: "" };
}

function normalizeReasonChips(reasons) {
  if (!Array.isArray(reasons)) return [];
  return reasons
    .filter((r) => r && typeof r === "object")
    .map((r) => ({
      code: String(r.code || "UNKNOWN"),
      label: String(r.label || r.code || "Unknown reason"),
      severity: ["LOW", "MED", "HIGH"].includes(String(r.severity || "").toUpperCase())
        ? String(r.severity || "").toUpperCase()
        : "LOW",
    }))
    .slice(0, 3);
}

function renderReasonChipsHtml(reasons) {
  const chips = normalizeReasonChips(reasons);
  if (chips.length === 0) return "";
  return `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px;">${chips
    .map((r) => {
      const palette =
        r.severity === "HIGH"
          ? { bg: "#fee2e2", border: "#fca5a5", text: "#991b1b" }
          : r.severity === "MED"
            ? { bg: "#fef3c7", border: "#fcd34d", text: "#92400e" }
            : { bg: "#e0f2fe", border: "#7dd3fc", text: "#0c4a6e" };
      return `<span title="${escHtml(r.label)}" style="display:inline-flex;align-items:center;gap:6px;padding:3px 8px;border-radius:999px;border:1px solid ${palette.border};background:${palette.bg};color:${palette.text};font-size:11px;font-weight:700;">
        <span>${escHtml(r.code)}</span>
        <span style="font-weight:600;opacity:0.9;">${escHtml(r.label)}</span>
      </span>`;
    })
    .join("")}</div>`;
}

function resolveStepUpChallenge(stepUp, stepUpChallenge) {
  const explicit = stepUpChallenge && typeof stepUpChallenge === "object" ? stepUpChallenge : stepUp?.challenge;
  const type = String(explicit?.type || (stepUp?.level === 2 ? "OTP" : "HOLD")).toUpperCase();
  const payload = explicit && typeof explicit.payload === "object" ? explicit.payload : {};
  if (type === "OTP") {
    return {
      type,
      payload: {
        code: String(payload.code || ""),
        ttlMs: Number.isFinite(payload.ttlMs) ? Number(payload.ttlMs) : 60000,
        issuedAtMs: Number.isFinite(payload.issuedAtMs) ? Number(payload.issuedAtMs) : Date.now(),
      },
    };
  }
  if (type === "SLIDER") {
    return {
      type,
      payload: {
        target: Number.isFinite(payload.target) ? Number(payload.target) : 100,
        mustHoldMs: Number.isFinite(payload.mustHoldMs) ? Number(payload.mustHoldMs) : 250,
      },
    };
  }
  if (type === "RETYPE") {
    return {
      type,
      payload: {
        phrase: String(payload.phrase || ""),
        ttlMs: Number.isFinite(payload.ttlMs) ? Number(payload.ttlMs) : 60000,
        issuedAtMs: Number.isFinite(payload.issuedAtMs) ? Number(payload.issuedAtMs) : Date.now(),
      },
    };
  }
  return {
    type: "HOLD",
    payload: {
      durationMs: Number.isFinite(payload.durationMs) ? Number(payload.durationMs) : (stepUp?.level === 2 ? 1800 : 1200),
    },
  };
}

// ─────────────────────────────────────────────
//  Block modal (extended)
// ─────────────────────────────────────────────
function showBlockModal({
  mode = "BLOCK",
  analysis,
  originalText,
  redactedText,
  redactions,
  canOverride,
  holdMs,
  stepUp,
  stepUpChallenge,
  stepUpReasonCodes,
  humanExplanation,
  reasons,
  injectionResult,
  proxyHops,
  proxyFinalText,
}) {
  return new Promise((resolve) => {
    let timer = null;
    let start = 0;
    let verifyTimer = null;
    let verifyStart = 0;
    let sliderHoldTimer = null;
    let verified = false;
    let stepUpOutcomeLogged = false;

    const viewMode = String(mode || "BLOCK").toUpperCase() === "STEP_UP" ? "STEP_UP" : "BLOCK";
    const step = stepUp && typeof stepUp === "object" && stepUp.required ? stepUp : null;
    const challenge = step ? resolveStepUpChallenge(step, stepUpChallenge) : null;
    const hasRedactions = Array.isArray(redactions) && redactions.length > 0;
    const reasonChips = normalizeReasonChips(reasons);
    const reasonChipsHtml = renderReasonChipsHtml(reasonChips);
    const explanationLine =
      typeof humanExplanation === "string" && humanExplanation.trim()
        ? humanExplanation.trim()
        : step?.reason
          ? `Blocked because: ${step.reason}`
          : "";
    const requireVerifyBeforeSafeSend = Boolean(step && (viewMode === "STEP_UP" || Number(step.level || 0) >= 2));
    const stepUpLevel = step ? Number(step.level || 0) : 0;
    const stepUpType = challenge?.type || "";
    const stepUpCodes = Array.isArray(stepUpReasonCodes) ? stepUpReasonCodes.map(String) : [];

    const overlay = mk("div", [
      "position:fixed",
      "inset:0",
      "z-index:2147483647",
      "background:rgba(15,23,42,0.65)",
      "display:flex",
      "align-items:center",
      "justify-content:center",
      "padding:20px",
    ]);

    const card = mk("div", [
      "width:min(740px,96vw)",
      "max-height:92vh",
      "overflow:auto",
      "background:#ffffff",
      "color:#111827",
      "border-radius:16px",
      "padding:18px",
      "box-shadow:0 20px 48px rgba(15,23,42,0.35)",
      "font:13px/1.45 system-ui,sans-serif",
    ]);

    const categories = Array.isArray(analysis?.categories) ? analysis.categories : [];
    const categoryText = categories.join(", ") || "Unknown";
    const redactionSummary = summarizeRedactions(redactions || []);
    const injectionHtml = injectionResult?.detected
      ? `<div style="background:#fef2f2;border:1px solid #fca5a5;border-radius:10px;padding:8px 10px;margin-bottom:10px;">
           <b style="color:#991b1b;">Prompt Injection:</b>
           <span style="color:#7f1d1d;">${escHtml(
             (injectionResult.signals || []).map((s) => s.signal.replace(/_/g, " ")).join(", ")
           )} (score ${injectionResult.score}/100)</span>
         </div>`
      : "";

    const proxyHtml =
      proxyHops && proxyHops.length > 0
        ? `<div style="background:#f0fdf4;border:1px solid #86efac;border-radius:10px;padding:8px 10px;margin-bottom:10px;font-size:11px;">
           <b style="color:#166534;">Proxy chain:</b> ${proxyHops
             .map(
               (h) =>
                 `<span style="margin-right:6px;padding:1px 6px;border-radius:4px;background:${
                   h.success ? "#bbf7d0" : "#fecaca"
                 };color:${h.success ? "#14532d" : "#7f1d1d"};">
               ${escHtml(h.label || `Hop ${h.index + 1}`)} ${h.latencyMs ? `(${h.latencyMs}ms)` : ""} ${
                   h.success ? "✓" : `✗ ${escHtml(h.error || "")}`
                 }
             </span>`
             )
             .join("")}
         </div>`
        : "";

    const verifyHtml = step
      ? (() => {
          const levelBadge = step.level === 2 ? "L2" : "L1";
          if (challenge?.type === "OTP") {
            return `<div id="pf-verify-zone" style="margin-bottom:10px;border:1px solid #93c5fd;background:#eff6ff;border-radius:12px;padding:10px;">
              <div style="font-weight:700;font-size:12px;color:#1e3a8a;margin-bottom:6px;">Step-Up ${levelBadge} verification</div>
              <div style="font-size:12px;color:#1e40af;margin-bottom:8px;">Enter the one-time code to continue:</div>
              <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
                <span style="font-family:ui-monospace,monospace;font-weight:800;letter-spacing:0.08em;background:#dbeafe;color:#1e3a8a;padding:6px 10px;border-radius:10px;">${escHtml(
                  String(challenge.payload?.code || "")
                )}</span>
                <input id="pf-otp-input" inputmode="numeric" autocomplete="one-time-code" placeholder="Enter code" style="padding:8px 10px;border:1px solid #93c5fd;border-radius:10px;min-width:180px;"/>
                <span id="pf-verify-status" style="font-size:12px;color:#1e3a8a;"></span>
              </div>
            </div>`;
          }
          if (challenge?.type === "SLIDER") {
            return `<div id="pf-verify-zone" style="margin-bottom:10px;border:1px solid #bfdbfe;background:#eff6ff;border-radius:12px;padding:10px;">
              <div style="font-weight:700;font-size:12px;color:#1d4ed8;margin-bottom:6px;">Step-Up ${levelBadge} verification</div>
              <div style="font-size:12px;color:#1e40af;margin-bottom:8px;">Slide to <b>${escHtml(
                String(challenge.payload?.target ?? 100)
              )}</b>, hold briefly, then verify.</div>
              <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
                <input id="pf-slider-input" type="range" min="0" max="100" value="0" style="flex:1;min-width:220px;"/>
                <span id="pf-slider-value" style="font:12px ui-monospace,monospace;color:#1e40af;min-width:32px;text-align:right;">0</span>
                <button id="pf-slider-verify" disabled style="padding:8px 10px;border:0;border-radius:10px;background:#1d4ed8;color:#fff;font-weight:700;cursor:pointer;opacity:0.55;">Verify</button>
              </div>
              <div id="pf-verify-status" style="font-size:12px;color:#1e40af;margin-top:8px;"></div>
            </div>`;
          }
          if (challenge?.type === "RETYPE") {
            return `<div id="pf-verify-zone" style="margin-bottom:10px;border:1px solid #d8b4fe;background:#faf5ff;border-radius:12px;padding:10px;">
              <div style="font-weight:700;font-size:12px;color:#7e22ce;margin-bottom:6px;">Step-Up ${levelBadge} verification</div>
              <div style="font-size:12px;color:#6b21a8;margin-bottom:8px;">Retype this phrase to continue:</div>
              <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
                <span style="font-family:ui-monospace,monospace;font-weight:800;letter-spacing:0.08em;background:#f3e8ff;color:#6b21a8;padding:6px 10px;border-radius:10px;">${escHtml(
                  String(challenge.payload?.phrase || "")
                )}</span>
                <input id="pf-retype-input" placeholder="Retype phrase" style="padding:8px 10px;border:1px solid #d8b4fe;border-radius:10px;min-width:180px;"/>
                <span id="pf-verify-status" style="font-size:12px;color:#6b21a8;"></span>
              </div>
            </div>`;
          }
          return `<div id="pf-verify-zone" style="margin-bottom:10px;border:1px solid #fcd34d;background:#fffbeb;border-radius:12px;padding:10px;">
            <div style="font-weight:700;font-size:12px;color:#92400e;margin-bottom:6px;">Step-Up ${levelBadge} verification</div>
            <div style="font-size:12px;color:#78350f;margin-bottom:8px;">Hold to confirm for <b>${Math.round(
              Number(challenge?.payload?.durationMs || 1200) / 100
            ) / 10}s</b>.</div>
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
              <div style="flex:1;min-width:220px;">
                <div style="height:8px;border-radius:999px;background:#fde68a;overflow:hidden;margin-bottom:8px;">
                  <div id="pf-verify-hold-progress" style="width:0%;height:100%;background:#f59e0b;transition:width 0.05s linear;"></div>
                </div>
                <button id="pf-verify-hold-btn" style="padding:8px 10px;border:0;border-radius:10px;background:#92400e;color:#fff;font-weight:700;cursor:pointer;">Hold to verify</button>
              </div>
              <span id="pf-verify-status" style="font-size:12px;color:#92400e;"></span>
            </div>
          </div>`;
        })()
      : "";

    const substitutedPreview =
      Array.isArray(redactions) && redactions.length > 0 ? buildSafeSubstitutedText(originalText || "", redactions) : "";
    const proxyPreview = typeof proxyFinalText === "string" && proxyFinalText ? proxyFinalText : "";
    const proxyCharCount = proxyPreview ? countVisibleChars(proxyPreview) : 0;
    const redactedCharCount = redactedText ? countVisibleChars(String(redactedText)) : 0;
    const substitutedCharCount = substitutedPreview ? countVisibleChars(String(substitutedPreview)) : 0;
    const previewTextFull = [
      `Risk: ${Number.isFinite(analysis?.risk) ? analysis.risk : 0}/100`,
      `Detected: ${categoryText}`,
      `Redacted prompt length: ${redactedCharCount} chars`,
      substitutedPreview ? `Safe substituted length: ${substitutedCharCount} chars` : "Safe substituted length: (none)",
      proxyPreview
        ? `After proxy chain length: ${proxyCharCount} chars (proxy runs on redacted text)`
        : "After proxy chain length: (none)",
      "",
      "Redacted prompt:",
      String(redactedText || ""),
      "",
      substitutedPreview ? "Safe substituted preview:" : "Safe substituted preview: (none)",
      substitutedPreview ? substitutedPreview : "",
      proxyPreview ? "\nAfter proxy chain (what will be sent if proxy enabled):" : "",
      proxyPreview ? proxyPreview : "",
    ]
      .filter((l) => l !== "")
      .join("\n");

    const previewTextLocked = [
      "Preview locked.",
      viewMode === "STEP_UP"
        ? "Complete verification above to continue sending."
        : "Complete Step‑Up verification above to view the full preview.",
      "",
      "Tip: you can still send redacted or safe‑substituted without revealing the full preview here.",
    ].join("\n");

    const previewTextInitial = step ? previewTextLocked : previewTextFull;

    const titleText = viewMode === "STEP_UP" ? "Prompt Firewall verification required" : "Prompt Firewall blocked this send";
    const explanationHtml = explanationLine
      ? `<div style="font-size:13px;font-weight:700;color:#0f172a;margin-bottom:6px;">${escHtml(explanationLine)}</div>`
      : "";
    const stepUpAutoSendHint =
      viewMode === "STEP_UP"
        ? `<div style="font-size:12px;color:#475569;margin-bottom:10px;">Complete verification to continue. L2 sends use redacted text by default.</div>`
        : "";
    const footerButtonsHtml =
      viewMode === "STEP_UP"
        ? `<div style="display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end;align-items:center;">
             <span style="font-size:12px;color:#475569;margin-right:auto;">${step ? "Verification required before send." : ""}</span>
             <button id="pf-cancel" style="padding:8px 10px;border:1px solid #cbd5e1;background:#fff;border-radius:10px;cursor:pointer;">Cancel</button>
           </div>`
        : `<div style="display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end;">
             <button id="pf-cancel" style="padding:8px 10px;border:1px solid #cbd5e1;background:#fff;border-radius:10px;cursor:pointer;">Cancel</button>
             <button id="pf-send-redacted" style="padding:8px 10px;border:0;background:#111827;color:#fff;border-radius:10px;cursor:pointer;">Send redacted</button>
             ${
               hasRedactions
                 ? `<button id="pf-send-safe-sub" style="padding:8px 10px;border:0;background:#065f46;color:#fff;border-radius:10px;cursor:pointer;">Send safe substituted</button>`
                 : ""
             }
             <button id="pf-send-rewrite" style="padding:8px 10px;border:0;background:#1d4ed8;color:#fff;border-radius:10px;cursor:pointer;">Send + safe rewrite</button>
             ${
               canOverride
                 ? `<button id="pf-request-override" ${step ? "disabled" : ""} style="padding:8px 10px;border:1px solid #f59e0b;background:#fffbeb;color:#92400e;border-radius:10px;cursor:pointer;${step ? "opacity:0.55;cursor:not-allowed;" : ""}">Send original (step-up)</button>`
                 : '<button disabled style="padding:8px 10px;border:1px solid #e2e8f0;background:#f8fafc;color:#94a3b8;border-radius:10px;">Override disabled</button>'
             }
           </div>`;

    card.innerHTML = `
      <div style="display:flex;justify-content:space-between;gap:8px;align-items:center;margin-bottom:8px;">
        <div style="font-weight:700;font-size:15px;">${escHtml(titleText)}</div>
        <div style="font-size:12px;background:#111827;color:#fff;padding:4px 8px;border-radius:999px;">Risk ${escHtml(
          String(analysis.risk || 0)
        )}/100</div>
      </div>
      ${explanationHtml}
      ${reasonChipsHtml}
      <div style="font-size:12px;color:#4b5563;margin-bottom:10px;">Detected: <b>${escHtml(categoryText)}</b></div>
      ${stepUpAutoSendHint}
      ${injectionHtml}
      ${proxyHtml}
      ${verifyHtml}
      <div style="display:grid;gap:10px;margin-bottom:10px;">
        <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:10px;">
          <div style="font-size:12px;font-weight:600;margin-bottom:6px;">Redaction summary</div>
          <div style="font-size:12px;color:#334155">${escHtml(redactionSummary || "No redactions.")}</div>
        </div>
        <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:10px;">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px;">
            <div style="font-size:12px;font-weight:700;">Redacted preview</div>
            <button id="pf-toggle-preview" ${step ? "disabled" : ""} style="border:1px solid #cbd5e1;background:#fff;border-radius:999px;padding:4px 10px;cursor:pointer;font-weight:700;font-size:11px;color:#0f172a;${step ? "opacity:0.6;cursor:not-allowed;" : ""}">${step ? "Locked" : "Expand"}</button>
          </div>
          <pre id="pf-preview" style="margin:0;white-space:pre-wrap;word-break:break-word;font:12px/1.35 ui-monospace,monospace;color:#0f172a;min-height:160px;max-height:420px;overflow:auto;">${escHtml(
            previewTextInitial
          )}</pre>
        </div>
      </div>
      <div id="pf-override-zone" style="display:none;margin-bottom:10px;border:1px solid #f59e0b;background:#fffbeb;border-radius:12px;padding:10px;">
        <div style="font-weight:600;font-size:12px;color:#92400e;margin-bottom:6px;">Step-up required</div>
        <div style="font-size:12px;color:#78350f;margin-bottom:8px;">Hold confirm for ${
          Math.round(holdMs / 100) / 10
        }s to send original.</div>
        <div style="height:8px;border-radius:999px;background:#fde68a;overflow:hidden;margin-bottom:8px;">
          <div id="pf-hold-progress" style="width:0%;height:100%;background:#f59e0b;transition:width 0.05s linear;"></div>
        </div>
        <button id="pf-hold-btn" style="padding:8px 10px;border:0;border-radius:10px;background:#92400e;color:#fff;font-weight:600;cursor:pointer;">Hold to confirm override</button>
      </div>
      ${footerButtonsHtml}
    `;

    overlay.appendChild(card);
    document.body.appendChild(overlay);

    if (step) {
      void appendResolution({
        action: "STEP_UP_ATTEMPT",
        risk: analysis?.risk || 0,
        categories: Array.isArray(analysis?.categories) ? analysis.categories : [],
        counts: analysis?.counts || {},
        reasonCodes: stepUpCodes,
        stepUpLevel: stepUpLevel || undefined,
        stepUpChallengeType: stepUpType || undefined,
        stepUpAttempted: true,
        automation: analysis?.automation || undefined,
        note: `Step-up challenge shown (${viewMode.toLowerCase()}).`,
      });
    }

    const cleanup = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (verifyTimer) {
        clearInterval(verifyTimer);
        verifyTimer = null;
      }
      if (sliderHoldTimer) {
        clearTimeout(sliderHoldTimer);
        sliderHoldTimer = null;
      }
      window.removeEventListener("keydown", onEsc, true);
      overlay.remove();
    };
    const done = (choice) => {
      if (step && !verified && !stepUpOutcomeLogged) {
        const skipped = ["SEND_REDACTED", "SEND_SAFE_SUBSTITUTED", "SEND_REWRITE"].includes(String(choice || ""));
        stepUpOutcomeLogged = true;
        void appendResolution({
          action: skipped ? "STEP_UP_SKIPPED" : "STEP_UP_ABORTED",
          risk: analysis?.risk || 0,
          categories: Array.isArray(analysis?.categories) ? analysis.categories : [],
          counts: analysis?.counts || {},
          reasonCodes: stepUpCodes,
          stepUpLevel: stepUpLevel || undefined,
          stepUpChallengeType: stepUpType || undefined,
          stepUpSuccess: false,
          automation: analysis?.automation || undefined,
          note: skipped ? "User chose safe path without completing step-up." : "Step-up challenge not completed.",
        });
      }
      cleanup();
      resolve(choice);
    };
    const onEsc = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        done("CANCEL");
      }
    };

    window.addEventListener("keydown", onEsc, true);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) done("CANCEL");
    });
    card.querySelector("#pf-cancel")?.addEventListener("click", () => done("CANCEL"));
    card.querySelector("#pf-send-redacted")?.addEventListener("click", () => done("SEND_REDACTED"));
    card.querySelector("#pf-send-safe-sub")?.addEventListener("click", () => done("SEND_SAFE_SUBSTITUTED"));
    card.querySelector("#pf-send-rewrite")?.addEventListener("click", () => done("SEND_REWRITE"));

    // Redacted preview expand/collapse.
    const preview = card.querySelector("#pf-preview");
    const togglePreview = card.querySelector("#pf-toggle-preview");
    if (preview && togglePreview) {
      let expanded = false;
      togglePreview.addEventListener("click", () => {
        if (step && !verified) return;
        expanded = !expanded;
        preview.style.maxHeight = expanded ? "72vh" : "420px";
        preview.style.minHeight = expanded ? "260px" : "120px";
        togglePreview.textContent = expanded ? "Collapse" : "Expand";
      });
    }

    const overrideBtn = card.querySelector("#pf-request-override");
    const zone = card.querySelector("#pf-override-zone");
    const holdBtn = card.querySelector("#pf-hold-btn");
    const progress = card.querySelector("#pf-hold-progress");

    const safeSendBtns = [
      card.querySelector("#pf-send-redacted"),
      card.querySelector("#pf-send-safe-sub"),
      card.querySelector("#pf-send-rewrite"),
    ].filter(Boolean);

    const sendBtns = [
      ...safeSendBtns,
      overrideBtn,
    ].filter(Boolean);

    if (requireVerifyBeforeSafeSend) {
      for (const b of sendBtns) {
        b.disabled = true;
        b.style.opacity = "0.55";
        b.style.cursor = "not-allowed";
      }
    }

    const setStatusText = (text) => {
      const status = card.querySelector("#pf-verify-status");
      if (status) status.textContent = String(text || "");
    };

    const setVerified = () => {
      verified = true;
      setStatusText(viewMode === "STEP_UP" ? "Verified ✓" : "Unlocked ✓");
      // Unlock preview content after verification.
      if (preview) preview.textContent = previewTextFull;
      if (togglePreview) {
        togglePreview.disabled = false;
        togglePreview.style.opacity = "";
        togglePreview.style.cursor = "";
        if (String(togglePreview.textContent || "").trim().toLowerCase() === "locked") togglePreview.textContent = "Expand";
      }
      for (const b of sendBtns) {
        b.disabled = false;
        b.style.opacity = "";
        b.style.cursor = "";
      }
      const v = card.querySelector("#pf-verify-zone");
      if (viewMode === "STEP_UP") {
        if (!stepUpOutcomeLogged) {
          stepUpOutcomeLogged = true;
          void appendResolution({
            action: "STEP_UP_SUCCESS",
            risk: analysis?.risk || 0,
            categories: Array.isArray(analysis?.categories) ? analysis.categories : [],
            counts: analysis?.counts || {},
            reasonCodes: stepUpCodes,
            stepUpLevel: stepUpLevel || undefined,
            stepUpChallengeType: stepUpType || undefined,
            stepUpSuccess: true,
            automation: analysis?.automation || undefined,
            note: "Step-up verification completed.",
          });
        }
        done("STEP_UP_VERIFIED");
        return;
      }
      if (v) v.style.display = "none";
      if (!stepUpOutcomeLogged) {
        stepUpOutcomeLogged = true;
        void appendResolution({
          action: "STEP_UP_SUCCESS",
          risk: analysis?.risk || 0,
          categories: Array.isArray(analysis?.categories) ? analysis.categories : [],
          counts: analysis?.counts || {},
          reasonCodes: stepUpCodes,
          stepUpLevel: stepUpLevel || undefined,
          stepUpChallengeType: stepUpType || undefined,
          stepUpSuccess: true,
          automation: analysis?.automation || undefined,
          note: "Step-up verification completed.",
        });
      }
    };

    // Step-up verification handlers
    if (step) {
      if (challenge?.type === "OTP") {
        const input = card.querySelector("#pf-otp-input");
        if (input) {
          input.addEventListener("input", () => {
            const v = String(input.value || "").replace(/\s+/g, "");
            const ttlMs = Number(challenge.payload?.ttlMs || 60000);
            const issuedAtMs = Number(challenge.payload?.issuedAtMs || Date.now());
            if (Date.now() - issuedAtMs > ttlMs) {
              setStatusText("Code expired");
              return;
            }
            const expected = String(challenge.payload?.code || "");
            if (v.length >= Math.max(1, expected.length)) {
              if (v === expected) setVerified();
              else setStatusText("Incorrect code");
            }
          });
        }
      } else if (challenge?.type === "SLIDER") {
        const slider = card.querySelector("#pf-slider-input");
        const sliderValue = card.querySelector("#pf-slider-value");
        const verifyBtn = card.querySelector("#pf-slider-verify");
        const target = Number(challenge.payload?.target ?? 100);
        const mustHoldMs = Number(challenge.payload?.mustHoldMs ?? 250);
        let sliderReady = false;

        const resetSliderReady = (message = "") => {
          sliderReady = false;
          if (sliderHoldTimer) {
            clearTimeout(sliderHoldTimer);
            sliderHoldTimer = null;
          }
          if (verifyBtn) {
            verifyBtn.disabled = true;
            verifyBtn.style.opacity = "0.55";
            verifyBtn.style.cursor = "not-allowed";
          }
          if (message) setStatusText(message);
        };

        const maybeStartSliderHold = (value) => {
          if (value < target) {
            resetSliderReady("");
            return;
          }
          if (sliderReady || sliderHoldTimer) return;
          setStatusText("Hold at target...");
          sliderHoldTimer = setTimeout(() => {
            sliderHoldTimer = null;
            sliderReady = true;
            if (verifyBtn) {
              verifyBtn.disabled = false;
              verifyBtn.style.opacity = "";
              verifyBtn.style.cursor = "";
            }
            setStatusText("Ready to verify");
          }, mustHoldMs);
        };

        if (slider) {
          slider.addEventListener("input", () => {
            const value = Number(slider.value || 0);
            if (sliderValue) sliderValue.textContent = String(Math.round(value));
            if (value >= target) maybeStartSliderHold(value);
            else resetSliderReady("");
          });
          slider.addEventListener("change", () => {
            const value = Number(slider.value || 0);
            if (value < target) resetSliderReady("");
          });
        }
        if (verifyBtn) {
          verifyBtn.addEventListener("click", () => {
            if (!sliderReady) {
              setStatusText("Slide to target and hold briefly");
              return;
            }
            setVerified();
          });
        }
      } else if (challenge?.type === "RETYPE") {
        const input = card.querySelector("#pf-retype-input");
        if (input) {
          input.addEventListener("input", () => {
            const ttlMs = Number(challenge.payload?.ttlMs || 60000);
            const issuedAtMs = Number(challenge.payload?.issuedAtMs || Date.now());
            if (Date.now() - issuedAtMs > ttlMs) {
              setStatusText("Phrase expired");
              return;
            }
            const expected = String(challenge.payload?.phrase || "");
            const v = String(input.value || "").trim().toUpperCase();
            if (v.length >= Math.max(1, expected.length)) {
              if (v === expected.toUpperCase()) setVerified();
              else setStatusText("Incorrect phrase");
            }
          });
        }
      } else {
        const vHoldBtn = card.querySelector("#pf-verify-hold-btn");
        const vProgress = card.querySelector("#pf-verify-hold-progress");

        const resetVerifyHold = () => {
          if (verifyTimer) {
            clearInterval(verifyTimer);
            verifyTimer = null;
          }
          verifyStart = 0;
          if (vProgress) vProgress.style.width = "0%";
        };
        const startVerifyHold = () => {
          if (!vHoldBtn || !vProgress) return;
          resetVerifyHold();
          verifyStart = Date.now();
          const unlockMs = Number(challenge?.payload?.durationMs || (step.level === 2 ? 1800 : 1200));
          verifyTimer = setInterval(() => {
            const pct = Math.min(1, (Date.now() - verifyStart) / unlockMs);
            vProgress.style.width = `${Math.round(pct * 100)}%`;
            if (pct >= 1) {
              resetVerifyHold();
              setVerified();
            }
          }, 24);
        };

        if (vHoldBtn) {
          vHoldBtn.addEventListener("mousedown", startVerifyHold);
          vHoldBtn.addEventListener("touchstart", startVerifyHold, { passive: true });
          vHoldBtn.addEventListener("mouseup", resetVerifyHold);
          vHoldBtn.addEventListener("mouseleave", resetVerifyHold);
          vHoldBtn.addEventListener("touchend", resetVerifyHold);
          vHoldBtn.addEventListener("touchcancel", resetVerifyHold);
        }
      }
    }

    const resetHold = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      start = 0;
      if (progress) progress.style.width = "0%";
    };
    const startHold = () => {
      if (!holdBtn || !progress) return;
      resetHold();
      start = Date.now();
      timer = setInterval(() => {
        const pct = Math.min(1, (Date.now() - start) / holdMs);
        progress.style.width = `${Math.round(pct * 100)}%`;
        if (pct >= 1) {
          resetHold();
          done("OVERRIDE_ORIGINAL");
        }
      }, 24);
    };

    if (overrideBtn && zone) {
      overrideBtn.addEventListener("click", () => {
        if (step && !verified) return;
        zone.style.display = "block";
      });
    }
    if (holdBtn) {
      holdBtn.addEventListener("mousedown", startHold);
      holdBtn.addEventListener("touchstart", startHold, { passive: true });
      holdBtn.addEventListener("mouseup", resetHold);
      holdBtn.addEventListener("mouseleave", resetHold);
      holdBtn.addEventListener("touchend", resetHold);
      holdBtn.addEventListener("touchcancel", resetHold);
    }
  });
}

function countVisibleChars(text) {
  const s = String(text || "");
  try {
    // Grapheme clusters = closest to "what users see as characters".
    // Supported in modern Chromium.
    const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    let n = 0;
    for (const _part of seg.segment(s)) n++;
    return n;
  } catch {
    // Fallback: code points (better than UTF-16 .length for emojis).
    return Array.from(s).length;
  }
}

// ─────────────────────────────────────────────
//  DOM helpers
// ─────────────────────────────────────────────
function mk(tag, styles) {
  const el = document.createElement(tag);
  el.style.cssText = Array.isArray(styles) ? styles.join(";") : styles;
  return el;
}

function getEditableFromTarget(target) {
  if (!(target instanceof Element)) return null;
  if (isEditable(target)) return target;
  return target.closest(EDITABLE_SELECTOR);
}

function isEditable(el) {
  if (!(el instanceof Element)) return false;
  if (el.matches("textarea")) return !el.hasAttribute("disabled") && !el.hasAttribute("readonly");
  if (!el.hasAttribute("contenteditable")) return false;
  return (el.getAttribute("contenteditable") || "").toLowerCase() !== "false";
}

function isLikelyChatInput(el) {
  if (!isEditable(el)) return false;
  const host = location.hostname.toLowerCase();
  if (CHAT_HOST_HINTS.some((h) => host === h || host.endsWith(`.${h}`))) return true;
  const attrs = [el.id, el.getAttribute("name"), el.getAttribute("aria-label"), el.getAttribute("placeholder")]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (CHAT_INPUT_HINTS.some((h) => attrs.includes(h))) return true;
  const nearby = (el.closest("form, section, main, div")?.textContent || "").slice(0, 500).toLowerCase();
  return CHAT_INPUT_HINTS.some((h) => nearby.includes(h));
}

function getText(el) {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) return el.value || "";
  return (el.innerText || el.textContent || "").replace(/\u00a0/g, " ");
}

function setText(el, text) {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    el.value = text;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }
  el.textContent = text;
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function getSendButton(target) {
  if (!(target instanceof Element)) return null;
  const btn = target.closest('button, [role="button"], input[type="submit"]');
  if (!btn || !looksLikeSend(btn)) return null;
  return btn;
}

function getHostHeuristicSendButton(target) {
  if (!isKnownChatHost()) return null;
  if (!(target instanceof Element)) return null;
  const btn = target.closest('button, [role="button"], input[type="submit"]');
  if (!btn || !isUsableButtonLike(btn) || looksLikeNonSendAction(btn)) return null;

  const editable = locateBestEditable(btn);
  if (!editable || !isLikelyChatInput(editable)) return null;
  const text = getText(editable);
  if (!text.trim()) return null;

  const form = btn.closest("form");
  if (form && form.contains(editable)) return btn;

  const container = btn.closest("section, main, article, div");
  if (container && container.contains(editable)) return btn;

  return null;
}

function looksLikeSend(btn) {
  if (btn.matches('[data-testid="send-button"]')) return true;
  if (btn.matches('[data-testid*="send" i], [aria-label*="send message" i]')) return true;
  const text = [
    btn.getAttribute("aria-label"),
    btn.getAttribute("title"),
    btn.textContent,
    btn.getAttribute("data-testid"),
    btn.getAttribute("name"),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return /(send|submit|run|ask|arrow up|paper airplane|upward)/.test(text);
}

function looksLikeNonSendAction(btn) {
  const text = [
    btn.getAttribute("aria-label"),
    btn.getAttribute("title"),
    btn.textContent,
    btn.getAttribute("data-testid"),
    btn.getAttribute("name"),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return /(attach|upload|image|voice|mic|microphone|menu|history|model|tools?|plus|add file)/.test(text);
}

function isUsableButtonLike(btn) {
  if (!(btn instanceof HTMLElement)) return false;
  if ((btn instanceof HTMLButtonElement || btn instanceof HTMLInputElement) && btn.disabled) return false;
  if (btn.getAttribute("aria-disabled") === "true") return false;
  const r = btn.getBoundingClientRect();
  if (r.width < 6 || r.height < 6) return false;
  const s = getComputedStyle(btn);
  return s.visibility !== "hidden" && s.display !== "none" && s.pointerEvents !== "none";
}

function locateBestEditable(anchor) {
  if (PF_STATE.lastFocusedEditable && document.contains(PF_STATE.lastFocusedEditable)) return PF_STATE.lastFocusedEditable;
  if (anchor instanceof Element) {
    const form = anchor.closest("form");
    if (form) {
      const el = form.querySelector(EDITABLE_SELECTOR);
      if (el) return el;
    }
    const container = anchor.closest("section, main, article, div");
    if (container) {
      const el = container.querySelector(EDITABLE_SELECTOR);
      if (el) return el;
    }
  }
  return document.querySelector(EDITABLE_SELECTOR);
}

function insertAtCursor(el, text) {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) {
    const s = el.selectionStart ?? el.value.length;
    const e = el.selectionEnd ?? el.value.length;
    el.value = el.value.slice(0, s) + text + el.value.slice(e);
    el.selectionStart = el.selectionEnd = s + text.length;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }
  el.focus();
  if (!document.execCommand("insertText", false, text)) setText(el, getText(el) + text);
}

async function executeSend(editable, text, triggerMeta) {
  setText(editable, text);
  await new Promise((r) => setTimeout(r, 16));
  PF_STATE.bypassUntil = Date.now() + 700;

  if (triggerMeta.type === "button" && triggerMeta.button?.isConnected) {
    triggerMeta.button.click();
    return;
  }
  if (triggerMeta.type === "form" && triggerMeta.form?.isConnected) {
    triggerMeta.form.requestSubmit();
    return;
  }
  if (clickKnownSend()) return;

  for (const type of ["keydown", "keyup"]) {
    editable.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
  }
  const form = editable.closest("form");
  if (form) form.requestSubmit();
}

function clickKnownSend() {
  const selectors = [
    'button[data-testid="send-button"]',
    'button[aria-label*="Send" i]',
    'button[aria-label*="Submit" i]',
    'button[title*="Send" i]',
    'button[aria-label*="Run" i]',
    'button[type="submit"]',
  ];
  for (const sel of selectors) {
    const candidates = Array.from(document.querySelectorAll(sel));
    const target = candidates.find((el) => {
      return isUsableButtonLike(el);
    });
    if (target) {
      target.click();
      return true;
    }
  }
  return false;
}

// ─────────────────────────────────────────────
//  Messaging / utils
// ─────────────────────────────────────────────
function sendMsg(msg) {
  return new Promise((resolve) => {
    try {
      if (!chrome?.runtime?.id) {
        markRuntimeInvalidated("Extension context invalidated.");
        resolve({ ok: false, error: "Extension context invalidated." });
        return;
      }
      chrome.runtime.sendMessage(msg, (resp) => {
        try {
          const errMsg = chrome.runtime.lastError?.message || "";
          if (errMsg) {
            if (/extension context invalidated/i.test(errMsg)) markRuntimeInvalidated(errMsg);
            resolve({ ok: false, error: errMsg });
            return;
          }
          resolve(resp || { ok: false, error: "No response." });
        } catch (err) {
          const msgText = err instanceof Error ? err.message : "Extension context invalidated.";
          if (/extension context invalidated/i.test(msgText)) markRuntimeInvalidated(msgText);
          resolve({ ok: false, error: msgText });
        }
      });
    } catch (err) {
      const msgText = err instanceof Error ? err.message : "Extension context invalidated.";
      if (/extension context invalidated/i.test(msgText)) markRuntimeInvalidated(msgText);
      resolve({ ok: false, error: msgText });
    }
  });
}

function markRuntimeInvalidated(message) {
  PF_STATE.runtimeInvalidated = true;
  if (PF_STATE.runtimeInvalidatedNotified) return;
  PF_STATE.runtimeInvalidatedNotified = true;
  try {
    toast("Prompt Firewall updated. Refresh this tab to re-enable protection.", 4500);
  } catch {
    // no-op
  }
  try {
    console.warn("[Prompt Firewall]", message);
  } catch {
    // no-op
  }
}

async function appendResolution(payload) {
  await sendMsg({
    type: "LEDGER_APPEND",
    payload: { ...payload, domain: location.hostname, trigger: "content_resolution", eventType: "user_resolution" },
  });
}

function toast(message, durationMs = 2800) {
  const node = document.createElement("div");
  node.textContent = message;
  node.style.cssText = [
    "position:fixed",
    "right:16px",
    "bottom:16px",
    "z-index:2147483647",
    "padding:10px 14px",
    "border-radius:10px",
    "font:12px/1.3 system-ui,sans-serif",
    "background:#111827",
    "color:#f9fafb",
    "box-shadow:0 8px 20px rgba(0,0,0,0.3)",
    "opacity:0.98",
    "max-width:380px",
    "word-wrap:break-word",
  ].join(";");
  document.body.appendChild(node);
  setTimeout(() => node.remove(), durationMs);
}

function summarizeRedactions(redactions) {
  if (!Array.isArray(redactions) || redactions.length === 0) return "";
  const counts = {};
  for (const r of redactions) counts[r.category] = (counts[r.category] || 0) + 1;
  return Object.entries(counts)
    .map(([k, v]) => `${k}: ${v}`)
    .join(" • ");
}

// ─────────────────────────────────────────────
//  Invisible CAPTCHA (behavioral micro-challenge)
// ─────────────────────────────────────────────
function pruneWindow(timestamps, windowMs) {
  const now = Date.now();
  return (Array.isArray(timestamps) ? timestamps : []).filter((t) => Number.isFinite(t) && now - t <= windowMs);
}

function fnv1a32(str) {
  let h = 0x811c9dc5;
  const s = String(str || "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function generateCaptchaCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  let x = buf[0] >>> 0;
  let out = "";
  for (let i = 0; i < 4; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out += alphabet[(x >>> 0) % alphabet.length];
  }
  return out;
}

async function maybeRequireHumanVerification(text) {
  const now = Date.now();

  PF_STATE.sendBurst = pruneWindow([...PF_STATE.sendBurst, now], 2500);
  const h = String(fnv1a32(String(text || "").trim().slice(0, 2500)));
  if (h === PF_STATE.lastSendHash && now - PF_STATE.lastSendAt < 1500) PF_STATE.repeatSendCount++;
  else PF_STATE.repeatSendCount = 0;
  PF_STATE.lastSendHash = h;
  PF_STATE.lastSendAt = now;

  if (now < PF_STATE.humanVerifiedUntil) return true;

  const repeats = PF_STATE.repeatSendCount >= 3;
  // Burst / paste-to-send verification now runs in background as STEP_UP L1.
  const suspicious = repeats;
  if (!suspicious) return true;

  const reason = repeats ? "repeated prompt pattern" : "behavioral signal";

  const ok = await showMicroChallengeModal({ reason });
  if (ok) {
    PF_STATE.humanVerifiedUntil = Date.now() + 60_000;
    toast("Human verification passed.");
    await appendResolution({
      action: "CAPTCHA_PASSED",
      risk: 0,
      categories: [],
      counts: {},
      note: `Invisible CAPTCHA passed (${reason}).`,
    });
  }
  return ok;
}

function showMicroChallengeModal({ reason }) {
  return new Promise((resolve) => {
    let timer = null;
    let start = 0;
    const code = generateCaptchaCode();

    const overlay = mk("div", [
      "position:fixed",
      "inset:0",
      "z-index:2147483647",
      "background:rgba(15,23,42,0.65)",
      "display:flex",
      "align-items:center",
      "justify-content:center",
      "padding:20px",
    ]);

    const card = mk("div", [
      "width:min(520px,96vw)",
      "background:#ffffff",
      "color:#111827",
      "border-radius:16px",
      "padding:16px",
      "box-shadow:0 20px 48px rgba(15,23,42,0.35)",
      "font:13px/1.45 system-ui,sans-serif",
    ]);

    card.innerHTML = `
      <div style="font-weight:800;font-size:14px;margin-bottom:6px;">Human verification</div>
      <div style="font-size:12px;color:#475569;margin-bottom:10px;">Triggered by: <b>${escHtml(reason || "behavior")}</b></div>
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:10px;margin-bottom:10px;">
        <div style="font-size:12px;font-weight:700;margin-bottom:6px;">Micro-challenge</div>
        <div style="font-size:12px;color:#334155;margin-bottom:8px;">Hold for <b>1.5s</b> or type this code:</div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
          <div style="flex:1;min-width:220px;">
            <div style="height:8px;border-radius:999px;background:#e2e8f0;overflow:hidden;margin-bottom:8px;">
              <div id="pf-mc-progress" style="width:0%;height:100%;background:#111827;transition:width 0.05s linear;"></div>
      </div>
            <button id="pf-mc-hold" style="padding:8px 10px;border:0;border-radius:10px;background:#111827;color:#fff;font-weight:700;cursor:pointer;">Hold to verify</button>
        </div>
          <span style="font-family:ui-monospace,monospace;font-weight:900;background:#e2e8f0;color:#111827;padding:6px 10px;border-radius:10px;letter-spacing:0.08em;">${escHtml(
            code
          )}</span>
          <input id="pf-mc-input" placeholder="Type code" style="padding:8px 10px;border:1px solid #cbd5e1;border-radius:10px;min-width:160px;"/>
        </div>
        <div id="pf-mc-status" style="margin-top:8px;font-size:12px;color:#475569;"></div>
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button id="pf-mc-cancel" style="padding:8px 10px;border:1px solid #cbd5e1;background:#fff;border-radius:10px;cursor:pointer;">Cancel</button>
      </div>
    `;

    overlay.appendChild(card);
    document.body.appendChild(overlay);

    const cleanup = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      window.removeEventListener("keydown", onEsc, true);
      overlay.remove();
    };

    const done = (ok) => {
      cleanup();
      resolve(Boolean(ok));
    };

    const onEsc = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        done(false);
      }
    };

    window.addEventListener("keydown", onEsc, true);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) done(false);
    });
    card.querySelector("#pf-mc-cancel")?.addEventListener("click", () => done(false));

    const progress = card.querySelector("#pf-mc-progress");
    const holdBtn = card.querySelector("#pf-mc-hold");
    const input = card.querySelector("#pf-mc-input");
    const status = card.querySelector("#pf-mc-status");

    const resetHold = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      start = 0;
      if (progress) progress.style.width = "0%";
    };
    const startHold = () => {
      if (!holdBtn || !progress) return;
      resetHold();
      start = Date.now();
      const holdMs = 1500;
      timer = setInterval(() => {
        const pct = Math.min(1, (Date.now() - start) / holdMs);
        progress.style.width = `${Math.round(pct * 100)}%`;
        if (pct >= 1) {
          resetHold();
          done(true);
        }
      }, 24);
    };

    if (holdBtn) {
      holdBtn.addEventListener("mousedown", startHold);
      holdBtn.addEventListener("touchstart", startHold, { passive: true });
      holdBtn.addEventListener("mouseup", resetHold);
      holdBtn.addEventListener("mouseleave", resetHold);
      holdBtn.addEventListener("touchend", resetHold);
      holdBtn.addEventListener("touchcancel", resetHold);
    }

    if (input) {
      input.addEventListener("input", () => {
        const v = String(input.value || "").trim().toUpperCase();
        if (v.length >= 4) {
          if (v === code) done(true);
          else if (status) status.textContent = "Incorrect code";
        }
      });
    }
  });
}

// ─────────────────────────────────────────────
//  Safe substitution (format-preserving redaction)
// ─────────────────────────────────────────────
function seededChars(seed, alphabet, len) {
  let x = (seed >>> 0) || 1;
  let out = "";
  const a = String(alphabet || "abcdefghijklmnopqrstuvwxyz0123456789");
  for (let i = 0; i < len; i++) {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    out += a[(x >>> 0) % a.length];
  }
  return out;
}

function generateOtpCode() {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  const n = (buf[0] >>> 0) % 1_000_000;
  return String(n).padStart(6, "0");
}

function buildSafeSubstitutedText(originalText, redactions) {
  const list = Array.isArray(redactions) ? [...redactions] : [];
  if (list.length === 0) return String(originalText || "");
  list.sort((a, b) => (a.start || 0) - (b.start || 0));

  const text = String(originalText || "");
  let cursor = 0;
  let out = "";

  for (const r of list) {
    const start = Number.isFinite(r.start) ? r.start : -1;
    const end = Number.isFinite(r.end) ? r.end : -1;
    if (start < 0 || end <= start || start > text.length) continue;
    out += text.slice(cursor, start);
    const raw = text.slice(start, Math.min(end, text.length));
    out += getSafeSubstitution(String(r.category || "UNKNOWN"), raw);
    cursor = Math.min(end, text.length);
  }
  out += text.slice(cursor);
  return out;
}

function getSafeSubstitution(category, raw) {
  const cat = String(category || "UNKNOWN").toUpperCase();
  const seed = fnv1a32(raw);
  const key = `${cat}:${seed}`;
  if (PF_STATE.substitutionCache.has(key)) return PF_STATE.substitutionCache.get(key);

  PF_STATE.substitutionSerial[cat] = (PF_STATE.substitutionSerial[cat] || 0) + 1;
  const idx = PF_STATE.substitutionSerial[cat];
  const value = generateFakeForCategory(cat, raw, idx, seed);
  PF_STATE.substitutionCache.set(key, value);
  return value;
}

function generateFakeForCategory(category, raw, idx, seed) {
  const s = String(raw || "");

  if (category === "EMAIL") {
    const at = s.indexOf("@");
    const tld = at >= 0 ? (s.slice(at + 1).split(".").pop() || "com") : "com";
    return `user_${idx}@company.${tld.replace(/[^a-z]/gi, "") || "com"}`.toLowerCase();
  }

  if (category === "PHONE") {
    const digits = s.replace(/\D/g, "");
    const want = Math.max(10, Math.min(15, digits.length || 10));
    const tail = String(1000 + (idx % 9000)).padStart(4, "0");
    const replacementDigits = (`555000${tail}` + seededChars(seed ^ idx, "0123456789", want)).slice(0, want);
    let j = 0;
    return s.replace(/\d/g, () => replacementDigits[j++] ?? "0");
  }

  if (category === "SSN") {
    return `123-45-${String(6700 + (idx % 999)).padStart(4, "0")}`;
  }

  if (category === "FINANCIAL") {
    const digits = s.replace(/\D/g, "");
    const len = Math.max(13, Math.min(19, digits.length || 16));
    const card = generateLuhnNumber(len, seed ^ (idx * 97));
    return applyDigitMask(s, card);
  }

  if (category === "IP_ADDRESS") {
    return `192.0.2.${(idx % 250) + 1}`;
  }

  if (category === "PASSPORT") {
    const letters = (s.match(/^[A-Z]{1,2}/) || ["P"])[0];
    const digitsLen = Math.max(6, Math.min(9, s.replace(/[^0-9]/g, "").length || 7));
    const digits = seededChars(seed ^ idx, "0123456789", digitsLen);
    return `${letters}${digits}`;
  }

  if (category === "DATE_OF_BIRTH") {
    // Preserve delimiter style if possible.
    const delim = s.includes("-") ? "-" : "/";
    return `DOB: 01${delim}01${delim}1990`;
  }

  if (category === "ADDRESS") {
    return `123 Example St`;
  }

  if (category === "JWT") {
    const parts = s.split(".");
    if (parts.length === 3) {
      const a = seededChars(seed ^ 1, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_", Math.max(10, parts[0].length));
      const b = seededChars(seed ^ 2, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_", Math.max(10, parts[1].length));
      const c = seededChars(seed ^ 3, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_", Math.max(16, parts[2].length));
      // Keep typical JWT header prefix to preserve shape.
      const header = a.startsWith("eyJ") ? a : `eyJ${a.slice(3)}`;
      return `${header}.${b}.${c}`;
    }
    const header = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
    const payload = seededChars(seed ^ idx, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_", 48);
    const sig = seededChars(seed ^ (idx * 13), "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_", 43);
    return `${header}.${payload}.${sig}`;
  }

  if (category === "PRIVATE_KEY") {
    const lines = s.split(/\r?\n/);
    const beginIdx = lines.findIndex((l) => /-----BEGIN .*PRIVATE KEY-----/.test(l));
    const endIdx = lines.findIndex((l) => /-----END .*PRIVATE KEY-----/.test(l));
    const begin = beginIdx >= 0 ? lines[beginIdx] : "-----BEGIN PRIVATE KEY-----";
    const end = endIdx >= 0 ? lines[endIdx] : "-----END PRIVATE KEY-----";
    const bodyLines = Math.max(6, Math.min(18, endIdx > beginIdx ? endIdx - beginIdx - 1 : 10));
    const body = Array.from({ length: bodyLines }, (_v, i) =>
      seededChars(seed ^ (idx * 31) ^ i, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/", 64)
    );
    return [begin, ...body, end].join("\n");
  }

  if (category === "SECRET") {
    if (/^AKIA[0-9A-Z]{16}$/.test(s)) {
      return `AKIA${seededChars(seed ^ idx, "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ", 16)}`;
    }
    if (/^AIza[0-9A-Za-z\-_]{35}$/.test(s)) {
      return `AIza${seededChars(seed ^ idx, "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_", 35)}`;
    }
    if (/^(sk|rk)_(live|test)_[A-Za-z0-9]{16,}$/.test(s)) {
      const prefix = s.split("_").slice(0, 3).join("_");
      const restLen = Math.max(16, s.length - (prefix.length + 1));
      return `${prefix}_${seededChars(seed ^ idx, "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz", restLen)}`;
    }
    // Generic token: preserve length + rough prefix/suffix.
    if (s.length >= 12) {
      const head = s.slice(0, 4);
      const tail = s.slice(-4);
      const mid = seededChars(seed ^ idx, "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_", Math.max(0, s.length - 8));
      return `${head}${mid}${tail}`;
    }
    return `SAFE_SECRET_${idx}`;
  }

  // Fallback: preserve length-ish for unknown categories
  if (s.length >= 6) {
    return seededChars(seed ^ idx, "abcdefghijklmnopqrstuvwxyz0123456789", s.length);
  }
  return `safe_${category.toLowerCase()}_${idx}`;
}

function applyDigitMask(template, digits) {
  const src = String(digits || "").replace(/\D/g, "");
  let j = 0;
  const t = String(template || "");
  if (!t) return src;
  return t.replace(/\d/g, () => src[j++] ?? "0");
}

function generateLuhnNumber(len, seed) {
  const n = Math.max(13, Math.min(19, Number(len) || 16));
  const bodyLen = n - 1;
  const body = seededChars(seed, "0123456789", bodyLen);
  const check = luhnCheckDigit(body);
  return `${body}${check}`;
}

function luhnCheckDigit(bodyDigits) {
  const s = String(bodyDigits || "").replace(/\D/g, "");
  let sum = 0;
  let alternate = true; // because check digit is appended
  for (let i = s.length - 1; i >= 0; i--) {
    let n = s.charCodeAt(i) - 48;
    if (n < 0 || n > 9) n = 0;
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }
  return (10 - (sum % 10)) % 10;
}

function escHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#039;";
    }
  });
}
