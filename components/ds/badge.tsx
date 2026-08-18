import type { ComponentProps } from "react";
import { cva, type VariantProps } from "class-variance-authority";

const badgeVariants = cva(
  "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-md border font-normal tabular-nums whitespace-nowrap [&>svg]:pointer-events-none",
  {
    variants: {
      variant: {
        neutral: "border-border bg-secondary text-muted-foreground",
        success: "border-ok/30 bg-ok/10 text-ok",
        warning: "border-warn/40 bg-warn/10 text-warn",
        destructive:
          "border-destructive/40 bg-destructive/10 text-destructive",
        info: "border-link/40 bg-link/10 text-link",
        merge:
          "border-violet-500/40 bg-violet-500/10 text-violet-700 dark:text-violet-300",
      },
      size: {
        xs: "h-5 gap-1 px-1.5 text-[10px] [&>svg]:size-3",
        sm: "h-6 gap-1 px-1.5 text-[11px] [&>svg]:size-3",
        md: "h-7 gap-1.5 px-2 text-[11px] [&>svg]:size-3.5",
      },
      stretch: {
        true: "w-full",
        false: "w-fit",
      },
    },
    defaultVariants: {
      variant: "neutral",
      size: "sm",
      stretch: false,
    },
  },
);

export type BadgeVariant = NonNullable<
  VariantProps<typeof badgeVariants>["variant"]
>;
export type BadgeSize = NonNullable<
  VariantProps<typeof badgeVariants>["size"]
>;

export function Badge({
  variant = "neutral",
  size = "sm",
  stretch = false,
  ...props
}: Omit<ComponentProps<"span">, "className"> &
  VariantProps<typeof badgeVariants>) {
  return (
    <span
      data-slot="badge"
      data-variant={variant}
      data-size={size}
      className={badgeVariants({ variant, size, stretch })}
      {...props}
    />
  );
}
