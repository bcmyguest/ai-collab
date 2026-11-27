import { quoteText } from "@/lib/quote";

const QUOTE_CLASS = "flex max-w-full min-w-0 items-baseline gap-1.5 rounded-lg border-l-2 border-primary/50 bg-muted/60 px-2 py-1 text-left text-xs text-muted-foreground";

/** The replied message above a reply's body; a tap scrolls to the original. A quote without an id stays static. */
export function Quote({ quote, label }) {
  const content = <>
    <span className="shrink-0 font-medium text-foreground">{label}</span>
    <span className="min-w-0 truncate">{quoteText(quote.body)}</span>
  </>;
  if (!quote.id) return <div data-quote="" className={QUOTE_CLASS}>{content}</div>;
  const id = CSS.escape(quote.id);
  const scroll = () => document.querySelector('[data-message-id="' + id + '"], [data-reply-id="' + id + '"]')?.scrollIntoView({ block: "center" });
  return <button type="button" data-quote={quote.id} onClick={scroll} title="Go to the replied message" className={QUOTE_CLASS}>{content}</button>;
}
