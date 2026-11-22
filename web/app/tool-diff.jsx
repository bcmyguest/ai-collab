"use client";
import { Component, lazy, Suspense, useEffect, useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { useTheme } from "next-themes";
import { cn } from "@/lib/utils";
import { limitFiles, patchOf } from "@/lib/tool-diff";

// @pierre/diffs loads on first use: its highlighter and styles stay out of the first page load.
const PatchDiff = lazy(() => import("@pierre/diffs/react").then(mod => ({ default: mod.PatchDiff })));
const WIDE = "(min-width: 768px)";
const THEME = { dark: "github-dark", light: "github-light" };
const BASE = { overflow: "wrap", disableFileHeader: true, disableLineNumbers: true, theme: THEME };

const optionsOf = (diffStyle, themeType) => ({ ...BASE, diffStyle, themeType });
const noteOf = file => file.kind === "delete" ? "File deleted; its content is not in the tool input." : file.notes.join(" · ") || "No changes.";

// Shows the fallback when its child throws, such as a failed chunk load.
class DiffBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

// Split from 768px up, unified below; the view follows the window width.
function useWide() {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const query = window.matchMedia(WIDE);
    const sync = () => setWide(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  return wide;
}

function Counts({ added, removed, className }) {
  return <span className={cn("shrink-0 font-mono", className)}>
    <span className="text-emerald-600 dark:text-emerald-400">+{added}</span>{" "}
    <span className="text-red-600 dark:text-red-400">−{removed}</span>
  </span>;
}

function FileDiff({ file, options }) {
  const patch = patchOf(file);
  const label = file.written ? "written" : file.kind === "add" ? "added" : file.kind === "delete" ? "deleted" : "";
  const plain = <pre className="overflow-x-auto px-2.5 py-1.5 font-mono">{patch}</pre>;
  return <details open className="group min-w-0 overflow-hidden rounded-lg border bg-card text-xs">
    <summary className="flex cursor-pointer list-none items-center gap-2 border-b px-2.5 py-1.5 [&::-webkit-details-marker]:hidden">
      <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90"/>
      <span className="min-w-0 flex-1 truncate font-mono">{file.path}</span>
      {label && <span className="shrink-0 text-muted-foreground">{label}</span>}
      <Counts added={file.added} removed={file.removed}/>
    </summary>
    {file.hunks.length
      ? <>
        {file.notes.length > 0 && <p className="border-b px-2.5 py-1 text-muted-foreground">{file.notes.join(" · ")}</p>}
        <DiffBoundary fallback={plain}>
          <Suspense fallback={plain}>
            <div className="min-w-0 [&_pre]:text-xs">
              <PatchDiff patch={patch} options={options} disableWorkerPool/>
            </div>
          </Suspense>
        </DiffBoundary>
      </>
      : <p className="px-2.5 py-1.5 text-muted-foreground">{noteOf(file)}</p>}
  </details>;
}

/** File diffs of one tool call: each file's path and +/- counts over its diff; more than DIFF_MAX_LINES lines wait behind "Show all". */
export function ToolDiff({ files, truncated = false }) {
  const [all, setAll] = useState(false);
  const wide = useWide();
  const { resolvedTheme } = useTheme();
  const options = useMemo(() => optionsOf(wide ? "split" : "unified", resolvedTheme === "light" ? "light" : "dark"), [wide, resolvedTheme]);
  const { files: shown, hidden } = all ? { files, hidden: 0 } : limitFiles(files);
  return <div className="flex min-w-0 flex-col gap-2">
    {truncated && <p className="text-xs text-muted-foreground">Input truncated; the diff shows the part kept.</p>}
    {shown.map((file, i) => <FileDiff key={file.path + i} file={file} options={options}/>)}
    {hidden > 0 && <button type="button" onClick={() => setAll(true)}
      className="self-start rounded-md border px-2.5 py-1 text-xs font-medium text-primary hover:bg-accent">
      Show all · {hidden} more lines
    </button>}
  </div>;
}

export { Counts };
