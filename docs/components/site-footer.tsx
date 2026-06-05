import Link from "next/link";

import { Logo } from "@/components/logo";
import { docsNav } from "@/lib/docs-nav";

export function SiteFooter() {
  return (
    <footer className="border-t border-edge-soft">
      <div className="mx-auto grid max-w-7xl gap-10 px-5 py-14 sm:grid-cols-2 lg:grid-cols-5">
        <div className="lg:col-span-2">
          <Logo />
          <p className="mt-4 max-w-xs text-sm leading-relaxed text-ink-dim">
            The agent-native backend framework for Node.js. Durable workflows,
            queues, schedules, and agents on a single Rust-powered runtime —
            zero infrastructure.
          </p>
        </div>
        {docsNav.map((group) => (
          <div key={group.title}>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-dim">
              {group.title}
            </h3>
            <ul className="mt-4 space-y-2.5">
              {group.items.map((item) => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className="text-sm text-ink-mid transition-colors hover:text-ink"
                  >
                    {item.title}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t border-edge-soft">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-5 py-6 text-xs text-ink-dim">
          <span>MIT licensed. Built with Rust + napi-rs + TypeScript.</span>
          <span className="font-mono">phases 0–2 complete · 51 tests green</span>
        </div>
      </div>
    </footer>
  );
}
