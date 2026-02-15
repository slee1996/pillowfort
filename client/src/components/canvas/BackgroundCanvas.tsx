import { useRef, useEffect } from "react";

export function BackgroundCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawingRef = useRef(false);
  const colorRef = useRef("");

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const parent = cv.parentElement;
    if (!parent) return;
    const ctx = cv.getContext("2d")!;

    const drawColor = () => `hsl(${Math.floor(Math.random() * 360)}, 80%, 65%)`;
    colorRef.current = drawColor();

    const ro = new ResizeObserver(() => {
      const r = parent.getBoundingClientRect();
      cv.width = r.width;
      cv.height = r.height;
    });
    ro.observe(parent);

    const onPointerDown = (e: PointerEvent) => {
      if (e.target !== cv) return;
      drawingRef.current = true;
      colorRef.current = drawColor();
      const rect = cv.getBoundingClientRect();
      ctx.beginPath();
      ctx.moveTo(e.clientX - rect.left, e.clientY - rect.top);
      ctx.strokeStyle = colorRef.current;
      ctx.lineWidth = 3;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!drawingRef.current) return;
      const rect = cv.getBoundingClientRect();
      ctx.lineTo(e.clientX - rect.left, e.clientY - rect.top);
      ctx.stroke();
    };

    const stop = () => {
      drawingRef.current = false;
    };

    cv.addEventListener("pointerdown", onPointerDown);
    cv.addEventListener("pointermove", onPointerMove);
    cv.addEventListener("pointerup", stop);
    cv.addEventListener("pointerleave", stop);

    return () => {
      ro.disconnect();
      cv.removeEventListener("pointerdown", onPointerDown);
      cv.removeEventListener("pointermove", onPointerMove);
      cv.removeEventListener("pointerup", stop);
      cv.removeEventListener("pointerleave", stop);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="fullscreen-canvas"
      style={{ cursor: "crosshair" }}
    />
  );
}
