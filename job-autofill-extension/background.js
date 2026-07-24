// background.js — service worker.
// Handles LLM calls (must live here, not in content scripts, to avoid CORS
// issues and keep your API key out of page context).

chrome.runtime.onInstalled.addListener(() => {
  console.log("Job Autofill Assistant installed");
});

// ---------------------------------------------------------------------------
// LLM answering. Supports three providers via a single settings object:
//   { provider: "anthropic" | "openai" | "ollama", apiKey, model, baseUrl }
// Saved from the popup's Settings section into chrome.storage.local.
// ---------------------------------------------------------------------------
async function askLLM(question, profile, jobContext, llm) {
  const systemPrompt =
    "You are helping a job applicant answer an application question. " +
    "Write in first person as the applicant. Be specific, honest, and concise " +
    "(2-4 sentences unless the question demands more). Never invent " +
    "credentials, employers, or dates not present in the profile.\n\n" +
    `Applicant profile:\n${JSON.stringify(stripResume(profile), null, 2)}\n\n` +
    `Job context (from the page):\n${jobContext || "unknown"}`;

  if (llm.provider === "anthropic") {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": llm.apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: llm.model || "claude-sonnet-4-5",
        max_tokens: 500,
        system: systemPrompt,
        messages: [{ role: "user", content: question }],
      }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return data.content.map((b) => b.text || "").join("");
  }

  if (llm.provider === "openai" || llm.provider === "groq") {
    const endpoint = llm.provider === "groq"
      ? "https://api.groq.com/openai/v1/chat/completions"
      : "https://api.openai.com/v1/chat/completions";
    const defaultModel = llm.provider === "groq"
      ? "llama-3.3-70b-versatile"
      : "gpt-4o-mini";
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${llm.apiKey}`,
      },
      body: JSON.stringify({
        model: llm.model || defaultModel,
        max_tokens: 500,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: question },
        ],
      }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return data.choices[0].message.content;
  }

  if (llm.provider === "ollama") {
    // Local model, no API key needed. Run: ollama serve
    // You may need: OLLAMA_ORIGINS=chrome-extension://* ollama serve
    const res = await fetch(`${llm.baseUrl || "http://localhost:11434"}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: llm.model || "llama3.1",
        stream: false,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: question },
        ],
      }),
    });
    const data = await res.json();
    return data.message.content;
  }

  throw new Error(`Unknown provider: ${llm.provider}`);
}

function stripResume(profile) {
  // Don't send the base64 resume blob to the LLM — too big, not useful.
  const { resumeBase64, ...rest } = profile;
  return rest;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "ASK_LLM") {
    chrome.storage.local.get(["profile", "llm"]).then(({ profile, llm }) => {
      if (!llm || (!llm.apiKey && llm.provider !== "ollama")) {
        sendResponse({ error: "LLM not configured. Open the popup → LLM Settings." });
        return;
      }
      askLLM(msg.question, profile || {}, msg.jobContext, llm)
        .then((answer) => sendResponse({ answer }))
        .catch((e) => sendResponse({ error: e.message }));
    });
    return true; // async response
  }
});
