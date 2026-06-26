import { useEffect, useState, useSyncExternalStore } from "react";
import {
  buildAppData,
  getCalendarId,
  getNote,
  getPlans,
  getStore,
  getSyncState,
  hydrateSeedIfEmpty,
  listPresence,
  setupSyncLifecycle,
  subscribeAll,
  type SyncState,
} from "../store/yjs";
import type { AppData, Plan, PresenceState } from "../types";
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
    let cancelled = false;
    let stopLifecycle: (() => void) | undefined;
    const store = getStore();
    store.whenReady.then(() => {
      if (cancelled) return;
      hydrateSeedIfEmpty(store);
      stopLifecycle = setupSyncLifecycle(store);
      setReady(true);
    });
    return () => {
      cancelled = true;
      stopLifecycle?.();
    };
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

// Plans: keep a small cached array snapshot so consumers using
// useSyncExternalStore stay referentially stable until the plans map changes.
let cachedPlans: Plan[] | null = null;
function ensurePlans(): Plan[] {
  if (!cachedPlans) cachedPlans = getPlans(getStore());
  return cachedPlans;
}

export function usePlans(): Plan[] {
  return useSyncExternalStore(
    (cb) => {
      const store = getStore();
      const handler = () => {
        cachedPlans = getPlans(store);
        cb();
      };
      store.plans.observe(handler);
      return () => store.plans.unobserve(handler);
    },
    ensurePlans,
    ensurePlans
  );
}

/**
 * Subscribe to a single (week, user) note. Strings are primitive so we can
 * safely read fresh on every snapshot without breaking referential stability.
 */
export function useNote(weekId: string, userId: string): string {
  const [text, setText] = useState(() => getNote(getStore(), weekId, userId));
  useEffect(() => {
    setText(getNote(getStore(), weekId, userId));
    const store = getStore();
    const handler = () => setText(getNote(store, weekId, userId));
    store.notes.observe(handler);
    return () => store.notes.unobserve(handler);
  }, [weekId, userId]);
  return text;
}

export function useSyncStatus(): SyncState {
  const [s, setS] = useState<SyncState>(() => getSyncState(getStore()));
  useEffect(() => {
    const store = getStore();
    const refresh = () => setS(getSyncState(store));
    refresh();
    const provider = store.provider;
    if (!provider) return;
    const onStatus = () => refresh();
    const onSync = () => refresh();
    provider.on("status", onStatus);
    provider.on("sync", onSync);
    return () => {
      provider.off("status", onStatus);
      provider.off("sync", onSync);
    };
  }, []);
  return s;
}
