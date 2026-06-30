// MagicUI AnimatedShinyText — a subtle highlight sweeping across dim text.
import type { CSSProperties, ReactNode } from "react";

import { cn } from "@/lib/utils";

export function AnimatedShinyText({
  children,
  className,
  shimmerWidth = 100,
}: {
  children: ReactNode;
  className?: string;
  shimmerWidth?: number;
}) {
  return (
    <span
      style={{ "--shiny-width": `${shimmerWidth}px` } as CSSProperties}
      className={cn(
        "animate-shiny-text bg-clip-text bg-no-repeat [background-position:0_0] [background-size:var(--shiny-width)_100%] [transition:background-position_1s_cubic-bezier(.6,.6,0,1)_infinite]",
        // dim base text + a moving bright band clipped to the glyphs
        "text-ink-dim bg-gradient-to-r from-transparent via-ink/90 via-50% to-transparent",
        className,
      )}
    >
      {children}
    </span>
  );
}
