import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TeamDevice } from "../../utils/team-view";
import { TeamDeviceCard } from "./TeamDeviceCard";

const local: TeamDevice = {
  id: "local",
  name: "This Mac",
  local: true,
  online: true,
  statusLabel: "This device",
  running: 0,
  waiting: 0,
};

describe("TeamDeviceCard", () => {
  it("shows the local device without a misleading remote-management button", () => {
    const html = renderToStaticMarkup(<TeamDeviceCard device={local} onOpen={vi.fn()} />);
    expect(html).toContain("This Mac");
    expect(html).toContain("This device");
    expect(html).not.toContain("<button");
  });

  it("opens the selected remote device", () => {
    const onOpen = vi.fn();
    const device = { ...local, id: "remote-1", name: "Remote Mac", local: false };
    const card = TeamDeviceCard({ device, onOpen });
    expect(renderToStaticMarkup(card)).toContain("<button");
    card.props.onClick();
    expect(onOpen).toHaveBeenCalledWith("remote-1");
  });
});
