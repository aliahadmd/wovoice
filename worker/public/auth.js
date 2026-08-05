const params = new URLSearchParams(location.search);
const challenge = params.get("code_challenge") || "";
const state = params.get("state") || "";
const intent = params.get("intent") === "delete" ? "delete" : "login";
const valid = /^[A-Za-z0-9_-]{43,128}$/.test(challenge) && /^[A-Za-z0-9_-]{20,160}$/.test(state);

let turnstileToken = "";
let challengeId = "";
let widgetId = null;
let resolveTurnstile;
let turnstileLoaded = false;

const turnstileReady = new Promise((resolve) => {
  resolveTurnstile = resolve;
});

// This callback name is declared in the Cloudflare Turnstile script URL.
// Defining it before that deferred script runs avoids polling and load-order races.
window.onTurnstileLoad = () => {
  turnstileLoaded = true;
  resolveTurnstile();
};

const waitForTurnstile = async () => {
  if (turnstileLoaded) return;
  let timeoutId;
  try {
    await Promise.race([
      turnstileReady,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error("The security check took too long to load.")), 15_000);
      }),
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
};

const emailStep = document.querySelector("#email-step");
const codeStep = document.querySelector("#code-step");
const invalidStep = document.querySelector("#invalid-step");
const serviceErrorStep = document.querySelector("#service-error-step");
const emailForm = document.querySelector("#email-form");
const codeForm = document.querySelector("#code-form");
const sendButton = document.querySelector("#send");

const setStatus = (id, message, error = false) => {
  const node = document.querySelector(id);
  if (!node) return;
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

const showServiceError = (error) => {
  console.error("WoVoice sign-in initialization failed", error);
  emailStep?.classList.add("hidden");
  codeStep?.classList.add("hidden");
  invalidStep?.classList.add("hidden");
  serviceErrorStep?.classList.remove("hidden");
};

async function boot() {
  if (!valid) {
    emailStep?.classList.add("hidden");
    invalidStep?.classList.remove("hidden");
    return;
  }

  if (intent === "delete") {
    document.querySelector("#auth-title").textContent = "Confirm account deletion";
    document.querySelector("#auth-intro").textContent =
      "Enter your verified email. We’ll send a fresh code before deleting your WoVoice account.";
    document.querySelector("#send").textContent = "Send deletion code";
    document.querySelector("#verify").textContent = "Verify and delete account";
    document.querySelector("#terms-row").classList.add("hidden");
    document.querySelector("#terms").required = false;
  }

  const configResponse = await fetch("/v1/auth/config", { headers: { Accept: "application/json" } });
  if (!configResponse.ok) throw new Error("WoVoice could not load its sign-in configuration.");
  const config = await configResponse.json();
  if (!config.turnstileSiteKey) throw new Error("WoVoice sign-in is not configured.");

  await waitForTurnstile();
  if (typeof window.turnstile?.render !== "function") {
    throw new Error("The security check did not initialize correctly.");
  }

  const widgetContainer = document.querySelector("#turnstile-widget");
  widgetId = window.turnstile.render("#turnstile-widget", {
    sitekey: config.turnstileSiteKey,
    theme: "dark",
    size: widgetContainer.clientWidth < 300 ? "compact" : "flexible",
    callback: (token) => {
      turnstileToken = token;
      sendButton.disabled = false;
      setStatus("#security-status", "Security check complete.");
    },
    "expired-callback": () => {
      turnstileToken = "";
      sendButton.disabled = true;
      setStatus("#security-status", "Security check expired. Complete it again.", true);
    },
    "error-callback": () => {
      turnstileToken = "";
      sendButton.disabled = true;
      setStatus("#security-status", "Security check failed. Check your connection and try again.", true);
    },
  });
}

emailForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!turnstileToken) {
    setStatus("#email-status", "Complete the security check.", true);
    return;
  }
  sendButton.disabled = true;
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
    if (widgetId !== null && typeof window.turnstile?.reset === "function") {
      window.turnstile.reset(widgetId);
    }
  } finally {
    if (turnstileToken) sendButton.disabled = false;
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
    callback.searchParams.set(
      intent === "delete" ? "reauth_token" : "code",
      intent === "delete" ? result.reauthToken : result.authorizationCode,
    );
    callback.searchParams.set("state", state);
    location.replace(callback);
  } catch (error) {
    setStatus("#code-status", error.message, true);
    button.disabled = false;
  }
});

document.querySelector("#restart")?.addEventListener("click", () => location.reload());
document.querySelector("#retry-boot")?.addEventListener("click", () => location.reload());
boot().catch(showServiceError);
