# Job Autofill Assistant (starter)

A minimal Chrome extension that autofills job applications on Workday,
Greenhouse, and Lever from a locally saved profile — the same core mechanic
Jobright's extension uses.

## Install (unpacked)

1. Open `chrome://extensions`
2. Toggle **Developer mode** (top right)
3. Click **Load unpacked** and select this folder
4. Pin the extension, open a job application page, click the icon,
   fill in your profile, hit **Save profile**, then **Autofill this page**

## How it works

| Piece        | Job |
|--------------|-----|
| `content.js` | Injected into job pages. Finds inputs, reads their labels, matches them to profile keys, fills them React-safely. Handles Workday's custom dropdowns, the skills multiselect, and resume upload. |
| `popup.html/js` | Profile editor. Stores everything in `chrome.storage.local` (resume as base64). |
| `background.js` | Service worker — mostly a stub for now. |

### The three hard problems (and how this solves them)

1. **React doesn't see `input.value = x`.** Workday is React; you must call
   the *native* value setter and dispatch an `input` event
   (`setNativeValue()` in content.js). Otherwise the form looks filled but
   submits empty.

2. **Workday dropdowns aren't `<select>` elements.** They're buttons that
   open a `role="listbox"`. You have to click, wait for the options to
   mount, then click the matching `role="option"` — all async.

3. **File inputs can't be set directly.** But you can build a `File` from
   stored bytes and assign it through a `DataTransfer` object, then fire
   `change`. That's how the resume upload works.

## Roadmap to "Jobright-level"

- **Multi-page flows.** Workday applications span pages ("My Information" →
  "My Experience" → questions → review). Use a `MutationObserver` to detect
  page transitions and re-run the fill, and track per-page progress like the
  checklist in Jobright's sidebar.
- **LLM-powered answers.** For free-text questions ("Why do you want to work
  here?") and unmapped fields, send the question + your profile to an LLM API
  from `background.js` and fill the generated answer. This is Jobright's big
  differentiator.
- **Field-mapping database.** Real products maintain per-ATS selector maps
  (`data-automation-id` values for Workday, `id` patterns for Greenhouse).
  The label-regex approach here covers ~80%; hardcoded maps get you the rest.
- **Side panel instead of popup.** Use `chrome.sidePanel` (Chrome 114+) so
  the UI stays open while you scroll the form — that's the panel you see in
  Jobright's screenshot.
- **Education/work-history repeaters.** Workday's "Add another" sections need
  you to click the add button, wait, then fill the newly mounted block.

## Important caveats

- **Always review before submitting.** Auto-fill, human-submit. Some ATS
  terms of service prohibit fully automated submission, and bad autofills
  hurt your applications more than slow manual ones.
- Never store other people's data; this stores *your* profile locally only.
- CAPTCHAs and login walls are out of scope by design — don't try to
  automate around them.
- Workday's DOM changes between tenant versions; expect to update selectors.
