import type { ButtonHTMLAttributes } from "react";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  primary?: boolean;
}

export function Button({ primary, className = "", ...props }: ButtonProps) {
  return (
    <button
      className={`xp-btn ${primary ? "xp-btn-primary" : ""} ${className}`}
      {...props}
    />
  );
}
