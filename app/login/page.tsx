"use client";

import { useForm } from "@tanstack/react-form";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { api, ApiError, postJson } from "@/app/components/api";

export default function LoginPage() {
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);

  const form = useForm({
    defaultValues: { password: "" },
    onSubmit: async ({ value }) => {
      setServerError(null);
      try {
        await api<{ ok: true }>(
          "/api/auth/login",
          postJson({ password: value.password }),
        );
        router.replace("/");
      } catch (err) {
        setServerError(
          err instanceof ApiError
            ? err.status === 401
              ? "Wrong password."
              : err.message
            : "Can't reach the server. Check your connection.",
        );
      }
    },
  });

  return (
    <main className="grid min-h-dvh place-items-center p-4">
      <Card className="w-full max-w-sm border-border bg-card">
        <CardHeader>
          <CardTitle className="text-base font-semibold">OMP Sessions</CardTitle>
          <CardDescription className="text-[11px] text-dim">
            Enter the dashboard password shown during setup.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              form.handleSubmit();
            }}
            className="flex flex-col gap-4"
          >
            <form.Field
              name="password"
              validators={{
                onSubmit: ({ value }) =>
                  value.length === 0 ? "Password is required." : undefined,
              }}
            >
              {(field) => (
                <Field data-invalid={field.state.meta.errors.length > 0}>
                  <FieldLabel htmlFor={field.name}>Password</FieldLabel>
                  <Input
                    id={field.name}
                    name={field.name}
                    type="password"
                    autoComplete="current-password"
                    autoFocus
                    value={field.state.value}
                    onChange={(e) => field.handleChange(e.target.value)}
                    onBlur={field.handleBlur}
                    aria-invalid={field.state.meta.errors.length > 0}
                  />
                  <FieldError
                    errors={field.state.meta.errors.map((message) =>
                      message ? { message } : undefined,
                    )}
                  />
                </Field>
              )}
            </form.Field>
            {serverError && (
              <p role="alert" className="text-sm text-destructive">
                {serverError}
              </p>
            )}
            <form.Subscribe selector={(s) => s.isSubmitting}>
              {(isSubmitting) => (
                <Button
                  type="submit"
                  size="lg"
                  className="w-full"
                  disabled={isSubmitting}
                >
                  {isSubmitting && <Spinner />}
                  {isSubmitting ? "Signing in…" : "Sign in"}
                </Button>
              )}
            </form.Subscribe>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
