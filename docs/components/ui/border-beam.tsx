// MagicUI BorderBeam — a light that travels around an element's border.
// Wrap inside any `relative` + rounded container.
"use client";

import { motion, type Transition } from "motion/react";
import type { CSSProperties } from "react";

import { cn } from "@/lib/utils";

interface BorderBeamProps {
  className?: string;
  size?: number;
  duration?: number;
  delay?: number;
  colorFrom?: string;
  colorTo?: string;
}

export function BorderBeam({
  className,
  size = 60,
  duration = 7,
  delay = 0,
  colorFrom = "#a78bfa",
  colorTo = "#8b5cf6",
}: BorderBeamProps) {
  return (
    <div className="pointer-events-none absolute inset-0 rounded-[inherit] [border:1px_solid_transparent] ![mask-clip:padding-box,border-box] ![mask-composite:intersect] [mask:linear-gradient(transparent,transparent),linear-gradient(#000,#000)]">
      <motion.div
        className={cn(
          "absolute aspect-square bg-gradient-to-l from-[var(--cf)] via-[var(--ct)] to-transparent",
          className,
        )}
        style={
          {
            width: size,
            offsetPath: `rect(0 auto auto 0 round ${size}px)`,
            "--cf": colorFrom,
            "--ct": colorTo,
          } as CSSProperties
        }
        initial={{ offsetDistance: "0%" }}
        animate={{ offsetDistance: "100%" }}
        transition={
          {
            repeat: Infinity,
            ease: "linear",
            duration,
            delay: -delay,
          } as Transition
        }
      />
    </div>
  );
}
