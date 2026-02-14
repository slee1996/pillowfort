import { useEffect, useState } from "react";

let showToastFn: ((text: string) => void) | null = null;

export function showToast(text: string) {
  showToastFn?.(text);
}

export function Toast() {
  const [text, setText] = useState("");
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    showToastFn = (t: string) => {
      setText(t);
      setVisible(true);
      setTimeout(() => setVisible(false), 1800);
    };
    return () => {
      showToastFn = null;
    };
  }, []);

  return (
    <div className={`copy-toast ${visible ? "visible" : ""}`}>{text}</div>
  );
}
