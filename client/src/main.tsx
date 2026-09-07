import { createRoot } from "react-dom/client";
import { App } from "./App";
import { installPillowfortAgent } from "./agent/bridge";
import { detectNativeWebMcp, installPillowfortWebMcp } from "./agent/webmcp";
import { captureRoomInvitation } from "./services/roomInvitation";
import "./styles/app.css";

captureRoomInvitation();

function syncVisualViewportVars() {
  const vv = window.visualViewport;
  const height = vv ? vv.height : window.innerHeight;
  const top = vv ? vv.offsetTop : 0;
  document.documentElement.style.setProperty("--vvh", `${height}px`);
  document.documentElement.style.setProperty("--vv-top", `${top}px`);
  document.documentElement.toggleAttribute("data-compact-room", window.innerWidth <= 600 && height <= 400);
}

// Visual viewport handler (virtual keyboard + iOS viewport offset)
syncVisualViewportVars();
if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", syncVisualViewportVars);
  window.visualViewport.addEventListener("scroll", syncVisualViewportVars);
}
window.addEventListener("resize", syncVisualViewportVars);
window.addEventListener("orientationchange", syncVisualViewportVars);

// Native tools share this tab's participant, not a new session or authorization.
// Keep the public window bridge opt-in for the local SDK.
const exposeWindow = new URLSearchParams(location.search).get("agent") === "1";
const nativeWebMcp = detectNativeWebMcp();
if (exposeWindow || nativeWebMcp) {
  const agent = installPillowfortAgent({ exposeWindow })!;
  if (nativeWebMcp) {
    let registration = installPillowfortWebMcp(agent, nativeWebMcp);
    void registration.ready.catch(() => console.error("Pillowfort native WebMCP registration failed; room UI remains available."));
    window.addEventListener("pagehide", () => registration.dispose());
    window.addEventListener("pageshow", event => {
      if (!event.persisted) return;
      registration = installPillowfortWebMcp(agent, nativeWebMcp);
      void registration.ready.catch(() => console.error("Pillowfort native WebMCP registration failed; room UI remains available."));
    });
  }
}

createRoot(document.getElementById("root")!).render(<App />);
