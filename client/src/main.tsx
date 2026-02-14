import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles/app.css";

// Visual viewport handler (virtual keyboard)
if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", () => {
    document.documentElement.style.setProperty(
      "--vvh",
      window.visualViewport!.height + "px"
    );
  });
}

createRoot(document.getElementById("root")!).render(<App />);
