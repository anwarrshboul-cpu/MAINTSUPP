import type { Metadata } from "next";
import AppHome from "./app-home";
import appHomeCss from "./app-home.css?url";

/**
 * maintsupp.com/app — the MAINTSUPP app, without an app store.
 *
 * One link for everybody (the owner's choice, 2026-10-04): opened in a browser
 * it is the install page — logo, an Install button where the phone offers one,
 * the iPhone steps where it does not, and a QR code for a desktop visitor. Once
 * installed, the home-screen icon opens this same address (the manifest's
 * `start_url`) and it becomes the app's front door: the client portal for
 * people with an account, and "My jobs" for contractors, whose jobs arrive as
 * links and are remembered on their phone.
 *
 * A thin server shell over a client component, like `/f` and `/j`: everything
 * here depends on the device (installed or not, iPhone or Android, which job
 * links it has opened), which the server cannot know.
 */
export const metadata: Metadata = {
  title: "Get the MAINTSUPP app",
  description:
    "Install MAINTSUPP on your phone: raise and follow maintenance jobs, and get alerts when they move. No app store needed.",
  alternates: { canonical: "/app" },
};

export default function AppPage() {
  return (
    <>
      <link rel="stylesheet" href={appHomeCss} />
      <AppHome />
    </>
  );
}
