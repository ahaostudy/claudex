import { clsx } from "clsx";
import { forwardRef, type ButtonHTMLAttributes } from "react";

type ButtonVariant = "outline" | "ghost" | "filled";
type ButtonSize = "xs" | "sm" | "md" | "lg";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

const variantStyles: Record<ButtonVariant, string> = {
  outline:
    "border border-line bg-canvas hover:bg-paper text-ink-soft",
  ghost:
    "bg-transparent hover:bg-paper text-ink-soft",
  filled:
    "bg-ink text-canvas hover:bg-ink-soft border border-transparent",
};

const sizeStyles: Record<ButtonSize, string> = {
  xs: "h-5 px-1.5 rounded-[4px] text-[10px] gap-1",
  sm: "h-7 px-2 rounded-[6px] text-[11px] gap-1",
  md: "h-8 px-2.5 rounded-[8px] text-[12px] gap-1.5",
  lg: "h-9 px-3.5 rounded-[8px] text-[13px] gap-2",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = "outline", size = "md", className, children, ...props }, ref) => {
    return (
      <button
        ref={ref}
        className={clsx(
          "inline-flex items-center font-medium shrink-0",
          "disabled:opacity-60 disabled:cursor-not-allowed",
          variantStyles[variant],
          sizeStyles[size],
          className,
        )}
        {...props}
      >
        {children}
      </button>
    );
  },
);

Button.displayName = "Button";
