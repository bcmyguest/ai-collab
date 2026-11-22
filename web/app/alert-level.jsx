import { DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";

// Which notifications buzz the phone; every message still reaches the chat.
export const ALERT_LEVELS = [["all", "All"], ["questions-and-direct", "Questions and direct replies"], ["questions", "Questions only"], ["none", "None"]];

/** The phone alert level as radio items inside the Notifications menu (server-side, honoured by hooks and the UI). */
export function AlertLevelItems({ level = "all", set }) {
  return <>
    <DropdownMenuSeparator/>
    <DropdownMenuLabel>Phone alerts</DropdownMenuLabel>
    <DropdownMenuRadioGroup value={level} onValueChange={set}>
      {ALERT_LEVELS.map(([id, text]) => <DropdownMenuRadioItem key={id} value={id}>{text}</DropdownMenuRadioItem>)}
    </DropdownMenuRadioGroup>
  </>;
}
