import { Bell } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

// Which notifications buzz the phone; every message still reaches the chat.
export const ALERT_LEVELS = [["all", "All"], ["questions-and-direct", "Questions and direct replies"], ["questions", "Questions only"], ["none", "None"]];

/** Phone alerts: which notifications buzz (server-side, honoured by hooks and the UI). */
export function AlertLevel({ level = "all", set, disabled }) {
  const label = ALERT_LEVELS.find(([id]) => id === level)?.[1] || "All";
  return <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <Button variant="ghost" size="icon" aria-label={"Phone alerts: " + label} title={"Phone alerts: " + label} disabled={disabled}><Bell/></Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end">
      <DropdownMenuLabel>Phone alerts</DropdownMenuLabel>
      <DropdownMenuRadioGroup value={level} onValueChange={set}>
        {ALERT_LEVELS.map(([id, text]) => <DropdownMenuRadioItem key={id} value={id}>{text}</DropdownMenuRadioItem>)}
      </DropdownMenuRadioGroup>
    </DropdownMenuContent>
  </DropdownMenu>;
}
