import { cn } from "@/lib/utils";

const variants = {
  default: "border-edge bg-surface-2 text-ink-mid",
  accent: "border-accent/30 bg-accent/10 text-accent-soft",
  green: "border-emerald-500/30 bg-emerald-500/10 text-emerald-400",
  amber: "border-amber-500/30 bg-amber-500/10 text-amber-400",
  outline: "border-edge text-ink-dim",
} as const;

export function Badge({
  variant = "default",
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & { variant?: keyof typeof variants }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium",
        variants[variant],
        className,
      )}
      {...props}
    />
  );
}
