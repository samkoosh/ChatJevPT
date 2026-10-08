// "How it works": fills the page's numbers ([data-n]) and prompts ([data-prompt]) from /api/how,
// so they always match the running code. The numbers written in how.html are the fallback.
// Admins (not previewing as a regular person) get an editor for every prompt instead.
const prompts = [...document.querySelectorAll("[data-prompt]")];
for (const pre of prompts) pre.textContent = "Loading…";

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function isAdmin() {
  try {
    if (sessionStorage.getItem("jev-preview") === "1") return false;
  } catch {}
  try {
    const me = await api("GET", "/api/me");
    return me.user?.role === "admin";
  } catch {
    return false;
  }
}

// One prompt's editor: the text, Save for everyone, Reset to default.
function editor(pre, prompt) {
  const box = el("div", "prompt-editor");
  const area = el("textarea", "prompt-text");
  area.spellcheck = false;
  area.setAttribute("aria-label", `Prompt: ${pre.dataset.prompt}`);
  const actions = el("div", "prompt-actions");
  const save = el("button", "btn primary", "Save for everyone");
  const reset = el("button", "btn", "Reset to default");
  const status = el("span", "prompt-status");
  status.setAttribute("role", "status");
  save.type = reset.type = "button";
  actions.append(save, reset, status);
  box.append(area, actions);
  box.dataset.prompt = pre.dataset.prompt;
  pre.replaceWith(box);

  let current = prompt;
  const fit = () => {
    area.style.height = "auto";
    area.style.height = `${area.scrollHeight + 2}px`;
  };
  const render = (message) => {
    const dirty = area.value !== current.text;
    save.disabled = !dirty || !area.value.trim();
    reset.disabled = current.isDefault && !dirty;
    status.textContent = message ?? (dirty ? "Unsaved changes" : current.isDefault ? "Default" : "Edited (saved for everyone)");
    box.classList.toggle("edited", !current.isDefault);
    box.closest("details")?.classList.toggle("has-edits", !!box.closest("details").querySelector(".prompt-editor.edited"));
  };
  const send = async (text) => {
    save.disabled = reset.disabled = true;
    status.textContent = "Saving…";
    try {
      current = await api("PUT", "/api/admin/prompts", { key: current.key, text });
      area.value = current.text;
      fit();
      render(text === null ? "Back to the default" : "Saved. Every answer uses it within 15 seconds.");
    } catch (err) {
      render(err.message);
    }
  };
  area.value = current.text;
  area.addEventListener("input", () => {
    fit();
    render();
  });
  save.addEventListener("click", () => send(area.value));
  reset.addEventListener("click", () => {
    if (area.value !== current.text && current.isDefault) {
      area.value = current.text; // just discard the unsaved edit
      fit();
      return render();
    }
    send(null);
  });
  render();
  // Size once it's visible (closed <details> have no layout).
  box.closest("details")?.addEventListener("toggle", fit);
  requestAnimationFrame(fit);
}

async function load() {
  const [how, admin] = await Promise.all([api("GET", "/api/how"), isAdmin()]);
  for (const node of document.querySelectorAll("[data-n]")) {
    if (how.numbers?.[node.dataset.n] !== undefined) node.textContent = how.numbers[node.dataset.n];
  }
  if (admin) {
    try {
      const { prompts: editable } = await api("GET", "/api/admin/prompts");
      document.getElementById("admin-note").hidden = false;
      for (const pre of prompts) {
        if (editable[pre.dataset.prompt]) editor(pre, editable[pre.dataset.prompt]);
        else pre.textContent = how.prompts?.[pre.dataset.prompt] ?? "(not available)";
      }
      return;
    } catch {
      // Not an admin after all (or the session ended): show the prompts read-only.
    }
  }
  for (const pre of prompts) pre.textContent = how.prompts?.[pre.dataset.prompt] ?? "(not available)";
}

load().catch(() => {
  for (const pre of prompts) pre.textContent = "Couldn't load the prompts right now.";
});
