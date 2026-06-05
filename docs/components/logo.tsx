import { cn } from "@/lib/utils";

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <span className="grid size-7 place-items-center rounded-lg bg-gradient-to-br from-violet-500 to-fuchsia-600 shadow-[0_0_18px_rgba(139,92,246,0.45)]">
        <svg
          viewBox="0 0 24 24"
          fill="none"
          className="size-4 text-white"
          aria-hidden
        >
          <path
            d="M13 2 4.5 13.5h5L11 22l8.5-11.5h-5L13 2Z"
            fill="currentColor"
          />
        </svg>
      </span>
      <span className="text-[15px] font-semibold tracking-tight text-ink">
        zenzip
      </span>
    </span>
  );
}
