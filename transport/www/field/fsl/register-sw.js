// /field/fsl/register-sw.js

const SW_URL = "/field/fsl/sw.js";
const SCOPE = "/field/fsl/";   // <-- no trailing slash


if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register(SW_URL, { scope: SCOPE })
      .then((reg) => {
        console.log("[FSL] SW registered with scope:", reg.scope);
      })
      .catch((err) => {
        console.error("[FSL] SW registration failed:", err);
      });
  });
} else {
  console.log("[FSL] serviceWorker not supported in this browser");
}
