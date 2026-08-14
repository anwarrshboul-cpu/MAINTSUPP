# MAINTSUPP integrated platform

This project combines the original MAINTSUPP public landing page with the full maintenance operations dashboard in one Vinext/Next application.

## Main routes

- `/` — complete public landing page
- `/login` — branded secure portal entry
- `/dashboard` — protected overview
- `/dashboard/jobs` — live maintenance board
- `/dashboard/planned` — planned visits and calendar
- `/dashboard/units` — units and assets
- `/dashboard/sites` — site register
- `/dashboard/contractors` — contractor performance
- `/dashboard/compliance` — compliance tracker
- `/dashboard/documents` — documents and evidence
- `/dashboard/reports` — spend and operational reporting
- `/dashboard/settings` — workspace settings
- `/dashboard/team` — users and permissions
- `/request` — standalone maintenance-request form

`/portal` remains as a compatibility route and redirects to `/dashboard`.

## Preserved functionality

- Full 16-section landing page and all original photographs
- Interactive service/trade tabs, workflow stepper, portal hotspots, pricing selector, calculator, sector gallery, testimonial carousel, FAQ and three-step portfolio form
- Camera, video and file evidence selection on the public report form
- Working job creation, upload, live board, filters, sorting, custom fields, comments, evidence management, CSV exports and notifications
- Site, compliance, document, calendar, team and settings views
- D1-backed job, board, compliance, activity and notification data
- R2-backed file uploads, downloads, previews and multipart transfers
- Protected dashboard routes and server-side API authentication

## Added integration features

- Shared MAINTSUPP name, two-tone logo and dark design tokens throughout
- Client Portal links now enter the secure login flow
- Protected `/dashboard/*` route structure with route-aware navigation
- Units, contractors and reporting modules derived from the operational data layer
- Six dynamic overview KPIs
- Public landing-page job submission with evidence upload
- D1-backed portfolio-review lead capture
- Extended relational schema for organisations, users, units, contractors, planned maintenance, quotations, invoices, system notifications and leads

## Local development

Requirements: Node.js 22.13 or newer, npm, Linux-compatible shell tools.

```bash
npm ci
npm run dev
```

The local preview uses simulated logical `DB` and `BUCKET` bindings from `.openai/hosting.json`.

## Build and validation

```bash
npm run build
npm run validate:artifact
npm test
```

The deployable output is written to `dist/`. Database migrations are in `drizzle/`.

To generate a new migration after changing `db/schema.ts`:

```bash
npm run db:generate
```

## Authentication

The public website remains anonymous. Dashboard pages use the platform-owned secure sign-in flow. API read/write operations verify the authenticated user on the server. Do not place credentials or secrets in frontend code.

## Environment and external services

No application secrets are required in source. Hosted deployments require the platform-provided D1 `DB` binding, R2 `BUCKET` binding and secure sign-in headers. Email and SMS delivery can be added later to the existing notification event structure.

## Brand rules

- Main background: `#101820`
- Card background: `#182830`
- Teal accent: `#12B4A8`
- Logo: `MAINT` in white and `SUPP` in teal; the **S** is part of `SUPP`
- Public-site supporting palette and photography remain from the original landing-page project
