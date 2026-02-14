import type { ReactNode } from "react";
import { TitleBar, type TitleButton } from "./TitleBar";

interface WindowProps {
  title: string;
  children: ReactNode;
  className?: string;
  buttons?: TitleButton[];
  minimized?: boolean;
  titleExtra?: ReactNode;
  onTitleDoubleClick?: () => void;
  titleBarRef?: React.RefObject<HTMLDivElement | null>;
}

export function Window({
  title,
  children,
  className = "",
  buttons,
  minimized,
  titleExtra,
  onTitleDoubleClick,
  titleBarRef,
}: WindowProps) {
  return (
    <div className={`xp-window ${minimized ? "minimized" : ""} ${className}`}>
      <TitleBar
        title={title}
        buttons={buttons}
        extra={titleExtra}
        onDoubleClick={onTitleDoubleClick}
        ref={titleBarRef}
      />
      {!minimized && children}
    </div>
  );
}
