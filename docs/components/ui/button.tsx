import Link from "next/link";

import { cn } from "@/lib/utils";

const variants = {
  primary:
    "bg-ink text-zinc-900 hover:bg-zinc-200 border border-transparent font-semibold",
  outline:
    "border border-edge bg-surface text-ink hover:border-zinc-600 hover:bg-surface-2",
  ghost: "text-ink-mid hover:text-ink hover:bg-surface-2 border border-transparent",
} as const;

const sizes = {
  sm: "h-8 px-3 text-xs",
  md: "h-10 px-4 text-sm",
  lg: "h-11 px-6 text-sm",
} as const;

interface ButtonLinkProps extends React.ComponentProps<typeof Link> {
  variant?: keyof typeof variants;
  size?: keyof typeof sizes;
}

export function ButtonLink({
  variant = "primary",
  size = "md",
  className,
  ...props
}: ButtonLinkProps) {
  return (
    <Link
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-lg transition-colors",
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  );
}
