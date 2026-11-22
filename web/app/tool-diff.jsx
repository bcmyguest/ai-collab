"use client";
import { lazy, Suspense, useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { limitFiles, patchOf } from "@/lib/tool-diff";

// @pierre/diffs loads on first use: its highlighter and styles stay out of the first page load.
const PatchDiff = lazy(() => import("@pierre/diffs/react").then(mod => ({ default: mod.PatchDiff })));
const WIDE = "(min-width: 768px)";
const THEME = { dark: "github-dark", light: "github-light" };
const OPTIONS = {
  unified: { diffStyle: "unified", overflow: "wrap", disableFileHeader: true, disableLineNumbers: true, theme: THEME },
  split: { diffStyle: "split", overflow: "wrap", disableFileHeader: true, disableLineNumbers: true, theme: THEME },
};

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
  const note = file.kind === "delete" ? "deleted" : file.kind === "add" ? "added" : "";
  return <details open className="group min-w-0 overflow-hidden rounded-lg border bg-card text-xs">
    <summary className="flex cursor-pointer list-none items-center gap-2 border-b px-2.5 py-1.5 [&::-webkit-details-marker]:hidden">
      <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90"/>
      <span className="min-w-0 flex-1 truncate font-mono">{file.path}</span>
      {note && <span className="shrink-0 text-muted-foreground">{note}</span>}
      <Counts added={file.added} removed={file.removed}/>
    </summary>
    {file.hunks.length
      ? <Suspense fallback={<pre className="overflow-x-auto px-2.5 py-1.5 font-mono">{patch}</pre>}>
        <div className="min-w-0 [&_pre]:text-xs">
          <PatchDiff patch={patch} options={options} disableWorkerPool/>
        </div>
      </Suspense>
      : <p className="px-2.5 py-1.5 text-muted-foreground">{file.kind === "delete" ? "File deleted; its content is not in the tool input." : "No changes."}</p>}
  </details>;
}

/** File diffs of one tool call: each file's path and +/- counts over its diff; more than DIFF_MAX_LINES lines wait behind "Show all". */
export function ToolDiff({ files }) {
  const [all, setAll] = useState(false);
  const wide = useWide();
  const { files: shown, hidden } = all ? { files, hidden: 0 } : limitFiles(files);
  const options = wide ? OPTIONS.split : OPTIONS.unified;
  return <div className="flex min-w-0 flex-col gap-2">
    {shown.map((file, i) => <FileDiff key={file.path + i} file={file} options={options}/>)}
    {hidden > 0 && <button type="button" onClick={() => setAll(true)}
      className="self-start rounded-md border px-2.5 py-1 text-xs font-medium text-primary hover:bg-accent">
      Show all · {hidden} more lines
    </button>}
  </div>;
}

export { Counts };
