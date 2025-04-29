// src/db/sqlite.js -> UPDATED
// ──────────────────────────────────────────────────────────────────
//  ▸ v8: Seed CEO User on migration if missing
//  ▸ v7: tasks.estimated_time_minutes
// ... rest of version history ...
/* eslint camelcase:0 */

const path    = require('node:path');
const sqlite3 = require('sqlite3').verbose();
//const bcrypt  = require('bcryptjs'); // <--- Added for seeding

const DB_PATH           = path.join(__dirname, '../../company.db');
const DB_SCHEMA_VERSION = 7; // <--- BUMPED to 8
let   db                = null;

// ... (applyPragmas function remains the same) ...
function applyPragmas (instance) {
  return new Promise((resolve, reject) => {
    instance.serialize(() => {
      instance.run('PRAGMA foreign_keys = ON;', fkErr => {
        if (fkErr) return reject(fkErr);
        instance.run('PRAGMA journal_mode=WAL;', walErr => {
          if (walErr) console.error('[DB] WAL enable failed (continuing):', walErr.message);
          resolve();
        });
      });
    });
  });
}

/* ─────────────── migrations ─────────────── */
function runMigrations (instance) {
  return new Promise((resolve, reject) => {
    instance.get('PRAGMA user_version;', (err, row) => {
      if (err) return reject(err);
      const current = row?.user_version || 0;
      if (current === DB_SCHEMA_VERSION) {
        console.log(`[DB] Schema is up-to-date (v${DB_SCHEMA_VERSION}).`);
        return resolve();
      }
      if (current > DB_SCHEMA_VERSION) {
        console.error(`[DB] Database schema (v${current}) is newer than this code (v${DB_SCHEMA_VERSION}).`);
        return reject(new Error('DB schema newer than code.'));
      }

      console.log(`[DB] Migrating schema v${current} → v${DB_SCHEMA_VERSION}`);
      instance.serialize(() => {

        /* ── Fresh DB (apply latest schema in one go) ── */
        if (current < 1) {
          console.log('[DB] Applying v1 base schema (incl. all subsequent fields)…');
          instance.run(`
            CREATE TABLE IF NOT EXISTS companies (
              company_id  INTEGER PRIMARY KEY AUTOINCREMENT,
              name        TEXT UNIQUE NOT NULL,
              created_at  TEXT DEFAULT CURRENT_TIMESTAMP
            );`);

          instance.run(`
            CREATE TABLE IF NOT EXISTS users (
              id              INTEGER PRIMARY KEY AUTOINCREMENT,
              company_id      INTEGER,
              email           TEXT UNIQUE NOT NULL,
              password_hash   TEXT NOT NULL,
              first_name      TEXT    DEFAULT NULL,           -- v6
              last_name       TEXT    DEFAULT NULL,           -- v6
              role            TEXT CHECK(role IN ('CEO','PM','EMP')) NOT NULL DEFAULT 'EMP',
              manager_id      INTEGER DEFAULT NULL,           -- v3
              job_title       TEXT    DEFAULT NULL,           -- v3
              team_name       TEXT    DEFAULT NULL,           -- v4
              profile_task_id TEXT    UNIQUE DEFAULT NULL,    -- v5
              created_at      TEXT DEFAULT CURRENT_TIMESTAMP,
              FOREIGN KEY (company_id) REFERENCES companies(company_id) ON DELETE SET NULL,
              FOREIGN KEY (manager_id) REFERENCES users(id) ON DELETE SET NULL
            );`);

          instance.run(`
            CREATE TABLE IF NOT EXISTS tasks (
              task_id               TEXT PRIMARY KEY,
              company_id            INTEGER NOT NULL,
              employee_id           INTEGER NOT NULL,
              title                 TEXT NOT NULL,
              original_description  TEXT,
              estimated_time_minutes INTEGER,                 -- v7
              status                TEXT DEFAULT 'pending',
              created_at            TEXT DEFAULT CURRENT_TIMESTAMP,
              FOREIGN KEY (company_id) REFERENCES companies(company_id) ON DELETE CASCADE,
              FOREIGN KEY (employee_id) REFERENCES users(id) ON DELETE CASCADE
            );`);

          instance.run(`
            CREATE TABLE IF NOT EXISTS task_steps (
              step_id          INTEGER PRIMARY KEY AUTOINCREMENT,
              task_id          TEXT    NOT NULL,
              company_id       INTEGER NOT NULL,
              step_number      INTEGER NOT NULL,
              description      TEXT    NOT NULL,
              status           TEXT DEFAULT 'pending',
              is_interruption  INTEGER NOT NULL DEFAULT 0,   -- v3
              last_update_json TEXT,
              created_at       TEXT DEFAULT CURRENT_TIMESTAMP,
              updated_at       TEXT DEFAULT CURRENT_TIMESTAMP,
              FOREIGN KEY (task_id) REFERENCES tasks(task_id) ON DELETE CASCADE,
              FOREIGN KEY (company_id) REFERENCES companies(company_id) ON DELETE CASCADE
            );`);

          instance.run(`
            CREATE TRIGGER IF NOT EXISTS trg_task_steps_updated
            AFTER UPDATE ON task_steps
            FOR EACH ROW
            BEGIN
              UPDATE task_steps SET updated_at = CURRENT_TIMESTAMP WHERE step_id = NEW.step_id;
            END;`);

          instance.run(`
            CREATE TABLE IF NOT EXISTS task_updates (
              update_id     INTEGER PRIMARY KEY AUTOINCREMENT,
              task_id       TEXT    NOT NULL,
              company_id    INTEGER NOT NULL,
              employee_id   INTEGER NOT NULL,
              step_number   INTEGER,
              update_text   TEXT    NOT NULL,
              created_at    TEXT DEFAULT CURRENT_TIMESTAMP,
              FOREIGN KEY (task_id)     REFERENCES tasks(task_id)   ON DELETE CASCADE,
              FOREIGN KEY (company_id)  REFERENCES companies(company_id) ON DELETE CASCADE,
              FOREIGN KEY (employee_id) REFERENCES users(id)        ON DELETE CASCADE
            );`);

          instance.run(`
            CREATE TABLE IF NOT EXISTS poll_requests (
              poll_id       TEXT PRIMARY KEY,
              task_id       TEXT    NOT NULL,
              requested_by  INTEGER NOT NULL,
              requested_at  TEXT DEFAULT CURRENT_TIMESTAMP,
              responded_at  TEXT,
              status        TEXT DEFAULT 'pending',
              FOREIGN KEY (task_id)      REFERENCES tasks(task_id) ON DELETE CASCADE,
              FOREIGN KEY (requested_by) REFERENCES users(id)     ON DELETE CASCADE
            );`);

          instance.run(`
            CREATE TABLE IF NOT EXISTS profile_history (
              hist_id     INTEGER PRIMARY KEY AUTOINCREMENT,
              user_id     INTEGER NOT NULL,
              company_id  INTEGER NOT NULL,
              changed_by  INTEGER NOT NULL,
              ts          TEXT DEFAULT CURRENT_TIMESTAMP,
              diff_json   TEXT NOT NULL,
              FOREIGN KEY (user_id)    REFERENCES users(id) ON DELETE CASCADE,
              FOREIGN KEY (changed_by) REFERENCES users(id) ON DELETE SET NULL
            );`);

          instance.run(`
            CREATE TABLE IF NOT EXISTS log (
              id          INTEGER PRIMARY KEY AUTOINCREMENT,
              ts          TEXT,
              type        TEXT,
              agentId     TEXT,
              employeeId  TEXT,
              task_id     TEXT,
              payload     TEXT
            );`);

          // Indexes (new + legacy)
          instance.run(`CREATE INDEX IF NOT EXISTS idx_tasks_company      ON tasks(company_id);`);
          instance.run(`CREATE INDEX IF NOT EXISTS idx_tasks_employee     ON tasks(employee_id);`);
          instance.run(`CREATE INDEX IF NOT EXISTS idx_tasks_estimate     ON tasks(estimated_time_minutes);`);   // v7
          instance.run(`CREATE INDEX IF NOT EXISTS idx_task_steps_tasknum ON task_steps(task_id, step_number);`);
          instance.run(`CREATE INDEX IF NOT EXISTS idx_users_manager_id   ON users(manager_id);`);
          instance.run(`CREATE INDEX IF NOT EXISTS idx_users_team_name    ON users(team_name);`);
          instance.run(`CREATE INDEX IF NOT EXISTS idx_users_profile_task ON users(profile_task_id);`);
          instance.run(`CREATE INDEX IF NOT EXISTS idx_users_name         ON users(last_name, first_name);`);
          instance.run(`CREATE INDEX IF NOT EXISTS idx_profile_hist_user  ON profile_history(user_id, ts DESC);`);
          instance.run(`CREATE INDEX IF NOT EXISTS idx_polls_task_status  ON poll_requests(task_id, status);`);
        }

        /* ── Incremental migrations ─────────────────────────── */
        // v1 → v2 (progress + polling)
        if (current < 2) {
            console.log('[DB Migration] Applying v2 schema changes...');
            instance.run(`
            CREATE TABLE IF NOT EXISTS task_updates (
              update_id     INTEGER PRIMARY KEY AUTOINCREMENT,
              task_id       TEXT    NOT NULL,
              company_id    INTEGER NOT NULL,
              employee_id   INTEGER NOT NULL,
              step_number   INTEGER,
              update_text   TEXT    NOT NULL,
              created_at    TEXT DEFAULT CURRENT_TIMESTAMP,
              FOREIGN KEY (task_id)     REFERENCES tasks(task_id)   ON DELETE CASCADE,
              FOREIGN KEY (company_id)  REFERENCES companies(company_id) ON DELETE CASCADE,
              FOREIGN KEY (employee_id) REFERENCES users(id)        ON DELETE CASCADE
            );`, (err) => { if(err) console.error("DB Migration Error (create task_updates):", err.message); });

            instance.run(`
            CREATE TABLE IF NOT EXISTS poll_requests (
              poll_id        TEXT PRIMARY KEY,
              task_id        TEXT    NOT NULL,
              requested_by   INTEGER NOT NULL,
              requested_at   TEXT DEFAULT CURRENT_TIMESTAMP,
              responded_at   TEXT,
              status         TEXT DEFAULT 'pending',
              FOREIGN KEY (task_id)      REFERENCES tasks(task_id) ON DELETE CASCADE,
              FOREIGN KEY (requested_by) REFERENCES users(id)     ON DELETE CASCADE
            );`, (err) => { if(err) console.error("DB Migration Error (create poll_requests):", err.message); });

            instance.run(`CREATE INDEX IF NOT EXISTS idx_polls_task_status ON poll_requests(task_id, status);`, (err) => { if(err) console.error("DB Migration Error (create idx_polls_task_status):", err.message); });
        }

        // v2 → v3 (add org chart cols)
        if (current < 3) {
            console.log('[DB Migration] Applying v3 schema changes...');
            instance.run(`ALTER TABLE users ADD COLUMN manager_id INTEGER DEFAULT NULL;`, (err) => { if(err && !err.message.includes('duplicate column name')) console.error("DB Migration Error (add manager_id):", err.message); });
            instance.run(`ALTER TABLE users ADD COLUMN job_title TEXT DEFAULT NULL;`, (err) => { if(err && !err.message.includes('duplicate column name')) console.error("DB Migration Error (add job_title):", err.message); });
            instance.run(`ALTER TABLE task_steps ADD COLUMN is_interruption INTEGER NOT NULL DEFAULT 0;`, (err) => { if(err && !err.message.includes('duplicate column name')) console.error("DB Migration Error (add is_interruption):", err.message); });
            instance.run(`CREATE INDEX IF NOT EXISTS idx_users_manager_id ON users(manager_id);`, (err) => { if(err) console.error("DB Migration Error (ensure idx_users_manager_id):", err.message); });
        }

        // v3 → v4 (add team name col)
        if (current < 4) {
             console.log('[DB Migration] Applying v4 schema changes...');
             instance.run(`ALTER TABLE users ADD COLUMN team_name TEXT DEFAULT NULL;`, (err) => { if(err && !err.message.includes('duplicate column name')) console.error("DB Migration Error (add team_name):", err.message); });
             instance.run(`CREATE INDEX IF NOT EXISTS idx_users_team_name ON users(team_name);`, (err) => { if(err) console.error("DB Migration Error (create idx_users_team_name):", err.message); });
        }

        // v4 → v5 (add profile_task_id and history table)
        if (current < 5) {
             console.log('[DB Migration] Applying v5 schema changes...');
             // Add column to users
             instance.run(`ALTER TABLE users ADD COLUMN profile_task_id TEXT UNIQUE DEFAULT NULL;`, (err) => { if(err && !err.message.includes('duplicate column name')) console.error("DB Migration Error (add profile_task_id):", err.message); });
             // Create history table
             instance.run(`
               CREATE TABLE IF NOT EXISTS profile_history (
                 hist_id      INTEGER PRIMARY KEY AUTOINCREMENT,
                 user_id      INTEGER NOT NULL,
                 company_id   INTEGER NOT NULL,
                 changed_by   INTEGER NOT NULL,
                 ts           TEXT    DEFAULT CURRENT_TIMESTAMP,
                 diff_json    TEXT    NOT NULL,
                 FOREIGN KEY(user_id)    REFERENCES users(id) ON DELETE CASCADE,
                 FOREIGN KEY(changed_by) REFERENCES users(id) ON DELETE SET NULL
               );`, (err) => { if(err) console.error("DB Migration Error (create profile_history v5):", err.message); });
             // Add indexes
             instance.run(`CREATE INDEX IF NOT EXISTS idx_users_profile_task ON users(profile_task_id);`, (err) => { if(err) console.error("DB Migration Error (create idx_users_profile_task v5):", err.message); });
             instance.run(`CREATE INDEX IF NOT EXISTS idx_profile_hist_user ON profile_history(user_id, ts DESC);`, (err) => { if(err) console.error("DB Migration Error (create idx_profile_hist_user v5):", err.message); });
        }

        // v5 → v6 (add name columns)
        if (current < 6) {
             console.log('[DB Migration] Applying v6 schema changes...');
             instance.run(`ALTER TABLE users ADD COLUMN first_name TEXT DEFAULT NULL;`, (err) => { if(err && !err.message.includes('duplicate column name')) console.error("DB Migration Error (add first_name):", err.message); });
             instance.run(`ALTER TABLE users ADD COLUMN last_name TEXT DEFAULT NULL;`, (err) => { if(err && !err.message.includes('duplicate column name')) console.error("DB Migration Error (add last_name):", err.message); });
             // Add index for names
             instance.run(`CREATE INDEX IF NOT EXISTS idx_users_name ON users(last_name, first_name);`, (err) => { if(err) console.error("DB Migration Error (create idx_users_name v6):", err.message); });
        }

        // v6 → v7  (add estimated_time_minutes)
        if (current < 7) {
          console.log('[DB] Applying v7 schema changes (task time estimates)…');
          instance.run(
            `ALTER TABLE tasks ADD COLUMN estimated_time_minutes INTEGER;`,
            err => { if (err && !/duplicate column/i.test(err.message)) console.error('Migration v7 error:', err.message); }
          );
          instance.run(
            `CREATE INDEX IF NOT EXISTS idx_tasks_estimate ON tasks(estimated_time_minutes);`
          );
        }

        /* ── bump user_version ── */
        instance.run(`PRAGMA user_version = ${DB_SCHEMA_VERSION};`, err => { // Use the constant
          if (err) return reject(err);
          console.log(`[DB] Schema migration complete → v${DB_SCHEMA_VERSION}`);
          resolve();
        });

      }); // serialize
    });   // get user_version
  });     // Promise
}

/* ─────────── initialise connection ─────────── */
const dbPromise = new Promise((resolve, reject) => {
  console.log('[DB] Opening', DB_PATH);
  const instance = new sqlite3.Database(DB_PATH, async err => {
    if (err) return reject(err);
    try {
      await applyPragmas(instance);
      await runMigrations(instance);
      db = instance;
      console.log(`[DB] Ready – schema v${DB_SCHEMA_VERSION}`);
      resolve(db);
    } catch (e) { reject(e); }
  });
}).catch(e => {
  console.error('[DB] Fatal DB init error:', e);
  process.exit(1);
});

async function getDb () { return dbPromise; } // Export function to get the resolved DB instance

/* ───────── helper wrappers ───────── */
function promisifyRun (sql, params = []) {
  return dbPromise.then(dbi => new Promise((res, rej) =>
    dbi.run(sql, params, function (err) { err ? rej(err) : res(this); })));
}
function promisifyGet (sql, params = []) {
  return dbPromise.then(dbi => new Promise((res, rej) =>
    dbi.get(sql, params, (err, row) => err ? rej(err) : res(row))));
}
function promisifyAll (sql, params = []) {
  return dbPromise.then(dbi => new Promise((res, rej) =>
    dbi.all(sql, params, (err, rows) => err ? rej(err) : res(rows))));
}

//--------------------------------------------------------------------
// Users - v6 schema includes first_name, last_name
//--------------------------------------------------------------------
const getUserById = async id => {
  return promisifyGet(
      `SELECT id, email, first_name, last_name, role, company_id, manager_id, job_title, team_name, profile_task_id
       FROM users WHERE id=?`, // Added first_name, last_name
      [id]
  );
};
module.exports.getUserById = getUserById;

const getAllUsers = async companyId => {
  if (!companyId && companyId !== 0) throw new Error("Company ID required");
  return promisifyAll(
    `SELECT id, email, first_name, last_name, role, company_id, manager_id, job_title, team_name, profile_task_id
     FROM users WHERE company_id=? ORDER BY role, last_name, first_name, email`, // Added names, updated sort
    [companyId]
  );
};
module.exports.getAllUsers = getAllUsers;

const getUserByEmail = async (email, companyId) => {
    if (!email || !companyId) return null;
    return promisifyGet(
        `SELECT id, email, first_name, last_name, role, company_id, manager_id, job_title, team_name, profile_task_id
         FROM users WHERE lower(email)=lower(?) AND company_id=?`, // Added names
        [email, companyId]
    );
};
module.exports.getUserByEmail = getUserByEmail;

// Updated getUserByName using new columns
const getUserByName = async (name, companyId) => {
    if (!name || !companyId) return [];
    const searchTerm = name.toLowerCase().trim();
    // Attempt to match full name or first name
    return promisifyAll(
       `SELECT id, email, first_name, last_name, role, job_title, team_name
         FROM users
         WHERE company_id = ?
           AND (
                 lower(first_name || ' ' || last_name) LIKE '%' || ? || '%'
                 OR lower(first_name) LIKE ? || '%'
               )
         ORDER BY last_name, first_name`, // Prioritize more complete matches implicitly
       [companyId, searchTerm, searchTerm]
    );
  };
module.exports.getUserByName = getUserByName;

const getUserByRole = async (role, companyId) => {
    if (!role || !companyId) return null;
    return promisifyGet(
        `SELECT id, email, first_name, last_name, role, company_id, manager_id, job_title, team_name, profile_task_id
         FROM users WHERE lower(role)=lower(?) AND company_id=? LIMIT 1`, // Added names
        [role, companyId]
    );
};
module.exports.getUserByRole = getUserByRole;

// **** START Added getRoster helper (Should be here from previous step) ****
const getRoster = async companyId => {
    if (!companyId && companyId !== 0) throw new Error("Company ID required for getRoster");
    const dbi = await dbPromise;
    return new Promise((res, rej) =>
        dbi.all(
          'SELECT id, first_name AS fn, last_name AS ln, email FROM users WHERE company_id = ?',
          [companyId],
          (e, rows) => (e ? rej(e) : res(rows || [])) // Ensure rows is always an array
        ));
};
module.exports.getRoster = getRoster;
// **** END Added getRoster helper ****

// Modified setUserProfile to record history - REQUIRES changerUserId
const setUserProfile = async ({ userId, companyId, firstName, lastName, jobTitle, managerId, teamName, changerUserId }) => { // <<< Added firstName, lastName
  if (!userId || !companyId || !changerUserId) throw new Error("User ID, Company ID, and Changer User ID required");

  const old = await getUserById(userId);
  if (!old || old.company_id !== companyId) throw new Error("User not found or company mismatch.");

  // Normalize inputs <<< MODIFIED: Added name normalization >>>
  const newFirstName = firstName === undefined ? old.first_name : (firstName?.trim() || null);
  const newLastName = lastName === undefined ? old.last_name : (lastName?.trim() || null);
  const newJobTitle = jobTitle === undefined ? old.job_title : (jobTitle?.trim() || null);
  const newManagerId = managerId === undefined ? old.manager_id : (managerId === null ? null : parseInt(managerId, 10));
  const newTeamName = teamName === undefined ? old.team_name : (teamName?.trim() || null);

  // Update user profile <<< MODIFIED: Added name columns to UPDATE >>>
  const result = await promisifyRun(
      `UPDATE users SET
          first_name = ?,
          last_name = ?,
          job_title = ?,
          manager_id = ?,
          team_name = ?
       WHERE id = ? AND company_id = ?`,
      [newFirstName, newLastName, newJobTitle, newManagerId, newTeamName, userId, companyId]
  );

  // Record history <<< MODIFIED: Check name changes for diff >>>
  if (result.changes > 0) {
      const diff = {};
      if (old.first_name !== newFirstName) diff.first_name = { old: old.first_name, new: newFirstName };
      if (old.last_name !== newLastName)   diff.last_name = { old: old.last_name, new: newLastName };
      if (old.job_title !== newJobTitle)   diff.job_title = { old: old.job_title, new: newJobTitle };
      if (old.manager_id !== newManagerId) diff.manager_id = { old: old.manager_id, new: newManagerId };
      if (old.team_name !== newTeamName)   diff.team_name = { old: old.team_name, new: newTeamName };

      if (Object.keys(diff).length > 0) {
            await promisifyRun(
               `INSERT INTO profile_history (user_id, company_id, changed_by, diff_json)
                VALUES (?,?,?,?)`,
               [userId, companyId, changerUserId, JSON.stringify(diff)]
            );
            console.log(`[DB] Profile history recorded for user ${userId} by user ${changerUserId}`);
        } else {
            console.log(`[DB] Profile update for user ${userId} resulted in 0 effective changes (data identical).`);
        }
    } else {
         console.log(`[DB] Profile update for user ${userId} resulted in 0 DB changes.`);
    }

    return result.changes; // Return number of rows updated
};
module.exports.setUserProfile = setUserProfile;

// New helper: Get the profile task ID for a user
const getProfileTaskIdForUser = async (userId, companyId) => {
    if (!userId || !companyId) return null;
    const result = await promisifyGet(
        `SELECT profile_task_id FROM users WHERE id = ? AND company_id = ?`,
        [userId, companyId]
    );
    return result?.profile_task_id || null;
};
module.exports.getProfileTaskIdForUser = getProfileTaskIdForUser;

//--------------------------------------------------------------------
// Tasks & Steps (v7 includes estimatedMinutes)
//--------------------------------------------------------------------
/** Create a new task record.
 * @param {Object} opts
 * @param {number|null} opts.estimatedMinutes  – optional time estimate in minutes
 */
const addTask = async ({ taskId, companyId, employeeId, title,
                         description, estimatedMinutes = null }) => {
  await promisifyRun(
    `INSERT INTO tasks
       (task_id, company_id, employee_id, title, original_description, estimated_time_minutes)
     VALUES (?,?,?,?,?,?)`,
    [taskId, companyId, employeeId, title, description || null, estimatedMinutes]
  );
  return taskId;
};
module.exports.addTask = addTask;

/** Update (or set) the time-estimate for a task. */
const setTaskEstimate = async ({ taskId, companyId, estimatedMinutes }) => {
  const result = await promisifyRun(
    `UPDATE tasks SET estimated_time_minutes = ?
       WHERE task_id = ? AND company_id = ?`,
    [estimatedMinutes, taskId, companyId]
  );
  return result.changes;
};
module.exports.setTaskEstimate = setTaskEstimate;

const addStep = async ({ taskId, companyId, stepNumber, description, isInterruption = 0 }) => {
  if (!(taskId && companyId && Number.isInteger(stepNumber) && description !== undefined)) throw new Error("Missing fields for addStep");
  const res = await promisifyRun(
    `INSERT INTO task_steps (task_id, company_id, step_number, description, is_interruption) VALUES (?,?,?,?,?)`,
    [taskId, companyId, stepNumber, description, isInterruption ? 1 : 0]
  );
  return res.lastID;
};
module.exports.addStep = addStep;

const updateStepStatus = async ({ stepId, status, lastUpdateJson }) => {
  await promisifyRun(
    `UPDATE task_steps SET status = ?, last_update_json = COALESCE(?, last_update_json) WHERE step_id = ?`,
    [status, lastUpdateJson || null, stepId]
  );
};
module.exports.updateStepStatus = updateStepStatus;

const getStepsForTask = async taskId => {
  return promisifyAll(
    `SELECT step_id, task_id, company_id, step_number, description, status, is_interruption, last_update_json, created_at, updated_at
     FROM task_steps
     WHERE task_id = ? ORDER BY step_number`,
    [taskId]
  );
};
module.exports.getStepsForTask = getStepsForTask;

const updateTaskStatus = async ({ taskId, companyId, newStatus }) => {
    const result = await promisifyRun(
        `UPDATE tasks SET status = ? WHERE task_id = ? AND company_id = ?`,
        [newStatus, taskId, companyId]
    );
    return result.changes;
};
module.exports.updateTaskStatus = updateTaskStatus;

//--------------------------------------------------------------------
// Task progress updates & polls (No changes needed for v7)
//--------------------------------------------------------------------
const addTaskUpdate = async ({ taskId, companyId, employeeId, updateText, stepNumber = null }) => {
  const res = await promisifyRun(
    `INSERT INTO task_updates (task_id, company_id, employee_id, step_number, update_text) VALUES (?,?,?,?,?)`,
    [taskId, companyId, employeeId, stepNumber, updateText]
  );
  return res.lastID;
};
module.exports.addTaskUpdate = addTaskUpdate;

const getUpdatesForTask = async taskId => {
  return promisifyAll(
    `SELECT * FROM task_updates WHERE task_id = ? ORDER BY created_at`, [taskId]
  );
};
module.exports.getUpdatesForTask = getUpdatesForTask;

const recordPollRequest = async ({ pollId, taskId, requestedBy }) => {
  await promisifyRun(
    `INSERT INTO poll_requests (poll_id, task_id, requested_by) VALUES (?,?,?)`,
    [pollId, taskId, requestedBy]
  );
  return pollId;
};
module.exports.recordPollRequest = recordPollRequest;

const markPollResponded = async pollId => {
  await promisifyRun(
    `UPDATE poll_requests SET status='responded', responded_at=CURRENT_TIMESTAMP WHERE poll_id = ?`, [pollId]
  );
};
module.exports.markPollResponded = markPollResponded;

//--------------------------------------------------------------------
// Team Name Helper (v5)
//--------------------------------------------------------------------
// New helper: Get likely canonical team name using fuzzy matching
const getLikelyTeam = async (snippet, companyId) => {
    if (!snippet || !companyId) return null;
    // Find the most common team name that contains the snippet (case-insensitive)
    const result = await promisifyGet(
       `SELECT team_name
          FROM users
         WHERE company_id=? AND team_name IS NOT NULL
           AND lower(team_name) LIKE '%' || lower(?) || '%'
         GROUP BY lower(team_name) -- Group by lower case to count variations together
         ORDER BY count(*) DESC, length(team_name) ASC -- Prefer most common, then shortest match
         LIMIT 1`,
       [companyId, snippet]
    );
    return result?.team_name || null; // Return the canonical name (original casing)
};
module.exports.getLikelyTeam = getLikelyTeam;

//--------------------------------------------------------------------
// Logging (No changes needed for v7)
//--------------------------------------------------------------------
const write = async ({ ts, type, agentId, employeeId, data }) => {
  const taskId = data?.taskId || null;
  await promisifyRun(
    `INSERT INTO log (ts, type, agentId, employeeId, task_id, payload) VALUES (?,?,?,?,?,?)`,
    [ts, type, agentId, employeeId, taskId, JSON.stringify(data)]
  );
};
module.exports.write = write;

const summaryForDay = async dayIso => {
  const rows = await promisifyAll( `SELECT * FROM log WHERE ts LIKE ?`, [`${dayIso}%`] );
  const byEmp = {};
  rows.forEach(r => {
    if (!byEmp[r.employeeId]) byEmp[r.employeeId] = [];
    try { byEmp[r.employeeId].push(JSON.parse(r.payload || "{}")); } catch {/* ignore */}
  });
  return byEmp;
};
module.exports.summaryForDay = summaryForDay;

//--------------------------------------------------------------------
// Utility – close connection on app shutdown
//--------------------------------------------------------------------
const close = async () => {
  const dbi = await dbPromise;
  if (!dbi) return;
  await new Promise(res => dbi.close(res));
  console.log("[DB] Connection closed.");
  db = null;
};
module.exports.close = close;

//--------------------------------------------------------------------
// Export promise and getDb function itself
//--------------------------------------------------------------------
module.exports.dbPromise = dbPromise;
module.exports.getDb = getDb;
module.exports.promisifyRun = promisifyRun;
module.exports.promisifyGet = promisifyGet;
module.exports.promisifyAll = promisifyAll;