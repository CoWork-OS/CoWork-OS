import { useEffect, useRef } from "react";

/** Fences independent inbox reads across newer requests, unmounts and StrictMode remounts. */
export class InboxRequests {
  private epoch = 0;
  private active = false;
  private generations = new Map<string, number>();

  activate() {
    this.epoch += 1;
    this.active = true;
  }

  deactivate() {
    this.active = false;
    this.epoch += 1;
  }

  capture(channel: string, matchesContext: () => boolean = () => true): () => boolean {
    const epoch = this.epoch;
    const generation = (this.generations.get(channel) ?? 0) + 1;
    this.generations.set(channel, generation);
    return () =>
      this.active &&
      epoch === this.epoch &&
      generation === this.generations.get(channel) &&
      matchesContext();
  }
}

export function useInboxRequests() {
  const requests = useRef<InboxRequests | null>(null);
  if (!requests.current) requests.current = new InboxRequests();
  const scope = requests.current;
  useEffect(() => {
    scope.activate();
    return () => scope.deactivate();
  }, [scope]);
  return scope;
}
