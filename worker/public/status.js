fetch("/v1/status", { headers: { Accept: "application/json" }, cache: "no-store" })
  .then((response) => {
    if (!response.ok) throw new Error("offline");
    return response.json();
  })
  .then((value) => {
    document.querySelector("#service-status").textContent = value.status === "online"
      ? "All WoVoice systems are operational."
      : "WoVoice is currently unavailable.";
  })
  .catch(() => {
    document.querySelector("#service-status").textContent = "WoVoice is currently unavailable.";
  });
