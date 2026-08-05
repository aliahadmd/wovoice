import { describe, expect, it } from "vitest";
import authHtml from "../public/auth.html?raw";
import authScript from "../public/auth.js?raw";
import callbackHtml from "../public/app/callback.html?raw";
import callbackScript from "../public/app/callback.js?raw";

describe("passwordless sign-in assets", () => {
  it("loads WoVoice initialization before the explicit Turnstile callback", () => {
    const appScript = authHtml.indexOf('src="/auth.js"');
    const turnstileScript = authHtml.indexOf("challenges.cloudflare.com/turnstile");

    expect(appScript).toBeGreaterThan(-1);
    expect(turnstileScript).toBeGreaterThan(appScript);
    expect(authHtml).toContain("onload=onTurnstileLoad");
    expect(authScript).toContain("window.onTurnstileLoad");
  });

  it("does not shadow the Turnstile browser API with a named element", () => {
    expect(authHtml).toContain('id="turnstile-widget"');
    expect(authHtml).not.toContain('id="turnstile"');
    expect(authScript).toContain('render("#turnstile-widget"');
  });

  it("keeps invalid requests separate from service initialization failures", () => {
    expect(authHtml).toContain('id="invalid-step"');
    expect(authHtml).toContain('id="service-error-step"');
    expect(authScript).toContain("serviceErrorStep?.classList.remove");
  });

  it("offers a package-targeted callback when automatic App Link routing fails", () => {
    expect(callbackHtml).toContain('id="open-app"');
    expect(callbackHtml).toContain('src="/app/callback.js"');
    expect(callbackScript).toContain("intent://${location.host}");
    expect(callbackScript).toContain("package=${packageName}");
    expect(callbackScript).toContain('"com.aliahad.wovoice"');
  });
});
