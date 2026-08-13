"use client";

import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  TypographyError,
  TypographyMuted,
} from "@/components/ui/typography";
import {
  LoginCard,
  LoginCardBody,
  LoginCardHeader,
  LoginForm,
  LoginScreen,
  PageTitle,
  SubmitButton,
} from "@/components/ds/page";
import { useLogin } from "./use-login";

export default function LoginPage() {
  const { form, passwordValidators, serverError } = useLogin();

  return (
    <LoginScreen>
      <LoginCard>
        <LoginCardHeader>
          <PageTitle kicker="on this Mac">OMP Sessions</PageTitle>
          <TypographyMuted>
            Enter the dashboard password shown during setup to view and join
            your sessions.
          </TypographyMuted>
        </LoginCardHeader>
        <LoginCardBody>
          <LoginForm
            onSubmit={(event) => {
              event.preventDefault();
              form.handleSubmit();
            }}
          >
            <form.Field name="password" validators={passwordValidators}>
              {(field) => (
                <Field data-invalid={field.state.meta.errors.length > 0}>
                  <FieldLabel htmlFor={field.name}>Password</FieldLabel>
                  <Input
                    id={field.name}
                    name={field.name}
                    type="password"
                    className="h-11"
                    autoComplete="current-password"
                    autoFocus
                    value={field.state.value}
                    onChange={(event) => field.handleChange(event.target.value)}
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
            {serverError ? (
              <TypographyError role="alert">{serverError}</TypographyError>
            ) : null}
            <form.Subscribe selector={(state) => state.isSubmitting}>
              {(isSubmitting) => (
                <SubmitButton disabled={isSubmitting} aria-busy={isSubmitting}>
                  {isSubmitting ? <Spinner /> : null}
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
