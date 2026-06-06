import { AutomationApiCenterClient } from "./AutomationApiCenterClient";
import { AutomationApiCenterErrorBoundary } from "./AutomationApiCenterErrorBoundary";

export default function PlatformAutomationSettingsPage() {
  return (
    <AutomationApiCenterErrorBoundary>
      <AutomationApiCenterClient />
    </AutomationApiCenterErrorBoundary>
  );
}
