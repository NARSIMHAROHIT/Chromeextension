const TEXT_FIELDS = [
  "firstName", "lastName", "email", "phone", "city",
  "postalCode", "linkedin", "currentCompany", "currentTitle",
  // Common questions — stored as plain strings, matched to dropdowns/radios on the page
  "workAuth", "sponsorship", "over18", "relocate", "howHeard", "startDate",
  "gender", "ethnicity", "veteran", "disability", "whyInterested",
];

const $ = (id) => document.getElementById(id);
const status = (msg) => ($("status").textContent = msg);

// ---- Load saved profile + LLM settings into the form ----
chrome.storage.local.get(["profile", "llm"]).then(({ profile = {}, llm = {} }) => {
  TEXT_FIELDS.forEach((k) => { if (profile[k]) $(k).value = profile[k]; });
  if (profile.skills) $("skills").value = profile.skills.join(", ");
  if (profile.resumeFileName) $("resumeNote").textContent = `Saved: ${profile.resumeFileName}`;
  if (llm.provider) $("llmProvider").value = llm.provider;
  if (llm.apiKey) $("llmKey").value = llm.apiKey;
  if (llm.model) $("llmModel").value = llm.model;
});

// ---- Save ----
$("save").addEventListener("click", async () => {
  const { profile = {} } = await chrome.storage.local.get("profile");

  TEXT_FIELDS.forEach((k) => (profile[k] = $(k).value.trim()));
  profile.skills = $("skills").value.split(",").map((s) => s.trim()).filter(Boolean);

  const file = $("resume").files[0];
  if (file) {
    if (file.size > 4 * 1024 * 1024) return status("Resume too large (max ~4 MB).");
    profile.resumeBase64 = await fileToBase64(file);
    profile.resumeFileName = file.name;
    profile.resumeMime = file.type;
  }

  const llm = {
    provider: $("llmProvider").value,
    apiKey: $("llmKey").value.trim(),
    model: $("llmModel").value.trim(),
  };

  await chrome.storage.local.set({ profile, llm });
  status("Profile saved ✓");
});

// ---- Autofill the active tab ----
$("fill").addEventListener("click", async () => {
  const { profile } = await chrome.storage.local.get("profile");
  if (!profile) return status("Save your profile first.");

  const { llm } = await chrome.storage.local.get("llm");
  const useLLM = !!(llm && llm.provider);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  status(useLLM ? "Filling (LLM answers may take a moment)…" : "Filling…");
  try {
    // Inject into the current page (works on ANY career site thanks to
    // activeTab — Honeywell/Oracle, iCIMS, SuccessFactors, custom portals...).
    // The guard inside content.js makes re-injection harmless.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: ["content.js"],
    });
    const result = await chrome.tabs.sendMessage(tab.id, { type: "AUTOFILL", profile, useLLM });
    status(
      `Filled ${result.textFields} fields` +
      (result.choices ? `, ${result.choices} questions answered` : "") +
      (result.resume ? ", resume attached" : "") +
      (result.skills ? ", skills added" : "") +
      (result.llmAnswers ? `, ${result.llmAnswers} AI answers (review the highlighted ones!)` : "") + "."
    );
  } catch (e) {
    status("Couldn't fill this page. Make sure the application form is visible, then try again. (Chrome system pages can't be filled.)");
  }
});

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
