import { CopyButton } from "./CopyButton";

export function CodeBlock({
  code,
  language,
  title,
}: {
  code: string;
  language?: string;
  title?: string;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-panel">
      <div className="flex items-center justify-between border-b border-border bg-panel-2 px-4 py-2">
        <span className="text-xs font-medium text-muted">
          {title ?? language ?? "code"}
        </span>
        <CopyButton value={code} />
      </div>
      <pre className="overflow-x-auto px-4 py-3.5 text-[13px] leading-relaxed">
        <code className="font-mono text-fg">{code}</code>
      </pre>
    </div>
  );
}
