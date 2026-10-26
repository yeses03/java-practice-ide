/* Java Practice IDE - frontend logic (plain JS, no build step). */
(function () {
  "use strict";

  const STORE_KEY = "javaPracticeIde.v1";
  const TEMPLATE = `import java.io.*;
import java.util.*;

public class Main {
    public static void main(String[] args) {
        Scanner sc = new Scanner(System.in);

        // Write your code here

        sc.close();
    }
}
`;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ------------------------------------------------------------------ state
  // state = { currentId, questions: [{id, title, text, statement, tests:[{input,expected,hidden}], warnings, code}] }
  let state = { currentId: null, questions: [] };
  let editingId = null; // set while the paste box is open for an EXISTING question
  let busy = false;

  function loadState() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        if (s && Array.isArray(s.questions)) state = s;
      }
    } catch (e) { /* private mode / corrupted: start fresh */ }
  }
  function saveState() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* storage full or blocked */ }
  }
  const current = () => state.questions.find((q) => q.id === state.currentId) || null;

  // ------------------------------------------------------------------ editor
  // Monaco from the CDN; if the CDN is unreachable we fall back to a plain textarea.
  let editor = null; // Monaco instance
  let fallbackArea = null;
  let suppressChange = false;

  const getCode = () => (editor ? editor.getValue() : fallbackArea.value);
  function setCode(code) {
    suppressChange = true;
    if (editor) editor.setValue(code); else fallbackArea.value = code;
    suppressChange = false;
  }
  let saveTimer = null;
  function onCodeChanged() {
    if (suppressChange) return;
    clearMarkers();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const q = current();
      if (q) { q.code = getCode(); saveState(); }
    }, 300);
  }

  function initEditor() {
    return new Promise((resolve) => {
      const makeFallback = () => {
        fallbackArea = document.createElement("textarea");
        fallbackArea.style.cssText = "width:100%;height:100%;background:#1e1e1e;color:#ddd;border:0;padding:10px;font:13px ui-monospace,Menlo,monospace;tab-size:4;resize:none";
        fallbackArea.spellcheck = false;
        fallbackArea.addEventListener("input", onCodeChanged);
        $("editor").appendChild(fallbackArea);
        showBanner("Could not load Monaco editor from the CDN (offline?). Using a plain text editor instead.");
        resolve();
      };
      if (typeof require === "undefined" || !require.config) return makeFallback();

      const base = "https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min";
      require.config({ paths: { vs: base + "/vs" } });
      // Monaco runs its language services in web workers; workers can't be loaded cross-origin
      // directly, so we hand it a tiny data: URL script that importScripts() the CDN worker.
      window.MonacoEnvironment = {
        getWorkerUrl: () =>
          "data:text/javascript;charset=utf-8," +
          encodeURIComponent(`self.MonacoEnvironment={baseUrl:'${base}/'};importScripts('${base}/vs/base/worker/workerMain.js');`),
      };
      require(["vs/editor/editor.main"], () => {
        editor = monaco.editor.create($("editor"), {
          value: TEMPLATE, language: "java", theme: "vs-dark", automaticLayout: true,
          fontSize: 14, minimap: { enabled: false }, scrollBeyondLastLine: false, tabSize: 4,
        });
        editor.onDidChangeModelContent(onCodeChanged);
        resolve();
      }, makeFallback);
    });
  }

  // javac prints "Main.java:7: error: ';' expected". Turn those into red squiggles in the editor.
  function clearMarkers() {
    if (editor) monaco.editor.setModelMarkers(editor.getModel(), "javac", []);
  }
  function setMarkers(output) {
    if (!editor) return;
    const markers = [];
    const re = /^Main\.java:(\d+): (error|warning): (.*)$/gm;
    let m;
    while ((m = re.exec(output))) {
      const line = parseInt(m[1], 10);
      markers.push({
        startLineNumber: line, endLineNumber: line, startColumn: 1,
        endColumn: editor.getModel().getLineMaxColumn(line) || 1,
        message: m[3], severity: m[2] === "error" ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
      });
    }
    monaco.editor.setModelMarkers(editor.getModel(), "javac", markers);
  }
  function gotoLine(line) {
    if (!editor) return;
    editor.revealLineInCenter(line);
    editor.setPosition({ lineNumber: line, column: 1 });
    editor.focus();
  }

  // ------------------------------------------------------------------ question rendering
  function inline(s) {
    // escape first, then turn `code` into <code>
    return esc(s).replace(/`([^`]+)`/g, "<code>$1</code>");
  }
  const HEADINGS = /^(problem statement|input format|output format|code constraints|constraints|sample test cases?|note)\s*:?\s*$/i;
  const BULLET = /^\s*(?:[*•-])\s+(.*)$/;

  // Very small "text -> HTML" converter that understands the layout of these questions:
  // title line, section headings, bullet lists, short sub-headings, and plain paragraphs.
  function renderStatement(text) {
    const lines = text.split("\n").map((l) => l.replace(/\s+$/, ""));
    let html = "";
    let para = [];
    let list = [];
    const flushPara = () => { if (para.length) { html += "<p>" + para.map(inline).join("<br>") + "</p>"; para = []; } };
    const flushList = () => { if (list.length) { html += "<ul>" + list.map((i) => "<li>" + inline(i) + "</li>").join("") + "</ul>"; list = []; } };
    const nextNonBlank = (i) => { for (let j = i + 1; j < lines.length; j++) if (lines[j].trim()) return lines[j]; return ""; };

    lines.forEach((line, i) => {
      const t = line.trim();
      if (!t) { flushPara(); flushList(); return; }
      const b = BULLET.exec(line);
      if (b) { flushPara(); list.push(b[1]); return; }
      flushList();
      if (i === 0 && /question\s*$/i.test(t)) { html += "<h1>" + esc(t) + "</h1>"; return; }
      if (/^note\s*:?$/i.test(t)) { flushPara(); html += "<h4>Note</h4>"; return; }
      if (HEADINGS.test(t)) { flushPara(); html += "<h3>" + esc(t.replace(/\s*:\s*$/, "")) + "</h3>"; return; }
      // short line, preceded by a blank line, followed by a bullet list => sub-heading ("Season Mapping")
      const prevBlank = i === 0 || !lines[i - 1].trim();
      if (prevBlank && t.length <= 40 && !/[.:,;]$/.test(t) && BULLET.test(nextNonBlank(i))) {
        flushPara(); html += "<h4>" + esc(t) + "</h4>"; return;
      }
      para.push(t);
    });
    flushPara(); flushList();
    return html;
  }

  function renderSamples(tests) {
    if (!tests.length) return "";
    let h = "<h3>Sample test cases</h3>";
    tests.forEach((t, i) => {
      h += `<div class="samplelabel">Input ${i + 1}</div><pre>${esc(t.input)}</pre>`;
      h += `<div class="samplelabel">Output ${i + 1}</div><pre>${esc(t.expected)}</pre>`;
    });
    return h;
  }

  function renderTests() {
    const q = current();
    const list = $("testList");
    list.innerHTML = "";
    $("testCount").textContent = q.tests.length;
    $("parseWarnings").textContent = (q.warnings || []).join("\n");
    q.tests.forEach((t, i) => {
      const div = document.createElement("div");
      div.className = "tcase";
      div.innerHTML = `
        <div class="th"><span>Test case ${i + 1}</span>
          <label><input type="checkbox" class="hid" ${t.hidden ? "checked" : ""}> hidden</label>
          <span class="spacer"></span>
          <button class="btn small danger del">Delete</button></div>
        <div class="cols">
          <div><label>Input</label><textarea class="inp" spellcheck="false"></textarea></div>
          <div><label>Expected output</label><textarea class="exp" spellcheck="false"></textarea></div>
        </div>`;
      const inp = div.querySelector(".inp"), exp = div.querySelector(".exp");
      inp.value = t.input; exp.value = t.expected;
      inp.addEventListener("input", () => { t.input = inp.value; saveState(); });
      exp.addEventListener("input", () => { t.expected = exp.value; saveState(); });
      div.querySelector(".hid").addEventListener("change", (e) => { t.hidden = e.target.checked; saveState(); });
      div.querySelector(".del").addEventListener("click", () => {
        q.tests.splice(i, 1); saveState(); renderTests(); renderQuestion();
      });
      list.appendChild(div);
    });
  }

  function renderQuestion() {
    const q = current();
    $("titleInput").value = q.title;
    // Samples shown in the statement come from the (editable) parsed tests, not raw text.
    $("statement").innerHTML = renderStatement(q.statement) + renderSamples(q.tests.filter((t) => !t.hidden));
  }

  // ------------------------------------------------------------------ views
  function showView() {
    const q = current();
    const pasting = !q || editingId !== null;
    $("pasteView").classList.toggle("hidden", !pasting);
    $("questionView").classList.toggle("hidden", pasting);
    $("btnCancelPaste").classList.toggle("hidden", !(editingId !== null || (q && state.questions.length)));
    if (!pasting) { renderQuestion(); renderTests(); }
    renderMenu();
  }

  function renderMenu() {
    const menu = $("questionMenu");
    if (!state.questions.length) { menu.innerHTML = '<div class="empty">No saved questions yet.</div>'; return; }
    menu.innerHTML = "";
    state.questions.slice().reverse().forEach((q) => {
      const item = document.createElement("div");
      item.className = "item" + (q.id === state.currentId ? " active" : "");
      item.innerHTML = `<span class="t">${esc(q.title)}</span><span class="muted small">${q.tests.length} tests</span><button class="btn small danger">Delete</button>`;
      item.addEventListener("click", () => { switchTo(q.id); menu.classList.add("hidden"); });
      item.querySelector("button").addEventListener("click", (e) => {
        e.stopPropagation();
        if (!confirm(`Delete "${q.title}"?`)) return;
        state.questions = state.questions.filter((x) => x.id !== q.id);
        if (state.currentId === q.id) {
          state.currentId = state.questions.length ? state.questions[state.questions.length - 1].id : null;
          editingId = null;
          setCode(current() ? current().code : TEMPLATE);
        }
        saveState(); showView();
      });
      menu.appendChild(item);
    });
  }

  function switchTo(id) {
    const old = current();
    if (old) old.code = getCode();
    state.currentId = id; editingId = null;
    setCode(current().code);
    clearMarkers();
    saveState(); showView();
    clearResults();
  }

  function newQuestion() {
    const old = current();
    if (old) { old.code = getCode(); saveState(); }
    editingId = null; state.currentId = null;
    $("pasteBox").value = "";
    setCode(TEMPLATE);
    showView();
    $("pasteBox").focus();
  }

  function parseAndLoad() {
    const text = $("pasteBox").value;
    if (!text.trim()) return;
    const parsed = QuestionParser.parseQuestion(text);
    if (editingId !== null) {
      const q = state.questions.find((x) => x.id === editingId);
      if (!confirm("Re-parsing replaces this question's test cases (including your manual edits). Continue?")) return;
      Object.assign(q, { text, statement: parsed.statement, tests: parsed.tests, warnings: parsed.warnings });
      state.currentId = q.id;
    } else {
      const q = {
        id: "q" + Date.now(), title: QuestionParser.guessTitle(parsed.statement), text,
        statement: parsed.statement, tests: parsed.tests, warnings: parsed.warnings, code: TEMPLATE,
      };
      state.questions.push(q); state.currentId = q.id;
      setCode(TEMPLATE);
    }
    editingId = null;
    saveState(); showView(); clearResults();
  }

  // ------------------------------------------------------------------ running
  function showBanner(msg) { const b = $("banner"); b.textContent = msg; b.classList.remove("hidden"); }

  function setBusy(on) {
    busy = on;
    $("btnRun").disabled = on; $("btnSubmit").disabled = on;
  }

  async function callJudge(tests) {
    const r = await fetch("/api/judge", {
      method: "POST",
      headers: { "Content-Type": "application/json" }, // required by the server (anti-CSRF)
      body: JSON.stringify({ code: getCode(), tests, timeout: Number($("timeout").value) || 5 }),
    });
    const data = await r.json().catch(() => ({ error: "Server returned something unreadable." }));
    if (!r.ok && !data.error) data.error = "Server error " + r.status;
    return data;
  }

  async function execute(mode) {
    if (busy) return;
    const q = current();
    clearMarkers();
    let tests, labels;
    if (mode === "run") {
      if ($("useCustom").checked) {
        tests = [{ input: $("customInput").value, expected: null }]; labels = [null];
      } else if (q && q.tests.length) {
        tests = [{ input: q.tests[0].input, expected: q.tests[0].expected }]; labels = [q.tests[0]];
      } else {
        tests = [{ input: "", expected: null }]; labels = [null];
      }
    } else {
      if (!q || !q.tests.length) { renderMessage("Add at least one test case first (or use Run with custom input).", "warn"); return; }
      tests = q.tests.map((t) => ({ input: t.input, expected: t.expected }));
      labels = q.tests;
    }
    setBusy(true);
    $("resultsPane").classList.remove("collapsed");
    $("resultsBody").innerHTML = '<p class="muted">Compiling and running…</p>';
    if (q) { q.code = getCode(); saveState(); }
    try {
      const data = await callJudge(tests);
      if (data.error) renderMessage(data.error, "bad");
      else renderResults(data, labels, mode);
    } catch (e) {
      renderMessage("Could not reach the local server. Is `python app.py` still running?", "bad");
    } finally {
      setBusy(false);
    }
  }

  // ------------------------------------------------------------------ results rendering
  function clearResults() {
    $("resultsBody").innerHTML = '<p class="muted">Press Run (⌘↵) to try the first sample, or Submit (⌘⇧↵) to judge all test cases.</p>';
  }
  function renderMessage(msg, kind) {
    $("resultsBody").innerHTML = `<div class="verdict v-${kind === "bad" ? "bad" : "warn"}" style="font-size:15px">${esc(msg)}</div>`;
  }

  const VCLASS = { Accepted: "v-ok", Finished: "v-ok", "Wrong Answer": "v-bad", "Compilation Error": "v-warn", "Runtime Error": "v-bad", "Time Limit Exceeded": "v-warn" };
  const VCOLOR = { Accepted: "var(--green)", Finished: "var(--green)", "Wrong Answer": "var(--red)", "Runtime Error": "var(--red)", "Time Limit Exceeded": "var(--amber)" };

  function trimEndLines(text) {
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    return lines;
  }
  // Render text line by line; line numbers in `marks` (1-based) get highlighted.
  function linesBox(text, mark, cls) {
    const lines = trimEndLines(text);
    if (!lines.length) return '<div class="codebox"><span class="ln muted">(empty)</span></div>';
    return '<div class="codebox">' + lines.map((l, i) =>
      `<span class="ln${mark === i + 1 ? " " + cls : ""}">${esc(l) || " "}</span>`).join("") + "</div>";
  }
  // javac error output: make "Main.java:7: error" lines clickable
  function errBox(output) {
    const html = output.split("\n").map((l) => {
      const m = /^Main\.java:(\d+):/.exec(l);
      return m ? `<span class="errline" data-line="${m[1]}">${esc(l)}</span>` : esc(l) + "\n";
    }).join("");
    return `<pre class="err">${html}</pre>`;
  }

  function renderResults(data, labels, mode) {
    const body = $("resultsBody");
    if (data.verdict === "Compilation Error") {
      const out = data.compile.output;
      setMarkers(out);
      body.innerHTML = `<div class="summary"><span class="verdict v-warn">Compilation Error</span></div>
        <p class="muted small">${data.compile.friendly ? "" : "Click an error line to jump to it in the editor."}</p>${errBox(out)}`;
      bindErrLines(body);
      return;
    }
    const results = data.results;
    const failIdx = results.findIndex((r) => r.verdict !== "Accepted" && r.verdict !== "Finished");
    let selected = failIdx >= 0 ? failIdx : 0;
    const title = mode === "submit" ? "" : (labels[0] ? " (Sample 1)" : " (custom input)");
    const totalMs = results.reduce((a, r) => a + r.timeMs, 0);

    const draw = () => {
      let h = `<div class="summary"><span class="verdict ${VCLASS[data.verdict] || ""}">${esc(data.verdict)}${esc(title)}</span>`;
      if (data.passed !== undefined && results.some((r) => r.verdict !== "Finished")) {
        h += `<span><strong>${data.passed} / ${data.total}</strong> test cases passed</span>`;
      }
      h += `<span class="muted small">· total ${totalMs} ms (includes JVM startup)</span></div><div class="chips">`;
      results.forEach((r, i) => {
        h += `<button class="chip${i === selected ? " sel" : ""}" data-i="${i}"><span class="dot" style="background:${VCOLOR[r.verdict] || "var(--muted)"}"></span>Case ${r.index}<span class="ms">${r.timeMs} ms</span></button>`;
      });
      h += "</div>" + detail(results[selected], labels[selected]);
      body.innerHTML = h;
      body.querySelectorAll(".chip").forEach((c) => c.addEventListener("click", () => { selected = +c.dataset.i; draw(); }));
    };
    draw();
  }

  function detail(r, label) {
    const hidden = label && label.hidden;
    const head = `<h4 class="${VCLASS[r.verdict] || ""}">Case ${r.index}: ${esc(r.verdict)} <span class="muted small">· ${r.timeMs} ms</span></h4>`;
    const input = label ? label.input : null;
    switch (r.verdict) {
      case "Accepted":
        return head + (hidden ? '<p class="muted">Hidden test passed.</p>' : `<div class="cols3"><div class="col"><h5>Input</h5>${linesBox(input || "")}</div><div class="col"><h5>Output</h5>${linesBox(r.stdout)}</div></div>`);
      case "Finished":
        return head + `<h5 class="muted">Output</h5><pre class="out">${esc(r.stdout) || "(no output)"}</pre>` + (r.stderr ? `<h5 class="muted">stderr</h5><pre class="out">${esc(r.stderr)}</pre>` : "");
      case "Wrong Answer": {
        if (hidden) return head + '<p class="muted">Hidden test: input and expected output are not shown.</p>';
        return head + `<div class="cols3">
          <div class="col"><h5>Input</h5>${linesBox(input || "")}</div>
          <div class="col"><h5>Expected output</h5>${linesBox(label ? label.expected : "", r.diffLine, "okline")}</div>
          <div class="col"><h5>Your output</h5>${linesBox(r.stdout, r.diffLine, "diff")}</div></div>
          <p class="muted small">First difference on line ${r.diffLine}. Trailing spaces and trailing blank lines are ignored; everything else must match exactly.</p>`
          + (r.stderr ? `<h5 class="muted">stderr</h5><pre class="out">${esc(r.stderr)}</pre>` : "");
      }
      case "Runtime Error":
        return head + `<p>Exit code: <strong>${r.exitCode}</strong>${r.signal ? ` (killed by signal ${r.signal})` : ""}</p>
          <h5 class="muted">stderr (exception / stack trace)</h5><pre class="err">${esc(r.stderr) || "(empty)"}</pre>`
          + (r.stdout && !hidden ? `<h5 class="muted">stdout before the crash</h5><pre class="out">${esc(r.stdout)}</pre>` : "");
      case "Time Limit Exceeded":
        return head + `<p>The program was still running after ${Number($("timeout").value) || 5} s and was killed. Check for infinite loops, or a Scanner waiting for more input than the test provides.</p>`
          + (r.stdout && !hidden ? `<h5 class="muted">stdout so far</h5><pre class="out">${esc(r.stdout)}</pre>` : "");
      default:
        return head;
    }
  }

  function bindErrLines(root) {
    root.querySelectorAll(".errline").forEach((el) => el.addEventListener("click", () => gotoLine(+el.dataset.line)));
  }

  // ------------------------------------------------------------------ wiring
  function wire() {
    $("btnRun").addEventListener("click", () => execute("run"));
    $("btnSubmit").addEventListener("click", () => execute("submit"));
    $("btnReset").addEventListener("click", () => {
      if (!confirm("Replace your code with the starter template?")) return;
      setCode(TEMPLATE); const q = current(); if (q) { q.code = TEMPLATE; saveState(); } clearMarkers();
    });
    $("btnNew").addEventListener("click", newQuestion);
    $("btnParse").addEventListener("click", parseAndLoad);
    $("btnCancelPaste").addEventListener("click", () => {
      editingId = null;
      if (!current() && state.questions.length) { state.currentId = state.questions[state.questions.length - 1].id; setCode(current().code); }
      showView();
    });
    $("btnEditQuestion").addEventListener("click", () => {
      const q = current(); editingId = q.id; $("pasteBox").value = q.text; showView();
    });
    $("btnAddTest").addEventListener("click", () => {
      const q = current(); q.tests.push({ input: "", expected: "", hidden: false });
      saveState(); renderTests(); renderQuestion();
      const areas = $("testList").querySelectorAll(".inp"); areas[areas.length - 1].focus();
    });
    $("titleInput").addEventListener("input", (e) => { const q = current(); q.title = e.target.value; saveState(); renderMenu(); });
    $("btnQuestions").addEventListener("click", (e) => { e.stopPropagation(); renderMenu(); $("questionMenu").classList.toggle("hidden"); });
    document.addEventListener("click", (e) => { if (!e.target.closest(".qpick")) $("questionMenu").classList.add("hidden"); });
    $("useCustom").addEventListener("change", (e) => $("customInput").classList.toggle("hidden", !e.target.checked));
    $("btnToggleResults").addEventListener("click", () => {
      const c = $("resultsPane").classList.toggle("collapsed");
      $("btnToggleResults").textContent = c ? "Expand" : "Collapse";
    });

    // Cmd+Enter = Run, Cmd+Shift+Enter = Submit (Ctrl works too).
    // Registered on window in the CAPTURE phase so it runs before Monaco, which would otherwise
    // use Cmd+Enter for "insert line below".
    window.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault(); e.stopPropagation();
        execute(e.shiftKey ? "submit" : "run");
      }
    }, true);
  }

  // ------------------------------------------------------------------ boot
  async function boot() {
    loadState();
    wire();
    await initEditor();
    if (!state.questions.find((q) => q.id === state.currentId)) {
      state.currentId = state.questions.length ? state.questions[state.questions.length - 1].id : null;
    }
    setCode(current() ? current().code : TEMPLATE);
    showView();
    try {
      const h = await (await fetch("/api/health")).json();
      if (!h.ok) showBanner(h.error);
    } catch (e) { showBanner("Cannot reach the local server."); }
  }
  boot();
})();
