"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { Eye, EyeOff } from "lucide-react";
import { supabase } from "@/src/lib/supabase";

/**
 * Uncontrolled email/password (no `value=`) so the browser can refill.
 * After successful auth, `navigator.credentials.store(PasswordCredential)` is needed because
 * `preventDefault` on submit stops the default navigation flow where Chrome’s save prompt usually runs.
 */
async function tryOfferSavePassword(
  email: string,
  password: string,
): Promise<void> {
  if (typeof globalThis === "undefined" || !globalThis.isSecureContext) return;
  if (!("PasswordCredential" in globalThis) || !navigator.credentials?.store) return;
  try {
    const C = (globalThis as unknown as {
      PasswordCredential: new (d: { id: string; password: string; name: string }) => Credential;
    }).PasswordCredential;
    const cred = new C({
      id: email,
      password,
      name: email,
    });
    await navigator.credentials.store(cred);
  } catch {
    // Declined, unsupported, or no permission — optional dialog is browser-specific.
  }
}

export default function LoginPage() {
  const router = useRouter();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorMessage(null);
    setIsSubmitting(true);

    const form = event.currentTarget;
    const formData = new FormData(form);
    const email = String(formData.get("email") ?? "").trim();
    const password = String(formData.get("password") ?? "");

    try {
      const response = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (response.error) {
        setErrorMessage(response.error.message || "Login failed. Please try again.");
        return;
      }

      await tryOfferSavePassword(email, password);

      router.push("/");
      router.refresh();
    } catch (error) {
      console.error("[login] submit exception:", error);
      setErrorMessage("Unexpected login error. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-10 dark:bg-slate-950">
      <section className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-950/70">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-slate-50">Login</h1>
        <p className="mt-2 text-sm text-muted-foreground">Sign in with your email and password.</p>

        <form
          id="login-form"
          className="mt-6 space-y-4"
          onSubmit={handleSubmit}
          method="post"
        >
          <div>
            <label htmlFor="email" className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              inputMode="email"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="you@example.com"
              required
              autoComplete="username"
              className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm text-slate-900 outline-none transition focus:border-primary focus:ring-1 focus:ring-ring dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
            />
          </div>

          <div>
            <label htmlFor="password" className="mb-1 block text-sm font-medium text-slate-700 dark:text-slate-300">
              Password
            </label>
            <div className="relative">
              <input
                id="password"
                name="password"
                type={showPassword ? "text" : "password"}
                required
                autoComplete="current-password"
                className="h-10 w-full rounded-lg border border-slate-200 bg-white py-2 pl-3 pr-10 text-sm text-slate-900 outline-none transition focus:border-primary focus:ring-1 focus:ring-ring dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="absolute right-0 top-0 flex h-10 w-10 items-center justify-center rounded-r-lg text-slate-500 transition hover:text-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:text-slate-400 dark:hover:text-slate-200"
                aria-pressed={showPassword}
                aria-label={showPassword ? "Hide password" : "Show password"}
                tabIndex={-1}
              >
                {showPassword ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
              </button>
            </div>
          </div>

          {errorMessage && (
            <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-200">
              {errorMessage}
            </p>
          )}

          <button
            type="submit"
            disabled={isSubmitting}
            className="inline-flex h-10 w-full items-center justify-center rounded-lg border border-slate-200 bg-slate-900 text-sm font-medium text-slate-50 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-700 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
          >
            {isSubmitting ? "Signing in..." : "Sign in"}
          </button>

          <div className="flex items-center gap-2.5 pt-1">
            <input
              id="remember-device"
              type="checkbox"
              defaultChecked
              className="h-4 w-4 shrink-0 rounded border-slate-300 text-primary focus:ring-ring"
            />
            <label
              htmlFor="remember-device"
              className="text-sm font-medium text-slate-800 dark:text-slate-200"
            >
              Remember me
            </label>
          </div>
        </form>
      </section>
    </main>
  );
}
