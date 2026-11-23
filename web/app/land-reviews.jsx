import { Button } from "@/components/ui/button";

export function LandReviews({ landing, disabled, onLand }) {
  if (!landing) return null;
  const { running, receipts, error } = landing;
  return <section aria-label="Review landing" className="space-y-2">
    <Button type="button" variant="outline" disabled={disabled || running}
      onClick={onLand}>
      {running ? "Landing reviews…" : "Land green reviews"}
    </Button>
    <div role="status" className="text-sm break-words">
      {error && <p>{error}</p>}
      {receipts.length > 0 && <ul className="list-disc space-y-1 pl-5">{receipts.map(item =>
        <li key={item.project + "/" + item.id}>
          {item.project}/{item.id} · {item.landed ? "Landed" : "Failed"} · {item.detail}
        </li>)}</ul>}
      {!running && landing.finished && receipts.length === 0 && !error && <p>No reviews with a merge-when-green answer.</p>}
    </div>
  </section>;
}
