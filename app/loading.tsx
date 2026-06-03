import { MenorixIntroSplash } from "@/components/MenorixIntroSplash";

/** Route-level loading — Menorix intro while Next.js streams the page. */
export default function Loading() {
  return (
    <MenorixIntroSplash durationMs={5200} variant="admin">
      <div className="min-h-[50vh]" aria-hidden />
    </MenorixIntroSplash>
  );
}
