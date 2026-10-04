/**
 * THE CONTRACTOR'S JOBS, REMEMBERED ON THEIR OWN PHONE.
 *
 * A contractor has no account: every job reaches them as its own link
 * (`/j/<token>`). The installed app's "My jobs" list is those links, kept in
 * this browser's storage — nothing about them is sent anywhere new, and the
 * server still decides everything about each link (valid, expired, revoked,
 * what it may do) every time it is opened.
 *
 * Browser storage can be missing or refuse writes (a private window, cleared
 * site data, iOS keeping the installed app's storage apart from Safari's), so
 * every access is guarded and the worst case is an empty list.
 */

export type SavedJob = {
  token: string;
  reference: string | null;
  title: string;
  location: string | null;
  savedAt: string;
};

const KEY = "maintsupp.savedJobs.v1";
const LIMIT = 50;

/** A job token is long hex; anything else is not one of ours. */
export function isJobToken(value: string) {
  return /^[a-f0-9]{32,128}$/i.test(value);
}

/**
 * The token in whatever was pasted: a full link, a link with tracking on the
 * end, or the bare token.
 */
export function tokenFromLink(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  const match = text.match(/\/j\/([a-f0-9]{32,128})/i);
  if (match) return match[1];
  return isJobToken(text) ? text : null;
}

export function readSavedJobs(): SavedJob[] {
  try {
    const raw = window.localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(list)) return [];
    return list.filter(
      (entry): entry is SavedJob =>
        Boolean(entry) && typeof entry.token === "string" && isJobToken(entry.token),
    );
  } catch {
    return [];
  }
}

function write(list: SavedJob[]) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(list.slice(0, LIMIT)));
  } catch {
    /* Storage refused: the list simply is not remembered. */
  }
}

/** Adds or refreshes a job, newest first. */
export function saveJob(job: Omit<SavedJob, "savedAt">) {
  if (!isJobToken(job.token)) return;
  const rest = readSavedJobs().filter((entry) => entry.token !== job.token);
  write([{ ...job, savedAt: new Date().toISOString() }, ...rest]);
}

export function forgetJob(token: string) {
  write(readSavedJobs().filter((entry) => entry.token !== token));
}
