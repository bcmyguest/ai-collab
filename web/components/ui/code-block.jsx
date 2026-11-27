"use client";
import { useEffect, useState } from "react"
import { cn } from "@/lib/utils"
import { highlight } from "@/lib/highlight"

function CodeBlock({
  children,
  className,
  ...props
}) {
  return (
    <div
      className={cn(
        "not-prose flex w-full flex-col overflow-clip border",
        "border-border bg-card text-card-foreground rounded-xl",
        className
      )}
      {...props}
    >
      {children}
    </div>
  )
}

// prompt-kit's CodeBlockCode with a lazy shiki core (JavaScript regex engine, dual light/dark themes); plain text until it loads.
function CodeBlockCode({
  code,
  language,
  className,
  ...props
}) {
  const [html, setHtml] = useState(null)
  useEffect(() => {
    let live = true
    setHtml(null)
    highlight(code, language).then((result) => { if (live) setHtml(result) })
    return () => { live = false }
  }, [code, language])
  const classes = cn("w-full overflow-x-auto text-sm [&>pre]:px-4 [&>pre]:py-4", className)
  return html
    ? <div className={classes} data-language={language} data-highlighted="" dangerouslySetInnerHTML={{ __html: html }} {...props}/>
    : <div className={classes} data-language={language} {...props}><pre><code>{code}</code></pre></div>
}

function CodeBlockGroup({
  children,
  className,
  ...props
}) {
  return (
    <div
      className={cn("flex items-center justify-between", className)}
      {...props}
    >
      {children}
    </div>
  )
}

export { CodeBlockGroup, CodeBlockCode, CodeBlock }
