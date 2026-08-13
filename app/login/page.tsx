"use client";

import { useForm } from "@tanstack/react-form";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  TypographyError,
  TypographyH1,
  TypographyMuted,
} from "@/components/ui/typography";
import { LoginForm, LoginScreen, SubmitButton } from "@/components/ds/page";
import {
  LoginCard,
  LoginCardBody,
  LoginCardHeader,
} from "@/components/ds/session";
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
    <LoginScreen>
      <LoginCard>
        <LoginCardHeader>
          <TypographyH1>OMP Sessions</TypographyH1>
          <TypographyMuted>
            Enter the dashboard password shown during setup.
          </TypographyMuted>
        </LoginCardHeader>
        <LoginCardBody>
          <LoginForm
            onSubmit={(e) => {
              e.preventDefault();
              form.handleSubmit();
            }}
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
              <TypographyError role="alert">{serverError}</TypographyError>
            )}
            <form.Subscribe selector={(s) => s.isSubmitting}>
              {(isSubmitting) => (
                <SubmitButton disabled={isSubmitting}>
                  {isSubmitting && <Spinner />}
                  {isSubmitting ? "Signing in…" : "Sign in"}
                </SubmitButton>
              )}
            </form.Subscribe>
          </LoginForm>
        </LoginCardBody>
      </LoginCard>
    </LoginScreen>
  );
}
