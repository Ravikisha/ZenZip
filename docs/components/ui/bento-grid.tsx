// MagicUI / Aceternity-style Bento grid for the feature showcase.
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { ComponentType, ReactNode } from "react";

import { cn } from "@/lib/utils";

export function BentoGrid({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn("grid w-full auto-rows-[14rem] grid-cols-1 gap-4 md:grid-cols-3", className)}>
      {children}
    </div>
  );
}

export function BentoCard({
  name,
  description,
  Icon,
  href,
  cta = "Learn more",
  className,
  children,
}: {
  name: string;
  description: string;
  Icon: ComponentType<{ className?: string }>;
  href: string;
  cta?: string;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "group relative flex flex-col justify-between overflow-hidden rounded-xl",
        "border border-edge bg-surface transition-all duration-300",
        "hover:border-accent/40 hover:shadow-[0_0_40px_-12px_rgb(139_92_246_/_0.35)]",
        className,
      )}
    >
      {/* decorative slot (patterns, etc.) */}
      {children}
      <div className="pointer-events-none z-10 flex transform-gpu flex-col gap-1 p-6 transition-all duration-300 group-hover:-translate-y-2">
        <Icon className="h-7 w-7 text-accent-soft" />
        <h3 className="mt-2 text-base font-semibold text-ink">{name}</h3>
        <p className="max-w-xs text-sm leading-relaxed text-ink-mid">{description}</p>
      </div>
      <div className="pointer-events-none absolute bottom-0 flex w-full translate-y-6 items-center gap-1 p-6 text-sm font-medium text-accent-soft opacity-0 transition-all duration-300 group-hover:translate-y-0 group-hover:opacity-100">
        {cta}
        <ArrowRight className="h-4 w-4" />
      </div>
      <div className="pointer-events-none absolute inset-0 transform-gpu transition-all duration-300 group-hover:bg-accent/[0.02]" />
    </Link>
  );
}
