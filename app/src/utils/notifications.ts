/**
 * Web Push subscription helper.
 *
 * Flow:
 *   1. ensureNotificationSupported() — feature-detects the APIs.
 *   2. getNotificationStatus() — read-only state for UI.
 *   3. subscribeForReminders({ userId }) — asks for permission, registers a
 *      PushSubscription with the SW, and POSTs it to the sync server along
 *      with this device's IANA timezone.
 *   4. unsubscribeFromReminders() — drops local + server subscription.
 *
 * The server then fires a daily push at 11pm in this device's local time when
 * the current day's log is still empty (gated by a cron-job.org tick).
 */

const env = (import.meta as unknown as { env?: Record<string, string> }).env;

const ROOM = (env?.VITE_ROOM ?? "reaching-unreal-default").trim();
/**
 * The HTTP base URL of the sync server. Derived from VITE_YWS_URL by swapping
 * ws→http / wss→https. Allows the same env var to drive both.
 */
function getApiBase(): string {
  const ws = (env?.VITE_YWS_URL ?? "").trim();
  if (!ws) return "";
  return ws.replace(/^ws:/i, "http:").replace(/^wss:/i, "https:").replace(/\/$/, "");
}

export type NotificationStatus =
  | "unsupported"
  | "default"
  | "denied"
  | "granted-no-subscription"
  | "subscribed";

export function isNotificationSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "Notification" in window &&
    "serviceWorker" in navigator &&
    "PushManager" in window
  );
}

export async function getNotificationStatus(): Promise<NotificationStatus> {
  if (!isNotificationSupported()) return "unsupported";
  const perm = Notification.permission;
  if (perm === "denied") return "denied";
  if (perm !== "granted") return "default";
  const reg = await navigator.serviceWorker.getRegistration();
  if (!reg) return "granted-no-subscription";
  const sub = await reg.pushManager.getSubscription();
  return sub ? "subscribed" : "granted-no-subscription";
}

function urlBase64ToUint8Array(base64String: string): ArrayBuffer {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  // Allocate a fresh, non-shared ArrayBuffer so PushManager.subscribe is
  // happy under strict DOM typings (it rejects SharedArrayBuffer-backed views).
  const out = new ArrayBuffer(raw.length);
  const view = new Uint8Array(out);
  for (let i = 0; i < raw.length; ++i) view[i] = raw.charCodeAt(i);
  return out;
}

async function fetchVapidPublicKey(): Promise<string> {
  const base = getApiBase();
  if (!base) throw new Error("Sync server URL is not configured (VITE_YWS_URL)");
  const res = await fetch(`${base}/vapid-public-key`);
  if (!res.ok) throw new Error(`vapid-public-key returned ${res.status}`);
  const text = (await res.text()).trim();
  if (!text) throw new Error("Server has no VAPID key configured");
  return text;
}

async function ensureServiceWorker(): Promise<ServiceWorkerRegistration> {
  const reg = await navigator.serviceWorker.register("/sw.js");
  // Make sure it's actually active before subscribing
  if (reg.active) return reg;
  await new Promise<void>((resolve) => {
    const w = reg.installing || reg.waiting;
    if (!w) return resolve();
    w.addEventListener("statechange", () => {
      if (w.state === "activated") resolve();
    });
  });
  return reg;
}

export interface SubscribeArgs {
  userId: string;
}

export async function subscribeForReminders({
  userId,
}: SubscribeArgs): Promise<NotificationStatus> {
  if (!isNotificationSupported()) return "unsupported";
  if (!userId) throw new Error("Pick a user identity first");

  const perm = await Notification.requestPermission();
  if (perm === "denied") return "denied";
  if (perm !== "granted") return "default";

  const reg = await ensureServiceWorker();
  const existing = await reg.pushManager.getSubscription();
  let sub = existing;
  if (!sub) {
    const vapid = await fetchVapidPublicKey();
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapid),
    });
  }

  const json = sub.toJSON() as {
    endpoint?: string;
    keys?: { p256dh?: string; auth?: string };
  };
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    throw new Error("Subscription is missing required fields");
  }

  const base = getApiBase();
  const timezone =
    Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Los_Angeles";

  const res = await fetch(`${base}/subscribe`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      subscription: {
        endpoint: json.endpoint,
        keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
      },
      room: ROOM,
      userId,
      timezone,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Server rejected subscription (${res.status}): ${text}`);
  }
  return "subscribed";
}

export async function unsubscribeFromReminders(): Promise<NotificationStatus> {
  if (!isNotificationSupported()) return "unsupported";
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  const endpoint = sub?.endpoint;
  if (sub) {
    try {
      await sub.unsubscribe();
    } catch {
      /* noop */
    }
  }
  if (endpoint) {
    const base = getApiBase();
    if (base) {
      try {
        await fetch(`${base}/unsubscribe`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ endpoint }),
        });
      } catch {
        /* server might be cold; the next /subscribe will overwrite anyway */
      }
    }
  }
  return getNotificationStatus();
}
