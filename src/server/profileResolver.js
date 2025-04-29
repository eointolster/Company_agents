// src/server/profileResolver.js -> UPDATED
// ---------------------------------------------------------------------
// + Added exact name matching before LLM.
// + Updated roster text format for LLM prompt.
// ---------------------------------------------------------------------
const llm = require('./llm'); // Import LLM wrapper for disambiguation

const {
    getUserByEmail,
    // getUserByName, // We might not need this if roster matching works well
    getUserByRole,
    getLikelyTeam,
    setUserProfile,
    getUserById,
    getRoster         // **** Import getRoster helper ****
} = require('../db/sqlite');

async function resolveProfile({ companyId, employeeId, changerUserId, parsed }) {
  console.log(`[Resolver Debug] Received parsed data for employee ${employeeId}:`, JSON.stringify(parsed, null, 2));
  const problems = [];
  let resolvedManagerId = null;
  let resolvedTeamName = null;
  let resolvedJobTitle = null;
  let resolvedFirstName = null;
  let resolvedLastName = null;

  // --- Sanity Checks ---
  if (!companyId || !employeeId || !changerUserId || !parsed || !parsed.confidence) {
      console.error("[Resolver] Missing required arguments or confidence map:", { companyId, employeeId, changerUserId, parsed });
      problems.push("Internal error: Missing data/confidence for profile resolution.");
      return { changed: 0, problems };
  }
  const confidence = parsed.confidence;

  const currentUserData = await getUserById(employeeId);
  if (!currentUserData || currentUserData.company_id !== companyId) {
       problems.push(`Cannot find current data for employee ${employeeId}.`);
       return { changed: 0, problems };
  }

  /* ── 1. Manager Resolution (Multi-Step Logic) ────────────────────── */
  const roster = await getRoster(companyId); // Fetch roster ONCE

  // --- Step 1: Use provided Email if valid ---
  if (parsed.managerEmail) {
      if (!/\S+@\S+\.\S+/.test(parsed.managerEmail)) {
           console.warn(`[Resolver] Worker provided invalid manager email format "${parsed.managerEmail}". Skipping email lookup.`);
      } else {
          const hit = await getUserByEmail(parsed.managerEmail, companyId);
          if (hit && hit.id !== employeeId) {
              resolvedManagerId = hit.id;
              console.log(`[Resolver] Manager found by EXACT email: ${parsed.managerEmail} -> ID ${resolvedManagerId}`);
          } else if (hit && hit.id === employeeId) {
              problems.push(`User cannot be their own manager (via email ${parsed.managerEmail}). Manager not set.`);
          } else {
              console.log(`[Resolver] Manager email "${parsed.managerEmail}" not found. Will try name/role next.`);
          }
      }
  }

  // --- Step 2: Try Exact Name Match (if email failed or wasn't provided) ---
  if (resolvedManagerId === null && parsed.managerName && roster && roster.length > 0) { // Check roster exists
     const managerNameLower = parsed.managerName.toLowerCase().trim();
     const exact = roster.find(r => {
         const fullName = `${r.fn || ''} ${r.ln || ''}`.trim().toLowerCase();
         // Check full name or just first/last if only one is present
         return fullName === managerNameLower ||
                (r.fn && !r.ln && r.fn.toLowerCase() === managerNameLower) ||
                (!r.fn && r.ln && r.ln.toLowerCase() === managerNameLower);
     });

     if (exact && exact.id !== employeeId) {
         resolvedManagerId = exact.id;
         console.log(`[Resolver] Manager resolved by exact name match: "${parsed.managerName}" -> ${resolvedManagerId}`);
     } else if (exact && exact.id === employeeId) {
         problems.push(`Manager name "${parsed.managerName}" matches the employee themselves. Manager not set.`);
         console.log(`[Resolver] Exact name match "${parsed.managerName}" was employee ${employeeId}.`);
     } else {
         console.log(`[Resolver] Exact name match for "${parsed.managerName}" failed.`);
     }
  }

  // --- Step 3: Use LLM Roster Disambiguation (if still not resolved and name exists) ---
  if (resolvedManagerId === null && parsed.managerName) {
      console.log(`[Resolver] Attempting LLM roster disambiguation for manager name: "${parsed.managerName}"`);

      if (roster && roster.length > 0) {
          // <<< START Refactor #2.2 - Include email in roster text >>>
          const rosterTxt = roster
             .map(r => `${r.id}\t${r.fn || ''} ${r.ln || ''}\t<${r.email || '?'}>`) // Include email
             .join('\n');
          // <<< END Refactor #2.2 >>>

          const disambigPrompt = `
Choose the best roster entry for the quoted name. Consider potential typos or variations.

Quoted name: "${parsed.managerName}"
Company Roster (Format: id<TAB>name<TAB><email>):
${rosterTxt}

Return ONLY the numeric id of the best match from the roster, or the word "none" if no entry is a plausible match or if the only match is the employee themselves (ID: ${employeeId}).`;

          try {
              console.log(`[Resolver] Sending disambiguation prompt to LLM for manager "${parsed.managerName}"`);
              const choice = await llm.generate('openai', disambigPrompt);
              const choiceClean = choice.trim().toLowerCase();

              if (choiceClean === 'none') {
                    console.log(`[Resolver] LLM indicated no plausible manager match for "${parsed.managerName}".`);
                    problems.push(`Could not confidently identify manager "${parsed.managerName}" from the roster. Manager not set.`);
                    // Keep resolvedManagerId as null for now, fallback happens later
              } else {
                    const chosenId = parseInt(choiceClean, 10);
                    if (!isNaN(chosenId) && roster.some(r => r.id === chosenId)) {
                       if (chosenId === employeeId) {
                          console.log(`[Resolver] LLM chose employee ID ${employeeId} as manager. Ignoring.`);
                          problems.push(`Identified manager "${parsed.managerName}" refers to the employee themselves. Manager not set.`);
                          // Keep resolvedManagerId as null
                       } else {
                          resolvedManagerId = chosenId;
                          console.log(`[Resolver] LLM chose manager ID: ${resolvedManagerId} for name "${parsed.managerName}".`);
                       }
                    } else {
                       console.warn(`[Resolver] LLM returned invalid ID "${choiceClean}" for manager name "${parsed.managerName}". Raw LLM response: "${choice}"`);
                       problems.push(`Could not reliably identify manager "${parsed.managerName}" (invalid LLM response). Manager not set.`);
                       // Keep resolvedManagerId as null
                    }
              }
          } catch (llmError) {
              console.error(`[Resolver] LLM error during manager disambiguation for "${parsed.managerName}":`, llmError);
              problems.push(`Error contacting AI to verify manager "${parsed.managerName}". Manager not set.`);
              // Keep resolvedManagerId as null
          }
      } else {
          console.log(`[Resolver] Company roster is empty. Cannot perform LLM disambiguation for manager "${parsed.managerName}".`);
          problems.push(`Could not verify manager "${parsed.managerName}" (empty roster). Manager not set.`);
          // Keep resolvedManagerId as null
      }
  }

  // --- Fallback if still no manager resolved ---
  if (resolvedManagerId === null) {
      // Only add problem if manager info WAS provided but couldn't be resolved.
      if (parsed.managerEmail || parsed.managerName || parsed.managerRole) {
           // Don't push a problem here anymore, just log that it couldn't be resolved.
           // The actual update logic below will handle setting it to null if it was previously non-null.
           console.log(`[Resolver] Could not resolve provided manager info for user ${employeeId}. Will use null or keep existing.`);
           // If it was previously set, we need to ensure it becomes null now.
           if (currentUserData.manager_id !== null) {
               resolvedManagerId = null; // Explicitly mark for removal if unresolvable
               console.log(`[Resolver]   ↳ Marking manager for removal as new info was unresolvable.`);
           } else {
               resolvedManagerId = null; // Keep as null
           }
      } else {
           // No manager info was parsed at all, keep the existing value.
           resolvedManagerId = currentUserData.manager_id;
           console.log(`[Resolver] No new manager info parsed, keeping existing manager ID: ${resolvedManagerId}`);
      }
  }

  // ... (Team, Job Title, Name resolution remains the same) ...
  /* ── 2. Team Name Resolution (Fuzzy Match if provided) ──────────────── */
  const teamConfidenceThreshold = 0.5;
  if (parsed.teamName && confidence.teamName >= teamConfidenceThreshold) {
      console.log(`[Resolver] Attempting team lookup/normalization for: "${parsed.teamName}"`);
      const canonicalTeam = await getLikelyTeam(parsed.teamName, companyId);
      if (canonicalTeam) {
          resolvedTeamName = canonicalTeam;
          if (resolvedTeamName.toLowerCase() !== parsed.teamName.toLowerCase()) {
              console.log(`[Resolver] Normalized team "${parsed.teamName}" to "${resolvedTeamName}" for user ${employeeId}`);
          } else {
              console.log(`[Resolver] Found existing team: "${resolvedTeamName}" for user ${employeeId}`);
          }
      } else {
          resolvedTeamName = parsed.teamName.trim();
          problems.push(`Team "${resolvedTeamName}" appears new. Saving it.`);
          console.log(`[Resolver] Team "${resolvedTeamName}" not found for user ${employeeId}. Saving as potentially new team.`);
      }
  } else if (parsed.teamName) {
      problems.push(`Low confidence (${confidence.teamName.toFixed(2)}) for team "${parsed.teamName}", ignoring. Keeping existing team: ${currentUserData.team_name || 'None'}.`);
      resolvedTeamName = currentUserData.team_name;
  } else {
      resolvedTeamName = currentUserData.team_name;
      console.log(`[Resolver] No new team info parsed, keeping existing team: ${resolvedTeamName || 'None'}`);
  }

  /* ── 3. Job Title Resolution (Use if provided & confident) ────────────── */
   const jobTitleConfidenceThreshold = 0.6;
   if (parsed.jobTitle && confidence.jobTitle >= jobTitleConfidenceThreshold) {
        resolvedJobTitle = parsed.jobTitle.trim();
        console.log(`[Resolver] Using provided job title: "${resolvedJobTitle}" for user ${employeeId}`);
   } else if (parsed.jobTitle) {
        problems.push(`Low confidence (${confidence.jobTitle.toFixed(2)}) for job title "${parsed.jobTitle}", ignoring. Keeping existing: ${currentUserData.job_title || 'None'}.`);
        resolvedJobTitle = currentUserData.job_title;
   } else {
       resolvedJobTitle = currentUserData.job_title;
       console.log(`[Resolver] No new job title parsed, keeping existing: ${resolvedJobTitle || 'None'}`);
   }

  /* ── 3.5 Name Resolution (v4.6) ──────────────────────────────────────── */
    const nameConfidenceThreshold = 0.7;
    if (parsed.firstName && confidence.name >= nameConfidenceThreshold) {
        resolvedFirstName = parsed.firstName.trim();
        console.log(`[Resolver] Using provided first name: "${resolvedFirstName}" for user ${employeeId}`);
    } else if (parsed.firstName) {
        problems.push(`Low confidence (${confidence.name.toFixed(2)}) for first name "${parsed.firstName}", ignoring. Keeping existing: ${currentUserData.first_name || 'None'}.`);
        resolvedFirstName = currentUserData.first_name;
    } else {
        resolvedFirstName = currentUserData.first_name;
        console.log(`[Resolver] No new first name parsed, keeping existing: ${resolvedFirstName || 'None'}`);
    }

    if (parsed.lastName && confidence.name >= nameConfidenceThreshold) {
        resolvedLastName = parsed.lastName.trim();
        console.log(`[Resolver] Using provided last name: "${resolvedLastName}" for user ${employeeId}`);
    } else if (parsed.lastName) {
        problems.push(`Low confidence (${confidence.name.toFixed(2)}) for last name "${parsed.lastName}", ignoring. Keeping existing: ${currentUserData.last_name || 'None'}.`);
        resolvedLastName = currentUserData.last_name;
    } else {
        resolvedLastName = currentUserData.last_name;
        console.log(`[Resolver] No new last name parsed, keeping existing: ${resolvedLastName || 'None'}`);
    }

  /* ── 4. Persist ONLY Changed Data ─────────────────────────────────── */
  // Use the resolved values (which default to current if not changed/parsed)
  const updatePayload = {
      firstName: resolvedFirstName,
      lastName: resolvedLastName,
      jobTitle: resolvedJobTitle,
      managerId: resolvedManagerId,
      teamName: resolvedTeamName
  };

  // Determine if any field is actually different from the current state
  const needsUpdate =
       updatePayload.firstName !== currentUserData.first_name ||
       updatePayload.lastName !== currentUserData.last_name ||
       updatePayload.jobTitle !== currentUserData.job_title ||
       updatePayload.managerId !== currentUserData.manager_id || // Compare resolved ID with current ID
       updatePayload.teamName !== currentUserData.team_name;

  let changes = 0;
  if (needsUpdate) {
      console.log(`[Resolver] Attempting DB update for user ${employeeId} with changes:`, updatePayload);
      try {
          changes = await setUserProfile({
              userId:     employeeId,
              companyId:  companyId,
              firstName:  updatePayload.firstName, // Pass potentially updated value
              lastName:   updatePayload.lastName,  // Pass potentially updated value
              jobTitle:   updatePayload.jobTitle,  // Pass potentially updated value
              managerId:  updatePayload.managerId, // Pass potentially updated value
              teamName:   updatePayload.teamName,  // Pass potentially updated value
              changerUserId: changerUserId
          });
          console.log(`[Resolver] setUserProfile reported ${changes} changes for user ${employeeId}.`);
          if (changes === 0 && needsUpdate) { // Check if update was intended but didn't happen
              console.warn(`[Resolver] DB update for user ${employeeId} reported 0 changes, though changes were detected.`);
              problems.push("Database reported no changes were made, although updates were intended.");
          }
      } catch (dbError) {
          console.error(`[Resolver] Database error calling setUserProfile for user ${employeeId}:`, dbError);
          problems.push(`Database error saving profile: ${dbError.message}`);
          changes = 0;
      }
  } else {
       console.log(`[Resolver] No effective changes detected for user ${employeeId}. Skipping DB update.`);
  }

  return { changed: changes, problems };
}

module.exports = resolveProfile;