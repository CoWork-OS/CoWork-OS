import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveFrameSlots } from "../live-frame-slots";

function setup(limit = 3) {
  const slots = new LiveFrameSlots(limit, () => 0, 0);
  const events: string[] = [];
  const add = (id: string) => slots.register(id, (live) => events.push(`${id}:${live}`));
  const live = (ids: string[]) => ids.filter((id) => slots.isLive(id));
  return { slots, events, add, live };
}

describe("LiveFrameSlots", () => {
  it("loads nothing until a frame has been on screen", () => {
    const { slots, events, add, live } = setup();
    add("a");
    add("b");
    expect(live(["a", "b"])).toEqual([]);
    slots.setVisible("b", true);
    expect(live(["a", "b"])).toEqual(["b"]);
    expect(events).toEqual(["b:true"]);
  });

  it("keeps at most the limit live, on-screen frames first", () => {
    const { slots, add, live } = setup();
    const ids = ["a", "b", "c", "d"];
    ids.forEach(add);
    ids.forEach((id) => slots.setVisible(id, true));
    // Four on screen: the one that appeared first is parked.
    expect(live(ids)).toEqual(["b", "c", "d"]);
    slots.setVisible("b", false);
    slots.setVisible("c", false);
    // Off-screen frames stay live while there is room, so scrolling back needs no reload.
    expect(live(ids)).toEqual(["a", "c", "d"]);
  });

  it("parks the least recently used off-screen frame when a new one appears", () => {
    const { slots, events, add, live } = setup();
    const ids = ["a", "b", "c", "d"];
    ids.forEach(add);
    ["a", "b", "c"].forEach((id) => slots.setVisible(id, true));
    ["a", "b", "c"].forEach((id) => slots.setVisible(id, false));
    slots.touch("a");
    events.length = 0;
    slots.setVisible("d", true);
    expect(live(ids)).toEqual(["a", "c", "d"]);
    // The outgoing frame is told first, so it unloads before the new one loads.
    expect(events).toEqual(["b:false", "d:true"]);
  });

  it("brings a clicked frame back, parking another", () => {
    const { slots, add, live } = setup(2);
    ["a", "b", "c"].forEach(add);
    ["a", "b", "c"].forEach((id) => slots.setVisible(id, true));
    expect(live(["a", "b", "c"])).toEqual(["b", "c"]);
    slots.touch("a");
    expect(live(["a", "b", "c"])).toEqual(["a", "c"]);
  });

  it("frees the slot when a frame goes away", () => {
    const { slots, add, live } = setup(1);
    ["a", "b"].forEach(add);
    slots.setVisible("a", true);
    slots.setVisible("b", true);
    expect(live(["a", "b"])).toEqual(["b"]);
    slots.unregister("b");
    expect(live(["a"])).toEqual(["a"]);
  });

  describe("while scrolling", () => {
    afterEach(() => vi.useRealTimers());

    it("loads only the frame the view settles on", () => {
      vi.useFakeTimers();
      const slots = new LiveFrameSlots(1, () => 0, 150);
      const loaded: string[] = [];
      ["a", "b", "c"].forEach((id) => slots.register(id, (live) => live && loaded.push(id)));
      // Scrolled past a and b on the way to c.
      slots.setVisible("a", true);
      vi.advanceTimersByTime(50);
      slots.setVisible("a", false);
      slots.setVisible("b", true);
      vi.advanceTimersByTime(50);
      slots.setVisible("b", false);
      slots.setVisible("c", true);
      expect(loaded).toEqual([]);
      vi.advanceTimersByTime(150);
      expect(loaded).toEqual(["c"]);
    });
  });
});
