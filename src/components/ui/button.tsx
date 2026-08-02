import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-md font-medium whitespace-nowrap transition-all outline-none focus-visible:ring-[2px] focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-45 aria-invalid:border-destructive aria-invalid:ring-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        // Primary — brand-filled (DESIGN_SPEC §4).
        default: "bg-primary text-primary-foreground hover:bg-brand-hover",
        // Danger — subtle error bg/text/border, not a solid red fill.
        destructive:
          "border border-error/35 bg-error-subtle text-error hover:brightness-110",
        outline:
          "border border-border bg-transparent hover:border-border-strong",
        // Secondary (default surface) — bg-panel-2 + hairline border.
        secondary:
          "border border-border bg-secondary text-secondary-foreground hover:border-border-strong",
        // Ghost/icon — transparent, text-light, hover bg-hover + text.
        ghost: "text-text-light hover:bg-accent hover:text-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-8 gap-2 px-3 has-[>svg]:px-2.5",
        sm: "h-[26px] gap-1.5 rounded-md px-2 text-sm has-[>svg]:px-1.5",
        lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
        icon: "size-8",
        "icon-sm": "size-[26px] [&_svg:not([class*='size-'])]:size-3.5",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
