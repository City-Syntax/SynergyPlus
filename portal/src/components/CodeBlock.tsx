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
    <div className="overflow-hidden rounded-card bg-surface inset-ring inset-ring-border">
      <div className="flex items-center justify-between border-b border-border bg-surface-tertiary py-1.5 pl-4 pr-2">
        <span className="header-subtitle text-text-secondary">
          {title ?? language ?? "code"}
        </span>
        <CopyButton value={code} />
      </div>
      <pre className="overflow-x-auto px-4 py-3.5">
        <code className="value-mono text-text">{code}</code>
      </pre>
    </div>
  );
}
