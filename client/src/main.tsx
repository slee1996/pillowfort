import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles/app.css";

function syncVisualViewportVars() {
  const vv = window.visualViewport;
  const height = vv ? vv.height : window.innerHeight;
  const top = vv ? vv.offsetTop : 0;
  document.documentElement.style.setProperty("--vvh", `${height}px`);
  document.documentElement.style.setProperty("--vv-top", `${top}px`);
}

// Visual viewport handler (virtual keyboard + iOS viewport offset)
syncVisualViewportVars();
if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", syncVisualViewportVars);
  window.visualViewport.addEventListener("scroll", syncVisualViewportVars);
}
window.addEventListener("resize", syncVisualViewportVars);
window.addEventListener("orientationchange", syncVisualViewportVars);

createRoot(document.getElementById("root")!).render(<App />);
