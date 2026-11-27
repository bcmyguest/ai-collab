export type CopyEnv = {
  navigator?: { clipboard?: { writeText?: (text: string) => Promise<void> } }
  document?: Pick<Document, "body" | "createElement" | "execCommand">
  isSecureContext?: boolean
}

/** Copies text with the async clipboard API, or with execCommand on plain-http pages where that API is absent. */
export async function copyText(text: string, env: CopyEnv = globalThis): Promise<boolean> {
  const clipboard = env.isSecureContext === false ? undefined : env.navigator?.clipboard
  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(text)
      return true
    } catch {
      // A denied permission still leaves the execCommand path.
    }
  }
  const doc = env.document
  if (!doc?.body) return false
  const area = doc.createElement("textarea")
  area.value = text
  area.readOnly = true
  area.style.position = "fixed"
  area.style.top = "0"
  area.style.left = "0"
  area.style.opacity = "0"
  doc.body.append(area)
  try {
    area.select()
    return doc.execCommand("copy")
  } catch {
    return false
  } finally {
    area.remove()
  }
}

/** The raw text of a react-markdown code node: its string children, without the newline that closes the fence. */
export function codeText(children: unknown): string {
  const text = Array.isArray(children) ? children.filter(part => typeof part === "string").join("") : typeof children === "string" ? children : ""
  return text.endsWith("\n") ? text.slice(0, -1) : text
}
