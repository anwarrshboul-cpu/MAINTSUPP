/**
 * Alt text registry for every photograph on the marketing site.
 *
 * This file used to hold a `PhotoSlot` component too. The component now lives
 * in `photo.tsx`, which renders the landing page's `.ph` artwork system; the
 * registry stayed behind because it is the single place that guarantees no
 * photograph can reach the page without a description. `photo.tsx` falls back
 * to it whenever a caller does not pass `alt` explicitly.
 *
 * The old loader painted photographs as CSS background-images on divs, so they
 * carried no alt text at all. That is the gap this closes.
 */

/**
 * Alt text for every slot.
 *
 * Written to describe what is in the photograph, not to repeat the heading
 * beside it. Where a caption already says the same thing, the entry is an empty
 * string so a screen reader is not told twice.
 */
export const photoAlt: Record<string, string> = {
  "hero-london-maintenance":
    "A maintenance engineer working on a shopfront in a London high street",
  "evidence-closeout":
    "An engineer photographing completed work on a phone as close-out evidence",

  /* All eight faults in section 4. Glazing and drainage were the last two
     without a photograph and are supplied now, so they are described here like
     the rest — `services.tsx` happens to pass its own alt for every tile, but
     this registry is what guarantees no photograph can reach the page
     undescribed, and an entry missing from it is a gap waiting for a caller
     that forgets. */
  "trade-electrical": "An electrician working at a distribution board",
  "trade-doors": "A roller shutter being serviced at a retail unit",
  "trade-leaks": "A plumber tracing a leak in a commercial ceiling void",
  "trade-hvac": "An engineer servicing air conditioning plant",
  "trade-glazing": "A technician fitting a glass panel into a commercial shopfront",
  "trade-signage": "Illuminated shopfront signage being repaired from an access platform",
  "trade-drainage": "A technician clearing a blocked floor drain with a drain machine",
  "trade-fabric": "General building fabric repairs under way on a commercial unit",

  "workflow-1-report": "A store manager photographing a fault on a phone",
  "workflow-2-triage": "A coordinator at a desk reviewing incoming jobs",
  "workflow-3-approve": "A quote being reviewed and approved on screen",
  "workflow-4-assign": "A contractor being briefed on a job by phone",
  "workflow-5-attend": "An engineer arriving on site with tools",
  "workflow-6-verify": "Completed work being checked against the job record",
  "workflow-7-report": "A monthly maintenance report open on a laptop",

  "dashboard-overview": "The client portal overview screen, shown with sample data",
  "dashboard-jobs": "The client portal jobs list, shown with sample data",
  "dashboard-compliance": "The client portal compliance screen, shown with sample data",
  "dashboard-spend": "The client portal spend breakdown, shown with sample data",
};

export function altFor(name: string) {
  return photoAlt[name] ?? "";
}
