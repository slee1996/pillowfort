import { useRef, useEffect } from "react";
import { send, getWs } from "../../services/ws";

const remoteDrawers: Record<string, [number, number]> = {};

export function DrawCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawingRef = useRef(false);
  const colorRef = useRef("");
  const pendingPtsRef = useRef<[number, number][]>([]);
  const isNewStrokeRef = useRef(false);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const parent = cv.parentElement;
    if (!parent) return;
    const ctx = cv.getContext("2d")!;

    const ro = new ResizeObserver(() => {
      const r = parent.getBoundingClientRect();
      cv.width = r.width;
      cv.height = r.height;
    });
    ro.observe(parent);

    function flushDraw() {
      rafRef.current = null;
      if (pendingPtsRef.current.length === 0 || getWs()?.readyState !== WebSocket.OPEN) return;
      const msg: Record<string, unknown> = { color: colorRef.current, pts: pendingPtsRef.current };
      if (isNewStrokeRef.current) msg.s = 1;
      send("draw", msg);
      isNewStrokeRef.current = false;
      pendingPtsRef.current = [];
      if (drawingRef.current) rafRef.current = requestAnimationFrame(flushDraw);
    }

    const onPointerDown = (e: PointerEvent) => {
      if (e.target !== cv) return;
      drawingRef.current = true;
      colorRef.current = `hsl(${Math.floor(Math.random() * 360)}, 80%, 65%)`;
      isNewStrokeRef.current = true;
      const rect = cv.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      const y = (e.clientY - rect.top) / rect.height;
      ctx.beginPath();
      ctx.moveTo(x * cv.width, y * cv.height);
      ctx.strokeStyle = colorRef.current;
      ctx.lineWidth = 3;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      pendingPtsRef.current = [[x, y]];
      if (!rafRef.current) rafRef.current = requestAnimationFrame(flushDraw);
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!drawingRef.current) return;
      const rect = cv.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      const y = (e.clientY - rect.top) / rect.height;
      ctx.lineTo(x * cv.width, y * cv.height);
      ctx.stroke();
      pendingPtsRef.current.push([x, y]);
    };

    const stopDraw = () => {
      if (!drawingRef.current) return;
      drawingRef.current = false;
      if (pendingPtsRef.current.length > 0 && getWs()?.readyState === WebSocket.OPEN) {
        send("draw", { color: colorRef.current, pts: pendingPtsRef.current });
      }
      pendingPtsRef.current = [];
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };

    // Remote draw handler
    const onRemoteDraw = (e: Event) => {
      const msg = (e as CustomEvent).detail;
      if (!msg.pts?.length || !msg.from) return;
      const w = cv.width, h = cv.height;
      ctx.strokeStyle = msg.color || "#fff";
      ctx.lineWidth = 3;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      const last = remoteDrawers[msg.from];
      if (msg.s || !last) {
        ctx.moveTo(msg.pts[0][0] * w, msg.pts[0][1] * h);
      } else {
        ctx.moveTo(last[0] * w, last[1] * h);
        ctx.lineTo(msg.pts[0][0] * w, msg.pts[0][1] * h);
      }
      for (let i = 1; i < msg.pts.length; i++) {
        ctx.lineTo(msg.pts[i][0] * w, msg.pts[i][1] * h);
      }
      ctx.stroke();
      remoteDrawers[msg.from] = msg.pts[msg.pts.length - 1];
    };

    cv.addEventListener("pointerdown", onPointerDown);
    cv.addEventListener("pointermove", onPointerMove);
    cv.addEventListener("pointerup", stopDraw);
    cv.addEventListener("pointerleave", stopDraw);
    window.addEventListener("pf-draw", onRemoteDraw);

    return () => {
      ro.disconnect();
      cv.removeEventListener("pointerdown", onPointerDown);
      cv.removeEventListener("pointermove", onPointerMove);
      cv.removeEventListener("pointerup", stopDraw);
      cv.removeEventListener("pointerleave", stopDraw);
      window.removeEventListener("pf-draw", onRemoteDraw);
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
