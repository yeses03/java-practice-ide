/*
 * Question parser. Pure functions, no DOM, so it also runs under Node for testing.
 *
 * parseQuestion(text) -> { statement, tests: [{input, expected}], warnings: [] }
 *
 * Strategy (lenient, because pasted text is messy):
 *  1. Find the "Sample test cases" heading. Everything before it is the statement.
 *     (If there is no such heading we scan the whole text.)
 *  2. Walk the remaining lines and find LABEL lines such as
 *       "Input 1 :"  "Output 3:"  "Sample Input 2"  "Expected Output"  "Input:"
 *     Note "Input format :" must NOT count as a label, so a label may only be followed
 *     by an optional number and an optional colon.
 *  3. The lines between one label and the next label are that label's body. A body is
 *     either a ``` fenced block (closing fence optional!) or plain lines up to the first blank line.
 *  4. Inputs and outputs are matched by their number (Input 3 <-> Output 3).
 *     Unnumbered labels are numbered in the order they appear.
 */
(function (root) {
  const SAMPLE_HEADING = /^[\s#>*_`]*sample\s+test\s*cases?\s*[:.]?[\s*_`]*$/i;
  const FENCE = /^\s*```/;
  const LABEL = /^(?:sample\s+|expected\s+|example\s+)?(input|output)\s*(?:#?\s*(\d+))?\s*(:?)\s*(.*)$/i;

  // Returns {kind:'input'|'output', num:number|null, inline:string} or null
  function matchLabel(line) {
    // Drop markdown decoration like "### ", "**", "> " from the start/end before matching.
    const cleaned = line.replace(/^[\s#>*_]+/, "").replace(/[\s*_]+$/, "");
    const m = LABEL.exec(cleaned);
    if (!m) return null;
    const rest = m[4].trim();
    // "Input format :" -> rest is "format :" with no colon right after "Input": not a label.
    if (rest && !m[3]) return null;
    return { kind: m[1].toLowerCase(), num: m[2] ? parseInt(m[2], 10) : null, inline: rest };
  }

  // Turn the lines of one label's body into a string.
  function extractBody(lines) {
    let i = 0;
    while (i < lines.length && lines[i].trim() === "") i++; // skip blank lines after the label
    const body = [];
    if (i < lines.length && FENCE.test(lines[i])) {
      i++; // opening fence
      // Read until the closing fence. If the user's paste lost it, we simply run to the
      // end of this body (the next label or end of text), which is what we want.
      for (; i < lines.length; i++) {
        if (FENCE.test(lines[i])) break;
        body.push(lines[i]);
      }
    } else {
      // Unfenced: take lines until the first blank line after we started.
      for (; i < lines.length; i++) {
        if (lines[i].trim() === "") break;
        body.push(lines[i]);
      }
    }
    while (body.length && body[body.length - 1].trim() === "") body.pop();
    return body.map((l) => l.replace(/\s+$/, "")).join("\n");
  }

  function parseQuestion(text) {
    const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
    const warnings = [];

    let samplesAt = lines.findIndex((l) => SAMPLE_HEADING.test(l));
    let firstLabel = -1;
    const scanFrom = samplesAt >= 0 ? samplesAt + 1 : 0;

    // Collect label positions.
    const labels = [];
    for (let i = scanFrom; i < lines.length; i++) {
      const lab = matchLabel(lines[i]);
      if (lab) {
        labels.push({ ...lab, line: i });
        if (firstLabel < 0) firstLabel = i;
      }
    }

    const statementEnd = samplesAt >= 0 ? samplesAt : firstLabel >= 0 ? firstLabel : lines.length;
    const statement = lines.slice(0, statementEnd).join("\n").trim();

    const inputs = new Map();
    const outputs = new Map();
    const counters = { input: 0, output: 0 };
    labels.forEach((lab, idx) => {
      const end = idx + 1 < labels.length ? labels[idx + 1].line : lines.length;
      let bodyLines = lines.slice(lab.line + 1, end);
      if (lab.inline) bodyLines = [lab.inline.replace(/^`+|`+$/g, ""), ...bodyLines];
      const body = extractBody(bodyLines);
      const num = lab.num != null ? lab.num : ++counters[lab.kind];
      if (lab.num != null) counters[lab.kind] = lab.num;
      const map = lab.kind === "input" ? inputs : outputs;
      if (map.has(num)) warnings.push(`Duplicate ${lab.kind} ${num} ignored.`);
      else map.set(num, body);
    });

    const nums = [...new Set([...inputs.keys(), ...outputs.keys()])].sort((a, b) => a - b);
    const tests = nums.map((n) => {
      if (!inputs.has(n)) warnings.push(`Output ${n} has no matching Input ${n}.`);
      if (!outputs.has(n)) warnings.push(`Input ${n} has no matching Output ${n}.`);
      return { input: inputs.get(n) ?? "", expected: outputs.get(n) ?? "" };
    });

    if (!tests.length) warnings.push("No test cases found. Add them manually below.");
    return { statement, tests, warnings, setupSql: guessSetupSql(statement) };
  }

  /*
   * Best-effort setup SQL for JDBC questions: needs a table name, a "col → TYPE" column list and
   * "(1, 'John Doe', 20, 'A')" rows in the statement. Returns "" when anything is missing or
   * doesn't line up (the user can then type the SQL by hand).
   */
  function guessSetupSql(statement) {
    const text = String(statement).replace(/[\u2018\u2019]/g, "'");
    const lines = text.split("\n");
    const tableM = /columns\s*\(\s*`?(\w+)`?\s*\)/i.exec(text) ||
      /\b(?!the\b|a\b|an\b|each\b|database\b|following\b)(\w+)\s+table\b/i.exec(text);
    if (!tableM) return "";
    const table = tableM[1];

    const TYPE = /^(?:tiny|small|big)?int(?:eger)?|^(?:var)?char\s*\(\d+\)|^decimal\s*\([\d\s,]+\)|^double|^float|^date(?:time)?|^text|^boolean/i;
    const cols = [];
    for (const line of lines) {
      const m = /^\s*[-*•]?\s*`?(\w+)`?\s*(?:→|->|:|-)\s*(.+)$/.exec(line);
      if (!m) continue;
      const t = TYPE.exec(m[2].trim());
      if (!t) continue;
      const type = t[0].replace(/^integer$/i, "INT").toUpperCase();
      cols.push(`${m[1]} ${type}${/primary\s*key/i.test(m[2]) ? " PRIMARY KEY" : ""}`);
    }

    const rows = lines.map((l) => l.trim().replace(/^[-*•]\s*/, "")).filter((l) => /^\(.+\)[,;]?$/.test(l));
    if (!cols.length || !rows.length) return "";
    // Tuple lines must have as many top-level values as there are columns.
    const arity = (r) => r.slice(1, r.lastIndexOf(")")).match(/'(?:[^']|'')*'|[^,]+/g).length;
    if (rows.some((r) => arity(r) !== cols.length)) return "";

    return [
      `DROP TABLE IF EXISTS ${table};`,
      `CREATE TABLE ${table} (${cols.join(", ")});`,
      `INSERT INTO ${table} VALUES\n${rows.map((r) => "  " + r.replace(/[,;]$/, "")).join(",\n")};`,
    ].join("\n");
  }

  // Pull a short title out of the statement for the history list.
  function guessTitle(statement) {
    const lines = statement.split("\n").map((l) => l.trim()).filter(Boolean);
    const stmtIdx = lines.findIndex((l) => /^problem statement\s*:?$/i.test(l));
    const start = stmtIdx >= 0 ? stmtIdx + 1 : lines.findIndex((l) => !/question\s*$/i.test(l));
    const first = (lines[start >= 0 ? start : 0] || "Untitled question").replace(/\s+/g, " ");
    return first.length > 60 ? first.slice(0, 57) + "..." : first;
  }

  const api = { parseQuestion, guessTitle, guessSetupSql };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.QuestionParser = api;
})(typeof window !== "undefined" ? window : globalThis);
