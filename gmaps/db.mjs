// gmaps/db.mjs — schema + prepared statements for the Google Maps lead source.
// Additive: creates its own tables in the SAME leads.db; the backlink `sources`
// table is never touched. initGmaps(db) is injectable so tests pass a :memory: db.

export function initGmaps(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS jobs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    source       TEXT,                 -- 'google_maps'
    city         TEXT,
    params_json  TEXT,                 -- {areas:[], queries:[], cap}
    status       TEXT,                 -- queued|running|done|error|stopped
    total_cells  INTEGER DEFAULT 0,
    done_cells   INTEGER DEFAULT 0,
    raw_results  INTEGER DEFAULT 0,    -- businesses returned across cells (pre-dedup)
    unique_leads INTEGER DEFAULT 0,
    duplicates   INTEGER DEFAULT 0,
    errors       INTEGER DEFAULT 0,
    started_at   INTEGER,
    completed_at INTEGER
  );`);

  db.exec(`CREATE TABLE IF NOT EXISTS searches (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id       INTEGER,
    area         TEXT,
    query        TEXT,
    status       TEXT,                 -- pending|ok|error
    result_count INTEGER DEFAULT 0,
    error        TEXT,
    ts           INTEGER
  );`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_searches_job ON searches(job_id, status);`);

  db.exec(`CREATE TABLE IF NOT EXISTS gmaps_leads (
    key           TEXT PRIMARY KEY,    -- place_id || cid || maps_url (stable id)
    job_id        INTEGER,
    name          TEXT,
    maps_url      TEXT,
    place_id      TEXT,
    cid           TEXT,
    address       TEXT,
    locality      TEXT,
    lat           REAL,
    lng           REAL,
    phone         TEXT,
    website       TEXT,
    category      TEXT,
    rating        REAL,
    review_count  INTEGER DEFAULT 0,
    hours_json    TEXT,
    description   TEXT,
    services_json TEXT,
    doctor_name   TEXT,
    socials_json  TEXT DEFAULT '{}',
    email         TEXT,
    booking_link  TEXT,
    whatsapp      TEXT,
    branch_count  INTEGER DEFAULT 1,
    -- discovery attribution (dedup keeps ONE row, records reach)
    areas_json    TEXT DEFAULT '{}',   -- {area: count}
    queries_json  TEXT DEFAULT '{}',   -- {query: count}
    found_count   INTEGER DEFAULT 0,   -- how many cells found it
    first_seen    INTEGER,
    last_seen     INTEGER,
    -- enrichment flags: YES | NO | UNKNOWN
    has_website   TEXT DEFAULT 'UNKNOWN',
    has_phone     TEXT DEFAULT 'UNKNOWN',
    has_email     TEXT DEFAULT 'UNKNOWN',
    has_social    TEXT DEFAULT 'UNKNOWN',
    has_booking   TEXT DEFAULT 'UNKNOWN',
    has_whatsapp  TEXT DEFAULT 'UNKNOWN',
    -- scoring
    score         INTEGER DEFAULT 0,
    score_reasons_json TEXT DEFAULT '[]',
    enrich_status TEXT DEFAULT 'pending', -- pending|ok|no_contact|error|skipped
    status        TEXT DEFAULT 'ok',
    note          TEXT,
    ts            INTEGER
  );`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_gmaps_job ON gmaps_leads(job_id);`);

  // STEP 3 grading columns — additive migration for DBs created before grading
  // existed. ALTER throws if the column is already there, so each is guarded.
  for (const [col, type] of [
    ['grade', 'TEXT'], ['fit_score', 'INTEGER DEFAULT 0'], ['priority', 'TEXT'],
    ['marketing_eligible', 'TEXT'], ['opportunity', 'TEXT'],
    ['grade_confidence', 'INTEGER DEFAULT 0'], ['grade_json', "TEXT DEFAULT '{}'"],
    // outreach workflow (CRM-lite): pipeline state + notes per lead
    ['outreach_status', "TEXT DEFAULT 'new'"], ['notes', 'TEXT'], ['contacted_at', 'INTEGER'],
  ]) {
    try { db.exec(`ALTER TABLE gmaps_leads ADD COLUMN ${col} ${type}`); } catch { /* column exists */ }
  }

  // auto-schedule table
  db.exec(`CREATE TABLE IF NOT EXISTS schedules (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT,
    city        TEXT,
    params_json TEXT,           -- {areas:[], queries:[], cap}
    interval_h  INTEGER,        -- hours between runs
    enabled     INTEGER DEFAULT 1,
    last_run_at INTEGER,
    next_run_at INTEGER,
    created_at  INTEGER
  )`);

  return {
    // jobs
    createJob: db.prepare(`INSERT INTO jobs (source,city,params_json,status,total_cells,started_at)
      VALUES ('google_maps',@city,@params_json,'queued',@total_cells,@started_at)`),
    getJob: db.prepare(`SELECT * FROM jobs WHERE id=?`),
    listJobs: db.prepare(`SELECT * FROM jobs ORDER BY id DESC`),
    setJobStatus: db.prepare(`UPDATE jobs SET status=@status, completed_at=@completed_at WHERE id=@id`),
    bumpJob: db.prepare(`UPDATE jobs SET done_cells=@done_cells, raw_results=@raw_results,
      unique_leads=@unique_leads, duplicates=@duplicates, errors=@errors WHERE id=@id`),

    // searches (cells)
    addSearch: db.prepare(`INSERT INTO searches (job_id,area,query,status,ts)
      VALUES (@job_id,@area,@query,'pending',@ts)`),
    pendingSearches: db.prepare(`SELECT * FROM searches WHERE job_id=? AND status='pending' ORDER BY id`),
    allSearches: db.prepare(`SELECT * FROM searches WHERE job_id=? ORDER BY id`),
    setSearch: db.prepare(`UPDATE searches SET status=@status, result_count=@result_count,
      error=@error, ts=@ts WHERE id=@id`),

    // leads
    getLead: db.prepare(`SELECT * FROM gmaps_leads WHERE key=?`),
    getLeadBy: db.prepare(`SELECT * FROM gmaps_leads WHERE place_id=@v OR cid=@v OR maps_url=@v
      OR (phone!='' AND phone=@phone) OR (website!='' AND website=@website) LIMIT 1`),
    insertLead: db.prepare(`INSERT INTO gmaps_leads
      (key,job_id,name,maps_url,place_id,cid,address,locality,lat,lng,phone,website,category,
       rating,review_count,hours_json,description,services_json,doctor_name,socials_json,email,
       booking_link,whatsapp,branch_count,areas_json,queries_json,found_count,first_seen,last_seen,ts)
      VALUES (@key,@job_id,@name,@maps_url,@place_id,@cid,@address,@locality,@lat,@lng,@phone,@website,
       @category,@rating,@review_count,@hours_json,@description,@services_json,@doctor_name,@socials_json,
       @email,@booking_link,@whatsapp,@branch_count,@areas_json,@queries_json,@found_count,
       @first_seen,@last_seen,@ts)`),
    updateLeadMerge: db.prepare(`UPDATE gmaps_leads SET
      areas_json=@areas_json, queries_json=@queries_json, found_count=@found_count,
      name=@name, phone=@phone, website=@website, category=@category, rating=@rating,
      review_count=@review_count, address=@address, locality=@locality, last_seen=@last_seen WHERE key=@key`),
    updateEnrich: db.prepare(`UPDATE gmaps_leads SET
      email=@email, socials_json=@socials_json, booking_link=@booking_link, whatsapp=@whatsapp,
      has_website=@has_website, has_phone=@has_phone, has_email=@has_email, has_social=@has_social,
      has_booking=@has_booking, has_whatsapp=@has_whatsapp, enrich_status=@enrich_status WHERE key=@key`),
    updateScore: db.prepare(`UPDATE gmaps_leads SET score=@score, score_reasons_json=@score_reasons_json WHERE key=@key`),
    updateGrade: db.prepare(`UPDATE gmaps_leads SET grade=@grade, fit_score=@fit_score, priority=@priority,
      marketing_eligible=@marketing_eligible, opportunity=@opportunity, grade_confidence=@grade_confidence,
      grade_json=@grade_json WHERE key=@key`),
    updateOutreach: db.prepare(`UPDATE gmaps_leads SET outreach_status=@outreach_status, notes=@notes,
      contacted_at=@contacted_at WHERE key=@key`),
    leadsByLocality: db.prepare(`SELECT key,name,address FROM gmaps_leads WHERE locality=?`),
    leadsByJob: db.prepare(`SELECT * FROM gmaps_leads WHERE job_id=? ORDER BY score DESC`),
    allLeads: db.prepare(`SELECT * FROM gmaps_leads ORDER BY score DESC`),

    // ---- home → cloud sync (upserts; online owns CRM fields, so those are preserved) ----
    syncUpsertJob: db.prepare(`INSERT OR REPLACE INTO jobs
      (id,source,city,params_json,status,total_cells,done_cells,raw_results,unique_leads,duplicates,errors,started_at,completed_at)
      VALUES (@id,@source,@city,@params_json,@status,@total_cells,@done_cells,@raw_results,@unique_leads,@duplicates,@errors,@started_at,@completed_at)`),
    syncUpsertLead: db.prepare(`INSERT INTO gmaps_leads
      (key,job_id,name,maps_url,place_id,cid,address,locality,lat,lng,phone,website,category,rating,review_count,
       hours_json,description,services_json,doctor_name,socials_json,email,booking_link,whatsapp,branch_count,
       areas_json,queries_json,found_count,first_seen,last_seen,has_website,has_phone,has_email,has_social,has_booking,
       has_whatsapp,score,score_reasons_json,enrich_status,status,note,ts,grade,fit_score,priority,marketing_eligible,
       opportunity,grade_confidence,grade_json,outreach_status,notes,contacted_at)
      VALUES (@key,@job_id,@name,@maps_url,@place_id,@cid,@address,@locality,@lat,@lng,@phone,@website,@category,@rating,
       @review_count,@hours_json,@description,@services_json,@doctor_name,@socials_json,@email,@booking_link,@whatsapp,
       @branch_count,@areas_json,@queries_json,@found_count,@first_seen,@last_seen,@has_website,@has_phone,@has_email,
       @has_social,@has_booking,@has_whatsapp,@score,@score_reasons_json,@enrich_status,@status,@note,@ts,@grade,
       @fit_score,@priority,@marketing_eligible,@opportunity,@grade_confidence,@grade_json,@outreach_status,@notes,@contacted_at)
      ON CONFLICT(key) DO UPDATE SET
       job_id=@job_id,name=@name,maps_url=@maps_url,place_id=@place_id,cid=@cid,address=@address,locality=@locality,
       lat=@lat,lng=@lng,phone=@phone,website=@website,category=@category,rating=@rating,review_count=@review_count,
       hours_json=@hours_json,description=@description,services_json=@services_json,doctor_name=@doctor_name,
       socials_json=@socials_json,email=@email,booking_link=@booking_link,whatsapp=@whatsapp,branch_count=@branch_count,
       areas_json=@areas_json,queries_json=@queries_json,found_count=@found_count,last_seen=@last_seen,
       has_website=@has_website,has_phone=@has_phone,has_email=@has_email,has_social=@has_social,has_booking=@has_booking,
       has_whatsapp=@has_whatsapp,score=@score,score_reasons_json=@score_reasons_json,enrich_status=@enrich_status,
       status=@status,note=@note,ts=@ts,grade=@grade,fit_score=@fit_score,priority=@priority,
       marketing_eligible=@marketing_eligible,opportunity=@opportunity,grade_confidence=@grade_confidence,grade_json=@grade_json`),

    // schedules
    createSchedule: db.prepare(`INSERT INTO schedules (name,city,params_json,interval_h,enabled,next_run_at,created_at)
      VALUES (@name,@city,@params_json,@interval_h,1,@next_run_at,@created_at)`),
    listSchedules: db.prepare(`SELECT * FROM schedules ORDER BY id DESC`),
    getSchedule: db.prepare(`SELECT * FROM schedules WHERE id=?`),
    updateScheduleRun: db.prepare(`UPDATE schedules SET last_run_at=@now, next_run_at=@next WHERE id=@id`),
    toggleSchedule: db.prepare(`UPDATE schedules SET enabled=@enabled WHERE id=@id`),
    deleteSchedule: db.prepare(`DELETE FROM schedules WHERE id=?`),
    dueSchedules: db.prepare(`SELECT * FROM schedules WHERE enabled=1 AND next_run_at <= ?`),
  };
}
