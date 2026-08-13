"use client";

import { useForm } from "@tanstack/react-form";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, ApiError, postJson } from "@/app/components/api";

const passwordValidators = {
  onSubmit: ({ value }: { value: string }) =>
    value.length === 0 ? "Password is required." : undefined,
};

export function useLogin() {
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
      } catch (error) {
        setServerError(
          error instanceof ApiError
            ? error.status === 401
              ? "Wrong password."
              : error.message
            : "Can't reach the server. Check your connection.",
        );
      }
    },
  });

  return { form, passwordValidators, serverError };
}
