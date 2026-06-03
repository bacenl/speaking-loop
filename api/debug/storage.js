import postgres from "postgres";
import { del, put } from "@vercel/blob";

const RETENTION_DAYS = 30;

let sqlClient;
let schemaReady;

export function json(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

export function appVersion() {
  return (
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA ||
    process.env.npm_package_version ||
    "0.1.0"
  );
}

export function debugLoggingEnabled() {
  return process.env.DEBUG_LOGGING_ENABLED !== "false" && Boolean(process.env.POSTGRES_URL);
}

export function requireDebugAdmin(req, res) {
  const configured = process.env.DEBUG_ADMIN_TOKEN;
  if (!configured) {
    json(res, 503, { error: "DEBUG_ADMIN_TOKEN is not configured." });
    return false;
  }
  const token =
    req.headers["x-debug-token"] ||
    new URL(req.url, "http://localhost").searchParams.get("token");
  if (token !== configured) {
    json(res, 401, { error: "Unauthorized." });
    return false;
  }
  return true;
}

function sql() {
  if (!process.env.POSTGRES_URL) return null;
  if (!sqlClient) {
    sqlClient = postgres(process.env.POSTGRES_URL, {
      max: 1,
      idle_timeout: 20,
      connect_timeout: 10,
    });
  }
  return sqlClient;
}

export async function ensureDebugSchema() {
  const db = sql();
  if (!db) return false;
  if (!schemaReady) {
    schemaReady = db
      .begin(async (tx) => {
        await tx`select pg_advisory_xact_lock(hashtext('speaking_loop_debug_schema'))`;
        await tx`
          create table if not exists debug_sessions (
            id uuid primary key,
            session_number bigserial unique,
            started_at timestamptz not null default now(),
            scenario text,
            targets jsonb not null default '{}'::jsonb,
            app_version text,
            client_props jsonb not null default '{}'::jsonb,
            vad_enabled boolean
          )
        `;
        await tx`
          create table if not exists debug_messages (
            id uuid primary key,
            message_number bigserial unique,
            session_id uuid references debug_sessions(id) on delete cascade,
            turn_index integer,
            role text not null,
            content text,
            translation text,
            created_at timestamptz not null default now()
          )
        `;
        await tx`
          create table if not exists debug_api_calls (
            id uuid primary key,
            session_id uuid references debug_sessions(id) on delete cascade,
            message_id uuid references debug_messages(id) on delete set null,
            call_type text not null,
            provider text,
            model text,
            status text not null,
            latency_ms integer,
            request_summary jsonb not null default '{}'::jsonb,
            response_summary jsonb not null default '{}'::jsonb,
            error text,
            created_at timestamptz not null default now()
          )
        `;
        await tx`
          create table if not exists debug_audio (
            id uuid primary key,
            session_id uuid references debug_sessions(id) on delete cascade,
            message_id uuid references debug_messages(id) on delete set null,
            kind text not null,
            storage_key text not null,
            blob_url text,
            mime_type text,
            size_bytes integer,
            created_at timestamptz not null default now()
          )
        `;
        await tx`create index if not exists debug_messages_session_idx on debug_messages(session_id)`;
        await tx`create index if not exists debug_api_calls_session_idx on debug_api_calls(session_id)`;
        await tx`create index if not exists debug_audio_session_idx on debug_audio(session_id)`;
        await tx`create index if not exists debug_sessions_started_at_idx on debug_sessions(started_at desc)`;
      })
      .catch((error) => {
        schemaReady = undefined;
        throw error;
      });
  }
  await schemaReady;
  return true;
}

export function createDebugContext(body = {}) {
  return {
    sessionId: body.sessionId || crypto.randomUUID(),
    appVersion: body.appVersion || appVersion(),
    clientProps: body.clientProps || {},
    vadEnabled: Boolean(body.clientProps?.vadEnabled),
  };
}

export async function upsertDebugSession(body = {}, context = createDebugContext(body)) {
  if (!debugLoggingEnabled()) return null;
  await ensureDebugSchema();
  const db = sql();
  const [session] = await db`
    insert into debug_sessions (
      id,
      scenario,
      targets,
      app_version,
      client_props,
      vad_enabled
    )
    values (
      ${context.sessionId},
      ${body.scenario || null},
      ${db.json(body.targets || {})},
      ${context.appVersion},
      ${db.json(context.clientProps || {})},
      ${context.vadEnabled}
    )
    on conflict (id) do update set
      scenario = coalesce(excluded.scenario, debug_sessions.scenario),
      targets = excluded.targets,
      app_version = excluded.app_version,
      client_props = excluded.client_props,
      vad_enabled = excluded.vad_enabled
    returning id, session_number
  `;
  return session;
}

export async function logDebugMessage({
  sessionId,
  turnIndex,
  role,
  content,
  translation,
}) {
  if (!debugLoggingEnabled() || !sessionId) return null;
  await ensureDebugSchema();
  const db = sql();
  const [message] = await db`
    insert into debug_messages (
      id,
      session_id,
      turn_index,
      role,
      content,
      translation
    )
    values (
      ${crypto.randomUUID()},
      ${sessionId},
      ${turnIndex ?? null},
      ${role},
      ${content || null},
      ${translation || null}
    )
    returning id, message_number
  `;
  return message;
}

export async function logDebugApiCall({
  sessionId,
  messageId,
  callType,
  provider = "shisa",
  model,
  status,
  latencyMs,
  requestSummary = {},
  responseSummary = {},
  error,
}) {
  if (!debugLoggingEnabled() || !sessionId) return null;
  await ensureDebugSchema();
  const db = sql();
  await db`
    insert into debug_api_calls (
      id,
      session_id,
      message_id,
      call_type,
      provider,
      model,
      status,
      latency_ms,
      request_summary,
      response_summary,
      error
    )
    values (
      ${crypto.randomUUID()},
      ${sessionId},
      ${messageId || null},
      ${callType},
      ${provider},
      ${model || null},
      ${status},
      ${latencyMs ?? null},
      ${db.json(requestSummary)},
      ${db.json(responseSummary)},
      ${error || null}
    )
  `;
}

export async function storeDebugAudio({
  sessionId,
  messageId,
  kind,
  base64,
  buffer,
  mimeType,
}) {
  if (!debugLoggingEnabled() || !process.env.BLOB_READ_WRITE_TOKEN || !sessionId) {
    return null;
  }
  const bytes = buffer || Buffer.from(base64 || "", "base64");
  if (!bytes.length) return null;
  await ensureDebugSchema();
  const db = sql();
  const storageKey = `debug/${sessionId}/${Date.now()}-${kind}`;
  const blob = await put(storageKey, bytes, {
    access: "public",
    contentType: mimeType || "application/octet-stream",
    token: process.env.BLOB_READ_WRITE_TOKEN,
  });
  const [audio] = await db`
    insert into debug_audio (
      id,
      session_id,
      message_id,
      kind,
      storage_key,
      blob_url,
      mime_type,
      size_bytes
    )
    values (
      ${crypto.randomUUID()},
      ${sessionId},
      ${messageId || null},
      ${kind},
      ${storageKey},
      ${blob.url},
      ${mimeType || "application/octet-stream"},
      ${bytes.length}
    )
    returning id, storage_key, blob_url
  `;
  return audio;
}

export async function getDebugSummary() {
  await ensureDebugSchema();
  const db = sql();
  const [counts] = await db`
    select
      (select count(*)::int from debug_sessions) as sessions,
      (select count(*)::int from debug_messages) as messages,
      (select count(*)::int from debug_api_calls) as api_calls,
      (select count(*)::int from debug_audio) as audio_files
  `;
  return counts;
}

export async function getDebugMessages({ limit = 100, offset = 0 } = {}) {
  await ensureDebugSchema();
  const db = sql();
  return db`
    select
      m.created_at,
      m.id as message_id,
      m.message_number,
      s.session_number,
      m.turn_index,
      m.role,
      m.content,
      m.translation,
      s.app_version,
      s.client_props,
      s.vad_enabled,
      coalesce(
        json_agg(
          distinct jsonb_build_object(
            'id', c.id,
            'callType', c.call_type,
            'status', c.status,
            'latencyMs', c.latency_ms,
            'model', c.model,
            'error', c.error
          )
        ) filter (where c.id is not null),
        '[]'::json
      ) as api_calls,
      coalesce(
        json_agg(
          distinct jsonb_build_object(
            'id', a.id,
            'kind', a.kind,
            'key', a.storage_key,
            'mimeType', a.mime_type,
            'sizeBytes', a.size_bytes
          )
        ) filter (where a.id is not null),
        '[]'::json
      ) as audio
    from debug_messages m
    join debug_sessions s on s.id = m.session_id
    left join debug_api_calls c on c.message_id = m.id
    left join debug_audio a on a.message_id = m.id
    group by m.id, s.id
    order by m.created_at desc
    limit ${Math.min(Number(limit) || 100, 500)}
    offset ${Math.max(Number(offset) || 0, 0)}
  `;
}

export async function getAudioByKey(key) {
  await ensureDebugSchema();
  const db = sql();
  const [audio] = await db`
    select blob_url, mime_type
    from debug_audio
    where storage_key = ${key}
    limit 1
  `;
  return audio || null;
}

export async function cleanupDebugLogs(days = RETENTION_DAYS) {
  await ensureDebugSchema();
  const db = sql();
  const oldAudio = await db`
    select blob_url
    from debug_audio
    where created_at < now() - (${Number(days)} * interval '1 day')
      and blob_url is not null
  `;
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    await Promise.allSettled(
      oldAudio.map((item) => del(item.blob_url, { token: process.env.BLOB_READ_WRITE_TOKEN })),
    );
  }
  const result = await db`
    delete from debug_sessions
    where started_at < now() - (${Number(days)} * interval '1 day')
    returning id
  `;
  return { deletedSessions: result.length, deletedAudio: oldAudio.length };
}
