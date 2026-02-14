import { forwardRef, type ReactNode } from "react";
import { LogoIcon } from "./Logo";

export interface TitleButton {
  label: string;
  close?: boolean;
  onClick: () => void;
}

interface TitleBarProps {
  title: string;
  buttons?: TitleButton[];
  extra?: ReactNode;
  onDoubleClick?: () => void;
}

export const TitleBar = forwardRef<HTMLDivElement, TitleBarProps>(
  ({ title, buttons, extra, onDoubleClick }, ref) => {
    return (
      <div className="xp-title-bar" ref={ref} onDoubleClick={onDoubleClick}>
        <div className="xp-title-text">
          <div className="xp-title-icon">
            <LogoIcon />
          </div>
          {title}
          {extra}
        </div>
        {buttons && (
          <div className="xp-title-buttons">
            {buttons.map((btn, i) => (
              <div
                key={i}
                className={`xp-title-btn ${btn.close ? "xp-title-btn-close" : ""}`}
                onClick={btn.onClick}
              >
                {btn.label}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }
);
