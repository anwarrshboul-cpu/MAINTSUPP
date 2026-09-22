/**
 * THE UPLOAD SIZE POLICY, IN ONE PLACE.
 *
 * Read by the browser helper (`client-upload.ts`, which refuses an oversized
 * file before a single request is made) and by both upload routes
 * (`/api/files` and `/api/files/multipart`, which refuse it again, because the
 * browser's word is not the rule). These three used to carry a copy each;
 * a copy is how a limit drifts.
 *
 * VIDEO: 50 MB. The owner's decision of 2026-09-22 superseded the earlier
 * 90 MB. The Supabase project's upload ceiling on the current plan is 50 MB,
 * enforced by the provider on every multipart part as the upload grows (an
 * 88 MB video stopped at its eleventh 5 MiB part, the 50 MiB mark, and a
 * 60 MB file got a 413), and the plan is not being upgraded for larger video.
 * So 50 MB is what the product can truthfully promise, and it says so up front
 * instead of letting a phone spend minutes on a file the provider will refuse.
 *
 * "MB" here is the codebase's usual 1024 × 1024, the same unit as the 5 MiB
 * part size, so a video of exactly the maximum is ten full parts. That exact
 * size was uploaded end to end against the real provider before this shipped.
 *
 * EVERYTHING ELSE: 25 MB, unchanged. The public report form keeps its own,
 * smaller per-file cap (`app/(marketing)/_sections/report-job.tsx`).
 */

export const MAX_STANDARD_FILE_SIZE = 25 * 1024 * 1024;
export const MAX_VIDEO_FILE_SIZE = 50 * 1024 * 1024;

/** What a person is told, in both the browser and the API's 413. */
export const VIDEO_TOO_LARGE = "Maximum video size is 50 MB.";
export const FILE_TOO_LARGE = "Files must be 25 MB or smaller.";

/** The ceiling for one file, by whether it is a video. */
export function maxUploadSize(video: boolean): number {
  return video ? MAX_VIDEO_FILE_SIZE : MAX_STANDARD_FILE_SIZE;
}

/** The refusal for a file over its ceiling, or null when it fits. */
export function uploadSizeRefusal(video: boolean, byteSize: number): string | null {
  if (byteSize <= maxUploadSize(video)) return null;
  return video ? VIDEO_TOO_LARGE : FILE_TOO_LARGE;
}
