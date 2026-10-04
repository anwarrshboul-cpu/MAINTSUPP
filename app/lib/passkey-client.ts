/**
 * The browser half of "Sign in with Face ID" — WebAuthn passkeys.
 *
 * The phone does the hard part: it makes a key pair, keeps the private half
 * behind Face ID / Touch ID / a fingerprint, and signs our one-time challenge.
 * This module only moves bytes between `navigator.credentials` and
 * /api/auth/passkeys/*, base64url-encoded on the way. The server checks
 * everything (app/lib/webauthn.ts); nothing here is trusted.
 */

function toB64(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** Whether this browser can do passkeys at all. */
export function passkeysSupported(): boolean {
  return typeof window !== "undefined" && typeof window.PublicKeyCredential === "function";
}

/** Whether this device has Face ID / Touch ID / a fingerprint reader ready to use. */
export async function deviceUnlockAvailable(): Promise<boolean> {
  if (!passkeysSupported()) return false;
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

/** A friendly name for the device being set up, shown in the account list. */
export function thisDeviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return "iPad";
  if (/Android/.test(ua)) return "Android phone";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows PC";
  return "This device";
}

/** The label to put on the button: what the person will actually use. */
export function unlockLabel(): string {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  if (/iPhone|iPad/.test(ua)) return "Face ID";
  if (/Macintosh/.test(ua)) return "Touch ID";
  if (/Android/.test(ua)) return "fingerprint";
  if (/Windows/.test(ua)) return "Windows Hello";
  return "Face ID";
}

function cancelled(error: unknown) {
  return error instanceof DOMException && (error.name === "NotAllowedError" || error.name === "AbortError");
}

async function readJson(response: Response) {
  return (await response.json().catch(() => ({}))) as Record<string, unknown>;
}

/**
 * Adds a passkey for THIS device to the signed-in account.
 * Resolves with the device name, or throws a message fit to show.
 */
export async function registerThisDevice(): Promise<string> {
  const optionsResponse = await fetch("/api/auth/passkeys/options", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ purpose: "register" }),
  });
  const options = await readJson(optionsResponse);
  if (!optionsResponse.ok) throw new Error(String(options.error ?? "Face ID could not be set up."));
  const publicKey = options.publicKey as {
    challenge: string;
    user: { id: string; name: string; displayName: string };
    excludeCredentials: Array<{ type: "public-key"; id: string }>;
  } & Record<string, unknown>;

  let credential: PublicKeyCredential | null;
  try {
    credential = (await navigator.credentials.create({
      publicKey: {
        ...(publicKey as unknown as PublicKeyCredentialCreationOptions),
        challenge: fromB64(publicKey.challenge),
        user: { ...publicKey.user, id: fromB64(publicKey.user.id) },
        excludeCredentials: publicKey.excludeCredentials.map((entry) => ({
          type: "public-key" as const,
          id: fromB64(entry.id),
        })),
      },
    })) as PublicKeyCredential | null;
  } catch (error) {
    if (error instanceof DOMException && error.name === "InvalidStateError") {
      throw new Error("This device is already set up for Face ID sign-in.");
    }
    if (cancelled(error)) throw new Error("Set-up was cancelled.");
    throw new Error("This device could not create a passkey.");
  }
  if (!credential) throw new Error("Set-up was cancelled.");

  const response = credential.response as AuthenticatorAttestationResponse;
  const spki = response.getPublicKey?.();
  const authenticatorData = response.getAuthenticatorData?.();
  if (!spki || !authenticatorData) {
    throw new Error("This browser is too old for Face ID sign-in. Update the phone and try again.");
  }
  const name = thisDeviceName();
  const finish = await fetch("/api/auth/passkeys/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: toB64(credential.rawId),
      clientDataJSON: toB64(response.clientDataJSON),
      authenticatorData: toB64(authenticatorData),
      publicKey: toB64(spki),
      publicKeyAlgorithm: response.getPublicKeyAlgorithm(),
      transports: response.getTransports?.() ?? [],
      name,
    }),
  });
  const result = await readJson(finish);
  if (!finish.ok) throw new Error(String(result.error ?? "Face ID could not be set up."));
  return name;
}

/**
 * Signs in with whichever MAINTSUPP passkey the person picks.
 * Resolves with where to go next, or throws a message fit to show.
 */
export async function signInWithThisDevice(next: string): Promise<string> {
  const optionsResponse = await fetch("/api/auth/passkeys/options", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ purpose: "login" }),
  });
  const options = await readJson(optionsResponse);
  if (!optionsResponse.ok) throw new Error("Face ID sign-in is not available right now.");
  const publicKey = options.publicKey as { challenge: string; rpId: string; timeout: number };

  let credential: PublicKeyCredential | null;
  try {
    credential = (await navigator.credentials.get({
      publicKey: {
        challenge: fromB64(publicKey.challenge),
        rpId: publicKey.rpId,
        userVerification: "required",
        timeout: publicKey.timeout,
        allowCredentials: [],
      },
    })) as PublicKeyCredential | null;
  } catch (error) {
    if (cancelled(error)) throw new Error("Sign-in was cancelled.");
    throw new Error("This device has no MAINTSUPP passkey yet. Sign in with your password, then set up Face ID under Account.");
  }
  if (!credential) throw new Error("Sign-in was cancelled.");

  const response = credential.response as AuthenticatorAssertionResponse;
  const finish = await fetch("/api/auth/passkeys/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: toB64(credential.rawId),
      clientDataJSON: toB64(response.clientDataJSON),
      authenticatorData: toB64(response.authenticatorData),
      signature: toB64(response.signature),
      next,
    }),
  });
  const result = await readJson(finish);
  if (!finish.ok) throw new Error(String(result.error ?? "Face ID sign-in didn't work."));
  return String(result.redirectTo ?? "/dashboard");
}
