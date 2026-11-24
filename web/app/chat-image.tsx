"use client";

import { FileInput, FileInputDropzone, FileInputTrigger } from "@ui-sdk/react/file-input";
import { useEffect, useState, type ReactNode } from "react";
import { Paperclip, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const IMAGE_TYPES = [".png", ".jpg", ".jpeg", ".gif", ".webp"];

export function ImagePicker({ files, onChange, onError, disabled, children }: {
  files: File[];
  onChange: (files: File[]) => void;
  onError: (message: string) => void;
  disabled: boolean;
  children: ReactNode;
}) {
  return <FileInput name="image" value={files} onValueChange={onChange} disabled={disabled}
    accept={IMAGE_TYPES} maxSize={MAX_IMAGE_BYTES} minSize={1}
    onReject={([file]) => onError(file?.reasons.includes("file-too-large") ? "Choose an image up to 15 MB." : "Choose a PNG, JPEG, GIF, or WebP image.")}>
    <FileInputDropzone pasteTarget="#composer" className="rounded-3xl data-drag-accept:outline-2 data-drag-accept:outline-ring">
      {children}
    </FileInputDropzone>
  </FileInput>;
}

export function AttachImageButton({ replacing }: { replacing: boolean }) {
  const label = replacing ? "Replace image" : "Attach image";
  return <FileInputTrigger aria-label={label} title={label}
    render={<Button variant="ghost" size="icon" className="size-11 rounded-full sm:size-8"/>}>
    <Paperclip aria-hidden="true"/>
  </FileInputTrigger>;
}

export function ChatImage({ attachment, compact = false }: { attachment: { file: string; name: string }; compact?: boolean }) {
  const src = "/api/file/" + encodeURIComponent(attachment.file);
  const [unavailable, setUnavailable] = useState(false);
  return <a href={src} target="_blank" rel="noreferrer"
    className="block w-fit max-w-full overflow-hidden rounded-xl border bg-card focus-visible:outline-2 focus-visible:outline-ring">
    {!unavailable && <img src={src} alt="" loading="lazy" onError={() => setUnavailable(true)}
      className={cn("w-auto max-w-full object-contain", compact ? "max-h-20" : "max-h-96")}/>}
    <span className="block break-all px-3 py-1.5 text-sm underline">{attachment.name}</span>
    {unavailable && <span className="block px-3 pb-1.5 text-xs text-muted-foreground">Image unavailable</span>}
  </a>;
}

export function ImageDraft({ file, disabled, remove }: { file: File; disabled: boolean; remove: () => void }) {
  const [src, setSrc] = useState("");
  useEffect(() => {
    const url = URL.createObjectURL(file);
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return <div className="mx-1 mb-1 flex min-w-0 items-center gap-2 rounded-xl border px-2">
    {src && <img src={src} alt="" className="size-10 shrink-0 rounded-md object-contain"/>}
    <span className="min-w-0 flex-1 truncate text-sm" title={file.name}>{file.name}</span>
    <Button type="button" variant="ghost" size="icon" className="size-11 sm:size-8" disabled={disabled}
      aria-label="Remove image" onClick={remove}><X aria-hidden="true"/></Button>
  </div>;
}
