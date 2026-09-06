import { createRoot } from "react-dom/client";
import { App } from "./App";
import { installPillowfortAgent } from "./agent/bridge";
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

// Opt-in transport surface, not a privilege boundary: same-origin JavaScript
// already has the participant's authority. Preserve all normal URL handling.
if (new URLSearchParams(location.search).get("agent") === "1") {
  installPillowfortAgent();
}

createRoot(document.getElementById("root")!).render(<App />);
