import * as React from "react"

import { cn } from "@/lib/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full rounded-md border border-border bg-secondary px-3 py-2 font-mono text-md transition-[border-color,box-shadow] outline-none placeholder:text-text-muted focus-visible:border-border-strong focus-visible:ring-[2px] focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-45 aria-invalid:border-destructive aria-invalid:ring-destructive/20",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
