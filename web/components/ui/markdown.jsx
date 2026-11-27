import { cn } from "@/lib/utils"
import { remarkTaskLinks } from "@/lib/task-tags"
import { memo, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks"
import remarkGfm from "remark-gfm"
import { CodeBlock, CodeBlockCode, CodeBlockGroup } from "./code-block"
import { CopyButton } from "./copy-button"
import { codeText } from "@/lib/copy-text"

function extractLanguage(className) {
  if (!className) return "plaintext"
  const match = className.match(/language-(\w+)/)
  return match ? match[1] : "plaintext"
}

// One markdown config for the whole console: chat bubbles render it through assistant-ui's
// MarkdownTextPrimitive (web/components/chat/thread.jsx), everything outside a message context
// renders it through the Markdown component below. The primitive reads its text from the message
// part context and takes no text prop, so it cannot serve cards and activity rows directly;
// both paths must keep using THIS list so the two renderers cannot drift.
const INITIAL_COMPONENTS = {
  // "#mention" links come from @tags in chat bodies; only the tag is coloured.
  a: function LinkComponent({ href, children, ...props }) {
    // A button: the chat opens the tagged session (or harness) on tap through event delegation on data-mention.
    if (href === "#mention") return <button type="button" data-mention className="mention rounded-md bg-primary/15 px-1 font-medium text-primary hover:bg-primary/25">{children}</button>
    if (href?.startsWith("#project=") && href.includes("&level=tasks&task=")) return <a href={href} className="font-medium text-primary underline underline-offset-2">{children}</a>
    return <a href={href} target="_blank" rel="noreferrer" className="underline underline-offset-2" {...props}>{children}</a>
  },
  code: function CodeComponent({ className, children, ...props }) {
    const isInline =
      !props.node?.position?.start.line ||
      props.node?.position?.start.line === props.node?.position?.end.line

    if (isInline) {
      return (
        <span
          className={cn(
            "bg-primary-foreground rounded-sm px-1 font-mono text-sm",
            className
          )}
          {...props}
        >
          {children}
        </span>
      )
    }

    const language = extractLanguage(className)

    return (
      <CodeBlock className={className}>
        <CodeBlockGroup className="border-b border-border py-0.5 pr-1 pl-3">
          <div className="font-mono text-xs text-muted-foreground">{language === "plaintext" ? "" : language}</div>
          <CopyButton text={codeText(children)} />
        </CodeBlockGroup>
        <CodeBlockCode code={children} language={language} />
      </CodeBlock>
    );
  },
  pre: function PreComponent({ children }) {
    return <>{children}</>
  },
}

const Markdown = memo(function Markdown({ children, className, taskLinks }) {
  const plugins = useMemo(() => remarkPluginsFor(taskLinks), [taskLinks])
  return (
    <div className={className}>
      <ReactMarkdown remarkPlugins={plugins} components={INITIAL_COMPONENTS}>
        {children || ""}
      </ReactMarkdown>
    </div>
  )
}, function propsAreEqual(prev, next) {
  return prev.children === next.children && prev.taskLinks === next.taskLinks && prev.className === next.className
})

/** The remark plugin list for a task-link map, shared with the assistant-ui bubble renderer. */
export function remarkPluginsFor(taskLinks) {
  return taskLinks ? [remarkGfm, remarkBreaks, [remarkTaskLinks, taskLinks]] : [remarkGfm, remarkBreaks]
}

export { Markdown, INITIAL_COMPONENTS as MARKDOWN_COMPONENTS }
