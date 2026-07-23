import { cn } from "@/lib/utils"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn(
        "animate-pulse rounded-md bg-secondary motion-reduce:animate-none",
        className
      )}
      style={{ animationDuration: '1.2s' }}
      {...props}
    />
  )
}

export { Skeleton }
