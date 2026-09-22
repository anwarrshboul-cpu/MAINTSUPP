/**
 * The website media bucket (decision K) — reached, and reported on, truthfully.
 *
 * `env.CMS_BUCKET` is the website's own bucket (`cms-media` on Supabase
 * Storage; its own R2 bucket locally; its own directory on Railway). It is
 * never `env.BUCKET`, the customers' documents bucket, and nothing here falls
 * back to it: a deployment whose website bucket is missing says so, in words a
 * person can act on, and uploads nothing.
 */

/** The bucket, or null when this deployment has no binding for it at all. */
export async function cmsBucket(): Promise<R2Bucket | null> {
  const { env } = await import("cloudflare:workers");
  return (env.CMS_BUCKET as R2Bucket | undefined) ?? null;
}

/** The bucket's name as the provider knows it, for the sentence a person reads. */
export function cmsBucketName(): string {
  const configured = typeof process !== "undefined" ? process.env?.S3_CMS_BUCKET?.trim() : undefined;
  return configured || "cms-media";
}

/** Whether a storage error is the provider saying the bucket is not there. */
export function isMissingBucket(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /NoSuchBucket|Bucket not found|specified bucket does not exist/i.test(message);
}

export const MEDIA_STORAGE_UNAVAILABLE =
  "Website media storage is not configured on this deployment, so nothing can be uploaded to the media library.";

export function mediaStorageMissing(): string {
  return `The website media bucket (${cmsBucketName()}) does not exist in file storage yet. It is created once by whoever administers the storage; until then nothing can be uploaded, and nothing was.`;
}

export type MediaStorageStatus = { state: "ready" | "missing" | "unavailable"; bucket: string; message: string | null };

/**
 * Whether the library can store anything right now — one tiny listing, shown on
 * the library screen so a missing bucket is visible before anyone tries.
 */
export async function mediaStorageStatus(bucket: R2Bucket | null): Promise<MediaStorageStatus> {
  const name = cmsBucketName();
  if (!bucket) return { state: "unavailable", bucket: name, message: MEDIA_STORAGE_UNAVAILABLE };
  try {
    await bucket.list({ prefix: "cms/", limit: 1 });
    return { state: "ready", bucket: name, message: null };
  } catch (error) {
    if (isMissingBucket(error)) return { state: "missing", bucket: name, message: mediaStorageMissing() };
    console.error("[cms-media] the website media bucket could not be reached:", error instanceof Error ? error.message.slice(0, 200) : "error");
    return { state: "unavailable", bucket: name, message: "Website media storage could not be reached just now." };
  }
}
