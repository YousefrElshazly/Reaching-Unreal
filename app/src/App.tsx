import { useEffect, useMemo, useState } from "react";
import { useAppData, useEnsureSeeded, useSyncStatus } from "./hooks/useStore";
import {
  addUserTableToWeek,
  addWeekAfterLast,
  getStore,
  setPresence,
} from "./store/yjs";
import type { AppUser } from "./types";
import { WeekTable } from "./components/WeekTable";
import { WeekNav } from "./components/WeekNav";
import { Cursors } from "./components/Cursors";
import { SummaryView } from "./components/SummaryView";
import { SettingsModal } from "./components/SettingsModal";
import { IdentityPicker } from "./components/IdentityPicker";
import { parseISO } from "./utils/seasons";

const ME_KEY = "reaching-unreal:me";

function loadMe(): AppUser | null {
  try {
    const raw = localStorage.getItem(ME_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as AppUser;
  } catch {
    return null;
  }
}

function saveMe(u: AppUser): void {
  localStorage.setItem(ME_KEY, JSON.stringify(u));
}

function pickCurrentWeekId(weeks: { id: string; startDate: string }[]): string {
  if (weeks.length === 0) return "";
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let best = weeks[0].id;
  for (const w of weeks) {
    if (parseISO(w.startDate).getTime() <= today.getTime()) best = w.id;
  }
  return best;
}

export default function App() {
  const seeded = useEnsureSeeded();
  const data = useAppData();
  const syncStatus = useSyncStatus();
  const [me, setMe] = useState<AppUser | null>(loadMe);
  const [currentId, setCurrentId] = useState<string>("");
  const [showSummary, setShowSummary] = useState(false);
  const [showSettings, setShowSettings] = useState(false);

  // initialize/refresh current week selection
  useEffect(() => {
    if (!data.weeks.length) return;
    if (!currentId || !data.weeks.find((w) => w.id === currentId)) {
      setCurrentId(pickCurrentWeekId(data.weeks));
    }
  }, [data.weeks, currentId]);

  // identity → presence
  useEffect(() => {
    if (!me) return;
    setPresence(getStore(), { user: me, cursor: null });
  }, [me]);

  // mouse tracking → presence
  useEffect(() => {
    if (!me) return;
    let raf = 0;
    let next: { x: number; y: number } | null = null;
    const onMove = (e: MouseEvent) => {
      next = { x: e.clientX, y: e.clientY };
      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0;
          setPresence(getStore(), { user: me, cursor: next });
        });
      }
    };
    const onLeave = () => {
      setPresence(getStore(), { user: me, cursor: null });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseleave", onLeave);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseleave", onLeave);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [me]);

  const handlePick = (u: AppUser) => {
    saveMe(u);
    setMe(u);
  };

  const week = useMemo(
    () => data.weeks.find((w) => w.id === currentId) ?? null,
    [data.weeks, currentId]
  );

  const handleAddWeek = () => {
    const w = addWeekAfterLast(getStore());
    if (w) setCurrentId(w.id);
  };

  // If user has no table for this week (e.g. guest), give them an "add my table" affordance.
  const hasMyTable = !!(me && week?.tables.some((t) => t.userId === me.id));

  if (!seeded) {
    return (
      <div className="h-full flex items-center justify-center text-stone-500">
        Loading…
      </div>
    );
  }

  return (
    <div className="min-h-full">
      {!me && <IdentityPicker users={data.users} onPick={handlePick} />}

      <header className="sticky top-0 z-30 bg-stone-50/95 backdrop-blur border-b border-stone-200">
        <div className="max-w-[1400px] mx-auto px-6 pt-4 pb-3">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-8 h-8 rounded-lg bg-emerald-600 flex items-center justify-center text-white font-bold">
              ✓
            </div>
            <div>
              <h1 className="text-xl font-bold text-stone-900 leading-tight">
                Reaching Unreal
              </h1>
              <div className="text-xs text-stone-500">
                Productivity tracker · live collab
              </div>
            </div>
            <div className="ml-auto flex items-center gap-3 text-xs text-stone-500">
              <SyncBadge status={syncStatus} />
              {me && (
                <>
                  <span
                    className="w-2 h-2 rounded-full"
                    style={{ backgroundColor: me.color }}
                  />
                  <span>signed in as <strong>{me.name}</strong></span>
                  <button
                    onClick={() => {
                      localStorage.removeItem(ME_KEY);
                      setMe(null);
                    }}
                    className="ml-1 underline text-stone-500 hover:text-stone-700"
                  >
                    switch
                  </button>
                </>
              )}
            </div>
          </div>
          <WeekNav
            weeks={data.weeks}
            currentId={currentId}
            onSelect={setCurrentId}
            onAddWeek={handleAddWeek}
            onShowSummary={() => setShowSummary(true)}
            onShowSettings={() => setShowSettings(true)}
          />
        </div>
      </header>

      <main className="max-w-[1400px] mx-auto px-6 py-6">
        {!week && (
          <div className="text-center text-stone-500 py-20">
            No week selected.
          </div>
        )}
        {week && (
          <div className="flex flex-col gap-6">
            {[...week.tables]
              .sort((a, b) => {
                if (!me) return 0;
                if (a.userId === me.id) return -1;
                if (b.userId === me.id) return 1;
                return 0;
              })
              .map((t) => (
                <WeekTable
                  key={t.userId}
                  week={week}
                  table={t}
                  isOwner={!!me && me.id === t.userId}
                />
              ))}
            {me && !hasMyTable && week.tables.length < 4 && (
              <div className="rounded-xl border-2 border-dashed border-stone-300 bg-white/50 p-8 flex flex-col items-center justify-center text-center">
                <p className="text-stone-600 mb-3">
                  You don't have a table in this week yet.
                </p>
                <button
                  onClick={() => addUserTableToWeek(getStore(), week.id, me)}
                  className="px-4 py-2 rounded-md bg-emerald-600 text-white font-medium hover:bg-emerald-700 text-sm"
                >
                  Add my table
                </button>
              </div>
            )}
          </div>
        )}
      </main>

      {showSummary && (
        <SummaryView data={data} onClose={() => setShowSummary(false)} />
      )}
      {showSettings && (
        <SettingsModal onClose={() => setShowSettings(false)} />
      )}

      <Cursors />
    </div>
  );
}

function SyncBadge({
  status,
}: {
  status: "offline" | "connecting" | "connected" | "disconnected";
}) {
  const map = {
    offline: { label: "Local only", dot: "bg-stone-400" },
    connecting: { label: "Connecting…", dot: "bg-amber-400" },
    connected: { label: "Synced", dot: "bg-emerald-500" },
    disconnected: { label: "Reconnecting…", dot: "bg-amber-400" },
  } as const;
  const { label, dot } = map[status];
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-stone-100 text-stone-600"
      title={
        status === "offline"
          ? "No sync server configured. Set VITE_YWS_URL to enable cross-device sync."
          : status === "connected"
          ? "Connected to sync server. Edits flow live to other devices."
          : "Trying to reach the sync server."
      }
    >
      <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />
      {label}
    </span>
  );
}
