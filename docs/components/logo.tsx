import Image from "next/image";

import { cn } from "@/lib/utils";

export function Logo({
  className,
  showWordmark = true,
}: {
  className?: string;
  showWordmark?: boolean;
}) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <Image
        src="/logo.png"
        alt="ZenZip logo"
        width={28}
        height={28}
        priority
        className="size-7 rounded-lg shadow-[0_0_18px_rgba(139,92,246,0.45)]"
      />
      {showWordmark && (
        <span className="text-[15px] font-semibold tracking-tight text-ink">zenzip</span>
      )}
    </span>
  );
}
