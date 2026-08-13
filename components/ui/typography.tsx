/** Shadcn typography roles. Type/color live here — callers pass no className. */
import type { ComponentProps } from "react";

type NoClass<T extends keyof HTMLElementTagNameMap> = Omit<
  ComponentProps<T>,
  "className"
>;

export function TypographyH1(props: NoClass<"h1">) {
  return <h1 className="text-base font-semibold text-foreground" {...props} />;
}

export function TypographyH2(props: NoClass<"h2">) {
  return <h2 className="text-sm font-semibold text-foreground" {...props} />;
}

export function TypographyH3(props: NoClass<"h3">) {
  return (
    <h3
      className="flex min-w-0 flex-1 items-center gap-1.5 text-[11px] font-medium text-dim"
      {...props}
    />
  );
}

export function TypographyH4(props: NoClass<"h4">) {
  return <h4 className="text-sm font-medium text-foreground" {...props} />;
}

export function TypographyP(props: NoClass<"p">) {
  return <p className="text-sm text-foreground" {...props} />;
}

export function TypographyLead(props: NoClass<"p">) {
  return <p className="text-sm text-muted-foreground" {...props} />;
}

export function TypographyLarge(props: NoClass<"div">) {
  return <div className="text-base font-semibold text-foreground" {...props} />;
}

export function TypographySmall(props: NoClass<"small">) {
  return (
    <small
      className="text-[11px] font-normal leading-none text-dim"
      {...props}
    />
  );
}

export function TypographyMuted(props: NoClass<"p">) {
  return <p className="text-xs text-muted-foreground" {...props} />;
}

export function TypographyInlineCode(props: NoClass<"code">) {
  return (
    <code
      className="truncate font-mono text-[11px] text-dim"
      {...props}
    />
  );
}

export function TypographyKicker(props: NoClass<"span">) {
  return (
    <span className="text-[11px] font-normal text-dim" {...props} />
  );
}

export function TypographyCount(props: NoClass<"span">) {
  return (
    <span
      className="shrink-0 text-[11px] font-normal tabular-nums text-dim"
      {...props}
    />
  );
}

export function TypographyPath(props: NoClass<"span">) {
  return (
    <span
      className="min-w-0 truncate font-mono text-[11px] text-dim"
      {...props}
    />
  );
}

export function TypographyBranch(props: NoClass<"span">) {
  return (
    <span
      className="min-w-0 truncate font-mono text-[11px] font-normal text-link"
      {...props}
    />
  );
}

export function TypographyError(props: NoClass<"p">) {
  return <p className="text-sm text-destructive" {...props} />;
}
