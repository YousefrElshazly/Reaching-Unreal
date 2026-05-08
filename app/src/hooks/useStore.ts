import { useEffect, useState, useSyncExternalStore } from "react";
import {
  buildAppData,
  getCalendarId,
  getStore,
  hydrateSeedIfEmpty,
  listPresence,
  subscribeAll,
} from "../store/yjs";
import type { AppData, PresenceState } from "../types";
import { getCalendarById } from "../calendars";
import type { Calendar } from "../calendars";

// React's useSyncExternalStore requires the snapshot to be referentially
// stable until the store actually changes. We cache a single snapshot and
// only rebuild it when subscribeAll fires.
let cachedSnapshot: AppData | null = null;

function ensureSnapshot(): AppData {
  if (!cachedSnapshot) cachedSnapshot = buildAppData(getStore());
  return cachedSnapshot;
}

export function useAppData(): AppData {
  return useSyncExternalStore(
    (cb) =>
      subscribeAll(getStore(), () => {
        cachedSnapshot = buildAppData(getStore());
        cb();
      }),
    ensureSnapshot,
    ensureSnapshot
  );
}

export function useCalendarId(): string {
  return useSyncExternalStore(
    (cb) => {
      const store = getStore();
      const handler = () => cb();
      store.meta.observe(handler);
      return () => store.meta.unobserve(handler);
    },
    () => getCalendarId(getStore()),
    () => getCalendarId(getStore())
  );
}

export function useCalendar(): Calendar {
  const id = useCalendarId();
  return getCalendarById(id);
}

export function useEnsureSeeded(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const store = getStore();
    // Wait one tick so y-indexeddb can hydrate before we decide to seed.
    const t = setTimeout(() => {
      hydrateSeedIfEmpty(store);
      setReady(true);
    }, 250);
    return () => clearTimeout(t);
  }, []);
  return ready;
}

export function usePresence(): PresenceState[] {
  const [states, setStates] = useState<PresenceState[]>([]);
  useEffect(() => {
    const store = getStore();
    const update = () => {
      const me = store.awareness.clientID;
      const all = listPresence(store);
      const out: PresenceState[] = [];
      all.forEach((value, key) => {
        if (key === me) return;
        const v = value as {
          user?: { id: string; name: string; color: string };
          cursor?: { x: number; y: number } | null;
        };
        if (!v?.user) return;
        out.push({
          userId: v.user.id,
          name: v.user.name,
          color: v.user.color,
          cursor: v.cursor ?? null,
        });
      });
      setStates(out);
    };
    update();
    store.awareness.on("change", update);
    return () => {
      store.awareness.off("change", update);
    };
  }, []);
  return states;
}

export function useSyncStatus(): "offline" | "connecting" | "connected" | "disconnected" {
  const [s, setS] = useState<"offline" | "connecting" | "connected" | "disconnected">(
    () => getStore().status.value
  );
  useEffect(() => {
    const store = getStore();
    setS(store.status.value);
    const provider = store.provider;
    if (!provider) return;
    const handler = (e: { status: string }) => {
      const next = (e.status as typeof s) ?? "disconnected";
      setS(next);
    };
    provider.on("status", handler);
    return () => {
      provider.off("status", handler);
    };
  }, []);
  return s;
}
