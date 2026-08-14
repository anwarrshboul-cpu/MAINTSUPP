"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";
import { BrandMark, Icon } from "../../components";
import { uploadEvidenceFile } from "../../lib/client-upload";
import type { Priority } from "../../lib/types";

type RequestChoice = { value: string; label: string; isDefault: boolean };

type RequestConfiguration = {
  sites: Array<{ id: string; name: string }>;
  priorities: RequestChoice[];
  engineers: RequestChoice[];
  categories: RequestChoice[];
};

export default function PublicRequestPage() {
  const [state, setState] = useState<"form" | "sending" | "success">("form");
  const [reference, setReference] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [successWarning, setSuccessWarning] = useState<string | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [configuration, setConfiguration] =
    useState<RequestConfiguration | null>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/context", { headers: { Accept: "application/json" } })
      .then(async (response) => {
        const payload = (await response.json()) as {
          context?: { requestConfiguration?: RequestConfiguration };
          error?: string;
        };
        if (!response.ok || !payload.context?.requestConfiguration) {
          throw new Error(payload.error || "The request form is unavailable.");
        }
        if (active) setConfiguration(payload.context.requestConfiguration);
      })
      .catch((caught: unknown) => {
        if (active) {
          setError(caught instanceof Error ? caught.message : "The request form is unavailable.");
        }
      });
    return () => {
      active = false;
    };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState("sending");
    setError(null);
    setSuccessWarning(null);
    setUploadProgress(0);
    const data = new FormData(event.currentTarget);
    const payload = {
      location: String(data.get("location") ?? ""),
      requester: String(data.get("requester") ?? ""),
      contact: String(data.get("contact") ?? ""),
      description: String(data.get("description") ?? ""),
      category: String(data.get("category") ?? "Other"),
      engineer: String(data.get("engineer") ?? ""),
      priority: String(data.get("priority") ?? "") as Priority,
    };

    try {
      const response = await fetch("/api/maintenance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = (await response.json()) as {
        request?: { id: string };
        uploadToken?: string;
        error?: string;
      };
      if (!response.ok || !result.request) {
        throw new Error(result.error || "Your request could not be submitted.");
      }

      if (files.length) {
        const failed: string[] = [];
        for (const [index, file] of files.entries()) {
          try {
            await uploadEvidenceFile({
              file,
              requestId: result.request.id,
              kind: "issue",
              uploadToken: result.uploadToken,
              onProgress: (progress) =>
                setUploadProgress(
                  Math.round(((index + progress / 100) / files.length) * 100),
                ),
            });
          } catch (caught) {
            failed.push(
              caught instanceof Error ? caught.message : `Could not upload ${file.name}.`,
            );
          }
        }
        if (failed.length) {
          setSuccessWarning(
            `Your request was saved, but ${failed.length} file${failed.length === 1 ? "" : "s"} could not be uploaded. The operations team can still see the request.`,
          );
        }
      }

      setReference(result.request.id);
      setState("success");
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Your request could not be submitted.",
      );
      setState("form");
    }
  }

  return (
    <main className="request-page">
      <header className="request-page__header">
        <Link href="/" aria-label="MAINTSUPP home">
          <BrandMark />
        </Link>
        <span>Maintenance support</span>
      </header>

      <section className="request-page__layout">
        <aside className="request-page__intro">
          <span className="public-kicker">
            <i />
            Report a site issue
          </span>
          <h1>Tell us what needs attention.</h1>
          <p>
            Give us the essential details and add any useful photos. Your
            request will be routed to the MAINTSUPP operations team immediately.
          </p>
          <div className="request-support-card">
            <span>
              <Icon name="clock" size={19} />
            </span>
            <div>
              <strong>Urgent issue?</strong>
              <p>
                Select urgent in the form. If there is an immediate threat to
                life or safety, contact the emergency services first.
              </p>
            </div>
          </div>
          <ol>
            <li className="is-current">
              <span>1</span>
              Request received
            </li>
            <li>
              <span>2</span>
              Operations triage
            </li>
            <li>
              <span>3</span>
              Engineer coordinated
            </li>
            <li>
              <span>4</span>
              Work verified
            </li>
          </ol>
        </aside>

        <div className="public-request-card">
          {state === "success" ? (
            <div className="request-success">
              <span>
                <Icon name="check" size={30} />
              </span>
              <small>Request received</small>
              <h2>Thank you. We have it.</h2>
              <p>
                The operations team can now triage your request. Keep this
                reference for any follow-up.
              </p>
              <strong>{reference}</strong>
              {successWarning && (
                <div className="form-error request-success__warning" role="status">
                  <Icon name="alert" size={17} />
                  {successWarning}
                </div>
              )}
              <div>
                <button
                  className="primary-button"
                  type="button"
                  onClick={() => {
                    setReference("");
                    setFiles([]);
                    setSuccessWarning(null);
                    setUploadProgress(0);
                    setState("form");
                  }}
                >
                  Submit another request
                </button>
                <Link className="secondary-button" href="/">
                  Back to MAINTSUPP
                </Link>
              </div>
            </div>
          ) : (
            <form onSubmit={submit}>
              <div className="public-request-card__heading">
                <span>Maintenance request</span>
                <h2>What has happened?</h2>
                <p>Fields marked with an asterisk are required.</p>
              </div>

              <label className="form-field">
                <span>Location *</span>
                <select name="location" required defaultValue="">
                  <option value="" disabled>
                    Select a site
                  </option>
                  {(configuration?.sites ?? []).map((site) => (
                    <option key={site.id} value={site.name}>{site.name}</option>
                  ))}
                </select>
              </label>

              <div className="form-grid">
                <label className="form-field">
                  <span>Your name *</span>
                  <input name="requester" required placeholder="Full name" />
                </label>
                <label className="form-field">
                  <span>Contact number *</span>
                  <input
                    name="contact"
                    required
                    type="tel"
                    placeholder="+44"
                  />
                </label>
              </div>

              <label className="form-field">
                <span>Description *</span>
                <textarea
                  name="description"
                  required
                  minLength={10}
                  rows={5}
                  placeholder="Describe the issue, where it is and any immediate risk…"
                />
              </label>

              <div className="form-grid">
                <label className="form-field">
                  <span>Priority *</span>
                  <select
                    name="priority"
                    defaultValue={configuration?.priorities.find((item) => item.isDefault)?.value ?? ""}
                  >
                    {(configuration?.priorities ?? []).map((item) => (
                      <option key={item.value} value={item.value}>{item.label}</option>
                    ))}
                  </select>
                </label>
                <label className="form-field">
                  <span>Category *</span>
                  <select name="category" defaultValue="">
                    {(configuration?.categories ?? []).map((item) => (
                      <option key={item.value} value={item.value}>{item.label}</option>
                    ))}
                  </select>
                </label>
              </div>

              <input
                type="hidden"
                name="engineer"
                value={configuration?.engineers.find((item) => item.isDefault)?.value ?? configuration?.engineers[0]?.value ?? ""}
              />

              <label className="file-drop public-file-drop">
                <input
                  type="file"
                  multiple
                  accept="image/*,video/*,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip"
                  onChange={(event) =>
                    setFiles(Array.from(event.currentTarget.files ?? []))
                  }
                />
                <span>
                  <Icon name="upload" size={20} />
                </span>
                <strong>
                  {files.length
                    ? `${files.length} file${files.length > 1 ? "s" : ""} selected`
                    : "Add photos, videos or documents"}
                </strong>
                <small>
                  Files up to 25 MB; videos up to 90 MB each. Large videos upload in parts.
                </small>
              </label>

              {error && (
                <div className="form-error" role="alert">
                  <Icon name="alert" size={17} />
                  {error}
                </div>
              )}

              <button
                className="primary-button public-submit"
                type="submit"
                disabled={
                  state === "sending" ||
                  !configuration ||
                  configuration.sites.length === 0
                }
              >
                {state === "sending"
                  ? uploadProgress
                    ? `Uploading evidence ${uploadProgress}%…`
                    : "Submitting…"
                  : "Submit request"}
                {state !== "sending" && <Icon name="arrow" size={17} />}
              </button>
            </form>
          )}
        </div>
      </section>
    </main>
  );
}
