import { DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { ALERT_LEVELS } from "@/lib/alert-level";

// Which notifications buzz the phone; every message still reaches the chat. The levels and their ids live in web/lib.
export { ALERT_LEVELS };

/** The phone alert level as radio items inside the Notifications menu (server-side, honoured by hooks and the UI). */
export function AlertLevelItems({ level, set }) {
  return <>
    <DropdownMenuSeparator/>
    <DropdownMenuLabel>Phone alerts</DropdownMenuLabel>
    <DropdownMenuRadioGroup value={level} onValueChange={set}>
      {ALERT_LEVELS.map(([id, text]) => <DropdownMenuRadioItem key={id} value={id}>{text}</DropdownMenuRadioItem>)}
    </DropdownMenuRadioGroup>
  </>;
}
