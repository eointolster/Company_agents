


// src/server/index.js — v6.1 + Strict Chat/Task Separation + Domain Passing
// ──────────────────────────────────────────────────────────────────────────
//  + Implements strict separation:
//      - employee_message always targets/creates an ad-hoc 'chat' worker.
//      - employee_task_update targets the specific task worker.
//  + Adds support for the new Admin dashboards
//  + Persists time‑estimates coming from agent_worker (estimated_minutes)
//  + Broadcasts employee_status, agent_assignment & agent_status updates
//  + Passes companyDomain to profile_update tasks
//
/* eslint camelcase:0 */

const cluster   = require('node:cluster');
const os        = require('os');
const express   = require('express');
const path      = require('node:path');
const WebSocket = require('ws');
const cron      = require('node-cron');
const { v4: uuid } = require('uuid');
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');

// ─── Config & DB helpers ────────────────────────────────────────────────
const cfg = require('../config');
const db  = require('../db/sqlite');
const {
  dbPromise,
  // User helpers
  getAllUsers,
  getUserById,
  getUserByEmail,
  getUserByName, // Added v5
  getUserByRole, // Added v5
  setUserProfile, // v5 version (expects changerUserId)
  getProfileTaskIdForUser, // Added v5
  getRoster, // Added for profileResolver
  // Task helpers
  addTask,
  addStep,
  setTaskEstimate,          // ← NEW helper (v7 schema)
  getStepsForTask,
  updateTaskStatus,
  // Update/Poll helpers
  addTaskUpdate,
  getUpdatesForTask,
  recordPollRequest,
  markPollResponded,
  // Team helper
  getLikelyTeam, // Added v5
  // Log helpers
  write: writeDbLog,
  summaryForDay
} = db;

// Resolver Logic (v5)
const resolveProfile = require('./profileResolver'); // Import resolver

const setupAuthRoutes = require('../routes/auth');
const authGuard       = require('./middleware/auth');
const JWT_SECRET      = process.env.JWT_SECRET || 'changeme';

/* ───────────────────────────────────────────────────────────────────────*/
/* 0. PRIMARY PROCESS                                                     */
/* ───────────────────────────────────────────────────────────────────────*/
if (cluster.isPrimary) {
  (async function startServer () {
    console.log('[Primary] ⏳ Waiting for database connection…');
    const dbi_instance = await dbPromise;
    console.log('[Primary] ✅ Database ready.');

    /* ------------ 0.1  Worker-pool bookkeeping ----------------------- */
    const pool             = new Map(); // workerId -> { worker, busy, lastUsed, currentEmployeeId, currentTaskData }
    const waitQ            = []; // Tasks waiting for a worker { envelope, _initialMsgPayload? }
    const state            = new Map(); // General purpose state (e.g., summaries)
    const empToWorker      = new Map(); // employeeId -> workerId (Tracks *any* worker assigned)
    const taskToWorker     = new Map(); // taskId -> workerId (Tracks specific task assignment)
    const empToChatWorker  = new Map(); // employeeId -> chatId (Tracks dedicated CHAT task worker if active)
    const empSockets       = new Map(); // employeeId -> WebSocket
    const adminSockets     = new Set(); // Set of Admin WebSockets

    const spawnWorker = () => {
      const wk = cluster.fork();
      console.log(`[Primary] Spawning worker ${wk.id}`);
      pool.set(wk.id, { worker: wk, busy: false, lastUsed: Date.now() });
      wk.on('message', msg => handleFromWorker(msg, wk.id));
      wk.on('exit', (code, sig) => {
        console.warn(`[Primary] Worker ${wk.id} exited (code ${code}, sig ${sig})`);
        const meta = pool.get(wk.id);
        if (meta) {
            if (meta.currentEmployeeId) {
                broadcastAgentAssignment(meta.currentEmployeeId, wk.id, 'released'); // Broadcast release on exit
                empToWorker.delete(meta.currentEmployeeId);
                // Also clear chat worker tracking if this worker was handling a chat
                if (empToChatWorker.get(meta.currentEmployeeId) === meta.currentTaskData?.taskId) {
                    empToChatWorker.delete(meta.currentEmployeeId);
                }
            }
            if (meta.currentTaskData?.taskId) taskToWorker.delete(meta.currentTaskData.taskId);
        }
        pool.delete(wk.id);
        if (pool.size < cfg.MIN_WORKERS) { console.log(`[Primary] Respawning worker...`); spawnWorker(); }
      });
      wk.on('error', err => {
        console.error(`[Primary] Worker ${wk.id} error:`, err);
        const meta = pool.get(wk.id);
         if (meta) {
            if (meta.currentEmployeeId) {
                broadcastAgentAssignment(meta.currentEmployeeId, wk.id, 'released'); // Broadcast release on error
                empToWorker.delete(meta.currentEmployeeId);
                // Also clear chat worker tracking if this worker was handling a chat
                 if (empToChatWorker.get(meta.currentEmployeeId) === meta.currentTaskData?.taskId) {
                     empToChatWorker.delete(meta.currentEmployeeId);
                 }
            }
            if (meta.currentTaskData?.taskId) taskToWorker.delete(meta.currentTaskData.taskId);
        }
        pool.delete(wk.id);
        if (pool.size < cfg.MIN_WORKERS) { console.log(`[Primary] Respawning worker...`); spawnWorker(); }
      });
    };
    for (let i = 0; i < cfg.MIN_WORKERS; i++) spawnWorker();

    // --- MODIFIED assignTask (Accepts initialMsgPayload) ---
    const assignTask = (envelope, initialMsgPayload = null) => {
      // Only assign if task data and taskId exist
      if (!envelope?.data?.taskId) {
          console.error('[Primary Assign Task] Attempted to assign task without valid data/taskId:', envelope);
          return;
      }
      const taskId = envelope.data.taskId;
      const taskType = envelope.data.taskType;
      const employeeId = envelope.employeeId;

      console.log(`[Primary] ➡️ Assign request for task ${taskId}, type ${taskType}, employee ${employeeId}`);
      const idleMetaArr = [...pool.values()].filter(m => !m.busy).sort((a, b) => a.lastUsed - b.lastUsed);
      const idleMeta = idleMetaArr[0];

      if (idleMeta) {
        const workerId = idleMeta.worker.id;
        console.log(`[Primary]    ↳ sending task ${taskId} to idle worker ${workerId}`);
        idleMeta.busy = true;
        idleMeta.lastUsed = Date.now();
        idleMeta.currentEmployeeId = employeeId;
        idleMeta.currentTaskData = envelope.data; // Includes taskType, companyDomain etc.

        empToWorker.set(employeeId, workerId); // General assignment
        taskToWorker.set(taskId, workerId); // Specific task assignment
        if (taskType === 'chat') {
            empToChatWorker.set(employeeId, taskId); // Track dedicated chat worker
            console.log(`[Primary]    ↳ Tracking worker ${workerId} as CHAT worker for employee ${employeeId} (Task: ${taskId})`);
        }

        // Send the main task envelope
        idleMeta.worker.send(envelope);

        // Send initial message if provided (for chat tasks)
        if (initialMsgPayload && initialMsgPayload.text && taskType === 'chat') {
            console.log(`[Primary]    ↳ forwarding initial chat message for task ${taskId} to worker ${workerId}`);
            idleMeta.worker.send({
                type: 'employee_input', // Worker expects this type for subsequent messages
                employeeId: employeeId,
                taskId: taskId, // Worker needs taskId to associate correctly
                data: {
                    text: initialMsgPayload.text || ''
                    // No need to include taskId inside data again
                }
            });
        }

        broadcastAgentAssignment(employeeId, workerId, 'assigned');
        broadcastAgentStatus(employeeId, workerId, 'active');
      } else {
          // Queueing logic (associating initial message)
          const taskToQueue = { ...envelope };
          if (initialMsgPayload && taskType === 'chat') { // Only queue initial message for chat tasks
             taskToQueue._initialMsgPayload = initialMsgPayload;
             console.log(`[Primary] Attaching initial chat message to queued task ${taskId}`);
          }

          if (pool.size < cfg.MAX_WORKERS) {
            console.log(`[Primary]    ↳ pool saturated, spawning extra worker & queueing task ${taskId}`);
            spawnWorker();
            waitQ.push(taskToQueue);
          } else {
            console.log(`[Primary]    ↳ pool at max, queueing task ${taskId}`);
            waitQ.push(taskToQueue);
          }
      }
    };
    // --- END MODIFIED assignTask ---

    // Periodic GC
    setInterval(() => {
        const now = Date.now(); if (pool.size <= cfg.MIN_WORKERS) return;
        const workersToGC = [];
        for (const [id, meta] of pool.entries()) {
            // **** Bonus Polish #1: Don't GC if assigned to a chat ****
            const isHandlingChat = meta.currentEmployeeId && empToChatWorker.get(meta.currentEmployeeId) === meta.currentTaskData?.taskId;
            if (!meta.busy && !isHandlingChat && now - meta.lastUsed > cfg.WORKER_IDLE_MS) { workersToGC.push(id); }
        }
        for (const id of workersToGC) {
          if (pool.size <= cfg.MIN_WORKERS) break;
          console.log(`[Primary GC] Killing idle worker ${id}`);
          const meta = pool.get(id);
          if (meta) { meta.worker.kill(); } // exit handler will clean up maps
        }
      }, cfg.WORKER_IDLE_MS / 2);

    // Push Poll
    const pushPoll = (empId, pollId, taskId) => {
        const ws = empSockets.get(empId);
        if (ws && ws.readyState === WebSocket.OPEN && ws.isAuth) {
          console.log(`[Primary] Pushing poll request ${pollId} for task ${taskId} to employee ${empId}`);
          ws.send(JSON.stringify({ type: 'poll_request', pollId, taskId, message: 'Manager requested an update for this task.' }));
        } else { console.log(`[Primary] Cannot push poll request to employee ${empId} - socket offline/unauthed.`); }
      };

    // --- Broadcast Helpers ---
    function broadcast(obj) {
        if (wss.clients.size === 0) return;
        const str = JSON.stringify(obj);
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(str, (err) => { if (err) console.error('[Primary WS Broadcast Error]:', err); });
            }
        });
    }

    function broadcastToAdmins(obj) {
        if (adminSockets.size === 0) return;
        const str = JSON.stringify(obj);
        adminSockets.forEach(client => {
            // Ensure client is authenticated and has an admin role
            if (client.isAuth && (client.role === 'CEO' || client.role === 'PM') && client.readyState === WebSocket.OPEN) {
                 client.send(str, (err) => { if (err) console.error('[Primary WS Admin Broadcast Error]:', err); });
            }
        });
    }

    function broadcastEmployeeStatus(employeeId, status) {
        console.log(`[WS Broadcast] Employee Status: ${employeeId} -> ${status}`);
        broadcastToAdmins({type: 'employee_status', employeeId, status});
    }

    function broadcastAgentAssignment(employeeId, workerId, phase) {
        console.log(`[WS Broadcast] Agent Assignment: Emp ${employeeId}, Worker ${workerId}, Phase: ${phase}`);
        broadcastToAdmins({type: 'agent_assignment', employeeId, workerId: (phase === 'assigned' ? workerId : null), phase});
    }

    function broadcastAgentStatus(empId, workerId, status /* 'active' | 'idle' */) {
      console.log(`[WS Broadcast] Agent Status: Emp ${empId}, Worker ${workerId}, Status: ${status}`);
      broadcastToAdmins({ type: 'agent_status', employeeId: empId, workerId, status });
    }

    // --- Handle messages FROM WORKERS ---
    const handleFromWorker = async (msg, workerId) => {
      msg._fromWorker = workerId; // Keep track of which worker sent it
      let handled = false;
      let shouldBroadcastToAdmins = false; // Flag to control broadcasting

      // Log non-idle messages
      if (msg.type !== 'idle') { writeDbLog(msg).catch(e => console.error('[Primary] DB log error:', e)); }

      // Determine if this message type should generally be broadcast to admins
      const broadcastableTypes = ['agent_response', 'status', 'error', 'agent_summary_json', 'parsed_profile_data', 'task_steps_saved', 'profile_updated', 'daily_summary'];
      if (broadcastableTypes.includes(msg.type)) {
           if (msg.type === 'error' && msg.employeeId && empSockets.has(msg.employeeId)) {
               shouldBroadcastToAdmins = false; // Don't broadcast errors if user gets them
           } else {
               shouldBroadcastToAdmins = true;
           }
      }
      if (msg.type === 'task_steps_saved') shouldBroadcastToAdmins = false; // Handled explicitly later
      if (msg.type === 'profile_updated') shouldBroadcastToAdmins = false; // Handled explicitly later
      if (msg.type === 'idle') shouldBroadcastToAdmins = false;


      // (A) breakdown summary inc. estimate
      if (msg.type === 'agent_summary_json' && msg.data?.steps && msg.data?.taskId) {
        const {taskId, steps, estimated_minutes: estimatedMinutes } = msg.data;
        const companyId = msg.companyId || msg.data.companyId;
        const employeeId = msg.employeeId;

        if (!employeeId || !companyId || !taskId) {
             console.error(`[Primary] Missing context for agent_summary_json:`, msg);
             handled = true;
             shouldBroadcastToAdmins = false;
             return;
        }

        if (steps) {
          try {
            const inserts = steps.map((d, i) => addStep({ taskId, companyId, stepNumber: i+1, description: d, isInterruption: msg.data.is_interruption || 0 }));
            await Promise.all(inserts);
            if (typeof estimatedMinutes === 'number' && Number.isFinite(estimatedMinutes) && estimatedMinutes >= 0) {
              await setTaskEstimate({taskId, companyId, estimatedMinutes});
              console.log(`[Primary] Saved estimate ${estimatedMinutes}m for task ${taskId}`);
            } else if (estimatedMinutes !== undefined) {
              console.warn(`[Primary] Received invalid estimate for task ${taskId}:`, estimatedMinutes);
            }
            await updateTaskStatus({taskId, companyId, newStatus: 'in_progress'});
            broadcastAgentStatus(employeeId, workerId, 'busy'); // Use 'busy' consistently

            const savedSteps = await getStepsForTask(taskId);
            broadcastToAdmins({ type: 'task_steps_saved', taskId, employeeId, steps: savedSteps, estimate: estimatedMinutes, status: 'in_progress' });
            shouldBroadcastToAdmins = false;
          } catch(e) {
            console.error(`[Primary] Error saving steps/estimate for task ${taskId}:`, e);
            shouldBroadcastToAdmins = false;
          }
        }
        handled = true;
      }

      // --- Handle PARSED PROFILE DATA using Resolver ---
      else if (msg.type === 'parsed_profile_data') {
           const { employeeId, companyId, data: parsed } = msg;
           const ws = empSockets.get(employeeId);

           if (!employeeId || !companyId || !parsed) {
                console.error(`[Primary] Invalid parsed_profile_data received:`, msg);
                if(ws) ws.send(JSON.stringify({ type: 'system_message', data: { message: 'Internal error processing profile data.' } }));
                handled = true;
                shouldBroadcastToAdmins = false;
                return;
           }

           console.log(`[Primary] Resolving profile data for employee ${employeeId} from worker ${workerId}`);
           try {
                const { changed, problems } = await resolveProfile({ companyId: companyId, employeeId: employeeId, changerUserId: employeeId, parsed: parsed });
                console.log(`[Primary] Profile resolution result for ${employeeId}: Changed=${changed}, Problems=${problems.join('; ')}`);
                broadcastAgentStatus(employeeId, workerId, 'busy'); // Update status after processing

                if (ws?.readyState === WebSocket.OPEN) {
                    let feedbackMsg = '';
                    if (changed > 0 && problems.length === 0) feedbackMsg = 'Profile updated successfully!';
                    else if (changed > 0 && problems.length > 0) feedbackMsg = `Profile saved, but with issues:\n• ${problems.join('\n• ')}`;
                    else if (changed === 0 && problems.length > 0) feedbackMsg = `Profile not saved due to issues:\n• ${problems.join('\n• ')}`;
                    else feedbackMsg = 'No changes detected in the profile information provided.';
                     ws.send(JSON.stringify({ type: 'system_message', data: { message: feedbackMsg } }));
                }

                if (changed > 0) {
                  const updatedUser = await getUserById(employeeId);
                  if (updatedUser) {
                       console.log(`[Primary Debug] Broadcasting profile_updated for user ${employeeId}...`); // Add this log
                       broadcastToAdmins({ type: 'profile_updated', user: updatedUser });
                       console.log(`[Primary Debug] Broadcast sent.`); // Confirm sending
                       shouldBroadcastToAdmins = false; // Prevent double broadcast if flag was set earlier
                  } else {
                       console.error(`[Primary] Failed to get updated user data for ${employeeId} after profile change.`);
                  }
              } else {
                   console.log(`[Primary Debug] Skipping profile_updated broadcast because changed=${changed}.`); // Log skip reason
              }

           } catch (resolverError) {
                console.error(`[Primary] Error during profile resolution for employee ${employeeId}:`, resolverError);
                if(ws) ws.send(JSON.stringify({ type: 'system_message', data: { message: `Error resolving profile data: ${resolverError.message}` } }));
                shouldBroadcastToAdmins = true; // Broadcast the error if resolver failed
           }
           handled = true;
      }

      // (B) worker finished
      else if (msg.type === 'idle') {
          const meta = pool.get(workerId);
          if (meta) {
              const prevEmp = meta.currentEmployeeId;
              const prevTaskData = meta.currentTaskData;

              if (prevEmp) { broadcastAgentStatus(prevEmp, workerId, 'idle'); }

              meta.busy = false; meta.lastUsed = Date.now();
              const finishedTaskId = prevTaskData?.taskId; // Get the ID of the task that just finished

              // --- Clear relevant maps ---
              if (prevEmp) {
                  console.log(`[Primary] Worker ${workerId} finished/idle after working for employee ${prevEmp} on task ${finishedTaskId || 'N/A'}`);
                  empToWorker.delete(prevEmp);
                  delete meta.currentEmployeeId;
                  // Check if the finished task was the dedicated chat task for this employee
                  if (prevTaskData?.taskType === 'chat' && empToChatWorker.get(prevEmp) === finishedTaskId) {
                      empToChatWorker.delete(prevEmp);
                      console.log(`[Primary]    ↳ Cleared dedicated chat worker tracking for employee ${prevEmp}`);
                  }
                  broadcastAgentAssignment(prevEmp, workerId, 'released');
              } else { console.log(`[Primary] Worker ${workerId} is now idle.`); }

              if (finishedTaskId) { taskToWorker.delete(finishedTaskId); }
              delete meta.currentTaskData;

              // Assign next task from queue (passing initial message if present)
              if (waitQ.length > 0) {
                  const nextTaskEnvelope = waitQ.shift();
                  assignTask(nextTaskEnvelope, nextTaskEnvelope._initialMsgPayload || null);
              }
          } else { console.warn(`[Primary] Idle message from unknown worker ${workerId}`); }
          handled = true;
          shouldBroadcastToAdmins = false;
      }

      // Route targeted messages to EMPLOYEE (if not handled above)
      else if (msg.employeeId && empSockets.has(msg.employeeId) && !handled) {
          const ws = empSockets.get(msg.employeeId);
          const shouldRelay = ['agent_response', 'system_message', 'error'].includes(msg.type);

          if (ws && ws.readyState === WebSocket.OPEN && ws.isAuth) {
              if (shouldRelay) {
                    console.log(`[Primary] Relaying msg type '${msg.type}' to employee ${msg.employeeId}`);
                    ws.send(JSON.stringify(msg));
                    const meta = pool.get(workerId);
                    if (meta && meta.busy && meta.currentEmployeeId === msg.employeeId) {
                        broadcastAgentStatus(msg.employeeId, workerId, 'busy'); // Worker is busy responding
                    }
                    handled = true;
              }
          } else if (!ws || !ws.isAuth || ws.readyState !== WebSocket.OPEN){
               console.log(`[Primary] Cannot relay msg type '${msg.type}'; employee ${msg.employeeId} offline/unauthed.`);
               if (shouldRelay) handled = true;
          }
      }

      // **** BROADCAST TO ADMINS (IF FLAGGED) ****
      if (shouldBroadcastToAdmins && !handled) {
          console.log(`[Primary] Broadcasting general message type '${msg.type}' from worker ${workerId} to admins.`);
          broadcastToAdmins(msg);
          handled = true;
      }

      if (!handled) { console.log(`[Primary] (unrouted/unhandled) worker msg type '${msg.type}' from worker ${workerId}`); }
    }; // End handleFromWorker

    /* ------------ 0.2  Express application ----------------------------- */
    const app = express();
    app.use(express.json());

    // Helper middleware to check roles
    const checkRole = (roles) => (req, res, next) => {
        if (req.user && roles.includes(req.user.role)) { return next(); }
        res.status(403).json({ error: 'Forbidden: Insufficient role privileges' });
    };

    // Helper middleware for "self or admin" checks
    const checkSelfOrAdmin = (req, res, next) => {
        const targetUserId = parseInt(req.params.userId, 10);
        if (isNaN(targetUserId)) return res.status(400).json({ error: 'Invalid user ID format' });
        if (req.user && (req.user.uid === targetUserId || req.user.role === 'CEO' || req.user.role === 'PM')) {
            return next();
        }
        res.status(403).json({ error: 'Forbidden: You can only modify your own profile or must be an admin.' });
    };

    // Static serving
    app.use(express.static(path.join(__dirname, '../../public')));

    // Root redirect
    app.get('/', (req, res) => { res.redirect('/login.html'); });

    // Specific Page Routes
    app.get('/admin.html', authGuard, checkRole(['CEO', 'PM']), (req, res) => { res.sendFile(path.join(__dirname, '../../public/admin.html')); });
    //app.get('/dashboard.html', authGuard, checkRole(['CEO', 'PM']), (req, res) => { res.sendFile(path.join(__dirname, '../../public/dashboard.html')); }); // Added auth guard
    app.get('/dashboard.html', (req, res) => { res.sendFile(path.join(__dirname, '../../public/dashboard.html')); });
    app.get('/manage-users.html', authGuard, checkRole(['CEO', 'PM']), (req, res) => { res.sendFile(path.join(__dirname, '../../public/manage-users.html')); });
    app.get('/employee.html', authGuard, checkRole(['EMP']), (req, res) => { res.sendFile(path.join(__dirname, '../../public/employee.html')); });
    app.get('/status-dashboard.html', authGuard, checkRole(['CEO', 'PM']), (req, res) => { res.sendFile(path.join(__dirname, '../../public/status-dashboard.html')); });
    app.get('/task-table-dashboard.html', authGuard, checkRole(['CEO', 'PM']), (req, res) => { res.sendFile(path.join(__dirname, '../../public/task-table-dashboard.html')); });

    // Auth routes
    app.use('/api', setupAuthRoutes(dbi_instance));

    /* ------------ ADMIN API ENDPOINTS ------------------------------ */

    // (1) Status Overview
    app.get('/api/admin/status-overview', authGuard, checkRole(['CEO', 'PM']), async (req, res) => {
      try {
        const users = await getAllUsers(req.user.cid);
        const overview = users.map(u => {
          const ws = empSockets.get(u.id);
          const isOnline = ws && ws.readyState === WebSocket.OPEN && ws.isAuth; // Check isAuth too
          const workerId = empToWorker.get(u.id) || null;
          const workerMeta = workerId ? pool.get(workerId) : null;
          // Determine agent status more accurately
          let agentStatus = 'unassigned';
          if (workerMeta) {
               // Agent is assigned, check if busy (processing task start or ongoing work)
               agentStatus = workerMeta.busy ? 'active' : 'idle';
          }
          // Determine employee idle status (example: online but no agent assigned)
          const isIdle = isOnline && !workerId;

          return {
            id: u.id,
            email: u.email,
            role: u.role,
            name: `${u.first_name || ''} ${u.last_name || ''}`.trim() || u.email,
            isOnline,
            isIdle,
            agentWorkerId: workerId,
            agentStatus: agentStatus
          };
        });
        res.json(overview);
      } catch (e) {
        console.error("[API /status-overview] Error:", e);
        res.status(500).json({error: 'Server error fetching status overview'});
      }
    });

    // (2) Pending tasks for specific employee
    app.get('/api/admin/employee/:eid/pending-tasks', authGuard, checkRole(['CEO', 'PM']), async (req, res) => {
      const employeeId = parseInt(req.params.eid, 10);
      if (Number.isNaN(employeeId)) return res.status(400).json({error: 'Bad id'});
      try {
        // Verify employee exists and belongs to admin's company
        const targetUser = await getUserById(employeeId);
         if (!targetUser || targetUser.company_id !== req.user.cid) {
             return res.status(404).json({ error: 'Employee not found or not in your company.' });
         }
        // Fetch tasks
        const rows = await new Promise((resolve, reject) => {
          dbi_instance.all(
            `SELECT task_id, title, status, estimated_time_minutes
             FROM tasks
             WHERE employee_id=? AND company_id=? AND status <> 'complete'
             ORDER BY created_at DESC`, // Changed <> instead of !=
            [employeeId, req.user.cid],
            (err, rows) => err ? reject(err) : resolve(rows || [])
          );
        });
        res.json(rows);
      } catch (e) {
        console.error(`[API /pending-tasks] Error for employee ${employeeId}:`, e);
        res.status(500).json({error: 'Database error fetching pending tasks'});
      }
    });

    // (3) All tasks (grouped)
    app.get('/api/admin/all-tasks', authGuard, checkRole(['CEO', 'PM']), async (req, res) => {
      const filterStatus = req.query.status?.toLowerCase();
      const allowed = ['pending', 'in_progress', 'stuck', 'complete'];
      const companyId = req.user.cid;

      try {
          let taskSql = `
              SELECT t.task_id, t.employee_id, t.title, t.original_description, t.status, t.created_at, t.estimated_time_minutes,
                     u.email AS employee_email, u.first_name AS employee_first_name, u.last_name AS employee_last_name
              FROM tasks t
              JOIN users u ON t.employee_id = u.id
              WHERE t.company_id = ?`;
          const params = [companyId];

          if (filterStatus && allowed.includes(filterStatus)) {
              taskSql += ' AND lower(t.status) = ?';
              params.push(filterStatus);
          } else if (filterStatus && filterStatus !== 'all') {
              console.warn(`[API /all-tasks] Ignoring invalid status filter: ${filterStatus}`);
          }

          taskSql += ' ORDER BY t.employee_id, t.created_at DESC';

          const tasks = await db.promisifyAll(taskSql, params);

          // Fetch steps for all tasks efficiently
          const taskIds = tasks.map(t => t.task_id);
          let stepsByTask = {};
          if (taskIds.length > 0) {
              const stepsPlaceholder = taskIds.map(() => '?').join(',');
              const allSteps = await db.promisifyAll(
                 `SELECT task_id, step_number, description, status FROM task_steps WHERE task_id IN (${stepsPlaceholder}) ORDER BY step_number`,
                  taskIds
              );
               allSteps.forEach(step => {
                   if (!stepsByTask[step.task_id]) stepsByTask[step.task_id] = [];
                   stepsByTask[step.task_id].push(step);
               });
          }

          // Group tasks by employee
          const groupedResult = {};
          tasks.forEach(task => {
              const empId = task.employee_id;
              if (!groupedResult[empId]) {
                  groupedResult[empId] = {
                      employee: {
                          id: empId,
                          email: task.employee_email,
                          name: `${task.employee_first_name || ''} ${task.employee_last_name || ''}`.trim() || task.employee_email
                      },
                      tasks: []
                  };
              }
               // Add steps to the task object
               task.steps = stepsByTask[task.task_id] || [];
              // Remove redundant employee info from task object before pushing
               delete task.employee_id;
               delete task.employee_email;
               delete task.employee_first_name;
               delete task.employee_last_name;
              groupedResult[empId].tasks.push(task);
          });

          res.json(groupedResult); // Return grouped structure

      } catch (e) {
          console.error("[API /all-tasks] Error:", e);
          res.status(500).json({error: 'Database error fetching tasks'});
      }
    });

    /* ---------------- Standard API Routes ------------------------------ */

    // GET Users (Admin view - now includes manager_id, job_title, team_name)
    app.get('/api/users', authGuard, checkRole(['CEO', 'PM']), async (req, res) => {
        try {
            const users = await getAllUsers(req.user.cid); // getAllUsers now returns new fields
            res.json(users);
        } catch (e) {
            console.error("[API /api/users] DB error:", e.message || e);
            res.status(500).json({ error: 'Database error getting users' });
        }
    });

    // POST Create Employee (Admin - UPDATED to store profile_task_id AND pass companyDomain)
    app.post('/api/admin/create-employee', authGuard, checkRole(['CEO', 'PM']), async (req, res) => {
      const { email, password } = req.body;
      if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
      if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
      let newUserId = null;
      let initialTaskId = null; // Store task ID
      try {
          const hash = bcrypt.hashSync(password, 10);
          const stmt = dbi_instance.prepare('INSERT INTO users (email, password_hash, role, company_id) VALUES (?, ?, ?, ?)');
          const result = await new Promise((resolve, reject) => {
              stmt.run(email, hash, 'EMP', req.user.cid, function (err) { // req.user.cid is companyId from JWT
                  stmt.finalize();
                  if (err) { const msg = err.message.includes('UNIQUE constraint failed: users.email') ? 'Email already exists.' : 'Database error creating user.'; return reject({ status: 400, message: msg }); }
                  resolve({ userId: this.lastID });
              });
          });
          newUserId = result.userId;
          console.log(`[API] Employee ${email} (ID: ${newUserId}) created by Admin ${req.user.uid} in Company ${req.user.cid}`);

          // Assign initial profile task
          initialTaskId = uuid(); // <<< Get the task ID
          const initialTaskTitle = "Update Your Profile Information";
          const initialTaskDesc = "Please provide your current job title, the email address/name of your direct manager (if any), and your primary team name."; // Updated description
          await addTask({ taskId: initialTaskId, companyId: req.user.cid, employeeId: newUserId, title: initialTaskTitle, description: initialTaskDesc });
          console.log(`[API] Assigned initial profile task ${initialTaskId} to new employee ${newUserId}`);

          // Link task ID to user profile
          await db.promisifyRun('UPDATE users SET profile_task_id=? WHERE id=?', [initialTaskId, newUserId]);
          console.log(`[API] Linked profile task ${initialTaskId} to user ${newUserId}`);

          // **** START Pass companyDomain (Refactor #2) ****
          let companyDomain = 'example.com'; // Default fallback
          // Infer domain from the ADMIN's email creating the user.
          // A more robust approach would be to store the domain on the companies table.
          if (req.user.email && req.user.email.includes('@')) {
              companyDomain = req.user.email.split('@')[1];
          }
          console.log(`[API] Using company domain "${companyDomain}" for task ${initialTaskId}`);
          // **** END Pass companyDomain ****

          // Assign task to worker, INCLUDING companyDomain
          assignTask({
              type: 'task',
              ts: new Date().toISOString(),
              agentId: 'system_init',
              employeeId: newUserId,
              companyId: req.user.cid,
              data: {
                  taskId: initialTaskId,
                  title: initialTaskTitle,
                  description: initialTaskDesc,
                  taskType: 'profile_update',
                  companyId: req.user.cid,
                  companyDomain: companyDomain // **** Pass the domain ****
              }
          });
          console.log(`[API] Dispatched initial profile task ${initialTaskId} to worker for employee ${newUserId}`);
          res.status(201).json({ ok: true, userId: newUserId });
      } catch(e) {
          console.error("[API /api/admin/create-employee] Error:", e.message || e);
          res.status(e.status || 500).json({ error: e.message || 'Failed to create employee or assign initial task' });
      }
    });

    // PUT Update User Profile (UPDATED to pass changerUserId)
    app.put('/api/users/:userId/profile', authGuard, checkSelfOrAdmin, async (req, res) => {
        const targetUserId = parseInt(req.params.userId, 10);
        const companyId = req.user.cid;
        const { firstName, lastName, jobTitle, managerEmail, teamName } = req.body; // Expect specific fields for direct update

        // Basic validation for direct API update
        if (firstName !== undefined && typeof firstName !== 'string' && firstName !== null) return res.status(400).json({ error: 'Invalid firstName format' });
        if (lastName !== undefined && typeof lastName !== 'string' && lastName !== null) return res.status(400).json({ error: 'Invalid lastName format' });
        if (jobTitle !== undefined && typeof jobTitle !== 'string' && jobTitle !== null) return res.status(400).json({ error: 'Invalid jobTitle format' });
        if (managerEmail !== undefined && managerEmail !== null && typeof managerEmail !== 'string') return res.status(400).json({ error: 'Invalid managerEmail format' });
        if (teamName !== undefined && typeof teamName !== 'string' && teamName !== null) return res.status(400).json({ error: 'Invalid teamName format' });

        let managerId = null;
        try {
            // Resolve manager email to ID if provided
            if (managerEmail) {
                if (!/\S+@\S+\.\S+/.test(managerEmail)) { return res.status(400).json({ error: `Manager email format looks invalid.` }); }
                const managerUser = await getUserByEmail(managerEmail, companyId);
                if (!managerUser) { return res.status(404).json({ error: `Manager with email '${managerEmail}' not found.` }); }
                if (managerUser.id === targetUserId) { return res.status(400).json({ error: 'User cannot be their own manager.' }); }
                managerId = managerUser.id;
            }

            // Call setUserProfile passing the ID of the user making the request
            const changes = await setUserProfile({
                userId: targetUserId,
                companyId,
                firstName, // Pass name
                lastName,  // Pass name
                jobTitle,
                managerId, // Use the resolved ID (or null if no email provided)
                teamName,
                changerUserId: req.user.uid // Pass logged-in user ID as changer
            });

            if (changes === 0) {
                const userExists = await getUserById(targetUserId);
                if (!userExists || userExists.company_id !== companyId) { return res.status(404).json({ error: 'User not found.' }); }
                else { console.log(`[API PUT /profile] User ${targetUserId} profile update resulted in 0 changes.`); return res.status(200).json(userExists); }
            }
            const updatedUser = await getUserById(targetUserId);
            if (!updatedUser) { return res.status(500).json({ error: 'Profile updated, but failed to retrieve latest data.' }); }
            console.log(`[API PUT /profile] User ${targetUserId} profile updated by user ${req.user.uid}.`);
            broadcastToAdmins({ type: 'profile_updated', user: updatedUser });
            res.status(200).json(updatedUser);

        } catch (e) {
            console.error(`[API PUT /profile] Error updating profile for user ${targetUserId}:`, e);
            res.status(500).json({ error: 'Server error updating profile.' });
        }
    });

    // GET Tasks for a specific employee (Admin view - supports filtering)
    app.get('/api/admin/employee/:eid/tasks', authGuard, checkRole(['CEO', 'PM']), async (req, res) => {
      const targetEmployeeId = parseInt(req.params.eid, 10);
      const adminCompanyId = req.user.cid;
      const requestedStatus = req.query.status;
      const validStatuses = ['pending', 'in_progress', 'stuck', 'complete'];

      if (isNaN(targetEmployeeId)) return res.status(400).json({ error: 'Invalid employee ID format' });

      // Verify admin has access to this employee's company
      const targetUser = await getUserById(targetEmployeeId);
      if (!targetUser || targetUser.company_id !== adminCompanyId) {
           return res.status(404).json({ error: 'Employee not found or not in your company.' });
      }

      let taskSql = `
          SELECT t.task_id, t.title, t.original_description, t.status, t.created_at, t.estimated_time_minutes,
                 json_group_array( DISTINCT json_object(
                     'step_id', s.step_id, 'step_number', s.step_number, 'description', s.description,
                     'status', s.status, 'is_interruption', s.is_interruption
                 )) FILTER (WHERE s.step_id IS NOT NULL) AS steps
          FROM tasks t
          LEFT JOIN task_steps s ON s.task_id = t.task_id
          WHERE t.employee_id = ? AND t.company_id = ? `;
      const params = [targetEmployeeId, adminCompanyId];

      if (requestedStatus && validStatuses.includes(requestedStatus.toLowerCase())) {
          taskSql += ` AND lower(t.status) = ? `; params.push(requestedStatus.toLowerCase()); // Use lower() for case-insensitivity
      } else if (requestedStatus && requestedStatus.toLowerCase() !== 'all') {
           console.log(`[API /api/admin/employee/:eid/tasks] Ignoring invalid status filter: ${requestedStatus}`);
      }
      taskSql += ` GROUP BY t.task_id ORDER BY t.created_at DESC;`;

      try {
          const tasks = await new Promise((resolve, reject) => { dbi_instance.all(taskSql, params, (err, rows) => err ? reject(err) : resolve(rows || [])); });
          for (const task of tasks) {
              try { task.steps = JSON.parse(task.steps || '[]'); task.steps.sort((a, b) => (a.step_number || 0) - (b.step_number || 0)); } catch (e) { console.error(`Error parsing steps JSON for task ${task.task_id}:`, e); task.steps = []; }
              try { task.updates = await getUpdatesForTask(task.task_id); } catch (updateErr) { console.error(`Error fetching updates for task ${task.task_id}:`, updateErr); task.updates = []; }
          }
          res.json(tasks);
      } catch (e) {
          console.error("[API /api/admin/employee/:eid/tasks] DB error:", e);
          res.status(500).json({ error: 'Database error getting tasks' });
      }
    });

    // POST Poll request for a task (Admin)
    app.post('/api/task/:tid/poll', authGuard, checkRole(['CEO', 'PM']), async (req, res) => {
        const taskId = req.params.tid; const pollId = uuid(); const adminUserId = req.user.uid; const adminCompanyId = req.user.cid;
        try {
            const task = await new Promise((resolve, reject) => { dbi_instance.get( 'SELECT employee_id FROM tasks WHERE task_id = ? AND company_id = ?', [taskId, adminCompanyId], (err, row) => err ? reject(err) : resolve(row) ); });
            if (task && task.employee_id) {
                await recordPollRequest({ pollId, taskId, requestedBy: adminUserId });
                pushPoll(task.employee_id, pollId, taskId);
                console.log(`[API /api/task/:tid/poll] Poll request ${pollId} initiated for task ${taskId} by Admin ${adminUserId}`);
                res.status(202).json({ pollId });
            } else { res.status(404).json({ error: 'Task not found or access denied' }); }
        } catch (e) { console.error("[API /api/task/:tid/poll] Error:", e); res.status(500).json({ error: 'Failed to initiate poll request' }); }
    });

    // POST Create new task (Employee)
    app.post('/api/employee/tasks', authGuard, checkRole(['EMP']), async (req, res) => {
        const { title, description = '' } = req.body; if (!title) return res.status(400).json({ error: 'Task title is required' });
        const taskId = uuid(); const employeeId = req.user.uid; const companyId = req.user.cid;
        const taskStatus = 'pending'; const createdAt = new Date().toISOString();
        try {
            await addTask({ taskId, companyId, employeeId, title, description });
            console.log(`[API /api/employee/tasks] Task ${taskId} created by Employee ${employeeId}`);
            assignTask({ type: 'task', ts: createdAt, agentId: `creator:${employeeId}`, employeeId: employeeId, companyId: companyId,
                data: { taskId: taskId, title: title, description: description, taskType: 'breakdown', companyId: companyId } // Pass companyId in data
            });
            console.log(`[API /api/employee/tasks] Dispatched task ${taskId} to worker for breakdown.`);
            const newTaskData = { type: 'new_task_created', employeeId: employeeId, task_id: taskId, title: title, original_description: description, status: taskStatus, created_at: createdAt, steps: [], updates: [] };
            broadcastToAdmins(newTaskData);
            console.log(`[API /api/employee/tasks] Broadcasted new_task_created for ${taskId} to admins.`);
            res.status(201).json({ taskId });
          } catch (e) { console.error("[API /api/employee/tasks] Error creating task:", e); res.status(500).json({ error: 'Failed to create task' }); }
    });

    // GET List own tasks (Employee view - supports filtering)
    app.get('/api/employee/tasks', authGuard, checkRole(['EMP']), async (req, res) => {
        const employeeId = req.user.uid; const companyId = req.user.cid;
        const requestedStatus = req.query.status; const validStatuses = ['pending', 'in_progress', 'stuck', 'complete'];
        let sql = 'SELECT task_id, title, status FROM tasks WHERE employee_id = ? AND company_id = ?';
        const params = [employeeId, companyId];
        if (requestedStatus && validStatuses.includes(requestedStatus.toLowerCase())) {
            sql += ' AND lower(status) = ?'; params.push(requestedStatus.toLowerCase()); // Use lower()
        } else if (requestedStatus && requestedStatus.toLowerCase() !== 'all') {
             console.log(`[API /api/employee/tasks] Ignoring invalid status filter: ${requestedStatus}`);
        }
        sql += ' ORDER BY created_at DESC';
        try {
            const rows = await new Promise((resolve, reject) => { dbi_instance.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows || [])); });
            res.json(rows);
        } catch (e) {
            console.error("[API /api/employee/tasks] DB error listing tasks:", e);
            res.status(500).json({ error: 'Database error listing tasks' });
        }
    });

    // GET Profile Task ID for Employee
    app.get('/api/employee/profile-task-id', authGuard, checkRole(['EMP']), async (req, res) => {
        const employeeId = req.user.uid;
        const companyId = req.user.cid;
        try {
            const taskId = await getProfileTaskIdForUser(employeeId, companyId);
            if (taskId) {
                res.json({ taskId: taskId });
            } else {
                // This could happen if the user was created before v5 or if linking failed
                console.warn(`[API GET /profile-task-id] No profile task ID found for user ${employeeId}`);
                res.status(404).json({ error: 'Profile task ID not found for this user.' });
            }
        } catch(e) {
            console.error(`[API GET /profile-task-id] Error fetching profile task ID for user ${employeeId}:`, e);
            res.status(500).json({ error: 'Server error retrieving profile task ID.' });
        }
    });

    /* ------------ 0.3 WebSocket gateway --------------------------------- */
    const wss = new WebSocket.Server({ port: cfg.PORT_WS });
    console.log(`[Primary] WS listening on ${cfg.PORT_WS}`);

    wss.on('connection', ws => {
      console.log('[WS] Client connecting…');
      ws.isAuth = false; ws.userId = null; ws.role = null; ws.companyId = null;
      ws.lastMessageTime = Date.now();

      ws.on('message', raw => {
        ws.lastMessageTime = Date.now();
        let msg; try { msg = JSON.parse(raw); } catch { ws.send(JSON.stringify({type:"error", error:"bad_json"})); return; }

        // 1) Handle Initial Authentication
        if (!ws.isAuth) {
          // ... (Authentication logic remains the same) ...
          if (msg.type !== 'auth' || !msg.token) { ws.close(1008, "Auth token required"); return; }
          try {
            const payload = jwt.verify(msg.token, JWT_SECRET);
            ws.isAuth = true; ws.userId = payload.uid; ws.role = payload.role; ws.companyId = payload.cid;
            if (ws.role === 'EMP') {
              empSockets.set(ws.userId, ws);
              console.log(`[WS] Employee ${ws.userId} (Company ${ws.companyId}) authenticated.`);
              broadcastEmployeeStatus(ws.userId, 'online');
            }
            else if (ws.role === 'CEO' || ws.role === 'PM') {
              adminSockets.add(ws);
              console.log(`[WS] Admin ${ws.userId} (${ws.role}, Company ${ws.companyId}) authenticated.`);
            }
            else { ws.close(1008, "Unknown role"); return; }
            ws.send(JSON.stringify({type:"auth_success"}));
          } catch(err) {
            ws.send(JSON.stringify({type:"auth_failed", error: "Invalid or expired token"}));
            ws.close(1008, "Invalid token");
          }
          return;
        }

        // 2) Handle Messages from Authenticated Clients
        if (ws.role === 'EMP') {
            // --- Message Type: employee_message (General Chat Input) ---
            if (msg.type === 'employee_message') {
                console.log(`[WS Route] Received employee_message from ${ws.userId}`);
                const employeeId = ws.userId;
                const companyId = ws.companyId;
                const chatMessageText = msg.text?.trim();

                if (!chatMessageText) return; // Ignore empty messages

                const existingChatTaskId = empToChatWorker.get(employeeId);
                let chatWorkerMeta = null;
                let validExistingWorkerFound = false;

                // --- Check for EXISTING valid chat worker ---
                if (existingChatTaskId) {
                    const chatWorkerId = taskToWorker.get(existingChatTaskId);
                    if (chatWorkerId) {
                        chatWorkerMeta = pool.get(chatWorkerId);
                        // Verify the worker exists, is assigned to this chat task, and is still assigned to this employee
                        if (chatWorkerMeta &&
                            chatWorkerMeta.currentTaskData?.taskId === existingChatTaskId &&
                            chatWorkerMeta.currentEmployeeId === employeeId)
                        {
                            validExistingWorkerFound = true;
                        } else {
                             console.warn(`[WS Route] Chat worker validation failed for employee ${employeeId}, task ${existingChatTaskId}. Clearing potentially stale mappings.`);
                             empToChatWorker.delete(employeeId);
                             taskToWorker.delete(existingChatTaskId); // Clean up task map too
                             chatWorkerMeta = null;
                        }
                    } else {
                         console.warn(`[WS Route] No worker process found for tracked chat task ${existingChatTaskId}. Clearing stale mapping.`);
                         empToChatWorker.delete(employeeId);
                         chatWorkerMeta = null;
                    }
                }

                // --- Route to Existing or Create New ---
                if (validExistingWorkerFound && chatWorkerMeta) {
                    // Scenario 1: Forward to existing, valid chat worker
                    console.log(`[WS Route] Forwarding chat message to existing worker ${chatWorkerMeta.worker.id} for task ${existingChatTaskId}.`);
                    chatWorkerMeta.worker.send({
                         type: 'employee_input', // Worker expects this type
                         employeeId: employeeId,
                         taskId: existingChatTaskId, // MUST include taskId for worker context
                         data: { text: chatMessageText }
                     });
                    // Mark worker as active if it wasn't (e.g., if it just finished a prior turn but timeout hasn't hit)
                    if (!chatWorkerMeta.busy) {
                         chatWorkerMeta.busy = true; // Mark busy immediately
                         broadcastAgentStatus(employeeId, chatWorkerMeta.worker.id, 'active');
                    }
                } else {
                    // Scenario 2: Create a NEW ad-hoc chat task
                    console.log(`[WS Route] No valid chat worker for employee ${employeeId}. Creating new chat task.`);
                    const newChatTaskId = `chat-${uuid()}`;
                    const chatTaskData = {
                        taskId: newChatTaskId,
                        title: 'Live Chat',
                        description: `Ad-hoc chat session with employee ${employeeId}`,
                        taskType: 'chat', // Explicitly set type
                        companyId: companyId
                    };
                    // Assign the NEW chat task, passing the ORIGINAL message payload
                    assignTask(
                      { // Task Envelope
                        type: 'task',
                        ts: new Date().toISOString(),
                        agentId: `chat-init:${employeeId}`, // Identifier for this instance
                        employeeId: employeeId,
                        companyId: companyId,
                        data: chatTaskData // The details of the chat task itself
                      },
                      { text: chatMessageText } // Pass the user's actual chat message text
                    );
                }
            } // End handling employee_message

            // --- Message Type: employee_task_update (Task-Specific Update) ---
            else if (msg.type === 'employee_task_update') {
              const { pollId, taskId, updateText, stepNumber = null } = msg;
              if (!taskId || !updateText || !ws.userId || !ws.companyId) {
                  console.warn('[WS] Invalid employee_task_update received:', msg);
                  return; // Ignore invalid update
              }
              if (taskId.startsWith('chat-')) {
                  console.warn(`[WS] Received employee_task_update for a chat task ID (${taskId}). Ignoring.`);
                  return; // Don't process updates for chat tasks this way
              }

              (async () => {
                 try {
                   // 1. Save update to DB
                   const updateId = await addTaskUpdate({ taskId, companyId: ws.companyId, employeeId: ws.userId, updateText, stepNumber });
                   console.log(`[WS] Task update ${updateId} saved for task ${taskId} by employee ${ws.userId} (Poll: ${pollId || 'N/A'})`);

                   // 2. Broadcast update to admins
                   const broadcastData = { type: 'task_update_received', update_id: updateId, taskId: taskId, employeeId: ws.userId, updateText: updateText, stepNumber: stepNumber, timestamp: new Date().toISOString() };
                   if (pollId) {
                       await markPollResponded(pollId);
                       console.log(`[WS] Poll ${pollId} marked responded.`);
                       broadcastData.pollId = pollId;
                       broadcastToAdmins({type: 'poll_responded', pollId, taskId, employeeId: ws.userId});
                   }
                   broadcastToAdmins(broadcastData);
                   console.log(`[WS] Broadcasted task_update_received for task ${taskId} to admins.`);

                   // 3. Forward to the SPECIFIC worker for THIS task (if active)
                   let workerIdForTask = taskToWorker.get(taskId);
                   let workerMeta = workerIdForTask ? pool.get(workerIdForTask) : null;

                   // 3a. Handle profile task re-assignment if needed
                   const profileTaskId = await getProfileTaskIdForUser(ws.userId, ws.companyId);
                   if (taskId === profileTaskId && (!workerMeta || !workerMeta.busy)) {
                        console.log(`[WS] Profile task update for ${taskId} received, but no active worker assigned. Re-assigning task...`);
                        const taskDetails = await db.promisifyGet( `SELECT title, original_description FROM tasks WHERE task_id = ? AND company_id = ?`, [taskId, ws.companyId] );
                        if (taskDetails) {
                             // Re-fetch companyDomain for re-assignment
                             let companyDomain = 'example.com'; // Default
                             const userDetails = await getUserById(ws.userId); // Get user details again
                             if (userDetails?.email && userDetails.email.includes('@')) {
                                  companyDomain = userDetails.email.split('@')[1];
                             }
                             console.log(`[WS] Using company domain "${companyDomain}" for profile task re-assignment.`);

                             assignTask({
                                 type: 'task', ts: new Date().toISOString(), agentId: `reopen:${ws.userId}`, employeeId: ws.userId, companyId: ws.companyId,
                                 data: { taskId, title: taskDetails.title, description: taskDetails.original_description, taskType: 'profile_update', companyId: ws.companyId, companyDomain: companyDomain } // Pass domain
                                });
                             await new Promise(resolve => setTimeout(resolve, 150)); // Allow time for assignment
                             workerIdForTask = taskToWorker.get(taskId);
                             workerMeta = workerIdForTask ? pool.get(workerIdForTask) : null;
                             console.log(`[WS] Re-checked worker for task ${taskId} after re-assign attempt. Worker ID: ${workerIdForTask}, Busy: ${workerMeta?.busy}`);
                        } else { console.error(`[WS] Failed to fetch details for profile task ${taskId} during re-assign attempt.`); }
                   }

                   // 3b. Forward if worker exists, is busy, AND is handling THIS task
                   if (workerMeta && workerMeta.busy && workerMeta.currentTaskData?.taskId === taskId) {
                       console.log(`[WS] Forwarding employee_task_update for task ${taskId} to worker ${workerIdForTask}`);
                       // Send using 'employee_task_update' type
                       workerMeta.worker.send({ type: 'employee_task_update', taskId, employeeId: ws.userId, updateText, stepNumber }); // Correctly send payload
                       broadcastAgentStatus(ws.userId, workerIdForTask, 'active');
                   } else {
                       let reason = !workerIdForTask ? "No worker assigned" : (!workerMeta ? `Worker ${workerIdForTask} missing` : (!workerMeta.busy ? `Worker ${workerIdForTask} idle` : `Worker ${workerIdForTask} on wrong task (${workerMeta.currentTaskData?.taskId})`));
                       console.log(`[WS] Did not forward task update for task ${taskId}. Reason: ${reason}.`);
                   }
                 } catch (e) {
                    console.error('[WS] Error saving/forwarding task_update:', e);
                    ws.send(JSON.stringify({ type: "system_message", data: { message: "Error saving your task update. Please try again." } }));
                 }
               })();
            } // End handling employee_task_update

            // --- Message Type: employee_status_update ---
            else if (msg.type === 'employee_status_update') {
               // ... (Status update logic remains the same) ...
                const { taskId, newStatus, explanation = null } = msg;
                const validStatuses = ['pending', 'in_progress', 'stuck', 'complete'];
                if (!taskId || !newStatus || !validStatuses.includes(newStatus.toLowerCase())) {
                    console.warn('[WS] Invalid employee_status_update received:', msg);
                    return;
                }
                const finalStatus = newStatus.toLowerCase();
                (async () => {
                    try {
                        const changes = await updateTaskStatus({ taskId, companyId: ws.companyId, newStatus: finalStatus });
                        if (changes > 0) {
                            console.log(`[WS] Task ${taskId} status updated to '${finalStatus}' by employee ${ws.userId}`);
                            if (finalStatus === 'stuck' && explanation) {
                                await addTaskUpdate({ taskId, companyId: ws.companyId, employeeId: ws.userId, updateText: `Status set to STUCK: ${explanation}` });
                                console.log(`[WS] 'Stuck' explanation logged for task ${taskId}`);
                            }
                            const broadcastData = { type: 'task_status_updated', taskId: taskId, employeeId: ws.userId, status: finalStatus, timestamp: new Date().toISOString() };
                            console.log(`[WS] Broadcasting task_status_updated for task ${taskId} to admins.`);
                            broadcastToAdmins(broadcastData);
                        } else { console.warn(`[WS] updateTaskStatus reported 0 changes for task ${taskId} to status ${finalStatus}.`); }
                    } catch (e) {
                       console.error(`[WS] Error updating status for task ${taskId}:`, e);
                       ws.send(JSON.stringify({ type: "system_message", data: { message: "Error updating task status. Please try again." } }));
                    }
                })();
            } // End handling employee_status_update

            else { console.log(`[WS] Unhandled message type '${msg.type}' from employee ${ws.userId}`); }
        } // End if (ws.role === 'EMP')

        // --- Handle Admin Messages ---
        else if (ws.role === 'CEO' || ws.role === 'PM') {
             console.log(`[WS] Received message type '${msg.type}' from Admin ${ws.userId}`);
             // Placeholder for future admin actions via WS
        }
      }); // End ws.on('message')

       ws.on('close', (code, reason) => {
        const reasonStr = reason ? reason.toString() : 'No reason specified';
        console.log(`[WS] Client disconnected (User: ${ws.userId || 'unauth'}, Role: ${ws.role || 'N/A'}, Company: ${ws.companyId || 'N/A'}, Code: ${code}, Reason: ${reasonStr})`);
        if (ws.userId && ws.role === 'EMP') {
          empSockets.delete(ws.userId);
          broadcastEmployeeStatus(ws.userId, 'offline');
           // If this employee had a dedicated chat worker, clean up those mappings too
           const chatTaskId = empToChatWorker.get(ws.userId);
           if(chatTaskId) {
                const chatWorkerId = taskToWorker.get(chatTaskId);
                console.log(`[WS Close] Cleaning up chat task ${chatTaskId} and worker ${chatWorkerId} for disconnected employee ${ws.userId}`);
                empToChatWorker.delete(ws.userId);
                taskToWorker.delete(chatTaskId);
                // Optional: Signal worker to end chat early? For now, timeout handles it.
           }
        }
        if (ws.role === 'CEO' || ws.role === 'PM') adminSockets.delete(ws);
        ws.isAuth = false;
      });

      ws.on('error', (err) => {
        console.error(`[WS] Error (User: ${ws.userId || 'unauth'}, Role: ${ws.role || 'N/A'}, Company: ${ws.companyId || 'N/A'}):`, err);
        if (ws.userId && ws.role === 'EMP') {
          empSockets.delete(ws.userId);
          broadcastEmployeeStatus(ws.userId, 'offline');
          // Cleanup chat mappings on error too
           const chatTaskId = empToChatWorker.get(ws.userId);
           if(chatTaskId) {
                const chatWorkerId = taskToWorker.get(chatTaskId);
                console.log(`[WS Error] Cleaning up chat task ${chatTaskId} and worker ${chatWorkerId} for errored employee ${ws.userId}`);
                empToChatWorker.delete(ws.userId);
                taskToWorker.delete(chatTaskId);
           }
        }
        if (ws.role === 'CEO' || ws.role === 'PM') adminSockets.delete(ws);
        ws.isAuth = false; ws.close(1011, "WebSocket error occurred");
      });

    }); // End wss.on('connection')

    /* ------------ 0.4  Daily summary cron -------------------- */
    if (cron.validate(cfg.SUMMARY_CRON)) {
      console.log(`[Primary] Scheduling daily summary cron: ${cfg.SUMMARY_CRON}`);
      cron.schedule(cfg.SUMMARY_CRON, async () => {
        const day = new Date().toISOString().slice(0, 10); console.log(`[Cron] Running daily summary for ${day}`);
        try { const summary = await summaryForDay(day); console.log(`[Cron] Summary data fetched, broadcasting to admins.`); broadcastToAdmins({ type: 'daily_summary', ts: new Date().toISOString(), data: summary });
        } catch (e) { console.error('[Cron] Error generating or broadcasting daily summary:', e); }
      });
    } else { console.error(`[Primary] Invalid cron pattern: ${cfg.SUMMARY_CRON}. Daily summary disabled.`); }


    /* ------------ 0.5  HTTP server start --------------------------------- */
    const server = app.listen(cfg.PORT_HTTP, () => console.log(`[Primary] HTTP server listening on port ${cfg.PORT_HTTP}`));

    // --- Graceful Shutdown ---
    process.on('SIGTERM', () => {
        console.log('[Primary] SIGTERM received. Shutting down gracefully...');
        server.close(() => {
            console.log('[Primary] HTTP server closed.');
            wss.close(() => console.log('[Primary] WebSocket server closed.'));
            console.log('[Primary] Terminating worker processes...');
            for (const meta of pool.values()) { meta.worker.kill('SIGTERM'); }
            db.close().then(() => process.exit(0));
            setTimeout(() => process.exit(1), 5000); // Force exit
        });
    });

  })().catch(e => { console.error('[Primary] Fatal startup error:', e); process.exit(1); });

/* ───────────────────────────────────────────────────────────────────── */
/* 1. WORKER PROCESS                                                      */
/* ───────────────────────────────────────────────────────────────────── */
} else {
  require('../workers/agent_worker'); // Worker logic remains separate
} // End primary/worker check


// // src/server/index.js — v6.1 + Strict Chat/Task Separation + Domain Passing
// // ──────────────────────────────────────────────────────────────────────────
// //  + Implements strict separation:
// //      - employee_message always targets/creates an ad-hoc 'chat' worker.
// //      - employee_task_update targets the specific task worker.
// //  + Adds support for the new Admin dashboards
// //  + Persists time‑estimates coming from agent_worker (estimated_minutes)
// //  + Broadcasts employee_status, agent_assignment & agent_status updates
// //  + Passes companyDomain to profile_update tasks
// //
// /* eslint camelcase:0 */

// const cluster   = require('node:cluster');
// const os        = require('os');
// const express   = require('express');
// const path      = require('node:path');
// const WebSocket = require('ws');
// const cron      = require('node-cron');
// const { v4: uuid } = require('uuid');
// const bcrypt    = require('bcryptjs');
// const jwt       = require('jsonwebtoken');

// // ─── Config & DB helpers ────────────────────────────────────────────────
// const cfg = require('../config');
// const db  = require('../db/sqlite');
// const {
//   dbPromise,
//   // User helpers
//   getAllUsers,
//   getUserById,
//   getUserByEmail,
//   getUserByName, // Added v5
//   getUserByRole, // Added v5
//   setUserProfile, // v5 version (expects changerUserId)
//   getProfileTaskIdForUser, // Added v5
//   getRoster, // Added for profileResolver
//   // Task helpers
//   addTask,
//   addStep,
//   setTaskEstimate,          // ← NEW helper (v7 schema)
//   getStepsForTask,
//   updateTaskStatus,
//   // Update/Poll helpers
//   addTaskUpdate,
//   getUpdatesForTask,
//   recordPollRequest,
//   markPollResponded,
//   // Team helper
//   getLikelyTeam, // Added v5
//   // Log helpers
//   write: writeDbLog,
//   summaryForDay
// } = db;

// // Resolver Logic (v5)
// const resolveProfile = require('./profileResolver'); // Import resolver

// const setupAuthRoutes = require('../routes/auth');
// const authGuard       = require('./middleware/auth');
// const JWT_SECRET      = process.env.JWT_SECRET || 'changeme';

// /* ───────────────────────────────────────────────────────────────────────*/
// /* 0. PRIMARY PROCESS                                                     */
// /* ───────────────────────────────────────────────────────────────────────*/
// if (cluster.isPrimary) {
//   (async function startServer () {
//     console.log('[Primary] ⏳ Waiting for database connection…');
//     const dbi_instance = await dbPromise;
//     console.log('[Primary] ✅ Database ready.');

//     /* ------------ 0.1  Worker-pool bookkeeping ----------------------- */
//     const pool             = new Map(); // workerId -> { worker, busy, lastUsed, currentEmployeeId, currentTaskData }
//     const waitQ            = []; // Tasks waiting for a worker { envelope, _initialMsgPayload? }
//     const state            = new Map(); // General purpose state (e.g., summaries)
//     const empToWorker      = new Map(); // employeeId -> workerId (Tracks *any* worker assigned)
//     const taskToWorker     = new Map(); // taskId -> workerId (Tracks specific task assignment)
//     const empToChatWorker  = new Map(); // employeeId -> chatId (Tracks dedicated CHAT task worker if active)
//     const empSockets       = new Map(); // employeeId -> WebSocket
//     const adminSockets     = new Set(); // Set of Admin WebSockets

//     const spawnWorker = () => {
//       const wk = cluster.fork();
//       console.log(`[Primary] Spawning worker ${wk.id}`);
//       pool.set(wk.id, { worker: wk, busy: false, lastUsed: Date.now() });
//       wk.on('message', msg => handleFromWorker(msg, wk.id));
//       wk.on('exit', (code, sig) => {
//         console.warn(`[Primary] Worker ${wk.id} exited (code ${code}, sig ${sig})`);
//         const meta = pool.get(wk.id);
//         if (meta) {
//             if (meta.currentEmployeeId) {
//                 broadcastAgentAssignment(meta.currentEmployeeId, wk.id, 'released'); // Broadcast release on exit
//                 empToWorker.delete(meta.currentEmployeeId);
//                 // Also clear chat worker tracking if this worker was handling a chat
//                 if (empToChatWorker.get(meta.currentEmployeeId) === meta.currentTaskData?.taskId) {
//                     empToChatWorker.delete(meta.currentEmployeeId);
//                 }
//             }
//             if (meta.currentTaskData?.taskId) taskToWorker.delete(meta.currentTaskData.taskId);
//         }
//         pool.delete(wk.id);
//         if (pool.size < cfg.MIN_WORKERS) { console.log(`[Primary] Respawning worker...`); spawnWorker(); }
//       });
//       wk.on('error', err => {
//         console.error(`[Primary] Worker ${wk.id} error:`, err);
//         const meta = pool.get(wk.id);
//          if (meta) {
//             if (meta.currentEmployeeId) {
//                 broadcastAgentAssignment(meta.currentEmployeeId, wk.id, 'released'); // Broadcast release on error
//                 empToWorker.delete(meta.currentEmployeeId);
//                 // Also clear chat worker tracking if this worker was handling a chat
//                  if (empToChatWorker.get(meta.currentEmployeeId) === meta.currentTaskData?.taskId) {
//                      empToChatWorker.delete(meta.currentEmployeeId);
//                  }
//             }
//             if (meta.currentTaskData?.taskId) taskToWorker.delete(meta.currentTaskData.taskId);
//         }
//         pool.delete(wk.id);
//         if (pool.size < cfg.MIN_WORKERS) { console.log(`[Primary] Respawning worker...`); spawnWorker(); }
//       });
//     };
//     for (let i = 0; i < cfg.MIN_WORKERS; i++) spawnWorker();

//     // --- MODIFIED assignTask (Accepts initialMsgPayload) ---
//     const assignTask = (envelope, initialMsgPayload = null) => {
//       // Only assign if task data and taskId exist
//       if (!envelope?.data?.taskId) {
//           console.error('[Primary Assign Task] Attempted to assign task without valid data/taskId:', envelope);
//           return;
//       }
//       const taskId = envelope.data.taskId;
//       const taskType = envelope.data.taskType;
//       const employeeId = envelope.employeeId;

//       console.log(`[Primary] ➡️ Assign request for task ${taskId}, type ${taskType}, employee ${employeeId}`);
//       const idleMetaArr = [...pool.values()].filter(m => !m.busy).sort((a, b) => a.lastUsed - b.lastUsed);
//       const idleMeta = idleMetaArr[0];

//       if (idleMeta) {
//         const workerId = idleMeta.worker.id;
//         console.log(`[Primary]    ↳ sending task ${taskId} to idle worker ${workerId}`);
//         idleMeta.busy = true;
//         idleMeta.lastUsed = Date.now();
//         idleMeta.currentEmployeeId = employeeId;
//         idleMeta.currentTaskData = envelope.data; // Includes taskType, companyDomain etc.

//         empToWorker.set(employeeId, workerId); // General assignment
//         taskToWorker.set(taskId, workerId); // Specific task assignment
//         if (taskType === 'chat') {
//             empToChatWorker.set(employeeId, taskId); // Track dedicated chat worker
//             console.log(`[Primary]    ↳ Tracking worker ${workerId} as CHAT worker for employee ${employeeId} (Task: ${taskId})`);
//         }

//         // Send the main task envelope
//         idleMeta.worker.send(envelope);

//         // Send initial message if provided (for chat tasks)
//         if (initialMsgPayload && initialMsgPayload.text && taskType === 'chat') {
//             console.log(`[Primary]    ↳ forwarding initial chat message for task ${taskId} to worker ${workerId}`);
//             idleMeta.worker.send({
//                 type: 'employee_input', // Worker expects this type for subsequent messages
//                 employeeId: employeeId,
//                 taskId: taskId, // Worker needs taskId to associate correctly
//                 data: {
//                     text: initialMsgPayload.text || ''
//                     // No need to include taskId inside data again
//                 }
//             });
//         }

//         broadcastAgentAssignment(employeeId, workerId, 'assigned');
//         broadcastAgentStatus(employeeId, workerId, 'active');
//       } else {
//           // Queueing logic (associating initial message)
//           const taskToQueue = { ...envelope };
//           if (initialMsgPayload && taskType === 'chat') { // Only queue initial message for chat tasks
//              taskToQueue._initialMsgPayload = initialMsgPayload;
//              console.log(`[Primary] Attaching initial chat message to queued task ${taskId}`);
//           }

//           if (pool.size < cfg.MAX_WORKERS) {
//             console.log(`[Primary]    ↳ pool saturated, spawning extra worker & queueing task ${taskId}`);
//             spawnWorker();
//             waitQ.push(taskToQueue);
//           } else {
//             console.log(`[Primary]    ↳ pool at max, queueing task ${taskId}`);
//             waitQ.push(taskToQueue);
//           }
//       }
//     };
//     // --- END MODIFIED assignTask ---

//     // Periodic GC
//     setInterval(() => {
//         const now = Date.now(); if (pool.size <= cfg.MIN_WORKERS) return;
//         const workersToGC = [];
//         for (const [id, meta] of pool.entries()) {
//             // **** Bonus Polish #1: Don't GC if assigned to a chat ****
//             const isHandlingChat = meta.currentEmployeeId && empToChatWorker.get(meta.currentEmployeeId) === meta.currentTaskData?.taskId;
//             if (!meta.busy && !isHandlingChat && now - meta.lastUsed > cfg.WORKER_IDLE_MS) { workersToGC.push(id); }
//         }
//         for (const id of workersToGC) {
//           if (pool.size <= cfg.MIN_WORKERS) break;
//           console.log(`[Primary GC] Killing idle worker ${id}`);
//           const meta = pool.get(id);
//           if (meta) { meta.worker.kill(); } // exit handler will clean up maps
//         }
//       }, cfg.WORKER_IDLE_MS / 2);

//     // Push Poll
//     const pushPoll = (empId, pollId, taskId) => {
//         const ws = empSockets.get(empId);
//         if (ws && ws.readyState === WebSocket.OPEN && ws.isAuth) {
//           console.log(`[Primary] Pushing poll request ${pollId} for task ${taskId} to employee ${empId}`);
//           ws.send(JSON.stringify({ type: 'poll_request', pollId, taskId, message: 'Manager requested an update for this task.' }));
//         } else { console.log(`[Primary] Cannot push poll request to employee ${empId} - socket offline/unauthed.`); }
//       };

//     // --- Broadcast Helpers ---
//     function broadcast(obj) {
//         if (wss.clients.size === 0) return;
//         const str = JSON.stringify(obj);
//         wss.clients.forEach(client => {
//             if (client.readyState === WebSocket.OPEN) {
//                 client.send(str, (err) => { if (err) console.error('[Primary WS Broadcast Error]:', err); });
//             }
//         });
//     }

//     function broadcastToAdmins(obj) {
//         if (adminSockets.size === 0) return;
//         const str = JSON.stringify(obj);
//         adminSockets.forEach(client => {
//             // Ensure client is authenticated and has an admin role
//             if (client.isAuth && (client.role === 'CEO' || client.role === 'PM') && client.readyState === WebSocket.OPEN) {
//                  client.send(str, (err) => { if (err) console.error('[Primary WS Admin Broadcast Error]:', err); });
//             }
//         });
//     }

//     function broadcastEmployeeStatus(employeeId, status) {
//         console.log(`[WS Broadcast] Employee Status: ${employeeId} -> ${status}`);
//         broadcastToAdmins({type: 'employee_status', employeeId, status});
//     }

//     function broadcastAgentAssignment(employeeId, workerId, phase) {
//         console.log(`[WS Broadcast] Agent Assignment: Emp ${employeeId}, Worker ${workerId}, Phase: ${phase}`);
//         broadcastToAdmins({type: 'agent_assignment', employeeId, workerId: (phase === 'assigned' ? workerId : null), phase});
//     }

//     function broadcastAgentStatus(empId, workerId, status /* 'active' | 'idle' */) {
//       console.log(`[WS Broadcast] Agent Status: Emp ${empId}, Worker ${workerId}, Status: ${status}`);
//       broadcastToAdmins({ type: 'agent_status', employeeId: empId, workerId, status });
//     }

//     // --- Handle messages FROM WORKERS ---
//     const handleFromWorker = async (msg, workerId) => {
//       msg._fromWorker = workerId; // Keep track of which worker sent it
//       let handled = false;
//       let shouldBroadcastToAdmins = false; // Flag to control broadcasting

//       // Log non-idle messages
//       if (msg.type !== 'idle') { writeDbLog(msg).catch(e => console.error('[Primary] DB log error:', e)); }

//       // Determine if this message type should generally be broadcast to admins
//       const broadcastableTypes = ['agent_response', 'status', 'error', 'agent_summary_json', 'parsed_profile_data', 'task_steps_saved', 'profile_updated', 'daily_summary'];
//       if (broadcastableTypes.includes(msg.type)) {
//            if (msg.type === 'error' && msg.employeeId && empSockets.has(msg.employeeId)) {
//                shouldBroadcastToAdmins = false; // Don't broadcast errors if user gets them
//            } else {
//                shouldBroadcastToAdmins = true;
//            }
//       }
//       if (msg.type === 'task_steps_saved') shouldBroadcastToAdmins = false; // Handled explicitly later
//       if (msg.type === 'profile_updated') shouldBroadcastToAdmins = false; // Handled explicitly later
//       if (msg.type === 'idle') shouldBroadcastToAdmins = false;


//       // (A) breakdown summary inc. estimate
//       if (msg.type === 'agent_summary_json' && msg.data?.steps && msg.data?.taskId) {
//         const {taskId, steps, estimated_minutes: estimatedMinutes } = msg.data;
//         const companyId = msg.companyId || msg.data.companyId;
//         const employeeId = msg.employeeId;

//         if (!employeeId || !companyId || !taskId) {
//              console.error(`[Primary] Missing context for agent_summary_json:`, msg);
//              handled = true;
//              shouldBroadcastToAdmins = false;
//              return;
//         }

//         if (steps) {
//           try {
//             const inserts = steps.map((d, i) => addStep({ taskId, companyId, stepNumber: i+1, description: d, isInterruption: msg.data.is_interruption || 0 }));
//             await Promise.all(inserts);
//             if (typeof estimatedMinutes === 'number' && Number.isFinite(estimatedMinutes) && estimatedMinutes >= 0) {
//               await setTaskEstimate({taskId, companyId, estimatedMinutes});
//               console.log(`[Primary] Saved estimate ${estimatedMinutes}m for task ${taskId}`);
//             } else if (estimatedMinutes !== undefined) {
//               console.warn(`[Primary] Received invalid estimate for task ${taskId}:`, estimatedMinutes);
//             }
//             await updateTaskStatus({taskId, companyId, newStatus: 'in_progress'});
//             broadcastAgentStatus(employeeId, workerId, 'busy'); // Use 'busy' consistently

//             const savedSteps = await getStepsForTask(taskId);
//             broadcastToAdmins({ type: 'task_steps_saved', taskId, employeeId, steps: savedSteps, estimate: estimatedMinutes, status: 'in_progress' });
//             shouldBroadcastToAdmins = false;
//           } catch(e) {
//             console.error(`[Primary] Error saving steps/estimate for task ${taskId}:`, e);
//             shouldBroadcastToAdmins = false;
//           }
//         }
//         handled = true;
//       }

//       // --- Handle PARSED PROFILE DATA using Resolver ---
//       else if (msg.type === 'parsed_profile_data') {
//            const { employeeId, companyId, data: parsed } = msg;
//            const ws = empSockets.get(employeeId);

//            if (!employeeId || !companyId || !parsed) {
//                 console.error(`[Primary] Invalid parsed_profile_data received:`, msg);
//                 if(ws) ws.send(JSON.stringify({ type: 'system_message', data: { message: 'Internal error processing profile data.' } }));
//                 handled = true;
//                 shouldBroadcastToAdmins = false;
//                 return;
//            }

//            console.log(`[Primary] Resolving profile data for employee ${employeeId} from worker ${workerId}`);
//            try {
//                 const { changed, problems } = await resolveProfile({ companyId: companyId, employeeId: employeeId, changerUserId: employeeId, parsed: parsed });
//                 console.log(`[Primary] Profile resolution result for ${employeeId}: Changed=${changed}, Problems=${problems.join('; ')}`);
//                 broadcastAgentStatus(employeeId, workerId, 'busy'); // Update status after processing

//                 if (ws?.readyState === WebSocket.OPEN) {
//                     let feedbackMsg = '';
//                     if (changed > 0 && problems.length === 0) feedbackMsg = 'Profile updated successfully!';
//                     else if (changed > 0 && problems.length > 0) feedbackMsg = `Profile saved, but with issues:\n• ${problems.join('\n• ')}`;
//                     else if (changed === 0 && problems.length > 0) feedbackMsg = `Profile not saved due to issues:\n• ${problems.join('\n• ')}`;
//                     else feedbackMsg = 'No changes detected in the profile information provided.';
//                      ws.send(JSON.stringify({ type: 'system_message', data: { message: feedbackMsg } }));
//                 }

//                 if (changed > 0) {
//                   const updatedUser = await getUserById(employeeId);
//                   if (updatedUser) {
//                        console.log(`[Primary Debug] Broadcasting profile_updated for user ${employeeId}...`); // Add this log
//                        broadcastToAdmins({ type: 'profile_updated', user: updatedUser });
//                        console.log(`[Primary Debug] Broadcast sent.`); // Confirm sending
//                        shouldBroadcastToAdmins = false; // Prevent double broadcast if flag was set earlier
//                   } else {
//                        console.error(`[Primary] Failed to get updated user data for ${employeeId} after profile change.`);
//                   }
//               } else {
//                    console.log(`[Primary Debug] Skipping profile_updated broadcast because changed=${changed}.`); // Log skip reason
//               }

//            } catch (resolverError) {
//                 console.error(`[Primary] Error during profile resolution for employee ${employeeId}:`, resolverError);
//                 if(ws) ws.send(JSON.stringify({ type: 'system_message', data: { message: `Error resolving profile data: ${resolverError.message}` } }));
//                 shouldBroadcastToAdmins = true; // Broadcast the error if resolver failed
//            }
//            handled = true;
//       }

//       // (B) worker finished
//       else if (msg.type === 'idle') {
//           const meta = pool.get(workerId);
//           if (meta) {
//               const prevEmp = meta.currentEmployeeId;
//               const prevTaskData = meta.currentTaskData;

//               if (prevEmp) { broadcastAgentStatus(prevEmp, workerId, 'idle'); }

//               meta.busy = false; meta.lastUsed = Date.now();
//               const finishedTaskId = prevTaskData?.taskId; // Get the ID of the task that just finished

//               // --- Clear relevant maps ---
//               if (prevEmp) {
//                   console.log(`[Primary] Worker ${workerId} finished/idle after working for employee ${prevEmp} on task ${finishedTaskId || 'N/A'}`);
//                   empToWorker.delete(prevEmp);
//                   delete meta.currentEmployeeId;
//                   // Check if the finished task was the dedicated chat task for this employee
//                   if (prevTaskData?.taskType === 'chat' && empToChatWorker.get(prevEmp) === finishedTaskId) {
//                       empToChatWorker.delete(prevEmp);
//                       console.log(`[Primary]    ↳ Cleared dedicated chat worker tracking for employee ${prevEmp}`);
//                   }
//                   broadcastAgentAssignment(prevEmp, workerId, 'released');
//               } else { console.log(`[Primary] Worker ${workerId} is now idle.`); }

//               if (finishedTaskId) { taskToWorker.delete(finishedTaskId); }
//               delete meta.currentTaskData;

//               // Assign next task from queue (passing initial message if present)
//               if (waitQ.length > 0) {
//                   const nextTaskEnvelope = waitQ.shift();
//                   assignTask(nextTaskEnvelope, nextTaskEnvelope._initialMsgPayload || null);
//               }
//           } else { console.warn(`[Primary] Idle message from unknown worker ${workerId}`); }
//           handled = true;
//           shouldBroadcastToAdmins = false;
//       }

//       // Route targeted messages to EMPLOYEE (if not handled above)
//       else if (msg.employeeId && empSockets.has(msg.employeeId) && !handled) {
//           const ws = empSockets.get(msg.employeeId);
//           const shouldRelay = ['agent_response', 'system_message', 'error'].includes(msg.type);

//           if (ws && ws.readyState === WebSocket.OPEN && ws.isAuth) {
//               if (shouldRelay) {
//                     console.log(`[Primary] Relaying msg type '${msg.type}' to employee ${msg.employeeId}`);
//                     ws.send(JSON.stringify(msg));
//                     const meta = pool.get(workerId);
//                     if (meta && meta.busy && meta.currentEmployeeId === msg.employeeId) {
//                         broadcastAgentStatus(msg.employeeId, workerId, 'busy'); // Worker is busy responding
//                     }
//                     handled = true;
//               }
//           } else if (!ws || !ws.isAuth || ws.readyState !== WebSocket.OPEN){
//                console.log(`[Primary] Cannot relay msg type '${msg.type}'; employee ${msg.employeeId} offline/unauthed.`);
//                if (shouldRelay) handled = true;
//           }
//       }

//       // **** BROADCAST TO ADMINS (IF FLAGGED) ****
//       if (shouldBroadcastToAdmins && !handled) {
//           console.log(`[Primary] Broadcasting general message type '${msg.type}' from worker ${workerId} to admins.`);
//           broadcastToAdmins(msg);
//           handled = true;
//       }

//       if (!handled) { console.log(`[Primary] (unrouted/unhandled) worker msg type '${msg.type}' from worker ${workerId}`); }
//     }; // End handleFromWorker

//     /* ------------ 0.2  Express application ----------------------------- */
//     const app = express();
//     app.use(express.json());

//     // Helper middleware to check roles
//     const checkRole = (roles) => (req, res, next) => {
//         if (req.user && roles.includes(req.user.role)) { return next(); }
//         res.status(403).json({ error: 'Forbidden: Insufficient role privileges' });
//     };

//     // Helper middleware for "self or admin" checks
//     const checkSelfOrAdmin = (req, res, next) => {
//         const targetUserId = parseInt(req.params.userId, 10);
//         if (isNaN(targetUserId)) return res.status(400).json({ error: 'Invalid user ID format' });
//         if (req.user && (req.user.uid === targetUserId || req.user.role === 'CEO' || req.user.role === 'PM')) {
//             return next();
//         }
//         res.status(403).json({ error: 'Forbidden: You can only modify your own profile or must be an admin.' });
//     };

//     // Custom middleware to check auth for specific paths
//     app.use((req, res, next) => {
//       // List of paths that require authentication
//       const protectedPaths = [
//         '/dashboard.html',
//         '/admin.html',
//         '/manage-users.html',
//         '/employee.html',
//         '/status-dashboard.html',
//         '/task-table-dashboard.html'
//       ];
      
//       // Check if the request path is in the protected list
//       if (protectedPaths.includes(req.path)) {
//         // Apply auth guards
//         return authGuard(req, res, () => {
//           // If auth passes, check role next
//           const requiredRoles = req.path === '/employee.html' ? ['EMP'] : ['CEO', 'PM'];
//           return checkRole(requiredRoles)(req, res, next);
//         });
//       }
      
//       // Not a protected path, continue to next middleware
//       next();
//     });

//     // Then serve all static files
//     app.use(express.static(path.join(__dirname, '../../public')));

//     // Root redirect
//     app.get('/', (req, res) => { res.redirect('/login.html'); });

//     // Auth routes
//     app.use('/api', setupAuthRoutes(dbi_instance));

//     /* ------------ ADMIN API ENDPOINTS ------------------------------ */

//     // (1) Status Overview
//     app.get('/api/admin/status-overview', authGuard, checkRole(['CEO', 'PM']), async (req, res) => {
//       try {
//         const users = await getAllUsers(req.user.cid);
//         const overview = users.map(u => {
//           const ws = empSockets.get(u.id);
//           const isOnline = ws && ws.readyState === WebSocket.OPEN && ws.isAuth; // Check isAuth too
//           const workerId = empToWorker.get(u.id) || null;
//           const workerMeta = workerId ? pool.get(workerId) : null;
//           // Determine agent status more accurately
//           let agentStatus = 'unassigned';
//           if (workerMeta) {
//                // Agent is assigned, check if busy (processing task start or ongoing work)
//                agentStatus = workerMeta.busy ? 'active' : 'idle';
//           }
//           // Determine employee idle status (example: online but no agent assigned)
//           const isIdle = isOnline && !workerId;

//           return {
//             id: u.id,
//             email: u.email,
//             role: u.role,
//             name: `${u.first_name || ''} ${u.last_name || ''}`.trim() || u.email,
//             isOnline,
//             isIdle,
//             agentWorkerId: workerId,
//             agentStatus: agentStatus
//           };
//         });
//         res.json(overview);
//       } catch (e) {
//         console.error("[API /status-overview] Error:", e);
//         res.status(500).json({error: 'Server error fetching status overview'});
//       }
//     });

//     // (2) Pending tasks for specific employee
//     app.get('/api/admin/employee/:eid/pending-tasks', authGuard, checkRole(['CEO', 'PM']), async (req, res) => {
//       const employeeId = parseInt(req.params.eid, 10);
//       if (Number.isNaN(employeeId)) return res.status(400).json({error: 'Bad id'});
//       try {
//         // Verify employee exists and belongs to admin's company
//         const targetUser = await getUserById(employeeId);
//          if (!targetUser || targetUser.company_id !== req.user.cid) {
//              return res.status(404).json({ error: 'Employee not found or not in your company.' });
//          }
//         // Fetch tasks
//         const rows = await new Promise((resolve, reject) => {
//           dbi_instance.all(
//             `SELECT task_id, title, status, estimated_time_minutes
//              FROM tasks
//              WHERE employee_id=? AND company_id=? AND status <> 'complete'
//              ORDER BY created_at DESC`, // Changed <> instead of !=
//             [employeeId, req.user.cid],
//             (err, rows) => err ? reject(err) : resolve(rows || [])
//           );
//         });
//         res.json(rows);
//       } catch (e) {
//         console.error(`[API /pending-tasks] Error for employee ${employeeId}:`, e);
//         res.status(500).json({error: 'Database error fetching pending tasks'});
//       }
//     });

//     // (3) All tasks (grouped)
//     app.get('/api/admin/all-tasks', authGuard, checkRole(['CEO', 'PM']), async (req, res) => {
//       const filterStatus = req.query.status?.toLowerCase();
//       const allowed = ['pending', 'in_progress', 'stuck', 'complete'];
//       const companyId = req.user.cid;

//       try {
//           let taskSql = `
//               SELECT t.task_id, t.employee_id, t.title, t.original_description, t.status, t.created_at, t.estimated_time_minutes,
//                      u.email AS employee_email, u.first_name AS employee_first_name, u.last_name AS employee_last_name
//               FROM tasks t
//               JOIN users u ON t.employee_id = u.id
//               WHERE t.company_id = ?`;
//           const params = [companyId];

//           if (filterStatus && allowed.includes(filterStatus)) {
//               taskSql += ' AND lower(t.status) = ?';
//               params.push(filterStatus);
//           } else if (filterStatus && filterStatus !== 'all') {
//               console.warn(`[API /all-tasks] Ignoring invalid status filter: ${filterStatus}`);
//           }

//           taskSql += ' ORDER BY t.employee_id, t.created_at DESC';

//           const tasks = await db.promisifyAll(taskSql, params);

//           // Fetch steps for all tasks efficiently
//           const taskIds = tasks.map(t => t.task_id);
//           let stepsByTask = {};
//           if (taskIds.length > 0) {
//               const stepsPlaceholder = taskIds.map(() => '?').join(',');
//               const allSteps = await db.promisifyAll(
//                  `SELECT task_id, step_number, description, status FROM task_steps WHERE task_id IN (${stepsPlaceholder}) ORDER BY step_number`,
//                   taskIds
//               );
//                allSteps.forEach(step => {
//                    if (!stepsByTask[step.task_id]) stepsByTask[step.task_id] = [];
//                    stepsByTask[step.task_id].push(step);
//                });
//           }

//           // Group tasks by employee
//           const groupedResult = {};
//           tasks.forEach(task => {
//               const empId = task.employee_id;
//               if (!groupedResult[empId]) {
//                   groupedResult[empId] = {
//                       employee: {
//                           id: empId,
//                           email: task.employee_email,
//                           name: `${task.employee_first_name || ''} ${task.employee_last_name || ''}`.trim() || task.employee_email
//                       },
//                       tasks: []
//                   };
//               }
//                // Add steps to the task object
//                task.steps = stepsByTask[task.task_id] || [];
//               // Remove redundant employee info from task object before pushing
//                delete task.employee_id;
//                delete task.employee_email;
//                delete task.employee_first_name;
//                delete task.employee_last_name;
//               groupedResult[empId].tasks.push(task);
//           });

//           res.json(groupedResult); // Return grouped structure

//       } catch (e) {
//           console.error("[API /all-tasks] Error:", e);
//           res.status(500).json({error: 'Database error fetching tasks'});
//       }
//     });

//     /* ---------------- Standard API Routes ------------------------------ */

//     // GET Users (Admin view - now includes manager_id, job_title, team_name)
//     app.get('/api/users', authGuard, checkRole(['CEO', 'PM']), async (req, res) => {
//         try {
//             const users = await getAllUsers(req.user.cid); // getAllUsers now returns new fields
//             res.json(users);
//         } catch (e) {
//             console.error("[API /api/users] DB error:", e.message || e);
//             res.status(500).json({ error: 'Database error getting users' });
//         }
//     });

//     // POST Create Employee (Admin - UPDATED to store profile_task_id AND pass companyDomain)
//     app.post('/api/admin/create-employee', authGuard, checkRole(['CEO', 'PM']), async (req, res) => {
//       const { email, password } = req.body;
//       if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });
//       if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
//       let newUserId = null;
//       let initialTaskId = null; // Store task ID
//       try {
//           const hash = bcrypt.hashSync(password, 10);
//           const stmt = dbi_instance.prepare('INSERT INTO users (email, password_hash, role, company_id) VALUES (?, ?, ?, ?)');
//           const result = await new Promise((resolve, reject) => {
//               stmt.run(email, hash, 'EMP', req.user.cid, function (err) { // req.user.cid is companyId from JWT
//                   stmt.finalize();
//                   if (err) { const msg = err.message.includes('UNIQUE constraint failed: users.email') ? 'Email already exists.' : 'Database error creating user.'; return reject({ status: 400, message: msg }); }
//                   resolve({ userId: this.lastID });
//               });
//           });
//           newUserId = result.userId;
//           console.log(`[API] Employee ${email} (ID: ${newUserId}) created by Admin ${req.user.uid} in Company ${req.user.cid}`);

//           // Assign initial profile task
//           initialTaskId = uuid(); // <<< Get the task ID
//           const initialTaskTitle = "Update Your Profile Information";
//           const initialTaskDesc = "Please provide your current job title, the email address/name of your direct manager (if any), and your primary team name."; // Updated description
//           await addTask({ taskId: initialTaskId, companyId: req.user.cid, employeeId: newUserId, title: initialTaskTitle, description: initialTaskDesc });
//           console.log(`[API] Assigned initial profile task ${initialTaskId} to new employee ${newUserId}`);

//           // Link task ID to user profile
//           await db.promisifyRun('UPDATE users SET profile_task_id=? WHERE id=?', [initialTaskId, newUserId]);
//           console.log(`[API] Linked profile task ${initialTaskId} to user ${newUserId}`);

//           // **** START Pass companyDomain (Refactor #2) ****
//           let companyDomain = 'example.com'; // Default fallback
//           // Infer domain from the ADMIN's email creating the user.
//           // A more robust approach would be to store the domain on the companies table.
//           if (req.user.email && req.user.email.includes('@')) {
//               companyDomain = req.user.email.split('@')[1];
//           }
//           console.log(`[API] Using company domain "${companyDomain}" for task ${initialTaskId}`);
//           // **** END Pass companyDomain ****

//           // Assign task to worker, INCLUDING companyDomain
//           assignTask({
//               type: 'task',
//               ts: new Date().toISOString(),
//               agentId: 'system_init',
//               employeeId: newUserId,
//               companyId: req.user.cid,
//               data: {
//                   taskId: initialTaskId,
//                   title: initialTaskTitle,
//                   description: initialTaskDesc,
//                   taskType: 'profile_update',
//                   companyId: req.user.cid,
//                   companyDomain: companyDomain // **** Pass the domain ****
//               }
//           });
//           console.log(`[API] Dispatched initial profile task ${initialTaskId} to worker for employee ${newUserId}`);
//           res.status(201).json({ ok: true, userId: newUserId });
//       } catch(e) {
//           console.error("[API /api/admin/create-employee] Error:", e.message || e);
//           res.status(e.status || 500).json({ error: e.message || 'Failed to create employee or assign initial task' });
//       }
//     });

//     // PUT Update User Profile (UPDATED to pass changerUserId)
//     app.put('/api/users/:userId/profile', authGuard, checkSelfOrAdmin, async (req, res) => {
//         const targetUserId = parseInt(req.params.userId, 10);
//         const companyId = req.user.cid;
//         const { firstName, lastName, jobTitle, managerEmail, teamName } = req.body; // Expect specific fields for direct update

//         // Basic validation for direct API update
//         if (firstName !== undefined && typeof firstName !== 'string' && firstName !== null) return res.status(400).json({ error: 'Invalid firstName format' });
//         if (lastName !== undefined && typeof lastName !== 'string' && lastName !== null) return res.status(400).json({ error: 'Invalid lastName format' });
//         if (jobTitle !== undefined && typeof jobTitle !== 'string' && jobTitle !== null) return res.status(400).json({ error: 'Invalid jobTitle format' });
//         if (managerEmail !== undefined && managerEmail !== null && typeof managerEmail !== 'string') return res.status(400).json({ error: 'Invalid managerEmail format' });
//         if (teamName !== undefined && typeof teamName !== 'string' && teamName !== null) return res.status(400).json({ error: 'Invalid teamName format' });

//         let managerId = null;
//         try {
//             // Resolve manager email to ID if provided
//             if (managerEmail) {
//                 if (!/\S+@\S+\.\S+/.test(managerEmail)) { return res.status(400).json({ error: `Manager email format looks invalid.` }); }
//                 const managerUser = await getUserByEmail(managerEmail, companyId);
//                 if (!managerUser) { return res.status(404).json({ error: `Manager with email '${managerEmail}' not found.` }); }
//                 if (managerUser.id === targetUserId) { return res.status(400).json({ error: 'User cannot be their own manager.' }); }
//                 managerId = managerUser.id;
//             }

//             // Call setUserProfile passing the ID of the user making the request
//             const changes = await setUserProfile({
//                 userId: targetUserId,
//                 companyId,
//                 firstName, // Pass name
//                 lastName,  // Pass name
//                 jobTitle,
//                 managerId, // Use the resolved ID (or null if no email provided)
//                 teamName,
//                 changerUserId: req.user.uid // Pass logged-in user ID as changer
//             });

//             if (changes === 0) {
//                 const userExists = await getUserById(targetUserId);
//                 if (!userExists || userExists.company_id !== companyId) { return res.status(404).json({ error: 'User not found.' }); }
//                 else { console.log(`[API PUT /profile] User ${targetUserId} profile update resulted in 0 changes.`); return res.status(200).json(userExists); }
//             }
//             const updatedUser = await getUserById(targetUserId);
//             if (!updatedUser) { return res.status(500).json({ error: 'Profile updated, but failed to retrieve latest data.' }); }
//             console.log(`[API PUT /profile] User ${targetUserId} profile updated by user ${req.user.uid}.`);
//             broadcastToAdmins({ type: 'profile_updated', user: updatedUser });
//             res.status(200).json(updatedUser);

//         } catch (e) {
//             console.error(`[API PUT /profile] Error updating profile for user ${targetUserId}:`, e);
//             res.status(500).json({ error: 'Server error updating profile.' });
//         }
//     });

//     // GET Tasks for a specific employee (Admin view - supports filtering)
//     app.get('/api/admin/employee/:eid/tasks', authGuard, checkRole(['CEO', 'PM']), async (req, res) => {
//       const targetEmployeeId = parseInt(req.params.eid, 10);
//       const adminCompanyId = req.user.cid;
//       const requestedStatus = req.query.status;
//       const validStatuses = ['pending', 'in_progress', 'stuck', 'complete'];

//       if (isNaN(targetEmployeeId)) return res.status(400).json({ error: 'Invalid employee ID format' });

//       // Verify admin has access to this employee's company
//       const targetUser = await getUserById(targetEmployeeId);
//       if (!targetUser || targetUser.company_id !== adminCompanyId) {
//            return res.status(404).json({ error: 'Employee not found or not in your company.' });
//       }

//       let taskSql = `
//           SELECT t.task_id, t.title, t.original_description, t.status, t.created_at, t.estimated_time_minutes,
//                  json_group_array( DISTINCT json_object(
//                      'step_id', s.step_id, 'step_number', s.step_number, 'description', s.description,
//                      'status', s.status, 'is_interruption', s.is_interruption
//                  )) FILTER (WHERE s.step_id IS NOT NULL) AS steps
//           FROM tasks t
//           LEFT JOIN task_steps s ON s.task_id = t.task_id
//           WHERE t.employee_id = ? AND t.company_id = ? `;
//       const params = [targetEmployeeId, adminCompanyId];

//       if (requestedStatus && validStatuses.includes(requestedStatus.toLowerCase())) {
//           taskSql += ` AND lower(t.status) = ? `; params.push(requestedStatus.toLowerCase()); // Use lower() for case-insensitivity
//       } else if (requestedStatus && requestedStatus.toLowerCase() !== 'all') {
//            console.log(`[API /api/admin/employee/:eid/tasks] Ignoring invalid status filter: ${requestedStatus}`);
//       }
//       taskSql += ` GROUP BY t.task_id ORDER BY t.created_at DESC;`;

//       try {
//           const tasks = await new Promise((resolve, reject) => { dbi_instance.all(taskSql, params, (err, rows) => err ? reject(err) : resolve(rows || [])); });
//           for (const task of tasks) {
//               try { task.steps = JSON.parse(task.steps || '[]'); task.steps.sort((a, b) => (a.step_number || 0) - (b.step_number || 0)); } catch (e) { console.error(`Error parsing steps JSON for task ${task.task_id}:`, e); task.steps = []; }
//               try { task.updates = await getUpdatesForTask(task.task_id); } catch (updateErr) { console.error(`Error fetching updates for task ${task.task_id}:`, updateErr); task.updates = []; }
//           }
//           res.json(tasks);
//       } catch (e) {
//           console.error("[API /api/admin/employee/:eid/tasks] DB error:", e);
//           res.status(500).json({ error: 'Database error getting tasks' });
//       }
//     });

//     // POST Poll request for a task (Admin)
//     app.post('/api/task/:tid/poll', authGuard, checkRole(['CEO', 'PM']), async (req, res) => {
//         const taskId = req.params.tid; const pollId = uuid(); const adminUserId = req.user.uid; const adminCompanyId = req.user.cid;
//         try {
//             const task = await new Promise((resolve, reject) => { dbi_instance.get( 'SELECT employee_id FROM tasks WHERE task_id = ? AND company_id = ?', [taskId, adminCompanyId], (err, row) => err ? reject(err) : resolve(row) ); });
//             if (task && task.employee_id) {
//                 await recordPollRequest({ pollId, taskId, requestedBy: adminUserId });
//                 pushPoll(task.employee_id, pollId, taskId);
//                 console.log(`[API /api/task/:tid/poll] Poll request ${pollId} initiated for task ${taskId} by Admin ${adminUserId}`);
//                 res.status(202).json({ pollId });
//             } else { res.status(404).json({ error: 'Task not found or access denied' }); }
//         } catch (e) { console.error("[API /api/task/:tid/poll] Error:", e); res.status(500).json({ error: 'Failed to initiate poll request' }); }
//     });

//     // POST Create new task (Employee)
//     app.post('/api/employee/tasks', authGuard, checkRole(['EMP']), async (req, res) => {
//         const { title, description = '' } = req.body; if (!title) return res.status(400).json({ error: 'Task title is required' });
//         const taskId = uuid(); const employeeId = req.user.uid; const companyId = req.user.cid;
//         const taskStatus = 'pending'; const createdAt = new Date().toISOString();
//         try {
//             await addTask({ taskId, companyId, employeeId, title, description });
//             console.log(`[API /api/employee/tasks] Task ${taskId} created by Employee ${employeeId}`);
//             assignTask({ type: 'task', ts: createdAt, agentId: `creator:${employeeId}`, employeeId: employeeId, companyId: companyId,
//                 data: { taskId: taskId, title: title, description: description, taskType: 'breakdown', companyId: companyId } // Pass companyId in data
//             });
//             console.log(`[API /api/employee/tasks] Dispatched task ${taskId} to worker for breakdown.`);
//             const newTaskData = { type: 'new_task_created', employeeId: employeeId, task_id: taskId, title: title, original_description: description, status: taskStatus, created_at: createdAt, steps: [], updates: [] };
//             broadcastToAdmins(newTaskData);
//             console.log(`[API /api/employee/tasks] Broadcasted new_task_created for ${taskId} to admins.`);
//             res.status(201).json({ taskId });
//           } catch (e) { console.error("[API /api/employee/tasks] Error creating task:", e); res.status(500).json({ error: 'Failed to create task' }); }
//     });

//     // GET List own tasks (Employee view - supports filtering)
//     app.get('/api/employee/tasks', authGuard, checkRole(['EMP']), async (req, res) => {
//         const employeeId = req.user.uid; const companyId = req.user.cid;
//         const requestedStatus = req.query.status; const validStatuses = ['pending', 'in_progress', 'stuck', 'complete'];
//         let sql = 'SELECT task_id, title, status FROM tasks WHERE employee_id = ? AND company_id = ?';
//         const params = [employeeId, companyId];
//         if (requestedStatus && validStatuses.includes(requestedStatus.toLowerCase())) {
//             sql += ' AND lower(status) = ?'; params.push(requestedStatus.toLowerCase()); // Use lower()
//         } else if (requestedStatus && requestedStatus.toLowerCase() !== 'all') {
//              console.log(`[API /api/employee/tasks] Ignoring invalid status filter: ${requestedStatus}`);
//         }
//         sql += ' ORDER BY created_at DESC';
//         try {
//             const rows = await new Promise((resolve, reject) => { dbi_instance.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows || [])); });
//             res.json(rows);
//         } catch (e) {
//             console.error("[API /api/employee/tasks] DB error listing tasks:", e);
//             res.status(500).json({ error: 'Database error listing tasks' });
//         }
//     });

//     // GET Profile Task ID for Employee
//     app.get('/api/employee/profile-task-id', authGuard, checkRole(['EMP']), async (req, res) => {
//         const employeeId = req.user.uid;
//         const companyId = req.user.cid;
//         try {
//             const taskId = await getProfileTaskIdForUser(employeeId, companyId);
//             if (taskId) {
//                 res.json({ taskId: taskId });
//             } else {
//                 // This could happen if the user was created before v5 or if linking failed
//                 console.warn(`[API GET /profile-task-id] No profile task ID found for user ${employeeId}`);
//                 res.status(404).json({ error: 'Profile task ID not found for this user.' });
//             }
//         } catch(e) {
//             console.error(`[API GET /profile-task-id] Error fetching profile task ID for user ${employeeId}:`, e);
//             res.status(500).json({ error: 'Server error retrieving profile task ID.' });
//         }
//     });

//     /* ------------ 0.3 WebSocket gateway --------------------------------- */
//     const wss = new WebSocket.Server({ port: cfg.PORT_WS });
//     console.log(`[Primary] WS listening on ${cfg.PORT_WS}`);

//     wss.on('connection', ws => {
//       console.log('[WS] Client connecting…');
//       ws.isAuth = false; ws.userId = null; ws.role = null; ws.companyId = null;
//       ws.lastMessageTime = Date.now();

//       ws.on('message', raw => {
//         ws.lastMessageTime = Date.now();
//         let msg; try { msg = JSON.parse(raw); } catch { ws.send(JSON.stringify({type:"error", error:"bad_json"})); return; }

//         // 1) Handle Initial Authentication
//         if (!ws.isAuth) {
//           // ... (Authentication logic remains the same) ...
//           if (msg.type !== 'auth' || !msg.token) { ws.close(1008, "Auth token required"); return; }
//           try {
//             const payload = jwt.verify(msg.token, JWT_SECRET);
//             ws.isAuth = true; ws.userId = payload.uid; ws.role = payload.role; ws.companyId = payload.cid;
//             if (ws.role === 'EMP') {
//               empSockets.set(ws.userId, ws);
//               console.log(`[WS] Employee ${ws.userId} (Company ${ws.companyId}) authenticated.`);
//               broadcastEmployeeStatus(ws.userId, 'online');
//             }
//             else if (ws.role === 'CEO' || ws.role === 'PM') {
//               adminSockets.add(ws);
//               console.log(`[WS] Admin ${ws.userId} (${ws.role}, Company ${ws.companyId}) authenticated.`);
//             }
//             else { ws.close(1008, "Unknown role"); return; }
//             ws.send(JSON.stringify({type:"auth_success"}));
//           } catch(err) {
//             ws.send(JSON.stringify({type:"auth_failed", error: "Invalid or expired token"}));
//             ws.close(1008, "Invalid token");
//           }
//           return;
//         }

//         // 2) Handle Messages from Authenticated Clients
//         if (ws.role === 'EMP') {
//             // --- Message Type: employee_message (General Chat Input) ---
//             if (msg.type === 'employee_message') {
//                 console.log(`[WS Route] Received employee_message from ${ws.userId}`);
//                 const employeeId = ws.userId;
//                 const companyId = ws.companyId;
//                 const chatMessageText = msg.text?.trim();

//                 if (!chatMessageText) return; // Ignore empty messages

//                 const existingChatTaskId = empToChatWorker.get(employeeId);
//                 let chatWorkerMeta = null;
//                 let validExistingWorkerFound = false;

//                 // --- Check for EXISTING valid chat worker ---
//                 if (existingChatTaskId) {
//                     const chatWorkerId = taskToWorker.get(existingChatTaskId);
//                     if (chatWorkerId) {
//                         chatWorkerMeta = pool.get(chatWorkerId);
//                         // Verify the worker exists, is assigned to this chat task, and is still assigned to this employee
//                         if (chatWorkerMeta &&
//                             chatWorkerMeta.currentTaskData?.taskId === existingChatTaskId &&
//                             chatWorkerMeta.currentEmployeeId === employeeId)
//                         {
//                             validExistingWorkerFound = true;
//                         } else {
//                              console.warn(`[WS Route] Chat worker validation failed for employee ${employeeId}, task ${existingChatTaskId}. Clearing potentially stale mappings.`);
//                              empToChatWorker.delete(employeeId);
//                              taskToWorker.delete(existingChatTaskId); // Clean up task map too
//                              chatWorkerMeta = null;
//                         }
//                     } else {
//                          console.warn(`[WS Route] No worker process found for tracked chat task ${existingChatTaskId}. Clearing stale mapping.`);
//                          empToChatWorker.delete(employeeId);
//                          chatWorkerMeta = null;
//                     }
//                 }

//                 // --- Route to Existing or Create New ---
//                 if (validExistingWorkerFound && chatWorkerMeta) {
//                     // Scenario 1: Forward to existing, valid chat worker
//                     console.log(`[WS Route] Forwarding chat message to existing worker ${chatWorkerMeta.worker.id} for task ${existingChatTaskId}.`);
//                     chatWorkerMeta.worker.send({
//                          type: 'employee_input', // Worker expects this type
//                          employeeId: employeeId,
//                          taskId: existingChatTaskId, // MUST include taskId for worker context
//                          data: { text: chatMessageText }
//                      });
//                     // Mark worker as active if it wasn't (e.g., if it just finished a prior turn but timeout hasn't hit)
//                     if (!chatWorkerMeta.busy) {
//                          chatWorkerMeta.busy = true; // Mark busy immediately
//                          broadcastAgentStatus(employeeId, chatWorkerMeta.worker.id, 'active');
//                     }
//                 } else {
//                     // Scenario 2: Create a NEW ad-hoc chat task
//                     console.log(`[WS Route] No valid chat worker for employee ${employeeId}. Creating new chat task.`);
//                     const newChatTaskId = `chat-${uuid()}`;
//                     const chatTaskData = {
//                         taskId: newChatTaskId,
//                         title: 'Live Chat',
//                         description: `Ad-hoc chat session with employee ${employeeId}`,
//                         taskType: 'chat', // Explicitly set type
//                         companyId: companyId
//                     };
//                     // Assign the NEW chat task, passing the ORIGINAL message payload
//                     assignTask(
//                       { // Task Envelope
//                         type: 'task',
//                         ts: new Date().toISOString(),
//                         agentId: `chat-init:${employeeId}`, // Identifier for this instance
//                         employeeId: employeeId,
//                         companyId: companyId,
//                         data: chatTaskData // The details of the chat task itself
//                       },
//                       { text: chatMessageText } // Pass the user's actual chat message text
//                     );
//                 }
//             } // End handling employee_message

//             // --- Message Type: employee_task_update (Task-Specific Update) ---
//             else if (msg.type === 'employee_task_update') {
//               const { pollId, taskId, updateText, stepNumber = null } = msg;
//               if (!taskId || !updateText || !ws.userId || !ws.companyId) {
//                   console.warn('[WS] Invalid employee_task_update received:', msg);
//                   return; // Ignore invalid update
//               }
//               if (taskId.startsWith('chat-')) {
//                   console.warn(`[WS] Received employee_task_update for a chat task ID (${taskId}). Ignoring.`);
//                   return; // Don't process updates for chat tasks this way
//               }

//               (async () => {
//                  try {
//                    // 1. Save update to DB
//                    const updateId = await addTaskUpdate({ taskId, companyId: ws.companyId, employeeId: ws.userId, updateText, stepNumber });
//                    console.log(`[WS] Task update ${updateId} saved for task ${taskId} by employee ${ws.userId} (Poll: ${pollId || 'N/A'})`);

//                    // 2. Broadcast update to admins
//                    const broadcastData = { type: 'task_update_received', update_id: updateId, taskId: taskId, employeeId: ws.userId, updateText: updateText, stepNumber: stepNumber, timestamp: new Date().toISOString() };
//                    if (pollId) {
//                        await markPollResponded(pollId);
//                        console.log(`[WS] Poll ${pollId} marked responded.`);
//                        broadcastData.pollId = pollId;
//                        broadcastToAdmins({type: 'poll_responded', pollId, taskId, employeeId: ws.userId});
//                    }
//                    broadcastToAdmins(broadcastData);
//                    console.log(`[WS] Broadcasted task_update_received for task ${taskId} to admins.`);

//                    // 3. Forward to the SPECIFIC worker for THIS task (if active)
//                    let workerIdForTask = taskToWorker.get(taskId);
//                    let workerMeta = workerIdForTask ? pool.get(workerIdForTask) : null;

//                    // 3a. Handle profile task re-assignment if needed
//                    const profileTaskId = await getProfileTaskIdForUser(ws.userId, ws.companyId);
//                    if (taskId === profileTaskId && (!workerMeta || !workerMeta.busy)) {
//                         console.log(`[WS] Profile task update for ${taskId} received, but no active worker assigned. Re-assigning task...`);
//                         const taskDetails = await db.promisifyGet( `SELECT title, original_description FROM tasks WHERE task_id = ? AND company_id = ?`, [taskId, ws.companyId] );
//                         if (taskDetails) {
//                              // Re-fetch companyDomain for re-assignment
//                              let companyDomain = 'example.com'; // Default
//                              const userDetails = await getUserById(ws.userId); // Get user details again
//                              if (userDetails?.email && userDetails.email.includes('@')) {
//                                   companyDomain = userDetails.email.split('@')[1];
//                              }
//                              console.log(`[WS] Using company domain "${companyDomain}" for profile task re-assignment.`);

//                              assignTask({
//                                  type: 'task', ts: new Date().toISOString(), agentId: `reopen:${ws.userId}`, employeeId: ws.userId, companyId: ws.companyId,
//                                  data: { taskId, title: taskDetails.title, description: taskDetails.original_description, taskType: 'profile_update', companyId: ws.companyId, companyDomain: companyDomain } // Pass domain
//                                 });
//                              await new Promise(resolve => setTimeout(resolve, 150)); // Allow time for assignment
//                              workerIdForTask = taskToWorker.get(taskId);
//                              workerMeta = workerIdForTask ? pool.get(workerIdForTask) : null;
//                              console.log(`[WS] Re-checked worker for task ${taskId} after re-assign attempt. Worker ID: ${workerIdForTask}, Busy: ${workerMeta?.busy}`);
//                         } else { console.error(`[WS] Failed to fetch details for profile task ${taskId} during re-assign attempt.`); }
//                    }

//                    // 3b. Forward if worker exists, is busy, AND is handling THIS task
//                    if (workerMeta && workerMeta.busy && workerMeta.currentTaskData?.taskId === taskId) {
//                        console.log(`[WS] Forwarding employee_task_update for task ${taskId} to worker ${workerIdForTask}`);
//                        // Send using 'employee_task_update' type
//                        workerMeta.worker.send({ type: 'employee_task_update', taskId, employeeId: ws.userId, updateText, stepNumber }); // Correctly send payload
//                        broadcastAgentStatus(ws.userId, workerIdForTask, 'active');
//                    } else {
//                        let reason = !workerIdForTask ? "No worker assigned" : (!workerMeta ? `Worker ${workerIdForTask} missing` : (!workerMeta.busy ? `Worker ${workerIdForTask} idle` : `Worker ${workerIdForTask} on wrong task (${workerMeta.currentTaskData?.taskId})`));
//                        console.log(`[WS] Did not forward task update for task ${taskId}. Reason: ${reason}.`);
//                    }
//                  } catch (e) {
//                     console.error('[WS] Error saving/forwarding task_update:', e);
//                     ws.send(JSON.stringify({ type: "system_message", data: { message: "Error saving your task update. Please try again." } }));
//                  }
//                })();
//             } // End handling employee_task_update

//             // --- Message Type: employee_status_update ---
//             else if (msg.type === 'employee_status_update') {
//                // ... (Status update logic remains the same) ...
//                 const { taskId, newStatus, explanation = null } = msg;
//                 const validStatuses = ['pending', 'in_progress', 'stuck', 'complete'];
//                 if (!taskId || !newStatus || !validStatuses.includes(newStatus.toLowerCase())) {
//                     console.warn('[WS] Invalid employee_status_update received:', msg);
//                     return;
//                 }
//                 const finalStatus = newStatus.toLowerCase();
//                 (async () => {
//                     try {
//                         const changes = await updateTaskStatus({ taskId, companyId: ws.companyId, newStatus: finalStatus });
//                         if (changes > 0) {
//                             console.log(`[WS] Task ${taskId} status updated to '${finalStatus}' by employee ${ws.userId}`);
//                             if (finalStatus === 'stuck' && explanation) {
//                                 await addTaskUpdate({ taskId, companyId: ws.companyId, employeeId: ws.userId, updateText: `Status set to STUCK: ${explanation}` });
//                                 console.log(`[WS] 'Stuck' explanation logged for task ${taskId}`);
//                             }
//                             const broadcastData = { type: 'task_status_updated', taskId: taskId, employeeId: ws.userId, status: finalStatus, timestamp: new Date().toISOString() };
//                             console.log(`[WS] Broadcasting task_status_updated for task ${taskId} to admins.`);
//                             broadcastToAdmins(broadcastData);
//                         } else { console.warn(`[WS] updateTaskStatus reported 0 changes for task ${taskId} to status ${finalStatus}.`); }
//                     } catch (e) {
//                        console.error(`[WS] Error updating status for task ${taskId}:`, e);
//                        ws.send(JSON.stringify({ type: "system_message", data: { message: "Error updating task status. Please try again." } }));
//                     }
//                 })();
//             } // End handling employee_status_update

//             else { console.log(`[WS] Unhandled message type '${msg.type}' from employee ${ws.userId}`); }
//         } // End if (ws.role === 'EMP')

//         // --- Handle Admin Messages ---
//         else if (ws.role === 'CEO' || ws.role === 'PM') {
//              console.log(`[WS] Received message type '${msg.type}' from Admin ${ws.userId}`);
//              // Placeholder for future admin actions via WS
//         }
//       }); // End ws.on('message')

//        ws.on('close', (code, reason) => {
//         const reasonStr = reason ? reason.toString() : 'No reason specified';
//         console.log(`[WS] Client disconnected (User: ${ws.userId || 'unauth'}, Role: ${ws.role || 'N/A'}, Company: ${ws.companyId || 'N/A'}, Code: ${code}, Reason: ${reasonStr})`);
//         if (ws.userId && ws.role === 'EMP') {
//           empSockets.delete(ws.userId);
//           broadcastEmployeeStatus(ws.userId, 'offline');
//            // If this employee had a dedicated chat worker, clean up those mappings too
//            const chatTaskId = empToChatWorker.get(ws.userId);
//            if(chatTaskId) {
//                 const chatWorkerId = taskToWorker.get(chatTaskId);
//                 console.log(`[WS Close] Cleaning up chat task ${chatTaskId} and worker ${chatWorkerId} for disconnected employee ${ws.userId}`);
//                 empToChatWorker.delete(ws.userId);
//                 taskToWorker.delete(chatTaskId);
//                 // Optional: Signal worker to end chat early? For now, timeout handles it.
//            }
//         }
//         if (ws.role === 'CEO' || ws.role === 'PM') adminSockets.delete(ws);
//         ws.isAuth = false;
//       });

//       ws.on('error', (err) => {
//         console.error(`[WS] Error (User: ${ws.userId || 'unauth'}, Role: ${ws.role || 'N/A'}, Company: ${ws.companyId || 'N/A'}):`, err);
//         if (ws.userId && ws.role === 'EMP') {
//           empSockets.delete(ws.userId);
//           broadcastEmployeeStatus(ws.userId, 'offline');
//           // Cleanup chat mappings on error too
//            const chatTaskId = empToChatWorker.get(ws.userId);
//            if(chatTaskId) {
//                 const chatWorkerId = taskToWorker.get(chatTaskId);
//                 console.log(`[WS Error] Cleaning up chat task ${chatTaskId} and worker ${chatWorkerId} for errored employee ${ws.userId}`);
//                 empToChatWorker.delete(ws.userId);
//                 taskToWorker.delete(chatTaskId);
//            }
//         }
//         if (ws.role === 'CEO' || ws.role === 'PM') adminSockets.delete(ws);
//         ws.isAuth = false; ws.close(1011, "WebSocket error occurred");
//       });

//     }); // End wss.on('connection')

//     /* ------------ 0.4  Daily summary cron -------------------- */
//     if (cron.validate(cfg.SUMMARY_CRON)) {
//       console.log(`[Primary] Scheduling daily summary cron: ${cfg.SUMMARY_CRON}`);
//       cron.schedule(cfg.SUMMARY_CRON, async () => {
//         const day = new Date().toISOString().slice(0, 10); console.log(`[Cron] Running daily summary for ${day}`);
//         try { const summary = await summaryForDay(day); console.log(`[Cron] Summary data fetched, broadcasting to admins.`); broadcastToAdmins({ type: 'daily_summary', ts: new Date().toISOString(), data: summary });
//         } catch (e) { console.error('[Cron] Error generating or broadcasting daily summary:', e); }
//       });
//     } else { console.error(`[Primary] Invalid cron pattern: ${cfg.SUMMARY_CRON}. Daily summary disabled.`); }


//     /* ------------ 0.5  HTTP server start --------------------------------- */
//     const server = app.listen(cfg.PORT_HTTP, () => console.log(`[Primary] HTTP server listening on port ${cfg.PORT_HTTP}`));

//     // --- Graceful Shutdown ---
//     process.on('SIGTERM', () => {
//         console.log('[Primary] SIGTERM received. Shutting down gracefully...');
//         server.close(() => {
//             console.log('[Primary] HTTP server closed.');
//             wss.close(() => console.log('[Primary] WebSocket server closed.'));
//             console.log('[Primary] Terminating worker processes...');
//             for (const meta of pool.values()) { meta.worker.kill('SIGTERM'); }
//             db.close().then(() => process.exit(0));
//             setTimeout(() => process.exit(1), 5000); // Force exit
//         });
//     });

//   })().catch(e => { console.error('[Primary] Fatal startup error:', e); process.exit(1); });

// /* ───────────────────────────────────────────────────────────────────── */
// /* 1. WORKER PROCESS                                                      */
// /* ───────────────────────────────────────────────────────────────────── */
// } else {
//   require('../workers/agent_worker'); // Worker logic remains separate
// } // End primary/worker check