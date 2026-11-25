import { cn } from "@/lib/utils"
import { Markdown } from "./markdown"

// The markdown bubble the cards and the activity rows render outside a chat message context.
// Chat bubbles render through assistant-ui's MessagePrimitive instead (web/components/chat/thread.jsx).
const MessageContent = ({
  children,
  markdown = false,
  className,
  ...props
}) => {
  const classNames = cn(
    "rounded-lg p-2 text-foreground bg-secondary prose break-words whitespace-normal",
    className
  )

  return markdown ? (
    <Markdown className={classNames} {...props}>
      {children}
    </Markdown>
  ) : (
    <div className={classNames} {...props}>
      {children}
    </div>
  );
}

export { MessageContent }
