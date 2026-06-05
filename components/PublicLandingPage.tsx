"use client";

import "./menorix-intro.css";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { LogoMark } from "./LogoMark";
import { MenorixWordmark } from "./MenorixWordmark";
import { PlatformBrandingProvider } from "./PlatformBrandingContext";
import { PLATFORM_TAGLINE } from "../lib/platform-branding";

export function PublicLandingPage() {
  return (
    <PlatformBrandingProvider>
      <main className="login-page landing-page">
        <div className="login-page__bg" aria-hidden />

        <section className="landing-page__content">
          <header className="login-page__brand landing-page__brand">
            <LogoMark className="login-page__logo login-page__logo--live !h-[5.4rem] !w-[5.4rem] !rounded-[16px] !border-primary/40 !shadow-none" />
            <h1 className="login-page__title">
              <MenorixWordmark size="login" animated />
            </h1>
            <p className="landing-page__tagline">{PLATFORM_TAGLINE}</p>
          </header>

          <div className="landing-page__hero">
            <h2 className="landing-page__headline">B2B Returns &amp; Recovery Platform</h2>
            <p className="landing-page__description">
              Unify warehouse intake, returns processing, claims recovery, and catalog operations in one
              operational command center built for high-volume ecommerce teams.
            </p>
          </div>

          <ul className="landing-page__features" aria-label="Platform capabilities">
            <li>Returns intake and warehouse scanning</li>
            <li>Claims engine and evidence workflows</li>
            <li>Product catalog and import pipelines</li>
            <li>Multi-tenant organization controls</li>
          </ul>

          <div className="landing-page__cta">
            <Link href="/login" className="admin-btn-primary landing-page__cta-btn">
              Sign in to Menorix
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
            <p className="landing-page__cta-note">
              Authorized team members only. Contact your administrator for access.
            </p>
          </div>
        </section>
      </main>
    </PlatformBrandingProvider>
  );
}
