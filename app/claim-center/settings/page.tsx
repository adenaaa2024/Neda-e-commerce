import { redirect } from "next/navigation";

/** Settings overview moved to Policies — keep route as alias. */
export default function ClaimCenterSettingsAliasPage() {
  redirect("/claim-center/policies");
}
