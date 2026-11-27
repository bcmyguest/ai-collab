"use client"

import { useEffect, useRef, useState } from "react"
import { Button } from "@ui-sdk/react/button"
import { CheckIcon, CopyIcon } from "lucide-react"
import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { copyText } from "@/lib/copy-text"

const COPIED_MS = 1500

export function CopyButton({ text, className }: { text: string; className?: string }) {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const [copied, setCopied] = useState(false)

  useEffect(() => () => clearTimeout(timer.current), [])

  async function copy() {
    if (!(await copyText(text))) return
    clearTimeout(timer.current)
    setCopied(true)
    timer.current = setTimeout(() => setCopied(false), COPIED_MS)
  }

  return (
    <div className={cn("flex items-center gap-1", className)}>
      {/* Reserved width keeps the row still while the word comes and goes. */}
      <span role="status" aria-live="polite" className="w-12 text-right text-xs text-muted-foreground">
        {copied ? "Copied" : ""}
      </span>
      <Button
        aria-label="Copy code"
        pendingAnnouncement=""
        className={cn(buttonVariants({ variant: "ghost", size: "icon-sm" }), "text-muted-foreground pointer-coarse:size-9")}
        onClick={copy}
      >
        {copied ? <CheckIcon className="size-3.5" aria-hidden="true" /> : <CopyIcon className="size-3.5" aria-hidden="true" />}
      </Button>
    </div>
  )
}
