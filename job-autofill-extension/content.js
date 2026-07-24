// content.js — runs on job application pages.
// Listens for an "AUTOFILL" message from the popup, then fills the form.
// Injected two ways: automatically on known ATS domains (manifest), and
// on-demand into ANY page via the popup (chrome.scripting). The guard below
// prevents double-registration if both happen.
(function () {
  if (window.__jobAutofillInjected) return;
  window.__jobAutofillInjected = true;

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
  // Order matters: specific phone rules BEFORE the generic one, or
  // "Country Phone Code" / "Phone Device Type" would match as phone number.
  { key: "phoneType",  re: /phone\s*(device\s*)?type|device\s*type/i },
  { key: "phoneCountryCode", re: /country\s*phone\s*code|phone\s*country\s*code|dial(ing)?\s*code/i },
  { key: "phone",      re: /phone|mobile|cell/i },
  { key: "addressLine1", re: /address\s*line\s*1|street|addressLine1|^\s*address\s*\*?\s*$/i },
  { key: "addressLine2", re: /address\s*line\s*2|apt|suite|unit/i },
  { key: "city",       re: /\bcity\b|town/i },
  { key: "state",      re: /\bstate\b|province|region/i },
  { key: "postalCode", re: /zip|postal/i },
  { key: "country",    re: /country/i },
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

// Fill real <select> elements (Greenhouse and many other ATSs use these)
function fillNativeSelects(profile) {
  let filled = 0;
  document.querySelectorAll("select").forEach((sel) => {
    if (sel.offsetParent === null) return;
    if (sel.selectedIndex > 0 && sel.value) return; // already answered
    const label = getFieldLabel(sel);
    const key = matchAnswerKey(label) || matchProfileKey(label);
    if (!key || !profile[key]) return;

    const want = profile[key].toLowerCase();
    for (const opt of sel.options) {
      const text = opt.textContent.trim().toLowerCase();
      if (!text) continue;
      if (text.includes(want) || want.includes(text)) {
        sel.value = opt.value;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        sel.dispatchEvent(new Event("input", { bubbles: true }));
        filled++;
        break;
      }
    }
  });
  return filled;
}

// Fill searchable comboboxes (Greenhouse's new job-boards UI uses these:
// an input with role="combobox" that opens a filtered option list).
async function fillComboboxes(profile) {
  let filled = 0;
  const combos = document.querySelectorAll(
    'input[role="combobox"], input[aria-autocomplete="list"]'
  );
  for (const input of combos) {
    if (input.offsetParent === null || input.value) continue;
    const label = getFieldLabel(input);
    const key = matchAnswerKey(label) || matchProfileKey(label);
    if (!key || !profile[key]) continue;

    input.focus();
    input.click();
    setNativeValue(input, profile[key]);
    await sleep(500); // wait for the filtered option list

    const want = profile[key].toLowerCase();
    const options = document.querySelectorAll('[role="option"], [id*="option"]');
    let clicked = false;
    for (const opt of options) {
      const text = opt.textContent.trim().toLowerCase();
      if (text.includes(want) || want.includes(text)) {
        opt.click();
        clicked = true;
        break;
      }
    }
    if (!clicked && options.length === 1) { options[0].click(); clicked = true; }
    if (clicked) filled++;
    await sleep(200);
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
        chooseOption(radio);
        filled++;
        break;
      }
    }
  }
  return filled;
}

// ---------------------------------------------------------------------------
// 6c. Federal self-ID forms (CC-305 disability, veteran status) + their
// Name/Date fields. These are special:
//  - Options are long sentences ("No, I do not have a disability and have
//    not had one in the past"), so we categorize both the option and your
//    saved answer as yes / no / decline and match categories.
//  - Workday hides the native checkbox inputs behind styled widgets, so we
//    click the associated label when the input itself isn't visible.
// ---------------------------------------------------------------------------
function categorizeAnswer(text) {
  const t = text.toLowerCase().trim();
  if (/^yes\b/.test(t)) return "yes";
  if (/^no\b/.test(t)) return "no";
  if (/(do\s*n[o']t|not|prefer not|decline).*(answer|say|identify|disclose)|^decline/.test(t)) return "decline";
  return null;
}

function chooseOption(input) {
  // Native input may be visually hidden; click its label instead.
  if (input.offsetParent !== null) {
    input.click();
  } else {
    const lbl = input.id && document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
    (lbl || input.closest("label") || input).click();
  }
  input.dispatchEvent(new Event("change", { bubbles: true }));
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function fillSelfIdChoices(profile) {
  let filled = 0;
  const targets = [
    { saved: profile.disability, optionRe: /disabilit|do not want to answer/i },
    { saved: profile.veteran,    optionRe: /veteran/i },
  ];
  for (const { saved, optionRe } of targets) {
    if (!saved) continue;
    const wantCat = categorizeAnswer(saved);
    if (!wantCat) continue;

    const boxes = document.querySelectorAll(
      'input[type="checkbox"], input[type="radio"], [role="checkbox"], [role="radio"]'
    );
    for (const box of boxes) {
      if (box.checked || box.getAttribute("aria-checked") === "true") continue;
      const label = getFieldLabel(box);
      if (!label || !optionRe.test(label)) continue;
      if (categorizeAnswer(label) === wantCat) {
        chooseOption(box);
        filled++;
        break; // only one option per form
      }
    }
  }
  return filled;
}

// The CC-305 form also asks for Name and today's Date.
function fillSelfIdNameAndDate(profile) {
  let filled = 0;
  const now = new Date();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const yyyy = String(now.getFullYear());

  document.querySelectorAll("input").forEach((input) => {
    if (input.value || input.type === "checkbox" || input.type === "radio") return;
    const label = getFieldLabel(input).replace(/\*/g, "").trim().toLowerCase();
    const aria = (input.getAttribute("aria-label") || "").toLowerCase();

    // "Name" (full name) — exact-ish match only, to avoid First/Last fields
    if ((label === "name" || label === "your name" || label === "full name")
        && profile.firstName) {
      setNativeValue(input, `${profile.firstName} ${profile.lastName || ""}`.trim());
      filled++;
      return;
    }
    // Workday splits dates into Month/Day/Year spinner inputs
    if (aria === "month" || label === "month") { setNativeValue(input, mm); filled++; return; }
    if (aria === "day"   || label === "day")   { setNativeValue(input, dd); filled++; return; }
    if (aria === "year"  || label === "year")  { setNativeValue(input, yyyy); filled++; return; }
    // Single date input with MM/DD/YYYY placeholder ("Date" / "Today's Date")
    if ((label === "date" || label === "today's date" || /mm\/dd\/yyyy/i.test(input.placeholder || ""))
        && !/birth|dob/i.test(label)) {
      setNativeValue(input, `${mm}/${dd}/${yyyy}`);
      filled++;
    }
  });
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
  results.textFields += fillSelfIdNameAndDate(profile);
  results.choices = fillRadioQuestions(profile);
  results.choices += fillSelfIdChoices(profile);
  results.choices += fillNativeSelects(profile);
  results.choices += await fillDropdownQuestions(profile);
  results.choices += await fillComboboxes(profile);

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
    // Return every visible field + whether we can match it. Debug aid.
    const els = [...document.querySelectorAll(
      'input, textarea, select, button[aria-haspopup="listbox"]'
    )].filter((el) => el.offsetParent !== null);
    const seen = els
      .map((el) => {
        const label = getFieldLabel(el);
        return { label, matched: matchAnswerKey(label) || matchProfileKey(label) };
      })
      .filter((x) => x.label);
    sendResponse(seen);
  }
});

})();
