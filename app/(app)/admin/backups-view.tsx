"use client";

/**
 * Backups and recovery — Master Specification §39, visibility only.
 *
 * A read-only statement of what the portal can truthfully see: the database
 * it runs on, whether files are in the private bucket, and whether the
 * database's migrations match this build. Backup status itself is NOT visible
 * from here (see `/api/admin/backups`), and the screen says so rather than
 * drawing a button that could not do what it says.
 */

import { AdminLoading, AdminNotice, useAdminResource } from "../portal/views/admin-shell";

type Payload = {
  backups: { provider: string; visible: boolean; detail: string };
  database: { name: string; detail: string; configured: boolean };
  storage: { name: string; configured: boolean; detail: string };
  migrations: {
    codeFingerprint: string;
    storedFingerprint: string | null;
    appliedAt: string | null;
    current: boolean;
  };
  omissions: string[];
};

export function BackupsView() {
  const { data, loading, denied, error } = useAdminResource<Payload>("/api/admin/backups");

  if (loading && !data) return <AdminLoading label="Reading what the portal can see…" />;
  if (denied) {
    return (
      <AdminNotice tone="denied" icon="shield" title="This screen is for MAINTSUPP platform staff">
        {denied}
      </AdminNotice>
    );
  }
  if (error || !data) {
    return (
      <AdminNotice tone="error" icon="alert" title="The backup status could not be read">
        {error ?? "That could not be loaded."}
      </AdminNotice>
    );
  }

  const { backups, database, storage, migrations } = data;
  return (
    /* `section-stack`, as the Users, Roles and Clients screens have: its five
       notices otherwise sat edge to edge (visual pass, round 2). */
    <div className="section-stack admin-console">
      <AdminNotice tone="info" icon="shield" title={`Backups — taken by ${backups.provider}, not visible from here`}>
        {backups.detail}
      </AdminNotice>
      <AdminNotice tone={database.configured ? "info" : "error"} icon="folder" title={database.name}>
        {database.detail}
      </AdminNotice>
      <AdminNotice
        tone={storage.configured ? "info" : "error"}
        icon="upload"
        title={storage.name}
      >
        {storage.detail}
      </AdminNotice>
      <AdminNotice
        tone={migrations.current ? "info" : "error"}
        icon="refresh"
        title={migrations.current ? "Database schema — up to date with this build" : "Database schema — does not match this build"}
      >
        {`This build expects ${migrations.codeFingerprint}; the database last recorded ${
          migrations.storedFingerprint ?? "no completed migration run"
        }${migrations.appliedAt ? ` (${migrations.appliedAt})` : ""}.`}
      </AdminNotice>
      <AdminNotice tone="info" icon="alert" title="What this screen does not do">
        <ul>
          {data.omissions.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </AdminNotice>
    </div>
  );
}
