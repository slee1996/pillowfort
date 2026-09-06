import { useRef, useEffect, useState } from "react";
import { send } from "../../services/ws";
import {
  DRAWING_COLORS, DRAWING_HEIGHT, DRAWING_WIDTH,
  notifyDrawingSurface, registerDrawingSurface,
} from "../../services/drawingSurface";
import { PeriodIcon } from "../xp/PeriodIcon";
import { useGameStore } from "../../stores/gameStore";

type Point = [number, number];
type Drawer = { point: Point; color: string };
const MAX_POINTS = 128;
const BATCH_INTERVAL_MS = 250;
const INK_WIDTH = 3;
const BACKING_SCALE = 2;

export function DrawCanvas({ active }: { active: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const paperRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLSpanElement>(null);
  const activeRef = useRef(active);
  const colorRef = useRef("#000000");
  const noticeRef = useRef<string | null>(null);
  const runtimeRef = useRef<{
    finish: () => void;
    resize: () => void;
    setColor: (color: string) => void;
    exportPng: () => Promise<string>;
  } | null>(null);
  const [color, setColor] = useState(colorRef.current);
  const [notice, setNotice] = useState<string | null>(null);
  const [canExport, setCanExport] = useState(false);
  activeRef.current = active;

  useEffect(() => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    const paper = paperRef.current;
    const preview = previewRef.current;
    if (!canvas || !stage || !paper || !preview) return;

    // Only applied encrypted events paint this bitmap. Local events have no
    // acknowledgement ID, so optimistic ink cannot be safely reconciled with
    // their echoes or with drawings sent by an agent on this same device.
    const backing = document.createElement("canvas");
    backing.width = DRAWING_WIDTH * BACKING_SCALE;
    backing.height = DRAWING_HEIGHT * BACKING_SCALE;
    const ink = backing.getContext("2d");
    const display = canvas.getContext("2d");
    let ready = Boolean(ink && display);
    let disposed = false;
    let paintFrame: number | null = null;
    let batchTimer: number | undefined;
    let pointerId: number | null = null;
    let strokeColor = colorRef.current;
    let strokeStart = false;
    let points: Point[] = [];
    let lastInput: Point | null = null;
    const drawers = new Map<string, Drawer>();

    const updateNotice = (value: string | null) => {
      noticeRef.current = value;
      setNotice(value);
      notifyDrawingSurface();
    };
    if (ink) {
      ink.scale(BACKING_SCALE, BACKING_SCALE);
      ink.fillStyle = "#FFFFFF";
      ink.fillRect(0, 0, DRAWING_WIDTH, DRAWING_HEIGHT);
      ink.lineWidth = INK_WIDTH;
      ink.lineCap = "round";
      ink.lineJoin = "round";
    }
    setCanExport(ready);
    if (!ready) updateNotice("Drawing is unavailable in this browser.");

    const paint = () => {
      paintFrame = null;
      if (display && ready && activeRef.current) {
        display.drawImage(backing, 0, 0, canvas.width, canvas.height);
      }
    };
    const schedulePaint = () => {
      if (paintFrame === null && activeRef.current) paintFrame = requestAnimationFrame(paint);
    };
    const resize = () => {
      const rect = stage.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const scale = Math.min(rect.width / DRAWING_WIDTH, rect.height / DRAWING_HEIGHT);
      const width = DRAWING_WIDTH * scale;
      const height = DRAWING_HEIGHT * scale;
      paper.style.width = `${width}px`;
      paper.style.height = `${height}px`;
      const pixelRatio = Math.min(2, window.devicePixelRatio || 1);
      const pixelsWide = Math.max(1, Math.min(backing.width, Math.round(width * pixelRatio)));
      const pixelsHigh = Math.max(1, Math.min(backing.height, Math.round(height * pixelRatio)));
      if (canvas.width !== pixelsWide || canvas.height !== pixelsHigh) {
        canvas.width = pixelsWide;
        canvas.height = pixelsHigh;
      }
      schedulePaint();
    };
    const flush = () => {
      window.clearTimeout(batchTimer);
      batchTimer = undefined;
      if (!points.length) return;
      const batch = points;
      points = [];
      const accepted = send("draw", { color: strokeColor, pts: batch, ...(strokeStart ? { s: 1 } : {}) });
      strokeStart = !accepted;
      if (!accepted) updateNotice("That part of the stroke could not be shared. Please try again.");
    };
    const finish = () => {
      const previousPointer = pointerId;
      pointerId = null;
      preview.hidden = true;
      flush();
      lastInput = null;
      if (previousPointer !== null && canvas.hasPointerCapture(previousPointer)) {
        canvas.releasePointerCapture(previousPointer);
      }
    };
    const appendPoint = (event: PointerEvent, rect: DOMRect) => {
      const x = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
      const y = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      preview.style.left = `${x * 100}%`;
      preview.style.top = `${y * 100}%`;
      if (lastInput && lastInput[0] === x && lastInput[1] === y) return;
      // Uniformly thin unusually dense input in place, retaining the start
      // and the exact newest endpoint rather than clipping the stroke tail.
      if (points.length === MAX_POINTS) {
        for (let read = 2, write = 1; read < MAX_POINTS; read += 2, write++) points[write] = points[read];
        points.length = MAX_POINTS / 2;
      }
      lastInput = [x, y];
      points.push(lastInput);
      if (batchTimer === undefined) batchTimer = window.setTimeout(flush, BATCH_INTERVAL_MS);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!activeRef.current || !ready || pointerId !== null || !event.isPrimary || event.button !== 0) return;
      event.preventDefault();
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch {
        updateNotice("The pointer could not start drawing. Please try again.");
        return;
      }
      pointerId = event.pointerId;
      strokeColor = colorRef.current;
      strokeStart = true;
      points = [];
      lastInput = null;
      updateNotice(null);
      preview.style.borderColor = strokeColor;
      preview.hidden = false;
      appendPoint(event, canvas.getBoundingClientRect());
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!activeRef.current || event.pointerId !== pointerId) return;
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const samples = event.getCoalescedEvents?.();
      if (samples?.length) {
        const stride = Math.max(1, Math.ceil(samples.length / MAX_POINTS));
        for (let index = 0; index < samples.length; index += stride) appendPoint(samples[index], rect);
      }
      appendPoint(event, rect);
    };
    const onPointerUp = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      if (activeRef.current) appendPoint(event, canvas.getBoundingClientRect());
      finish();
    };
    const onPointerCancel = (event: PointerEvent) => {
      if (event.pointerId === pointerId) finish();
    };
    const onVisibilityChange = () => {
      if (document.hidden) finish();
    };
    const onDrawingError = () => {
      // Do not expose arbitrary room/server text through the drawing snapshot.
      updateNotice("Some ink could not be shared. Wait for secure delivery or device approval to finish, then start a new stroke.");
      finish();
    };
    const onAppliedDraw = (event: Event) => {
      if (!ink || !ready) return;
      const message = (event as CustomEvent).detail;
      if (!message || typeof message.from !== "string" || typeof message.color !== "string" || message.color.length > 24 ||
          !useGameStore.getState().members.includes(message.from) ||
          !Array.isArray(message.pts) || message.pts.length < 1 || message.pts.length > MAX_POINTS) return;
      for (const point of message.pts) {
        if (!Array.isArray(point) || point.length !== 2 ||
            !Number.isFinite(point[0]) || !Number.isFinite(point[1]) ||
            point[0] < 0 || point[0] > 1 || point[1] < 0 || point[1] > 1) return;
      }
      const batch = message.pts as Point[];
      const previous = drawers.get(message.from);
      const start = message.s === 1 || !previous || previous.color !== message.color;
      const first = batch[0];
      ink.strokeStyle = message.color;
      ink.fillStyle = message.color;
      // A dot is real ink, not a zero-length path (which canvas may omit).
      if (start) {
        ink.beginPath();
        ink.arc(first[0] * DRAWING_WIDTH, first[1] * DRAWING_HEIGHT, INK_WIDTH / 2, 0, Math.PI * 2);
        ink.fill();
      }
      // Never leave a participant's current path inside the shared 2D context.
      ink.beginPath();
      const origin = !start && previous ? previous.point : first;
      ink.moveTo(origin[0] * DRAWING_WIDTH, origin[1] * DRAWING_HEIGHT);
      for (let index = start ? 1 : 0; index < batch.length; index++) {
        ink.lineTo(batch[index][0] * DRAWING_WIDTH, batch[index][1] * DRAWING_HEIGHT);
      }
      ink.stroke();
      const end = batch[batch.length - 1];
      drawers.set(message.from, { point: [end[0], end[1]], color: message.color });
      schedulePaint();
    };
    const chooseColor = (value: string) => {
      if (!DRAWING_COLORS.some((entry) => entry.value === value)) return;
      colorRef.current = value;
      setColor(value);
      notifyDrawingSurface();
    };
    const exportPng = async () => {
      if (!ready || disposed) throw new Error("The shared drawing is not ready to save.");
      try {
        // Export only the canonical white paper, never toolbar, pointer preview,
        // room metadata, or an unrelated DOM screenshot.
        const image = document.createElement("canvas");
        image.width = DRAWING_WIDTH;
        image.height = DRAWING_HEIGHT;
        const context = image.getContext("2d");
        if (!context) throw new Error("No image context");
        context.drawImage(backing, 0, 0, DRAWING_WIDTH, DRAWING_HEIGHT);
        return image.toDataURL("image/png");
      } catch {
        updateNotice("The shared drawing could not be saved. Please try again.");
        throw new Error("The shared drawing could not be saved.");
      }
    };
    runtimeRef.current = { finish, resize, setColor: chooseColor, exportPng };
    const unregister = registerDrawingSurface({
      snapshot: () => ({
        active: activeRef.current, color: colorRef.current,
        width: DRAWING_WIDTH, height: DRAWING_HEIGHT,
        canExport: ready && !disposed, notice: noticeRef.current,
      }),
      setColor: chooseColor,
      exportPng,
    });
    const observer = new ResizeObserver(resize);
    observer.observe(stage);
    resize();
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerCancel);
    canvas.addEventListener("lostpointercapture", onPointerCancel);
    window.addEventListener("blur", finish);
    window.addEventListener("resize", resize);
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pf-draw", onAppliedDraw);
    window.addEventListener("pf-drawing-error", onDrawingError);
    const unsubscribeMembers = useGameStore.subscribe((state, previous) => {
      if (state.members === previous.members) return;
      for (const name of drawers.keys()) if (!state.members.includes(name)) drawers.delete(name);
    });

    return () => {
      disposed = true;
      ready = false;
      unregister();
      runtimeRef.current = null;
      observer.disconnect();
      unsubscribeMembers();
      if (paintFrame !== null) cancelAnimationFrame(paintFrame);
      window.clearTimeout(batchTimer);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerCancel);
      canvas.removeEventListener("lostpointercapture", onPointerCancel);
      if (pointerId !== null && canvas.hasPointerCapture(pointerId)) canvas.releasePointerCapture(pointerId);
      window.removeEventListener("blur", finish);
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pf-draw", onAppliedDraw);
      window.removeEventListener("pf-drawing-error", onDrawingError);
      preview.hidden = true;
      points = [];
      drawers.clear();
      backing.width = backing.height = 0;
      canvas.width = canvas.height = 0;
    };
  }, []);

  useEffect(() => {
    if (!active) runtimeRef.current?.finish();
    else runtimeRef.current?.resize();
    notifyDrawingSurface();
  }, [active]);

  const savePng = async () => {
    const runtime = runtimeRef.current;
    if (!runtime) return;
    try {
      const url = await runtime.exportPng();
      const link = document.createElement("a");
      link.href = url;
      link.download = "pillowfort-drawing.png";
      document.body.appendChild(link);
      link.click();
      link.remove();
      // Data URLs require no object URL lifetime or revocation.
    } catch {
      // exportPng reports a bounded, accessible error through the surface.
    }
  };

  return (
    <div className="drawing-workspace" hidden={!active}>
      <div className="drawing-toolbar" role="toolbar" aria-label="Drawing tools">
        <span className="drawing-toolbar-title"><PeriodIcon kind="pencil" /> Doodle</span>
        <div className="drawing-palette" role="group" aria-label="Ink color">
          {DRAWING_COLORS.map((entry) => (
            <button key={entry.value} type="button" className="xp-btn drawing-color"
              aria-label={entry.name} title={entry.name} aria-pressed={color === entry.value}
              onClick={() => runtimeRef.current?.setColor(entry.value)}>
              <span className="drawing-color-swatch" style={{ backgroundColor: entry.value }} aria-hidden="true" />
            </button>
          ))}
        </div>
        <button type="button" className="xp-btn drawing-save" disabled={!canExport} onClick={savePng}
          title="Save confirmed shared ink as a PNG"><PeriodIcon kind="paper" /> Save PNG</button>
      </div>
      <div className="drawing-stage" ref={stageRef}>
        <div className="drawing-paper" ref={paperRef} style={{ position: "relative" }}>
          <canvas id="game-canvas" ref={canvasRef} className="fullscreen-canvas"
            aria-label="Shared drawing paper, 1200 by 800. Draw with a mouse, touch, or pen. Ink appears when shared."
            aria-describedby="drawing-status"
            style={{ display: "block", width: "100%", height: "100%", touchAction: "none", cursor: "crosshair" }} />
          <span ref={previewRef} className="drawing-pointer-preview" hidden aria-hidden="true"
            style={{ position: "absolute", width: 12, height: 12, border: "2px dashed", borderRadius: "50%",
              transform: "translate(-50%, -50%)", pointerEvents: "none" }} />
        </div>
      </div>
      <div id="drawing-status" className="drawing-status" role="status" aria-live="polite">
        {notice ?? "Ink appears when shared. The ring previews your pointer. Only drawings since you joined are kept."}
      </div>
    </div>
  );
}
