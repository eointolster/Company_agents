// src/workers/agent_worker.js – v4.6 + Chat Task Handling + Chat Timeout
// ------------------------------------------------------------------
//  • Handles taskType: 'chat' for immediate conversation.
//  • Asks for first/last name during initial profile update prompt.
//  • Modifies profile_update extraction prompt to include first/last name.
//  • Pushes structured JSON object (including names) back via 'parsed_profile_data'.
//  • Breakdown prompt expects JSON { steps:[…], estimated_minutes:int }
//  • Pushes estimated_minutes up in agent_summary_json.
//  + Includes manager email guessing logic.
//  + Chat interactions now keep the worker busy with an idle timeout.
// ------------------------------------------------------------------
/* eslint camelcase:0 */
const { v4: uuid } = require('uuid');
const cluster      = require('node:cluster');
const llm          = require('../server/llm'); // LLM wrapper

// ─── Module‑level state ───────────────────────────────────────────────
const workerId         = cluster.worker?.id || 'unknown-worker';
let   agentId          = null;
let   employeeId       = null;
let   currentTaskData  = null;   // { taskId, title, description, taskType, companyId, companyDomain, is_interruption, chatTimeout? }
let   interactionType  = 'general_chat';
let   isBusy           = false;
const targetLlm        = 'openai'; // Or configure as needed
const CHAT_IDLE_TIMEOUT_MS = 90_000; // NEW: end session after 90 s of silence

console.log(`[Worker ${workerId}] Initialized.`);

// ─── Helper: send message back to primary process ─────────────────────
function push (type, data = {}) {
    if (!agentId && type !== 'idle') {
      console.warn(`[Worker ${workerId}] push type '${type}' blocked – agent context missing.`);
      return;
    }

    // Automatically add context if available
    let currentCompanyId = null;
    if (currentTaskData) {
      if (currentTaskData.taskId  && !data.taskId)  data.taskId  = currentTaskData.taskId;
      if (currentTaskData.companyId) currentCompanyId = currentTaskData.companyId;
    }
    const topLevelEmployeeId = data.employeeId || employeeId || null;

    const payload = {
      type,
      agentId   : agentId || 'system',
      employeeId: (type !== 'idle') ? topLevelEmployeeId : null, // Add employeeId unless idle
      companyId : (type !== 'idle') ? (data.companyId || currentCompanyId || null) : null, // Add companyId unless idle
      data, // Keep the original data object as is
      ts        : new Date().toISOString(),
      _workerId : workerId
    };

    // Clean up fields within the nested 'data' object if they are already top-level
    delete data.employeeId;
    delete data.companyId;

    try {
        process.send(payload);
    } catch (error) {
        console.error(`[Worker ${workerId}] Failed to send message to primary:`, error, payload);
        if (type !== 'idle') {
           console.error(`[Worker ${workerId}] Attempting reset due to send error.`);
           try { process.send({type:'error', agentId: agentId || 'system', employeeId: topLevelEmployeeId, companyId: currentCompanyId, data: { message: "Worker communication channel broken.", detail: error.message }, ts: new Date().toISOString(), _workerId: workerId}); } catch(e1){}
           // Call resetState() instead of Object.assign if it modifies state directly
           resetState();
           try { process.send({type:'idle', _workerId: workerId, ts: new Date().toISOString()}); }
           catch(e2) { console.error(`[Worker ${workerId}] Failed even sending direct idle message:`, e2); }
        }
    }
}

// ─── Helper: call LLM & optionally parse JSON ─────────────────────────
async function callLLM (prompt, expectJson = false) {
  const taskTitle = currentTaskData?.title || (expectJson ? 'Data Extraction' : 'LLM Interaction');
  push('status', { currentTask: taskTitle, progressPct: expectJson ? 40 : 60, detail: `Querying ${targetLlm}...` });

  // Updated prompt instructions for JSON to be more robust
  const finalPrompt = expectJson
    ? `${prompt}\n\nIMPORTANT: Respond ONLY with a valid JSON object exactly matching the requested structure. Do not include any explanation, preamble, markdown formatting (like \`\`\`json), or any text outside the JSON braces.`
    : prompt;

  try {
    const raw = await llm.generate(targetLlm, finalPrompt);
    console.log(`[Worker ${workerId}, Agent ${agentId}] LLM Raw (first 150):`, raw.substring(0,150).replace(/\n/g,' '));

    if (!expectJson) {
      push('agent_response', { answerText: raw || '[Agent processed request.]', llmUsed: targetLlm });
      push('status', { currentTask: taskTitle, progressPct: 95, detail: 'Response generated.' });
      return { ok: true, json: false, data: raw };
    }

    // Try to parse JSON directly
    let parsed;
    try {
        parsed = JSON.parse(raw);
        console.log(`[Worker ${workerId}, Agent ${agentId}] Successfully parsed JSON response.`);
        push('status', { currentTask: taskTitle, progressPct: 85, detail: 'Data extracted.' });
        return { ok: true, json: true, data: parsed };
    } catch (e) {
        console.error(`[Worker ${workerId}, Agent ${agentId}] Failed to parse LLM response as JSON:`, raw, e);
        push('error',  { message: 'Agent received unexpected data format from LLM.', detail: `Raw Response: ${raw}` , llmUsed: targetLlm });
        push('status', { currentTask: taskTitle, progressPct: 90, detail: 'Error parsing LLM response.' });
        push('agent_response', { answerText: "Sorry, I had trouble understanding the format of that information. Could you please provide the details clearly again?", llmUsed: targetLlm });
        return { ok: false, json: false, error: 'json_parse_error', rawData: raw };
    }

  } catch (e) {
    console.error(`[Worker ${workerId}, Agent ${agentId}] Error during LLM interaction:`, e);
    push('error',  { message: `LLM API call failed: ${e.message}`, llmUsed: targetLlm });
    push('status', { currentTask: taskTitle, progressPct: 90, detail: 'LLM API Error.' });
    push('agent_response', { answerText: "Sorry, I encountered an error trying to process that request. Please try again.", llmUsed: targetLlm });
    return { ok: false, json: false, error: 'llm_api_error' };
  }
}


// ─── Helper: Reset worker state ───────────────────────────────────────
function resetState () {
  console.log(`[Worker ${workerId}, Agent ${agentId || '(no agent)'}] Resetting state.`);
  if (currentTaskData?.chatTimeout) { // Clear any pending chat timeout on reset
      clearTimeout(currentTaskData.chatTimeout);
  }
  isBusy = false;
  agentId = null;
  employeeId = null;
  currentTaskData = null;
  interactionType = 'general_chat'; // Default back
}


// ─── Main message handler (from primary) ──────────────────────────────
process.on('message', async messageRaw => {
  const msg = typeof messageRaw === 'string' ? JSON.parse(messageRaw) : messageRaw;

  /* ── 1. TASK assignment ─────────────────────────────────────────── */
  if (msg.type === 'task') {
    if (isBusy) { console.warn(`[Worker ${workerId}] Received 'task' while already busy (Agent ${agentId}). Ignoring.`); return; }
    isBusy = true;
    agentId = uuid(); // Assign new agent ID
    currentTaskData = msg.data || {}; // Includes companyDomain now
    employeeId      = msg.employeeId;
    if (msg.companyId && !currentTaskData.companyId) { currentTaskData.companyId = msg.companyId; }
    interactionType = currentTaskData.taskType || 'general_chat'; // Determine interaction type

    console.log(`[Worker ${workerId}, Agent ${agentId}] Task assigned: ${currentTaskData.taskId || 'N/A'}, Type: ${interactionType}, For Emp: ${employeeId}, Company: ${currentTaskData.companyId}, Domain: ${currentTaskData.companyDomain}`);
    push('status', { currentTask: currentTaskData.title || interactionType, progressPct: 10, detail: 'Agent starting...' });

    // --- Handle different task types ---

    if (interactionType === 'chat') {
        console.log(`[Worker ${workerId}, Agent ${agentId}] Handling 'chat' task type. Ready for conversation.`);
        push('status', { currentTask: 'Live Chat', progressPct: 50, detail: 'Ready for chat input...' });

        // Send initial acknowledgment
        push('agent_response', { answerText: "Hi! I'm ready – ask away.", llmUsed: null });

        // Start the idle timer
        clearTimeout(currentTaskData?.chatTimeout);
        currentTaskData.chatTimeout = setTimeout(() => {
            console.log(`[Worker ${workerId}, Agent ${agentId}] Chat session timeout reached for task ${currentTaskData?.taskId} (no initial input). Going idle.`);
            push('idle', {});
            resetState();
        }, CHAT_IDLE_TIMEOUT_MS);
        return; // Keep worker busy
    }
    else if (interactionType === 'breakdown') {
      // a) Breakdown Task (now with estimated_minutes)
      const prompt = `You are an expert project planner.\nTask Title: "${currentTaskData.title}"\nDescription: "${currentTaskData.description || '[No description]'}"\n\nAnalyze the request and respond ONLY with a valid JSON object containing these exact keys:\n• "steps": An array of concise, actionable steps (strings, max 7) required to complete the task.\n• "estimated_minutes": An integer representing the total estimated time in minutes for all steps (use null if impossible to estimate).`;
      const res = await callLLM(prompt, true);
      let steps = [], est = null;
      if (res.ok && res.json) {
          steps = Array.isArray(res.data.steps) ? res.data.steps : [];
          if (res.data.estimated_minutes !== undefined) {
            const parsed = parseInt(res.data.estimated_minutes, 10);
            est = Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
          }
      }
      if (!steps.length && est === null) {
        push('error',{ message:'LLM failed to provide steps or a valid estimate.' });
        steps = []; // Ensure steps is an array even on failure
      }
      push('agent_summary_json', { steps, estimated_minutes: est, is_interruption: currentTaskData.is_interruption || 0 });
      push('status', { currentTask: currentTaskData.title, progressPct: 100, detail: 'Breakdown complete.' });
      push('idle', {});
      resetState();
      return;
    }
    else if (interactionType === 'profile_update') {
        // b) Profile Update Task - Ask the initial question
        const initialProfileQuestion = `Please provide the following information for your profile (or correct any existing details):\n• Your First Name.\n• Your Last Name.\n• Your exact job title.\n• Your direct manager (email preferred, but name or role like 'CEO' is okay).\n• The name of your primary team (e.g., "Platform Engineering", "Sales - EMEA").`;
        await callLLM(initialProfileQuestion, false); // Send question to user
        push('status', { currentTask: currentTaskData.title, progressPct: 30, detail: 'Waiting for profile details...' });
        return; // Keep worker busy
    }
    else { // c) Fallback for General Chat or other types (e.g., if type was missing)
        console.log(`[Worker ${workerId}, Agent ${agentId}] Handling as generic task type: ${interactionType}`);
        const initialPrompt = currentTaskData.description
            ? `Acknowledge the task: "${currentTaskData.title}". Description: "${currentTaskData.description}". Ask the employee how you can help with this.`
            : `Greet the employee and ask how you can assist them today.`;
        await callLLM(initialPrompt, false);
        push('status', { currentTask: currentTaskData.title || 'Chatting', progressPct: 50, detail: 'Waiting for input...' });
        return; // Keep worker busy
    }
  } // End if (msg.type === 'task')


  /* ── 2. Employee Input / Update ────────────────────────────────────── */

  let textToProcess = null;
  let isProfileTaskUpdate = false;

  // Consolidate checks for text input messages
  if (msg.type === 'employee_input' || msg.type === 'employee_task_update') {
      if (!isBusy || !agentId) { console.warn(`[Worker ${workerId}] Received '${msg.type}' but not busy/no agent. Ignoring.`); return; }
      if (!employeeId && msg.employeeId) employeeId = msg.employeeId; // Maintain context

      textToProcess = (msg.data?.text || msg.updateText)?.trim();
      if (!textToProcess) return;

      // Check if this specific message corresponds to the assigned task
      if (msg.taskId !== currentTaskData?.taskId) {
          console.log(`[Worker ${workerId}, Agent ${agentId}] Received '${msg.type}' for task ${msg.taskId} but current task is ${currentTaskData?.taskId}. Ignoring.`);
          return;
      }

      console.log(`[Worker ${workerId}, Agent ${agentId}] Received ${msg.type} for task ${msg.taskId}: "${textToProcess.substring(0,50)}..."`);
      if (interactionType === 'profile_update') { isProfileTaskUpdate = true; }
  }

  // If we have text to process...
  if (textToProcess) {
      // --- Specific handling for Profile Update interaction ---
      if (interactionType === 'profile_update' && isProfileTaskUpdate) { // Only process profile if it's the right type AND from an update/relevant input
          console.log(`[Worker ${workerId}, Agent ${agentId}] Processing profile update text...`);
          push('status', { currentTask: currentTaskData.title, progressPct: 50, detail: 'Extracting profile info...' });

          const extractionPrompt = `
You are parsing user input to extract profile information.
Employee Input: "${textToProcess}"

Extract the best-guess values for the fields below into a valid JSON object ONLY.
If a field isn't clearly mentioned or identifiable, use null for its value.
It's OK to guess if you're reasonably sure (e.g., >= 0.5 confidence) – include a confidence score map.

{
  "firstName": "<The employee's stated First Name, or null>",
  "lastName": "<The employee's stated Last Name, or null>",
  "jobTitle": "<The employee's stated job title, or null>",
  "managerEmail": "<The email address of the manager mentioned, or null if not stated or invalid>",
  "managerName": "<The name of the manager mentioned, or null if not mentioned>",
  "managerRole": "<A role mentioned for the manager (e.g., 'CEO', 'supervisor'), or null>",
  "teamName": "<The name of the team mentioned (e.g., 'Sales Ops', 'Frontend Platform'), or null>",
  "confidence": {
      "name": <float 0.0-1.0, confidence in first/last name extraction, or 0.0 if null>,
      "jobTitle": <float 0.0-1.0, confidence in jobTitle extraction, or 0.0 if null>,
      "manager": <float 0.0-1.0, overall confidence in identifying manager info (email/name/role), or 0.0 if none identified>,
      "teamName": <float 0.0-1.0, confidence in teamName extraction, or 0.0 if null>
  }
}

Be strict about extracting only a valid email address for managerEmail.
For managerName, extract the name if provided.
For managerRole, extract if a role like 'CEO' or 'direct supervisor' is mentioned for the manager.
Respond ONLY with the JSON object. No preamble, no explanations.`;

          const llmResult = await callLLM(extractionPrompt, true); // Expect JSON

          if (llmResult.ok && llmResult.json && llmResult.data.confidence) { // Check confidence exists
              const parsedData = llmResult.data;

              // Basic check if *anything* useful was extracted
              if (!parsedData.firstName && !parsedData.lastName && !parsedData.jobTitle && !parsedData.managerEmail && !parsedData.managerName && !parsedData.managerRole && !parsedData.teamName) {
                   console.warn(`[Worker ${workerId}, Agent ${agentId}] LLM failed to extract any profile fields from text.`);
                   push('agent_response', { answerText: "Sorry, I couldn't quite understand the details from your update. Could you please provide them clearly?\n• First Name: ?\n• Last Name: ?\n• Job Title: ?\n• Manager (Email/Name/Role): ?\n• Team Name: ?" });
                   push('status', { currentTask: currentTaskData.title, progressPct: 80, detail: 'Clarification needed.' });
                   return; // Stay busy, wait for next update/input
              }

              // Manager Email Guessing Logic
              if (!parsedData.managerEmail && parsedData.managerName) {
                  const companyDomain = currentTaskData?.companyDomain || 'example.com';
                  const guessPrompt = `
You are inferring an e-mail from a name.

Name: "${parsedData.managerName}"
Typical pattern: "<first>.<last>@${companyDomain}"

Return ONLY the most plausible e-mail or "null".`;
                  console.log(`[Worker ${workerId}] Guessing email for "${parsedData.managerName}" with domain ${companyDomain}`);
                  try {
                      const guessResult = await llm.generate(targetLlm, guessPrompt);
                      const guessedEmail = guessResult.trim().toLowerCase().replace(/"/g, '');
                      console.log(`[Worker ${workerId}] LLM guessed email: ${guessedEmail}`);
                      if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(guessedEmail) && guessedEmail.endsWith("@" + companyDomain)) {
                           parsedData.managerEmail = guessedEmail;
                           console.log(`[Worker ${workerId}] Guessed email ${guessedEmail} is valid format, adding to parsedData.`);
                      } else {
                           console.log(`[Worker ${workerId}] Guessed email ${guessedEmail} invalid format or wrong domain, ignoring.`);
                      }
                  } catch (guessError) {
                       console.error(`[Worker ${workerId}] Error guessing manager email:`, guessError);
                  }
              }

              console.log(`[Worker ${workerId}, Agent ${agentId}] Extracted - Name: ${parsedData.firstName} ${parsedData.lastName}, Job: ${parsedData.jobTitle}, Mgr Email: ${parsedData.managerEmail}, Mgr Name: ${parsedData.managerName}, Team: ${parsedData.teamName}`);
              push('status', { currentTask: currentTaskData.title, progressPct: 90, detail: 'Submitting profile data...' });
              push('parsed_profile_data', parsedData);
              push('agent_response', { answerText: 'Thanks! I\'ve sent your profile details for processing.' });
              push('status', { currentTask: currentTaskData.title, progressPct: 100, detail: 'Profile data submitted.' });
              push('idle', {}); // Profile updates are transactional, end interaction
              resetState();

          } else {
              // Bad JSON or LLM error - callLLM already sent feedback to user
              console.log(`[Worker ${workerId}, Agent ${agentId}] LLM profile extraction failed or returned unusable JSON.`);
              push('status', { currentTask: currentTaskData.title, progressPct: 80, detail: 'Clarification needed.' });
              // Stay busy, wait for next update/input
          }
          return; // Handled profile update
      } // End if (interactionType === 'profile_update' ...)

      // --- Generic handling for other interaction types (includes 'chat' and non-profile updates/inputs) ---
      console.log(`[Worker ${workerId}, Agent ${agentId}] Processing as general input/update (Type: ${interactionType}).`);
      push('status', { currentTask: currentTaskData?.title || 'Processing', progressPct: 60, detail: 'Processing...' });

      // Use a generic prompt for conversation, providing context if available
      const convoPrompt = `The employee said: "${textToProcess}". Respond conversationally. ${currentTaskData?.title ? `Current Task Context: "${currentTaskData.title}".` : 'Context: General Chat.'}`;
      await callLLM(convoPrompt, false); // Generate response

      push('status', { currentTask: currentTaskData?.title || 'Processing', progressPct: 100, detail: 'Response sent.' });

      // Apply chat timeout logic (from previous step)
      if (interactionType === 'chat') {
          clearTimeout(currentTaskData?.chatTimeout);
          currentTaskData.chatTimeout = setTimeout(() => {
              console.log(`[Worker ${workerId}, Agent ${agentId}] Chat session timeout reached for task ${currentTaskData?.taskId}. Going idle.`);
              push('idle', {});
              resetState();
          }, CHAT_IDLE_TIMEOUT_MS);
          console.log(`[Worker ${workerId}, Agent ${agentId}] Chat response sent. Timeout reset. Worker remains busy for task ${currentTaskData?.taskId}.`);
          return; // Keep worker busy for chat
      } else {
          console.log(`[Worker ${workerId}, Agent ${agentId}] Ending interaction for task type '${interactionType}' after response.`);
          push('idle', {});
          resetState();
          return;
      }
  } // End if (textToProcess)


  // --- Handle other message types if needed ---
  console.log(`[Worker ${workerId}] Unhandled message type: ${msg.type}`);

}); // End process.on('message')


// --- Graceful Shutdown ────────────────────────────────────────────────
['SIGTERM','SIGINT'].forEach(sig =>
  process.on(sig, () => {
    console.log(`[Worker ${workerId}] ${sig} received – exiting.`);
    process.exit(0);
  })
);

console.log(`[Worker ${workerId}] Ready and listening for messages.`);


