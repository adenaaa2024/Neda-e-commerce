import { NextResponse } from "next/server";

import {
  buildPwaVersionEndpointPayload,
  getPlatformPwaSettings,
} from "@/lib/pwa-settings-read";

/** Public read-only Menorix PWA version policy — no auth required (anon RLS on platform_settings). */
export async function GET(): Promise<Response> {
  const settings = await getPlatformPwaSettings();
  const payload = buildPwaVersionEndpointPayload(settings);
  return NextResponse.json(payload, {
    headers: {
      "Cache-Control": "no-store, max-age=0",
    },
  });
}
