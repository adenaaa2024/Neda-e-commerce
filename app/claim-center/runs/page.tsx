import { redirect } from "next/navigation";

/** V2 canonical route is /claim-center/sources */
export default function ClaimCenterRunsRedirectPage() {
  redirect("/claim-center/sources");
}
