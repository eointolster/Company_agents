/**
 * User registration (for initial Company & CEO setup) & login (for all users)
 * Exports a function that takes the initialized 'db' object.
 */

const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const router   = express.Router(); // Create a router instance

module.exports = function(db) {

    if (!db || typeof db.prepare !== 'function' || typeof db.get !== 'function') {
        throw new Error("Auth routes initialized without a valid DB object.");
    }

    const JWT_SECRET  = process.env.JWT_SECRET || 'changeme';
    const SALT_ROUNDS = 10;

    /* ── POST /api/register (Company & Initial CEO Setup) ─────────────── */
    // Now accepts and stores first_name and last_name
    router.post('/register', async (req, res) => {
      // <<< MODIFIED: Expect first_name, last_name >>>
      const { company_name, email, password, first_name, last_name } = req.body;
      const role = 'CEO';

      // <<< MODIFIED: Validation includes names >>>
      if (!company_name || !email || !password || !first_name || !last_name) {
        return res.status(400).json({ error: 'Company name, email, password, first name, and last name are required' });
      }
      if (password.length < 6) {
         return res.status(400).json({ error: 'Password must be at least 6 characters' });
      }
      if (!/\S+@\S+\.\S+/.test(email)) {
           return res.status(400).json({ error: 'Invalid email format' });
      }
      // Optional: Add length/character validation for names if needed

      const hash = bcrypt.hashSync(password, SALT_ROUNDS);
      let newCompanyId = null;

      try {
          db.serialize(() => {
              db.run("BEGIN TRANSACTION", (beginErr) => {
                  if (beginErr) throw beginErr;

                  // 1. Insert Company
                  const companyStmt = db.prepare(`INSERT INTO companies (name) VALUES (?)`);
                  companyStmt.run(company_name, function(companyInsertErr) {
                      if (companyInsertErr) {
                          const msg = companyInsertErr.message.includes('UNIQUE constraint failed: companies.name')
                              ? 'Company name already exists.'
                              : 'Error creating company.';
                          console.error("[API /register] DB Error (Company Insert):", companyInsertErr.message);
                           db.run("ROLLBACK");
                           companyStmt.finalize();
                           return res.status(400).json({ error: msg });
                      }
                      newCompanyId = this.lastID;
                      console.log(`[API /register] Company '${company_name}' created with ID: ${newCompanyId}`);
                      companyStmt.finalize();

                      // 2. Insert User <<< MODIFIED: Include name columns and values >>>
                      const userStmt = db.prepare(
                          `INSERT INTO users (email, password_hash, role, company_id, first_name, last_name) VALUES (?, ?, ?, ?, ?, ?)`
                          //                                                         ^----------^------ Added columns
                      );
                      userStmt.run(email, hash, role, newCompanyId, first_name, last_name, function(userInsertErr) {
                          //                                         ^----------^------ Added values
                          if (userInsertErr) {
                              const msg = userInsertErr.message.includes('UNIQUE constraint failed: users.email')
                                  ? 'Email already registered.'
                                  : 'Error creating user.';
                              console.error("[API /register] DB Error (User Insert):", userInsertErr.message);
                              db.run("ROLLBACK");
                              userStmt.finalize();
                              return res.status(400).json({ error: msg });
                          }
                          const newUserId = this.lastID;
                          userStmt.finalize();

                          // 3. Commit Transaction
                          db.run("COMMIT", (commitErr) => {
                              if (commitErr) {
                                  console.error("[API /register] DB Error (Commit):", commitErr.message);
                                  return res.status(500).json({ error: "Transaction commit failed." });
                              }

                              // 4. Sign JWT and Respond <<< MODIFIED: Updated log message >>>
                              const token = jwt.sign(
                                { uid: newUserId, role, cid: newCompanyId, email: email }, // Payload unchanged
                                JWT_SECRET,
                                { expiresIn: '8h' }
                              );
                              console.log(`[API /register] CEO User '${first_name} ${last_name}' (${email}, ID: ${newUserId}) registered for company ID ${newCompanyId}`);
                              res.status(201).json({ token });
                          });
                      });
                  });
              });
          });
      } catch (outerErr) {
          console.error("[API /register] Outer Transaction/Prepare Error:", outerErr);
          db.run("ROLLBACK");
          res.status(500).json({ error: "Server error during registration." });
      }
    }); // End POST /api/register

    /* ── POST /api/login (Unchanged) ────── */
    router.post('/login', (req, res) => {
      const { email, password } = req.body;
      if (!email || !password) return res.status(400).json({ error: 'email & password required' });

      try {
          db.get(`SELECT * FROM users WHERE email=?`, [email], (err, row) => {
            if (err) { console.error("[API /login] DB Error:", err.message); return res.status(500).json({ error: "DB error." }); }
            if (!row) { console.log(`[API /login] Fail (email not found): ${email}`); return res.status(401).json({ error: 'Bad credentials' }); }
            if (!bcrypt.compareSync(password, row.password_hash)) { console.log(`[API /login] Fail (bad pass): ${email}`); return res.status(401).json({ error: 'Bad credentials' }); }

            const token = jwt.sign(
              { uid: row.id, role: row.role, cid: row.company_id, email: row.email }, // Include cid
              JWT_SECRET,
              { expiresIn: '8h' }
            );
            console.log(`[API /login] OK: ${email} (Role: ${row.role}, Company: ${row.company_id})`);
            res.json({ token });
          });
      } catch (dbErr) {
          console.error("[API /login] Error running db.get:", dbErr);
          res.status(500).json({ error: "DB error during login." });
      }
    });

    return router; // Return the configured router
}; //