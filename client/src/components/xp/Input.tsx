import { forwardRef, type InputHTMLAttributes } from "react";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, id, className = "", ...props }, ref) => {
    return (
      <div className="xp-field">
        {label && <label htmlFor={id}>{label}</label>}
        <input id={id} className={`xp-input ${className}`} ref={ref} {...props} />
      </div>
    );
  }
);
