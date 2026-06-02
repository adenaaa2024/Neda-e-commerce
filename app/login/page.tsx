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
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-10">
      <section className="admin-modal-shell w-full max-w-md p-6">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Login</h1>
        <p className="mt-2 text-sm text-muted-foreground">Sign in with your email and password.</p>

        <form
          id="login-form"
          className="mt-6 space-y-4"
          onSubmit={handleSubmit}
          method="post"
        >
          <div>
            <label htmlFor="email" className="admin-form-label mb-1">
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
              className="admin-form-input admin-form-input--sm"
            />
          </div>

          <div>
            <label htmlFor="password" className="admin-form-label mb-1">
              Password
            </label>
            <div className="relative">
              <input
                id="password"
                name="password"
                type={showPassword ? "text" : "password"}
                required
                autoComplete="current-password"
                className="admin-form-input admin-form-input--sm py-2 pl-3 pr-10"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="absolute right-0 top-0 flex h-10 w-10 items-center justify-center rounded-r-lg text-muted-foreground transition hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-pressed={showPassword}
                aria-label={showPassword ? "Hide password" : "Show password"}
                tabIndex={-1}
              >
                {showPassword ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />}
              </button>
            </div>
          </div>

          {errorMessage && (
            <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {errorMessage}
            </p>
          )}

          <button
            type="submit"
            disabled={isSubmitting}
            className="admin-btn-primary h-10 w-full text-sm disabled:cursor-not-allowed disabled:opacity-60"
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
