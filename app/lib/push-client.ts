/**
 * Phone alerts, the browser half — shared by the app's front door (/app), the
 * portal's "Allow alerts" banner and the Account switch.
 *
 * ALERTS ARE ON BY DEFAULT, AS FAR AS A PHONE ALLOWS (owner, 2026-10-04).
 * No website may switch notifications on by itself: iPhone and Android both
 * insist on one "Allow" tap, and iPhone only offers it to an app on the home
 * screen. So the default is built from what IS allowed:
 *
 *   · the moment someone is signed in on a device that can take alerts, the
 *     portal asks — one tap, no settings to find;
 *   · once a phone has said Allow, it is subscribed silently on every visit,
 *     so signing in on that phone ties its alerts to the account without
 *     another tap;
 *   · turning them off is a choice the person makes, in Account → Phone
 *     alerts, and it is remembered on that device.
 */

const OFF_KEY = "maintsupp.alerts.off";
const SNOOZE_KEY = "maintsupp.alerts.snoozedUntil";

export type AlertSupport = "ready" | "needs-install" | "unsupported";

export function alertSupport(): AlertSupport {
  if (typeof window === "undefined") return "unsupported";
  const capable =
    "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  if (capable) return "ready";
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  return ios ? "needs-install" : "unsupported";
}

function storage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The person switched alerts off on this device. */
export function alertsTurnedOff(): boolean {
  return storage()?.getItem(OFF_KEY) === "1";
}

/** "Not now" on the banner: asked again in a week. */
export function snoozeAlertPrompt() {
  storage()?.setItem(SNOOZE_KEY, String(Date.now() + 7 * 24 * 60 * 60 * 1000));
}

export function alertPromptSnoozed(): boolean {
  const until = Number(storage()?.getItem(SNOOZE_KEY) ?? 0);
  return until > Date.now();
}

function urlKey(base64: string) {
  const padded = base64.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}

async function serverKey(): Promise<string | null> {
  const config = (await fetch("/api/push")
    .then((response) => response.json())
    .catch(() => ({ configured: false, publicKey: null }))) as {
    configured: boolean;
    publicKey: string | null;
  };
  return config.configured ? config.publicKey : null;
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (alertSupport() !== "ready") return null;
  const registration = await navigator.serviceWorker.ready;
  return registration.pushManager.getSubscription();
}

/** Tells the server which account (if signed in) and which job links this phone follows. */
export async function registerWithServer(subscription: PushSubscription, jobTokens: string[] = []) {
  const response = await fetch("/api/push", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subscription: subscription.toJSON(), jobTokens }),
  });
  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
    account?: boolean;
    jobs?: number;
  };
  if (!response.ok) throw new Error(payload.error || "Alerts could not be switched on.");
  return payload;
}

/**
 * Switch alerts on. Must run from a tap the first time (the phone's Allow
 * prompt); afterwards it is silent.
 */
export async function turnOnAlerts(jobTokens: string[] = []) {
  if (alertSupport() !== "ready") throw new Error("This phone can't show alerts here.");
  const permission =
    Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error(
      permission === "denied"
        ? "Alerts are blocked for MAINTSUPP. Allow them in the phone's Settings → Notifications."
        : "Alerts were not allowed.",
    );
  }
  const key = await serverKey();
  if (!key) throw new Error("Alerts are being set up — try again soon.");
  const registration = await navigator.serviceWorker.ready;
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlKey(key),
    }));
  storage()?.removeItem(OFF_KEY);
  return registerWithServer(subscription, jobTokens);
}

export async function turnOffAlerts() {
  storage()?.setItem(OFF_KEY, "1");
  const subscription = await currentSubscription().catch(() => null);
  if (!subscription) return;
  await fetch("/api/push", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint: subscription.endpoint }),
  }).catch(() => {});
  await subscription.unsubscribe().catch(() => {});
}

/**
 * On every signed-in visit: if this phone has already said Allow and the
 * person has not switched alerts off, (re)subscribe without asking. Returns
 * whether alerts are now on.
 */
export async function keepAlertsOn(jobTokens: string[] = []): Promise<boolean> {
  if (alertSupport() !== "ready" || alertsTurnedOff()) return false;
  if (Notification.permission !== "granted") return false;
  try {
    await turnOnAlerts(jobTokens);
    return true;
  } catch {
    return false;
  }
}

export async function sendTestAlert() {
  const subscription = await currentSubscription();
  if (!subscription) return false;
  const response = await fetch("/api/push?test=1", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subscription: subscription.toJSON() }),
  });
  return response.ok;
}

/**
 * Ask the phone for permission INSIDE a tap the person is already making —
 * "Sign in", "Open my jobs" — so the only thing they ever see about alerts is
 * the phone's own one-time Allow. Must be called synchronously from the tap
 * handler (before any await), or iPhone ignores it. Not awaited by callers.
 */
export function askAlertPermissionNow(): Promise<NotificationPermission | null> {
  try {
    if (alertSupport() !== "ready" || alertsTurnedOff()) return Promise.resolve(null);
    if (Notification.permission !== "default") return Promise.resolve(Notification.permission);
    return Notification.requestPermission();
  } catch {
    return Promise.resolve(null);
  }
}
