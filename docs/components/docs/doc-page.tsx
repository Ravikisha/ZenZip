import Link from "next/link";
import { ArrowLeft, ArrowRight } from "lucide-react";

import { flatNav } from "@/lib/docs-nav";

export interface TocEntry {
  id: string;
  title: string;
}

export function DocPage({
  title,
  description,
  href,
  toc,
  children,
}: {
  title: string;
  description: string;
  /** Current page href, used to compute prev/next from the nav order. */
  href: string;
  toc: TocEntry[];
  children: React.ReactNode;
}) {
  const index = flatNav.findIndex((item) => item.href === href);
  const prev = index > 0 ? flatNav[index - 1] : null;
  const next = index >= 0 && index < flatNav.length - 1 ? flatNav[index + 1] : null;

  return (
    <div className="flex gap-10">
      <article className="min-w-0 flex-1 pb-20">
        <header>
          <h1 className="text-3xl font-bold tracking-tight text-ink">{title}</h1>
          <p className="mt-3 text-base leading-7 text-ink-dim">{description}</p>
        </header>
        <div className="mt-8">{children}</div>

        <nav className="mt-16 grid gap-3 border-t border-edge-soft pt-8 sm:grid-cols-2">
          {prev ? (
            <Link
              href={prev.href}
              className="group rounded-xl border border-edge bg-surface p-4 transition-colors hover:border-zinc-600"
            >
              <span className="flex items-center gap-1.5 text-xs text-ink-dim">
                <ArrowLeft className="size-3.5" /> Previous
              </span>
              <span className="mt-1 block text-sm font-medium text-ink group-hover:text-accent-soft">
                {prev.title}
              </span>
            </Link>
          ) : (
            <span />
          )}
          {next ? (
            <Link
              href={next.href}
              className="group rounded-xl border border-edge bg-surface p-4 text-right transition-colors hover:border-zinc-600"
            >
              <span className="flex items-center justify-end gap-1.5 text-xs text-ink-dim">
                Next <ArrowRight className="size-3.5" />
              </span>
              <span className="mt-1 block text-sm font-medium text-ink group-hover:text-accent-soft">
                {next.title}
              </span>
            </Link>
          ) : (
            <span />
          )}
        </nav>
      </article>

      <aside className="hidden w-52 shrink-0 xl:block">
        <div className="sticky top-24">
          <h4 className="text-[11px] font-semibold uppercase tracking-wider text-ink-dim">
            On this page
          </h4>
          <ul className="mt-3 space-y-2 border-l border-edge-soft">
            {toc.map((entry) => (
              <li key={entry.id}>
                <a
                  href={`#${entry.id}`}
                  className="-ml-px block border-l border-transparent pl-4 text-[13px] leading-5 text-ink-dim transition-colors hover:border-accent hover:text-ink"
                >
                  {entry.title}
                </a>
              </li>
            ))}
          </ul>
        </div>
      </aside>
    </div>
  );
}
