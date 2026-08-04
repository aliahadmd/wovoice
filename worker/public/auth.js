const params = new URLSearchParams(location.search);
const challenge = params.get("code_challenge") || "";
const state = params.get("state") || "";
const intent = params.get("intent") === "delete" ? "delete" : "login";
const valid = /^[A-Za-z0-9_-]{43,128}$/.test(challenge) && /^[A-Za-z0-9_-]{20,160}$/.test(state);
let turnstileToken = "";
let challengeId = "";
let widgetId = null;

const emailStep = document.querySelector("#email-step");
const codeStep = document.querySelector("#code-step");
const invalidStep = document.querySelector("#invalid-step");
const emailForm = document.querySelector("#email-form");
const codeForm = document.querySelector("#code-form");
const setStatus = (id, message, error = false) => {
  const node = document.querySelector(id);
  node.textContent = message;
  node.classList.toggle("error", error);
};
const post = async (path, body) => {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
    credentials: "omit",
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value?.error?.message || "Something went wrong. Please try again.");
  return value;
};

async function boot() {
  if (!valid) {
    emailStep.classList.add("hidden");
    invalidStep.classList.remove("hidden");
    return;
  }
  if (intent === "delete") {
    document.querySelector("h1").textContent = "Confirm account deletion";
    document.querySelector("#email-step .lede").textContent =
      "Enter your verified email. We’ll send a fresh code before deleting your WoVoice account.";
    document.querySelector("#send").textContent = "Send deletion code";
  }
  const config = await fetch("/v1/auth/config", { headers: { Accept: "application/json" } }).then((r) => r.json());
  const render = () => {
    widgetId = turnstile.render("#turnstile", {
      sitekey: config.turnstileSiteKey,
      theme: "dark",
      callback: (token) => { turnstileToken = token; },
      "expired-callback": () => { turnstileToken = ""; },
    });
  };
  if (window.turnstile) render(); else setTimeout(render, 500);
}

emailForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!turnstileToken) {
    setStatus("#email-status", "Complete the security check.", true);
    return;
  }
  const button = document.querySelector("#send");
  button.disabled = true;
  setStatus("#email-status", "Sending a secure code…");
  try {
    const email = document.querySelector("#email").value.trim();
    const result = await post("/v1/auth/start", {
      email,
      turnstileToken,
      codeChallenge: challenge,
      intent,
      termsAccepted: intent === "login",
    });
    challengeId = result.challengeId;
    document.querySelector("#sent-to").textContent = `Enter the code sent to ${email}. It expires in 10 minutes.`;
    emailStep.classList.add("hidden");
    codeStep.classList.remove("hidden");
    document.querySelector("#code").focus();
  } catch (error) {
    setStatus("#email-status", error.message, true);
    turnstileToken = "";
    if (widgetId !== null) turnstile.reset(widgetId);
  } finally {
    button.disabled = false;
  }
});

codeForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = document.querySelector("#verify");
  button.disabled = true;
  setStatus("#code-status", "Verifying…");
  try {
    const result = await post("/v1/auth/verify", {
      challengeId,
      code: document.querySelector("#code").value.trim(),
    });
    const callback = new URL("/app/callback", location.origin);
    callback.searchParams.set(intent === "delete" ? "reauth_token" : "code",
      intent === "delete" ? result.reauthToken : result.authorizationCode);
    callback.searchParams.set("state", state);
    location.replace(callback);
  } catch (error) {
    setStatus("#code-status", error.message, true);
    button.disabled = false;
  }
});

document.querySelector("#restart")?.addEventListener("click", () => location.reload());
boot().catch(() => {
  emailStep.classList.add("hidden");
  invalidStep.classList.remove("hidden");
});
