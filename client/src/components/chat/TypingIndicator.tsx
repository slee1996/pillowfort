import { useEffect, useState } from "react";

export function TypingIndicator() {
  const [text, setText] = useState("");

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const handler = (e: Event) => {
      const name = (e as CustomEvent).detail;
      setText(`✎ ${name} is typing...`);
      clearTimeout(timer);
      timer = setTimeout(() => setText(""), 3000);
    };
    window.addEventListener("pf-typing", handler);
    return () => {
      window.removeEventListener("pf-typing", handler);
      clearTimeout(timer);
    };
  }, []);

  return (
    <div className="typing-indicator">
      {text}
    </div>
  );
}
