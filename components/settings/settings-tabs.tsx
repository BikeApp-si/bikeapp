import { Segmented } from "@/components/segmented";

// Settings' Company | Instance, in the open Bike only (docs/design/o2/c-instance.png). The hosted service runs the
// servers itself, so it has no Instance page and no tabs.
export function SettingsTabs({ on }: { on: "company" | "instance" | "ai" }) {
  return (
    <Segmented
      items={[
        { label: "Company", href: "/settings", active: on === "company" },
        { label: "Instance", href: "/settings/instance", active: on === "instance" },
        { label: "AI", href: "/settings/ai", active: on === "ai" },
      ]}
    />
  );
}
