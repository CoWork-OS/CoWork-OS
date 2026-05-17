import { Bell, Laptop, Monitor, Sparkles } from "lucide-react";

export function RemoteDeviceControlVisual() {
  return (
    <section className="remote-device-visual" aria-label="Remote device control overview">
      <div className="remote-device-visual-hero" aria-hidden="true">
        <div className="remote-device-laptop">
          <div className="remote-device-laptop-screen">
            <span />
            <span />
            <span />
          </div>
          <div className="remote-device-laptop-base" />
        </div>
        <div className="remote-device-connection-dots">
          <span />
          <span />
          <span />
        </div>
        <div className="remote-device-node">
          <Monitor size={26} strokeWidth={1.7} />
        </div>
      </div>

      <div className="remote-device-visual-body">
        <h3>Control other devices from this Mac</h3>
        <p>Connect another CoWork OS device, then start and monitor work from here.</p>

        <div className="remote-device-visual-points">
          <div className="remote-device-visual-point">
            <Laptop size={18} strokeWidth={1.8} />
            <div>
              <strong>Pick up where you left off</strong>
              <span>Open remote tasks and continue the thread from this device.</span>
            </div>
          </div>
          <div className="remote-device-visual-point">
            <Bell size={18} strokeWidth={1.8} />
            <div>
              <strong>Stay in the loop</strong>
              <span>See status, approvals, alerts, and task history for connected machines.</span>
            </div>
          </div>
          <div className="remote-device-visual-point">
            <Sparkles size={18} strokeWidth={1.8} />
            <div>
              <strong>Start something remotely</strong>
              <span>Send a task to a Mac mini, workstation, or server with its own tools.</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
