const state = { projects: [], activeId: null, snapshot: null, source: null };
const $ = (selector) => document.querySelector(selector);
const els = {
  select: $("#project-select"), health: $("#health"), status: $("#project-status"),
  messages: $("#messages"), composer: $("#composer"), input: $("#message-input"),
  send: $("#send-button"), question: $("#question-banner"), graph: $("#task-graph"),
  taskCount: $("#task-count"), timeline: $("#timeline"), evidence: $("#evidence-count"),
  tokens: $("#token-count"), deployments: $("#deployment-count"), latestDeployment: $("#latest-deployment"), toast: $("#toast")
};

const escapeHtml = (value = "") => String(value).replace(/[&<>'"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"})[c]);
const payload = (event) => typeof event.payload === "string" ? JSON.parse(event.payload || "{}") : (event.payload ?? {});
const formatTime = (value) => value ? new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value)) : "";
const showError = (message) => { els.toast.textContent = message; els.toast.hidden = false; clearTimeout(showError.timer); showError.timer = setTimeout(() => els.toast.hidden = true, 5000); };

async function api(path, options) {
  const response = await fetch(path, { headers: { "content-type": "application/json" }, ...options });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || body.error || `请求失败 (${response.status})`);
  return body;
}

async function loadProjects(preferredId) {
  const result = await api("/api/projects");
  state.projects = result.projects ?? result ?? [];
  state.activeId = preferredId || state.activeId || state.projects[0]?.id || null;
  els.select.innerHTML = `<option value="">新项目</option>${state.projects.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join("")}`;
  els.select.value = state.activeId || "";
  if (state.activeId) await loadSnapshot(); else renderEmpty();
}

async function loadSnapshot() {
  if (!state.activeId) return;
  state.snapshot = await api(`/api/projects/${encodeURIComponent(state.activeId)}/snapshot`);
  render();
  connectEvents();
}

function connectEvents() {
  state.source?.close();
  if (!state.activeId) return;
  const after = state.snapshot?.events?.at(-1)?.seq ?? 0;
  const source = new EventSource(`/api/projects/${encodeURIComponent(state.activeId)}/stream?afterSeq=${after}`);
  source.onopen = () => setHealth("ready", "状态已同步");
  source.onerror = () => setHealth("error", "正在重连");
  source.onmessage = () => loadSnapshot().catch((error) => showError(error.message));
  state.source = source;
}

function setHealth(kind, text) { els.health.className = `health ${kind}`; els.health.lastChild.textContent = text; }
function renderEmpty() {
  state.snapshot = null; state.source?.close(); state.source = null; setHealth("ready", "等待新项目");
  els.status.textContent = "等待输入"; els.status.className = "status-chip"; els.question.hidden = true;
  els.graph.innerHTML = `<p class="muted">方案生成后，任务依赖会出现在这里。</p>`;
  els.timeline.innerHTML = `<li class="muted">尚无事件</li>`; els.taskCount.textContent = "0 节点";
  els.evidence.textContent = "0"; els.tokens.textContent = "0"; els.deployments.textContent = "0";
  els.latestDeployment.textContent = "暂无已验证部署"; els.latestDeployment.className = "deployment muted";
}

function render() {
  const s = state.snapshot || {};
  const project = s.project || state.projects.find((p) => p.id === state.activeId) || {};
  els.status.textContent = project.status || "active"; els.status.className = `status-chip ${project.status === "running" ? "running" : ""}`;
  renderMessages(s.events || []); renderQuestions(s.questions || []); renderTasks(s.tasks || []); renderTimeline(s.events || []); renderEvidence(s);
}

function renderMessages(events) {
  const visible = events.filter((e) => /Message|Question|Plan|Requirement|Decision|ProjectCreated/.test(e.type));
  if (!visible.length) return;
  els.messages.innerHTML = visible.map((event) => {
    const p = payload(event); const user = /User|Requirement|Decision/.test(event.type);
    const text = p.text || p.prompt || p.summary || p.message || p.answer || event.type;
    return `<div class="message ${user ? "user" : "system"}"><small>${user ? "USER" : "FORGEOS"} · ${escapeHtml(event.type)}</small>${escapeHtml(text)}</div>`;
  }).join("");
  els.messages.scrollTop = els.messages.scrollHeight;
}

function renderQuestions(questions) {
  const open = questions.find((q) => q.status === "open" || q.status === "waiting_user");
  els.question.hidden = !open;
  if (open) els.question.innerHTML = `<strong>需要你的决定</strong><br>${escapeHtml(open.prompt)}`;
}

function renderTasks(tasks) {
  const order = ["analysis", "planning", "implementation", "test", "review", "merge", "deploy", "repair"];
  const groups = Map.groupBy(tasks, (task) => task.kind || "other");
  const kinds = [...new Set([...order.filter((kind) => groups.has(kind)), ...groups.keys()])];
  els.taskCount.textContent = `${tasks.length} 节点`;
  els.graph.innerHTML = kinds.length ? kinds.map((kind) => `<section class="task-stage"><header><span>${escapeHtml(kind)}</span><b>${groups.get(kind).length}</b></header>${groups.get(kind).map((task) => `<article class="task-card ${escapeHtml(task.status)}"><strong>${escapeHtml(task.title)}</strong><p>${escapeHtml(task.status)} · #${escapeHtml(String(task.generation ?? 1))}</p></article>`).join("")}</section>`).join("") : `<p class="muted">方案生成后，任务依赖会出现在这里。</p>`;
}

function renderTimeline(events) {
  const recent = events.slice(-14).reverse();
  els.timeline.innerHTML = recent.length ? recent.map((e) => `<li><time>${formatTime(e.createdAt || e.created_at)}</time>${escapeHtml(e.type)}</li>`).join("") : `<li class="muted">尚无事件</li>`;
}

function renderEvidence(s) {
  const calls = s.modelCalls || s.model_calls || [];
  const deployments = s.deployments || [];
  els.evidence.textContent = String((s.evidence || []).length);
  els.tokens.textContent = new Intl.NumberFormat("zh-CN", { notation: "compact" }).format(calls.reduce((sum, call) => sum + Number(call.totalTokens || call.total_tokens || 0), 0));
  els.deployments.textContent = String(deployments.length);
  const latest = deployments.at(-1);
  const previewUrl = latest?.previewUrl || latest?.preview_url || latest?.url;
  if (previewUrl) {
    els.latestDeployment.className = "deployment";
    els.latestDeployment.innerHTML = `<strong>最新本地预览</strong><br><a href="${escapeHtml(previewUrl)}" target="_blank" rel="noreferrer">${escapeHtml(previewUrl)}</a>`;
  } else { els.latestDeployment.textContent = "暂无已验证部署"; els.latestDeployment.className = "deployment muted"; }
}

els.composer.addEventListener("submit", async (event) => {
  event.preventDefault(); const text = els.input.value.trim(); if (!text) return;
  els.send.disabled = true;
  try {
    if (!state.activeId) {
      const result = await api("/api/projects", { method: "POST", body: JSON.stringify({ message: text }) });
      state.activeId = result.project?.id || result.id;
      await loadProjects(state.activeId);
    } else {
      const open = state.snapshot?.questions?.find((q) => q.status === "open" || q.status === "waiting_user");
      await api(`/api/projects/${encodeURIComponent(state.activeId)}/messages`, { method: "POST", body: JSON.stringify({ text, contextQuestionId: open?.id }) });
      await loadSnapshot();
    }
    els.input.value = "";
  } catch (error) { showError(error.message); } finally { els.send.disabled = false; els.input.focus(); }
});
els.input.addEventListener("keydown", (event) => { if (event.ctrlKey && event.key === "Enter") els.composer.requestSubmit(); });
els.select.addEventListener("change", async () => { state.activeId = els.select.value || null; if (state.activeId) await loadSnapshot(); else renderEmpty(); });

loadProjects().then(() => setHealth("ready", state.activeId ? "状态已同步" : "等待新项目")).catch((error) => { setHealth("error", "服务不可用"); showError(error.message); });
