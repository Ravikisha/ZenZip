"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { docsNav } from "@/lib/docs-nav";
import { cn } from "@/lib/utils";

export function DocsSidebar() {
  const pathname = usePathname();

  return (
    <nav className="space-y-7">
      {docsNav.map((group) => (
        <div key={group.title}>
          <h3 className="px-3 text-[11px] font-semibold uppercase tracking-wider text-ink-dim">
            {group.title}
          </h3>
          <ul className="mt-2 space-y-0.5">
            {group.items.map((item) => {
              const active = pathname === item.href;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className={cn(
                      "block rounded-md px-3 py-1.5 text-sm transition-colors",
                      active
                        ? "bg-accent/10 font-medium text-accent-soft"
                        : "text-ink-mid hover:bg-surface-2 hover:text-ink",
                    )}
                  >
                    {item.title}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
