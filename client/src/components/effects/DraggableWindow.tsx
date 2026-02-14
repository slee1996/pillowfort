import { useRef, useCallback, useEffect, type ReactNode } from "react";

interface DraggableWindowProps {
  children: ReactNode;
  className?: string;
  minimized: boolean;
  titleBarRef: React.RefObject<HTMLDivElement | null>;
  onDragEnd?: () => void;
}

export function DraggableWindow({ children, className = "", minimized, titleBarRef, onDragEnd }: DraggableWindowProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const startPos = useRef({ x: 0, y: 0 });
  const currentPos = useRef({ x: 0, y: 0 });
  const grabCount = useRef(0);
  const lastGrabTime = useRef(0);

  const hand = useRef<HTMLDivElement | null>(null);
  const handX = useRef(0);
  const handY = useRef(0);
  const handPhase = useRef<"idle" | "chasing" | "grabbed" | "returning" | "fadeout">("idle");
  const handAnim = useRef<number | null>(null);
  const handT = useRef(0);
  const shakeT = useRef(0);

  const frustration = useCallback(() => {
    const elapsed = (Date.now() - lastGrabTime.current) / 1000;
    const decayed = Math.max(0, grabCount.current - Math.floor(elapsed / 10));
    return Math.min(decayed, 12);
  }, []);

  const chaseSpeed = (f: number) => Math.min(6 + f * 2.5, 30);
  const returnSpeed = (f: number) => Math.min(8 + f * 3, 35);
  const shakeMag = (f: number) => Math.min(3 + f * 4, 45);
  const handSize = (f: number) => Math.min(32 + f * 5, 72);
  const grabPause = (f: number) => Math.max(8, 30 - f * 2);

  const openEmoji = (f: number) => ["🤚", "🖐️", "✋", "🖖"][Math.min(Math.floor(f / 3), 3)];
  const grabEmoji = (f: number) => (f >= 10 ? "💢" : f >= 6 ? "👊" : "✊");

  const setWindowTransform = useCallback((x: number, y: number) => {
    const el = containerRef.current;
    if (!el) return;
    currentPos.current = { x, y };
    if (Math.abs(x) < 0.5 && Math.abs(y) < 0.5) {
      currentPos.current = { x: 0, y: 0 };
      el.style.transform = "";
      return;
    }
    el.style.transform = `translate(${x}px, ${y}px)`;
  }, []);

  const removeHand = useCallback(() => {
    hand.current?.remove();
    hand.current = null;
    handPhase.current = "idle";
    handT.current = 0;
    shakeT.current = 0;
    if (handAnim.current) {
      cancelAnimationFrame(handAnim.current);
      handAnim.current = null;
    }
  }, []);

  const handLoop = useCallback(() => {
    const el = containerRef.current;
    const screen = el?.closest(".screen-chat") as HTMLElement | null;
    const handEl = hand.current;
    if (!el || !screen || !handEl) {
      removeHand();
      return;
    }

    if (handPhase.current === "idle") {
      handAnim.current = null;
      return;
    }

    const f = frustration();
    const shake = shakeMag(f);

    const screenRect = screen.getBoundingClientRect();
    const winRect = el.getBoundingClientRect();
    const target = {
      x: winRect.left - screenRect.left + winRect.width / 2 - 16,
      y: winRect.top - screenRect.top + 12,
    };
    const center = {
      x: screenRect.width / 2 - 16,
      y: screenRect.height / 2,
    };

    if (handPhase.current === "chasing") {
      const dx = target.x - handX.current;
      const dy = target.y - handY.current;
      const dist = Math.hypot(dx, dy);
      const speed = chaseSpeed(f);
      if (dist < speed + 2) {
        handX.current = target.x;
        handY.current = target.y;
        handEl.textContent = grabEmoji(f);
        handPhase.current = "grabbed";
        handT.current = 0;
      } else if (dist > 0) {
        handX.current += (dx / dist) * speed;
        handY.current += (dy / dist) * speed;
      }
    } else if (handPhase.current === "grabbed") {
      handT.current += 1;
      if (handT.current >= grabPause(f)) {
        handPhase.current = "returning";
        handT.current = 0;
      }
    } else if (handPhase.current === "returning") {
      const speed = returnSpeed(f);
      const wx = currentPos.current.x;
      const wy = currentPos.current.y;
      const wdist = Math.hypot(wx, wy);
      if (wdist < speed + 1) {
        setWindowTransform(0, 0);
      } else if (wdist > 0) {
        setWindowTransform(wx - (wx / wdist) * speed, wy - (wy / wdist) * speed);
      }

      const dx = center.x - handX.current;
      const dy = center.y - handY.current;
      const dist = Math.hypot(dx, dy);
      if (dist < speed + 1) {
        handX.current = center.x;
        handY.current = center.y;
      } else if (dist > 0) {
        handX.current += (dx / dist) * speed;
        handY.current += (dy / dist) * speed;
      }

      if (wdist < speed + 1 && dist < speed + 1) {
        handPhase.current = "fadeout";
        handT.current = 0;
      }
    } else if (handPhase.current === "fadeout") {
      handT.current += 1;
      handEl.style.opacity = String(Math.max(0, 1 - handT.current / 15));
      if (handT.current >= 15) {
        removeHand();
        return;
      }
    }

    shakeT.current += 1;
    let rot = 0;
    if (handPhase.current === "grabbed" || handPhase.current === "returning") {
      rot = Math.sin(shakeT.current * 0.8) * shake;
    } else if (handPhase.current === "chasing") {
      rot = Math.sin(shakeT.current * 0.4) * Math.min(shake * 0.3, 8);
    }

    handEl.style.left = `${handX.current}px`;
    handEl.style.top = `${handY.current}px`;
    handEl.style.transform = `rotate(${rot}deg)`;

    handAnim.current = requestAnimationFrame(handLoop);
  }, [frustration, removeHand, setWindowTransform]);

  const dispatchHand = useCallback(() => {
    const el = containerRef.current;
    const screen = el?.closest(".screen-chat") as HTMLElement | null;
    if (!el || !screen) {
      setWindowTransform(0, 0);
      return;
    }

    const f = frustration();
    if (!hand.current) {
      const handEl = document.createElement("div");
      handEl.className = "grab-hand";
      screen.appendChild(handEl);
      hand.current = handEl;

      const rect = screen.getBoundingClientRect();
      const edge = Math.floor(Math.random() * 4);
      if (edge === 0) {
        handX.current = Math.random() * rect.width;
        handY.current = -60;
      } else if (edge === 1) {
        handX.current = rect.width + 10;
        handY.current = Math.random() * rect.height;
      } else if (edge === 2) {
        handX.current = Math.random() * rect.width;
        handY.current = rect.height + 10;
      } else {
        handX.current = -60;
        handY.current = Math.random() * rect.height;
      }
    }

    hand.current.textContent = openEmoji(f);
    hand.current.style.fontSize = `${handSize(f)}px`;
    hand.current.style.opacity = "1";
    handPhase.current = "chasing";
    handT.current = 0;
    shakeT.current = 0;

    if (!handAnim.current) {
      handAnim.current = requestAnimationFrame(handLoop);
    }
  }, [frustration, handLoop, setWindowTransform]);

  useEffect(() => () => removeHand(), [removeHand]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (minimized) return;
    if ((e.target as HTMLElement).closest(".xp-title-buttons")) return;
    if (!titleBarRef.current?.contains(e.target as HTMLElement)) return;

    dragging.current = true;
    const el = containerRef.current!;
    el.classList.add("dragging");
    el.style.transition = "none";
    startPos.current = {
      x: e.clientX - currentPos.current.x,
      y: e.clientY - currentPos.current.y,
    };
    e.preventDefault();
  }, [minimized, titleBarRef]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    currentPos.current = {
      x: e.clientX - startPos.current.x,
      y: e.clientY - startPos.current.y,
    };
    containerRef.current!.style.transform = `translate(${currentPos.current.x}px, ${currentPos.current.y}px)`;
  }, []);

  const onPointerUp = useCallback(() => {
    if (!dragging.current) return;
    dragging.current = false;
    const el = containerRef.current!;
    el.classList.remove("dragging");
    el.style.transition = "";

    if (Math.abs(currentPos.current.x) < 3 && Math.abs(currentPos.current.y) < 3) {
      currentPos.current = { x: 0, y: 0 };
      el.style.transform = "";
      return;
    }

    onDragEnd?.();
    grabCount.current += 1;
    lastGrabTime.current = Date.now();
    dispatchHand();
  }, [dispatchHand, onDragEnd]);

  return (
    <div
      ref={containerRef}
      className={className}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      style={{ transition: "transform 0.05s" }}
    >
      {children}
    </div>
  );
}
