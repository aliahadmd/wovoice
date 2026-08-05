const params = new URLSearchParams(location.search);
const code = params.get("code") || "";
const reauthToken = params.get("reauth_token") || "";
const state = params.get("state") || "";
const token = code || reauthToken;
const valid = /^[A-Za-z0-9_-]{20,160}$/u.test(state)
  && /^[A-Za-z0-9._~-]{20,256}$/u.test(token)
  && !(code && reauthToken);

const openApp = document.querySelector("#open-app");
if (valid) {
  const packageName = "com.aliahad.wovoice";
  openApp.href = `intent://${location.host}${location.pathname}${location.search}`
    + `#Intent;scheme=https;package=${packageName};end`;
} else {
  document.querySelector("#callback-title").textContent = "Start sign-in again";
  document.querySelector("#callback-message").textContent =
    "This secure sign-in response is missing or has expired.";
  document.querySelector("#callback-help").textContent =
    "Return to WoVoice and tap Sign in to request a new verification code.";
  openApp.classList.add("hidden");
}
