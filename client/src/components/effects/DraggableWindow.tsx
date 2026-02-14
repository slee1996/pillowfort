import { useRef, useCallback, type ReactNode } from "react";

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

    // Snap back
    const snapBack = () => {
      currentPos.current = { x: 0, y: 0 };
      el.style.transition = "transform 0.3s ease";
      el.style.transform = "";
      setTimeout(() => { el.style.transition = ""; }, 300);
    };
    snapBack();
  }, [onDragEnd]);

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
