import { codeToHtml } from "shiki";

import { cn } from "@/lib/utils";

interface CodeBlockProps {
  code: string;
  lang?: string;
  filename?: string;
  className?: string;
}

/** Server component: highlights at build time via shiki. */
export async function CodeBlock({
  code,
  lang = "ts",
  filename,
  className,
}: CodeBlockProps) {
  const html = await codeToHtml(code.trim(), {
    lang,
    theme: "github-dark-default",
  });

  return (
    <figure
      className={cn(
        "group overflow-hidden rounded-xl border border-edge bg-[#0c0c10]",
        className,
      )}
    >
      {filename ? (
        <figcaption className="flex items-center gap-2 border-b border-edge-soft bg-surface px-4 py-2.5">
          <span className="flex gap-1.5">
            <span className="size-2.5 rounded-full bg-zinc-700" />
            <span className="size-2.5 rounded-full bg-zinc-700" />
            <span className="size-2.5 rounded-full bg-zinc-700" />
          </span>
          <span className="ml-1 font-mono text-xs text-ink-dim">{filename}</span>
        </figcaption>
      ) : null}
      <div
        className="thin-scroll overflow-x-auto p-4"
        // shiki output is trusted build-time HTML
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </figure>
  );
}

/** Tiny one-liner terminal command. */
export function CommandLine({ command }: { command: string }) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-edge bg-[#0c0c10] px-4 py-3 font-mono text-sm">
      <span className="select-none text-accent-soft">$</span>
      <span className="text-zinc-200">{command}</span>
    </div>
  );
}
