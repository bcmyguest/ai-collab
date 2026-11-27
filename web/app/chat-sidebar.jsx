"use client";
// The AFK switch in the thread sidebar's footer; the sidebar itself is thread-sidebar.tsx.
import { Coffee, Monitor, VolumeX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

const AFK_MODES = [["off", "Off", Monitor], ["on", "On", Coffee], ["quiet", "Quiet", VolumeX]];

// Operator away mode, broadcast to every project's agents.
export function AfkToggle({ mode, disabled, set }) {
  const Icon = AFK_MODES.find(([id]) => id === mode)?.[2] || Monitor;
  return <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <Button variant={mode === "off" ? "ghost" : "secondary"} size="sm" aria-label={"AFK mode: " + mode} title={"AFK mode: " + mode} disabled={disabled}>
        <Icon/><span className="text-xs">{mode === "off" ? "AFK" : "AFK " + mode}</span>
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="w-56">
      <DropdownMenuLabel>AFK mode · all projects</DropdownMenuLabel>
      <DropdownMenuRadioGroup value={mode} onValueChange={next => next !== mode && set(next)}>
        {AFK_MODES.map(([id, label, ItemIcon]) => <DropdownMenuRadioItem key={id} value={id}><ItemIcon/>{label}</DropdownMenuRadioItem>)}
      </DropdownMenuRadioGroup>
    </DropdownMenuContent>
  </DropdownMenu>;
}
