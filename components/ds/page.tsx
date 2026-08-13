/** Page chrome. Spacing lives here — callers pass no className. */
import { Button } from "@/components/ui/button";
import type { ComponentProps, ReactNode } from "react";
import { Search } from "lucide-react";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { TypographyH1, TypographyKicker } from "@/components/ui/typography";

type NoClass<T extends keyof HTMLElementTagNameMap> = Omit<
  ComponentProps<T>,
  "className"
>;

export function Page(props: NoClass<"main">) {
  return (
    <main
      className="mx-auto max-w-2xl px-4 pb-16 pt-6 sm:pt-10"
      {...props}
    />
  );
}

export function PageHeader(props: NoClass<"header">) {
  return (
    <header
      className="mb-6 flex items-center justify-between gap-4"
      {...props}
    />
  );
}

export function PageTitle({
  kicker,
  children,
  ...props
}: NoClass<"h1"> & { kicker?: ReactNode }) {
  return (
    <TypographyH1 {...props}>
      {children}
      {kicker ? (
        <>
          {" "}
          <TypographyKicker>{kicker}</TypographyKicker>
        </>
      ) : null}
    </TypographyH1>
  );
}

export function PageSearch({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <InputGroup className="mb-6">
      <InputGroupAddon>
        <Search aria-hidden />
      </InputGroupAddon>
      <InputGroupInput
        type="search"
        placeholder="Search repos, branches, worktrees, sessions…"
        aria-label="Search sessions"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </InputGroup>
  );
}

export function LoginScreen(props: NoClass<"main">) {
  return <main className="grid min-h-dvh place-items-center p-4" {...props} />;
}

export function LoginForm(props: NoClass<"form">) {
  return <form className="flex flex-col gap-4" {...props} />;
}

export function SubmitButton({
  children,
  ...props
}: Omit<ComponentProps<typeof Button>, "className" | "size" | "type">) {
  return (
    <Button type="submit" size="lg" className="w-full" {...props}>
      {children}
    </Button>
  );
}

export function LoginCard({ children }: { children: ReactNode }) {
  return (
    <div className="w-full max-w-sm rounded-xl bg-card py-4 text-sm text-card-foreground ring-1 ring-foreground/10">
      {children}
    </div>
  );
}

export function LoginCardHeader({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-1 px-4">{children}</div>;
}

export function LoginCardBody({ children }: { children: ReactNode }) {
  return <div className="px-4 pt-4">{children}</div>;
}
