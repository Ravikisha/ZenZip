import Link from "next/link";
import { AlertTriangle, Info, Lightbulb } from "lucide-react";

import { cn } from "@/lib/utils";

export function H2({
  id,
  children,
}: {
  id: string;
  children: React.ReactNode;
}) {
  return (
    <h2
      id={id}
      className="group mt-12 scroll-mt-24 border-b border-edge-soft pb-2 text-xl font-semibold tracking-tight text-ink first:mt-0"
    >
      <a href={`#${id}`} className="inline-flex items-center gap-2">
        {children}
        <span className="text-accent opacity-0 transition-opacity group-hover:opacity-100">
          #
        </span>
      </a>
    </h2>
  );
}

export function H3({
  id,
  children,
}: {
  id?: string;
  children: React.ReactNode;
}) {
  return (
    <h3
      id={id}
      className="mt-8 scroll-mt-24 text-base font-semibold tracking-tight text-ink"
    >
      {children}
    </h3>
  );
}

export function P({ children }: { children: React.ReactNode }) {
  return <p className="mt-4 text-[15px] leading-7 text-ink-mid">{children}</p>;
}

export function UL({ children }: { children: React.ReactNode }) {
  return (
    <ul className="mt-4 space-y-2 text-[15px] leading-7 text-ink-mid">
      {children}
    </ul>
  );
}

export function LI({ children }: { children: React.ReactNode }) {
  return (
    <li className="relative pl-5 before:absolute before:left-0 before:top-[0.7em] before:size-1.5 before:rounded-full before:bg-accent/60">
      {children}
    </li>
  );
}

export function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded-md border border-edge-soft bg-surface-2 px-1.5 py-0.5 font-mono text-[13px] text-violet-300">
      {children}
    </code>
  );
}

export function Strong({ children }: { children: React.ReactNode }) {
  return <strong className="font-semibold text-ink">{children}</strong>;
}

export function A({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="font-medium text-accent-soft underline decoration-accent/40 underline-offset-4 transition-colors hover:text-violet-300"
    >
      {children}
    </Link>
  );
}

const calloutStyles = {
  info: {
    icon: Info,
    classes: "border-sky-500/25 bg-sky-500/5 text-sky-200",
    iconColor: "text-sky-400",
  },
  warn: {
    icon: AlertTriangle,
    classes: "border-amber-500/25 bg-amber-500/5 text-amber-100",
    iconColor: "text-amber-400",
  },
  tip: {
    icon: Lightbulb,
    classes: "border-emerald-500/25 bg-emerald-500/5 text-emerald-100",
    iconColor: "text-emerald-400",
  },
} as const;

export function Callout({
  type = "info",
  title,
  children,
}: {
  type?: keyof typeof calloutStyles;
  title?: string;
  children: React.ReactNode;
}) {
  const style = calloutStyles[type];
  const Icon = style.icon;
  return (
    <div
      className={cn(
        "mt-6 flex gap-3 rounded-xl border p-4 text-sm leading-6",
        style.classes,
      )}
    >
      <Icon className={cn("mt-0.5 size-4 shrink-0", style.iconColor)} />
      <div>
        {title ? <p className="font-semibold">{title}</p> : null}
        <div className="[&>p]:mt-1 [&>p:first-child]:mt-0 opacity-90">
          {children}
        </div>
      </div>
    </div>
  );
}

export interface PropRow {
  name: string;
  type: string;
  default?: string;
  description: React.ReactNode;
}

export function PropsTable({ rows }: { rows: PropRow[] }) {
  return (
    <div className="thin-scroll mt-6 overflow-x-auto rounded-xl border border-edge">
      <table className="w-full min-w-[560px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-edge bg-surface text-left">
            <th className="px-4 py-3 font-medium text-ink">Option</th>
            <th className="px-4 py-3 font-medium text-ink">Type</th>
            <th className="px-4 py-3 font-medium text-ink">Default</th>
            <th className="px-4 py-3 font-medium text-ink">Description</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.name}
              className="border-b border-edge-soft last:border-0"
            >
              <td className="px-4 py-3 align-top font-mono text-[13px] text-violet-300">
                {row.name}
              </td>
              <td className="px-4 py-3 align-top font-mono text-[13px] text-ink-dim">
                {row.type}
              </td>
              <td className="px-4 py-3 align-top font-mono text-[13px] text-ink-dim">
                {row.default ?? "—"}
              </td>
              <td className="px-4 py-3 align-top leading-6 text-ink-mid">
                {row.description}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Table({
  head,
  rows,
}: {
  head: string[];
  rows: React.ReactNode[][];
}) {
  return (
    <div className="thin-scroll mt-6 overflow-x-auto rounded-xl border border-edge">
      <table className="w-full min-w-[480px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-edge bg-surface text-left">
            {head.map((h) => (
              <th key={h} className="px-4 py-3 font-medium text-ink">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-edge-soft last:border-0">
              {row.map((cell, j) => (
                <td key={j} className="px-4 py-3 align-top leading-6 text-ink-mid">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
