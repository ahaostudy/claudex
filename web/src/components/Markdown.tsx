import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/cn";

// ---------------------------------------------------------------------------
// Markdown renderer used for assistant text. GitHub-flavored (tables, task
// lists, strikethrough) via remark-gfm. No syntax highlighter — we style
// code blocks with Tailwind instead of pulling in 500 KB of Prism.
//
// Design contract mirrors mockup s-04 / s-07:
//   - body copy: 14.5px, leading-[1.6]
//   - headings: .display serif, stepped down by level
//   - inline code: mono, paper bg, thin border
//   - fenced code: mono, paper bg on soft-ink text, bordered, language tag
//     top-right — warm-white to match the rest of the publication-style UI
//   - blockquote: left rule + muted ink
//   - links: klein-ink underline; external opens in a new tab
//   - tables: collapsed borders, header row tinted
//
// We intentionally do NOT enable rehype-raw or any HTML passthrough. The
// default react-markdown renderer escapes embedded HTML, which is what we
// want — the assistant output is untrusted w.r.t. the DOM.
// ---------------------------------------------------------------------------

export function Markdown({ source }: { source: string }) {
  return (
    <div className="markdown text-[14.5px] text-ink leading-[1.6] min-w-0 break-words [overflow-wrap:anywhere]">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {source}
      </ReactMarkdown>
    </div>
  );
}

const COMPONENTS: Components = {
  p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
  h1: ({ children }) => (
    <h1 className="display text-[22px] leading-tight mt-4 mb-2 first:mt-0">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="display text-[19px] leading-tight mt-4 mb-2 first:mt-0">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="display text-[16.5px] leading-tight mt-3 mb-1.5 first:mt-0">
      {children}
    </h3>
  ),
  h4: ({ children }) => (
    <h4 className="display text-[14.5px] leading-tight mt-3 mb-1.5 first:mt-0">
      {children}
    </h4>
  ),
  h5: ({ children }) => (
    <h5 className="font-medium text-[13.5px] mt-2 mb-1 first:mt-0">
      {children}
    </h5>
  ),
  h6: ({ children }) => (
    <h6 className="font-medium text-[12.5px] uppercase tracking-[0.1em] text-ink-muted mt-2 mb-1 first:mt-0">
      {children}
    </h6>
  ),
  strong: ({ children }) => (
    <strong className="font-semibold">{children}</strong>
  ),
  em: ({ children }) => <em className="italic">{children}</em>,
  del: ({ children }) => <del className="line-through opacity-70">{children}</del>,
  a: ({ href, children }) => {
    // External links open in a new tab so clicking a URL in the transcript
    // doesn't blow the user out of the chat screen. noopener/noreferrer is a
    // belt-and-braces move in case an attacker ever got content in here.
    const isExternal = typeof href === "string" && /^https?:\/\//i.test(href);
    return (
      <a
        href={href}
        className="text-klein-ink underline underline-offset-2"
        {...(isExternal
          ? { target: "_blank", rel: "noopener noreferrer" }
          : null)}
      >
        {children}
      </a>
    );
  },
  ul: ({ children }) => (
    <ul className="list-disc pl-5 my-2 space-y-0.5 marker:text-ink-muted">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="list-decimal pl-5 my-2 space-y-0.5 marker:text-ink-muted">
      {children}
    </ol>
  ),
  li: ({ children, className, ...rest }) => {
    // GFM task list items arrive with `className="task-list-item"` and a
    // leading input checkbox. We preserve that marker and disable the
    // checkbox so the rendered transcript is read-only.
    const isTask =
      typeof className === "string" && className.includes("task-list-item");
    return (
      <li
        className={cn(
          "leading-[1.55]",
          isTask && "list-none -ml-5 flex items-start gap-2",
          className,
        )}
        {...rest}
      >
        {children}
      </li>
    );
  },
  input: ({ type, checked, ...rest }) => {
    // Only <input type="checkbox"> appears inside GFM task list items — any
    // other input form markdown somehow rendered we ignore.
    if (type !== "checkbox") return null;
    return (
      <input
        type="checkbox"
        checked={!!checked}
        readOnly
        disabled
        className="mt-[3px] accent-klein"
        {...rest}
      />
    );
  },
  blockquote: ({ children }) => (
    <blockquote className="pl-3 border-l-2 border-line-strong text-ink-muted my-2">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-3 border-line" />,
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="border-collapse border border-line text-[13.5px]">
        {children}
      </table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-paper">{children}</thead>,
  tr: ({ children }) => <tr className="border-b border-line">{children}</tr>,
  th: ({ children, style }) => (
    <th
      className="border border-line px-2.5 py-1.5 text-left font-medium"
      style={style}
    >
      {children}
    </th>
  ),
  td: ({ children, style }) => (
    <td className="border border-line px-2.5 py-1.5 align-top" style={style}>
      {children}
    </td>
  ),
  code: ({ className, children, ...rest }) => {
    // react-markdown sends `inline` on code nodes that live inline vs in a
    // pre. The v10 API dropped the `inline` prop, so we disambiguate by
    // checking whether the parent is a <pre> — which it is for fenced
    // blocks. Inline code gets the pill treatment; block code gets wrapped
    // by the `pre` renderer below.
    const isBlock =
      typeof className === "string" && /language-/.test(className);
    if (isBlock) {
      // Block code: reset any inherited pill styling so the inner <code>
      // inside the <pre> doesn't re-introduce a background / border. The
      // <pre> renderer owns the visual container.
      return (
        <code
          className={cn(
            className,
            "mono bg-transparent border-0 p-0 rounded-none text-inherit",
          )}
          {...rest}
        >
          {children}
        </code>
      );
    }
    return (
      <code
        className="mono text-[0.85em] bg-paper px-1 py-[1px] rounded-[3px] border border-line break-all [overflow-wrap:anywhere]"
        {...rest}
      >
        {children}
      </code>
    );
  },
  pre: ({ children }) => {
    // Extract the language off the embedded <code className="language-xxx">
    // so we can render a tiny tag in the top-right corner. We deliberately
    // don't syntax-highlight — just present the source cleanly.
    const lang = extractLang(children);
    return (
      <div className="relative my-2">
        {lang && (
          <span className="absolute right-2 top-1.5 text-[10px] uppercase tracking-[0.14em] text-ink-muted mono pointer-events-none">
            {lang}
          </span>
        )}
        <pre className="mono text-[12.5px] bg-paper text-ink-soft border border-line rounded-[8px] p-3 overflow-x-auto">
          {children}
        </pre>
      </div>
    );
  },
};

/**
 * Dig the `language-xxx` class off the inner <code> node of a <pre>. Falls
 * back to null if we can't tell — the renderer just skips the tag then.
 */
function extractLang(children: unknown): string | null {
  if (!children || typeof children !== "object") return null;
  // children is typically a single ReactElement — the <code> node.
  const maybe = children as {
    props?: { className?: string };
  };
  const cls = maybe.props?.className;
  if (typeof cls !== "string") return null;
  const m = cls.match(/language-([\w-]+)/);
  return m ? m[1] : null;
}
