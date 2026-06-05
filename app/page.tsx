import type { Metadata } from "next";
import { PublicLandingPage } from "@/components/PublicLandingPage";
import { getPlatformAppNameForMetadata } from "@/lib/platform-settings-read";

const SITE_URL = "https://menorix.com";
const LANDING_DESCRIPTION =
  "Menorix is a B2B returns and recovery platform for warehouse intake, claims operations, and catalog management.";

export async function generateMetadata(): Promise<Metadata> {
  const appName = await getPlatformAppNameForMetadata();
  const title = `${appName} — B2B Returns & Recovery Platform`;

  return {
    title,
    description: LANDING_DESCRIPTION,
    alternates: {
      canonical: SITE_URL,
    },
    openGraph: {
      type: "website",
      url: SITE_URL,
      title,
      description: LANDING_DESCRIPTION,
      siteName: appName,
    },
    twitter: {
      card: "summary",
      title,
      description: LANDING_DESCRIPTION,
    },
  };
}

/** Public marketing entry — crawlers and unauthenticated visitors get 200 OK (no redirect to /login). */
export default function HomePage() {
  return <PublicLandingPage />;
}
