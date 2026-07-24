// content.js — runs on job application pages.
// Listens for an "AUTOFILL" message from the popup, then fills the form.

// ---------------------------------------------------------------------------
// 1. React-safe value setting
// Workday (and most modern ATSs) are React apps. Setting input.value directly
// does NOT update React's internal state — the form will look filled but
// submit empty. The fix: call the native value setter, then dispatch an
// 'input' event so React's synthetic event system picks it up.
// ---------------------------------------------------------------------------
function setNativeValue(element, value) {
  const proto = element instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
  setter.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  element.dispatchEvent(new Event("blur", { bubbles: true }));
}

// ---------------------------------------------------------------------------
// 2. Find the label text for any input
// Workday uses data-automation-id attributes + <label for=...>. Fall back to
// aria-label, placeholder, or the nearest preceding label-ish element.
// ---------------------------------------------------------------------------
function getFieldLabel(input) {
  // Explicit <label for="id">
  if (input.id) {
    const lbl = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
    if (lbl) return lbl.textContent.trim();
  }
  // aria-label / aria-labelledby
  if (input.getAttribute("aria-label")) return input.getAttribute("aria-label").trim();
  const labelledBy = input.getAttribute("aria-labelledby");
  if (labelledBy) {
    const el = document.getElementById(labelledBy.split(" ")[0]);
    if (el) return el.textContent.trim();
  }
  // Workday's automation ids are often descriptive, e.g. "legalNameSection_firstName"
  const autoId = input.getAttribute("data-automation-id");
  if (autoId) return autoId;
  if (input.placeholder) return input.placeholder.trim();
  // Walk up and look for a label sibling
  let node = input.closest("div");
  for (let i = 0; i < 4 && node; i++, node = node.parentElement) {
    const lbl = node.querySelector("label, legend");
    if (lbl) return lbl.textContent.trim();
  }
  return "";
}

// ---------------------------------------------------------------------------
// 3. Field matching rules — map label text patterns to profile keys.
// Order matters: first match wins.
// ---------------------------------------------------------------------------
const FIELD_RULES = [
  { key: "firstName",  re: /first\s*name|given\s*name|firstname/i },
  { key: "lastName",   re: /last\s*name|family\s*name|surname|lastname/i },
  { key: "email",      re: /e-?mail/i },
  { key: "phone",      re: /phone|mobile|cell/i },
  { key: "addressLine1", re: /address\s*line\s*1|street|addressLine1/i },
  { key: "city",       re: /\bcity\b|town/i },
  { key: "postalCode", re: /zip|postal/i },
  { key: "linkedin",   re: /linkedin/i },
  { key: "github",     re: /github/i },
  { key: "website",    re: /website|portfolio|personal\s*site|\burl\b/i },
  { key: "currentCompany", re: /current\s*(employer|company)|company\s*name/i },
  { key: "currentTitle",   re: /(current\s*)?(job\s*)?title|position/i },
  { key: "school",     re: /school|university|college|institution/i },
  { key: "degree",     re: /degree/i },
  { key: "fieldOfStudy", re: /field\s*of\s*study|major/i },
  { key: "salary",     re: /salary|compensation|expected\s*pay/i },
];

function matchProfileKey(label) {
  for (const rule of FIELD_RULES) {
    if (rule.re.test(label)) return rule.key;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 3b. Common application questions with saved answers.
// These appear as dropdowns/radio groups (sponsorship, EEO self-ID) or
// textareas ("Why are you interested?"). Answers come from the profile,
// saved once in the popup.
// ---------------------------------------------------------------------------
const ANSWER_RULES = [
  { key: "sponsorship",   re: /sponsor/i },
  { key: "workAuth",      re: /(legally\s+)?authori[sz]ed\s+to\s+work|work\s+authori[sz]ation|eligible\s+to\s+work/i },
  { key: "howHeard",      re: /how\s+did\s+you\s+hear|referral\s+source|source.*(applic|hear)/i },
  { key: "over18",        re: /(at\s+least|over)\s*18|18\s+years/i },
  { key: "gender",        re: /\bgender\b|\bsex\b/i },
  { key: "ethnicity",     re: /ethnicity|race|hispanic|latino/i },
  { key: "veteran",       re: /veteran/i },
  { key: "disability",    re: /disabilit/i },
  { key: "whyInterested", re: /why\s+(are\s+you\s+)?interest|why\s+do\s+you\s+want|motivat/i },
  { key: "relocate",      re: /reloc/i },
  { key: "startDate",     re: /start\s+date|available\s+to\s+start|notice\s+period/i },
];

function matchAnswerKey(label) {
  for (const rule of ANSWER_RULES) {
    if (rule.re.test(label)) return rule.key;
  }
  return null;
}

// Fill Workday dropdown questions (buttons that open listboxes)
async function fillDropdownQuestions(profile) {
  let filled = 0;
  const buttons = document.querySelectorAll(
    'button[aria-haspopup="listbox"], [data-automation-id="selectWidget"] button'
  );
  for (const btn of buttons) {
    if (btn.offsetParent === null) continue;
    // Skip if already answered (Workday shows the choice as button text ≠ "Select One")
    const current = btn.textContent.trim().toLowerCase();
    if (current && !/select|choose|^\s*$/i.test(current)) continue;

    const label = getFieldLabel(btn);
    const key = matchAnswerKey(label) || matchProfileKey(label);
    if (key && profile[key]) {
      const ok = await selectWorkdayDropdown(btn, profile[key]);
      if (ok) filled++;
    }
  }
  return filled;
}

// Fill radio-button questions (Yes/No style, and EEO options)
function fillRadioQuestions(profile) {
  let filled = 0;
  const groups = document.querySelectorAll('[role="radiogroup"], fieldset');
  for (const group of groups) {
    const legend = group.querySelector("legend, label")?.textContent.trim()
      || group.getAttribute("aria-label") || "";
    const key = matchAnswerKey(legend);
    if (!key || !profile[key]) continue;

    const want = profile[key].toLowerCase();
    const radios = group.querySelectorAll('input[type="radio"], [role="radio"]');
    for (const radio of radios) {
      const optLabel = (getFieldLabel(radio) || radio.value || "").toLowerCase();
      if (optLabel.includes(want) || want.includes(optLabel)) {
        radio.click();
        radio.dispatchEvent(new Event("change", { bubbles: true }));
        filled++;
        break;
      }
    }
  }
  return filled;
}

// ---------------------------------------------------------------------------
// 4. Fill text inputs and textareas
// ---------------------------------------------------------------------------
function fillTextFields(profile) {
  const inputs = document.querySelectorAll(
    'input[type="text"], input[type="email"], input[type="tel"], input[type="url"], input:not([type]), textarea'
  );
  let filled = 0;
  inputs.forEach((input) => {
    if (input.value) return;                 // don't clobber existing values
    if (input.offsetParent === null) return; // skip hidden inputs
    const label = getFieldLabel(input);
    const key = matchProfileKey(label);
    if (key && profile[key]) {
      setNativeValue(input, profile[key]);
      filled++;
    }
  });
  return filled;
}

// ---------------------------------------------------------------------------
// 5. Workday dropdowns are custom <button> widgets, not <select>.
// Strategy: click the button, wait for the listbox to render, click the
// option whose text matches. Everything is async because the options are
// rendered lazily.
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function selectWorkdayDropdown(button, desiredText) {
  button.click();
  await sleep(400); // wait for listbox to mount
  const options = document.querySelectorAll('[role="option"], ul[role="listbox"] li');
  for (const opt of options) {
    if (opt.textContent.trim().toLowerCase().includes(desiredText.toLowerCase())) {
      opt.click();
      await sleep(200);
      return true;
    }
  }
  // close the dropdown if nothing matched
  document.body.click();
  return false;
}

// ---------------------------------------------------------------------------
// 6. Workday multiselect (the skills box in your screenshot).
// It's a text input that opens a search dropdown; you type, wait, then click
// the matching option. Repeat per skill.
// ---------------------------------------------------------------------------
async function fillWorkdayMultiselect(input, values) {
  for (const value of values) {
    input.focus();
    setNativeValue(input, value);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await sleep(600); // wait for search results
    const option = [...document.querySelectorAll('[role="option"]')]
      .find((o) => o.textContent.trim().toLowerCase() === value.toLowerCase())
      || document.querySelector('[role="option"]');
    if (option) option.click();
    await sleep(300);
  }
}

// ---------------------------------------------------------------------------
// 7. Resume upload. You can't set a file input's value from JS for security
// reasons, but you CAN construct a File and assign a DataTransfer.
// The resume is stored as base64 in chrome.storage.
// ---------------------------------------------------------------------------
async function uploadResume(profile) {
  if (!profile.resumeBase64) return false;
  const fileInput = document.querySelector('input[type="file"]');
  if (!fileInput) return false;

  const bytes = Uint8Array.from(atob(profile.resumeBase64), (c) => c.charCodeAt(0));
  const file = new File([bytes], profile.resumeFileName || "resume.pdf", {
    type: profile.resumeMime || "application/pdf",
  });
  const dt = new DataTransfer();
  dt.items.add(file);
  fileInput.files = dt.files;
  fileInput.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
}

// ---------------------------------------------------------------------------
// 8. Orchestrator + message listener
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 7b. LLM answers for open-ended questions.
// Any visible, empty textarea whose label did NOT match a profile key is
// treated as a free-text question and sent to your LLM (via background.js).
// ---------------------------------------------------------------------------
function getJobContext() {
  const title = document.querySelector('[data-automation-id="jobPostingHeader"], h1, h2');
  return (title ? title.textContent.trim() + " — " : "") + document.title;
}

async function answerOpenQuestions(profile, useLLM) {
  let answered = 0;
  const textareas = [...document.querySelectorAll("textarea")]
    .filter((t) => t.offsetParent !== null && !t.value);

  for (const ta of textareas) {
    const label = getFieldLabel(ta);
    if (!label || matchProfileKey(label)) continue; // profile fields handled elsewhere
    if (label.length < 8) continue;                 // too short to be a real question

    // 1) Saved answer first (e.g. your own "why interested" template)
    const savedKey = matchAnswerKey(label);
    if (savedKey && profile[savedKey]) {
      setNativeValue(ta, profile[savedKey]);
      answered++;
      continue;
    }

    // 2) Fall back to the LLM for anything unrecognized
    if (!useLLM) continue;
    const res = await chrome.runtime.sendMessage({
      type: "ASK_LLM",
      question: label,
      jobContext: getJobContext(),
    });
    if (res && res.answer) {
      setNativeValue(ta, res.answer.trim());
      // Highlight so the user knows to review AI-written answers
      ta.style.outline = "2px solid #f59e0b";
      answered++;
    }
  }
  return answered;
}

async function runAutofill(profile, useLLM) {
  const results = { textFields: 0, resume: false, skills: false, llmAnswers: 0, choices: 0 };

  results.textFields = fillTextFields(profile);
  results.choices = fillRadioQuestions(profile);
  results.choices += await fillDropdownQuestions(profile);

  // Skills multiselect (Workday marks it with a searchbox role or automation id)
  const skillsInput =
    document.querySelector('[data-automation-id*="skill" i] input') ||
    document.querySelector('input[placeholder*="skill" i]');
  if (skillsInput && Array.isArray(profile.skills) && profile.skills.length) {
    await fillWorkdayMultiselect(skillsInput, profile.skills);
    results.skills = true;
  }

  results.resume = await uploadResume(profile);
  results.llmAnswers = await answerOpenQuestions(profile, useLLM);
  return results;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "AUTOFILL") {
    runAutofill(msg.profile, !!msg.useLLM).then(sendResponse);
    return true; // keep the message channel open for the async response
  }
  if (msg.type === "SCAN") {
    // Return what fields we can see, useful for debugging matching rules
    const seen = [...document.querySelectorAll("input, textarea")]
      .filter((i) => i.offsetParent !== null)
      .map((i) => ({ label: getFieldLabel(i), matched: matchProfileKey(getFieldLabel(i)) }));
    sendResponse(seen);
  }
});
