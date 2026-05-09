import { useEffect, useState } from "react";
import { CALENDARS } from "../calendars";
import { setCalendarId, getStore } from "../store/yjs";
import { useCalendar } from "../hooks/useStore";
import { labelForWeekStart, parseISO } from "../utils/seasons";
import {
  getNotificationStatus,
  isNotificationSupported,
  subscribeForReminders,
  unsubscribeFromReminders,
  type NotificationStatus,
} from "../utils/notifications";
import type { AppUser } from "../types";

interface Props {
  onClose: () => void;
  me: AppUser | null;
}

export function SettingsModal({ onClose, me }: Props) {
  const cal = useCalendar();
  const [notifStatus, setNotifStatus] = useState<NotificationStatus>("default");
  const [notifBusy, setNotifBusy] = useState(false);
  const [notifError, setNotifError] = useState<string | null>(null);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  useEffect(() => {
    let cancelled = false;
    getNotificationStatus().then((s) => {
      if (!cancelled) setNotifStatus(s);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleEnableReminders = async () => {
    if (!me) {
      setNotifError("Pick a user identity first (close Settings, tap 'switch').");
      return;
    }
    setNotifBusy(true);
    setNotifError(null);
    try {
      const next = await subscribeForReminders({ userId: me.id });
      setNotifStatus(next);
    } catch (e) {
      setNotifError(e instanceof Error ? e.message : String(e));
    } finally {
      setNotifBusy(false);
    }
  };

  const handleDisableReminders = async () => {
    setNotifBusy(true);
    setNotifError(null);
    try {
      const next = await unsubscribeFromReminders();
      setNotifStatus(next);
    } catch (e) {
      setNotifError(e instanceof Error ? e.message : String(e));
    } finally {
      setNotifBusy(false);
    }
  };

  const sampleDates = [
    "2025-09-27",
    "2025-12-20",
    "2026-01-10",
    "2026-02-07",
    "2026-04-04",
    "2026-06-13",
  ];

  return (
    <div className="fixed inset-0 z-40 bg-stone-900/40 backdrop-blur-sm flex items-start justify-center overflow-auto py-10 px-4">
      <div className="bg-white rounded-2xl shadow-xl border border-stone-200 max-w-2xl w-full overflow-hidden">
        <div className="flex items-center gap-3 px-6 py-4 border-b border-stone-200">
          <h2 className="text-lg font-semibold text-stone-800">Settings</h2>
          <button
            onClick={onClose}
            className="ml-auto px-3 py-1.5 rounded-md bg-stone-100 hover:bg-stone-200 text-sm"
          >
            Close
          </button>
        </div>

        <div className="p-6 space-y-6">
          <section>
            <h3 className="text-sm font-semibold text-stone-700 mb-1">
              Daily reminder
            </h3>
            <p className="text-sm text-stone-500 mb-3">
              Get a push notification at <strong>11pm {tz}</strong> if today's
              row is still empty. Set this on each device (phone, laptop) you
              want to be reminded on.
            </p>

            <div className="rounded-xl border border-stone-200 bg-stone-50 px-4 py-3 flex items-center gap-3">
              <ReminderStatusDot status={notifStatus} />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-stone-800">
                  {labelForStatus(notifStatus)}
                </div>
                {notifStatus === "denied" && (
                  <div className="text-xs text-stone-500 mt-0.5">
                    Notifications are blocked in your browser/PWA settings.
                    Enable them there, then come back.
                  </div>
                )}
                {notifStatus === "unsupported" && (
                  <div className="text-xs text-stone-500 mt-0.5">
                    {!isNotificationSupported()
                      ? "This browser doesn't support push. On iPhone, install the app from Safari → Share → Add to Home Screen, then open it from the home screen."
                      : ""}
                  </div>
                )}
                {notifError && (
                  <div className="text-xs text-rose-600 mt-1">{notifError}</div>
                )}
              </div>
              {notifStatus === "subscribed" ? (
                <button
                  onClick={handleDisableReminders}
                  disabled={notifBusy}
                  className="px-3 py-1.5 rounded-md bg-stone-200 hover:bg-stone-300 text-sm disabled:opacity-50"
                >
                  {notifBusy ? "…" : "Turn off"}
                </button>
              ) : (
                <button
                  onClick={handleEnableReminders}
                  disabled={
                    notifBusy ||
                    notifStatus === "denied" ||
                    notifStatus === "unsupported"
                  }
                  className="px-3 py-1.5 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-sm disabled:opacity-50"
                >
                  {notifBusy ? "…" : "Enable"}
                </button>
              )}
            </div>
          </section>

          <section>
            <h3 className="text-sm font-semibold text-stone-700 mb-1">
              Calendar
            </h3>
            <p className="text-sm text-stone-500 mb-3">
              How weeks are labeled and grouped. Shared with everyone in this
              workspace.
            </p>

            <div className="space-y-2">
              {CALENDARS.map((c) => {
                const active = cal.id === c.id;
                return (
                  <button
                    key={c.id}
                    onClick={() => setCalendarId(getStore(), c.id)}
                    className={
                      "w-full text-left px-4 py-3 rounded-xl border flex items-start gap-3 transition-colors " +
                      (active
                        ? "bg-emerald-50 border-emerald-300"
                        : "bg-white border-stone-200 hover:bg-stone-50")
                    }
                  >
                    <div
                      className={
                        "mt-0.5 w-4 h-4 rounded-full border-2 flex-shrink-0 " +
                        (active
                          ? "border-emerald-600 bg-emerald-600"
                          : "border-stone-300")
                      }
                      style={
                        active
                          ? {
                              boxShadow: "inset 0 0 0 3px white",
                            }
                          : undefined
                      }
                    />
                    <div className="flex-1">
                      <div className="font-medium text-stone-800">{c.name}</div>
                      <div className="text-xs text-stone-500 mt-0.5">
                        Group by{" "}
                        <span className="font-medium">
                          {c.bucketTerm.toLowerCase()}
                        </span>
                        ,{" "}
                        {c.id === "stanford"
                          ? "labels weeks like “SPR W4” and detects breaks"
                          : "labels weeks by meteorological season"}
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {sampleDates.map((iso) => {
                          const lbl = c.labelForWeekStart(parseISO(iso));
                          return (
                            <span
                              key={iso}
                              className="text-[11px] px-1.5 py-0.5 rounded bg-stone-100 text-stone-600 border border-stone-200"
                              title={iso}
                            >
                              {lbl.short}
                            </span>
                          );
                        })}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="text-xs text-stone-500 leading-relaxed border-t border-stone-200 pt-4">
            <p>
              <strong>Stanford academic</strong> is encoded with the registrar's
              dates for academic years 2024-25 through 2027-28; later years use a
              heuristic that matches the published pattern (Autumn ≈ first Mon ≥
              Sep 21, Winter ≈ first Mon ≥ Jan 4, Spring ≈ first Mon ≥ Mar 28,
              Summer ≈ first Mon ≥ Jun 21). Weeks falling between quarters are
              labeled as breaks (Winter Break, Spring Break, Pre-Summer, Late
              Summer).
            </p>
            <p className="mt-2">
              For sample <code>{labelForWeekStart(parseISO("2026-02-07")).display}</code>{" "}
              under meteorological, equivalent in Stanford is{" "}
              <code>
                {(
                  CALENDARS.find((c) => c.id === "stanford")?.labelForWeekStart(
                    parseISO("2026-02-07")
                  )?.display ?? ""
                )}
              </code>
              .
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}

function ReminderStatusDot({ status }: { status: NotificationStatus }) {
  const color =
    status === "subscribed"
      ? "bg-emerald-500"
      : status === "denied"
      ? "bg-rose-400"
      : status === "unsupported"
      ? "bg-stone-300"
      : "bg-amber-400";
  return <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${color}`} />;
}

function labelForStatus(status: NotificationStatus): string {
  switch (status) {
    case "subscribed":
      return "Daily reminder is on for this device";
    case "denied":
      return "Notifications blocked";
    case "unsupported":
      return "Push notifications aren't available here";
    case "granted-no-subscription":
      return "Permission granted — finish setup";
    default:
      return "Daily reminder is off for this device";
  }
}
