"""
Java Practice IDE - local backend.

Serves the single-page frontend from ./static and exposes a tiny JSON API
that compiles and runs Java code with the JDK installed on this Mac.

    GET  /api/health   -> is a JDK available? which version?
    POST /api/judge    -> compile once, run each test in its own fresh directory

Run:  python app.py      (then open http://127.0.0.1:5050)
"""
import os
import re
import resource
import shutil
import signal
import subprocess
import tempfile
import time

from flask import Flask, jsonify, request, send_from_directory

HOST = "127.0.0.1"  # localhost only: nobody else on your Wi-Fi can reach this server
PORT = 5050  # not 5000, because macOS AirPlay Receiver already uses it

DEFAULT_TIMEOUT = 5.0  # seconds per test case
MAX_TIMEOUT = 20.0
COMPILE_TIMEOUT = 30.0
MAX_OUTPUT_BYTES = 200_000  # we only keep/show this much of stdout/stderr
MAX_FILE_BYTES = 20 * 1024 * 1024  # a runaway program can't write more than this
MAX_TESTS = 100
MAX_CODE_CHARS = 200_000

app = Flask(__name__, static_folder="static", static_url_path="")


# --------------------------------------------------------------------------
# Locating the JDK
# --------------------------------------------------------------------------
def _works(tool_dir, tool):
    """True if `<tool_dir>/<tool> -version` runs. (/usr/bin/java on a Mac without
    a JDK is a stub that fails, so existence of the file isn't enough.)"""
    path = os.path.join(tool_dir, tool) if tool_dir else tool
    try:
        r = subprocess.run([path, "-version"], capture_output=True, text=True, timeout=15)
        return r.returncode == 0, (r.stderr or r.stdout).strip()
    except (OSError, subprocess.TimeoutExpired):
        return False, ""


def find_jdk():
    """Return (javac_path, java_path, version_text) or None."""
    candidates = []
    if os.environ.get("JAVA_HOME"):
        candidates.append(os.path.join(os.environ["JAVA_HOME"], "bin"))
    on_path = shutil.which("javac")
    if on_path:
        candidates.append(os.path.dirname(on_path))
    # Homebrew locations (Apple Silicon, then Intel), even if the symlink step was skipped
    candidates += [
        "/opt/homebrew/opt/openjdk/bin",
        "/usr/local/opt/openjdk/bin",
        "/opt/homebrew/opt/openjdk@21/bin",
        "/opt/homebrew/opt/openjdk@17/bin",
    ]
    try:
        home = subprocess.run(["/usr/libexec/java_home"], capture_output=True, text=True, timeout=10)
        if home.returncode == 0 and home.stdout.strip():
            candidates.append(os.path.join(home.stdout.strip(), "bin"))
    except (OSError, subprocess.TimeoutExpired):
        pass

    for d in candidates:
        if not (os.path.isfile(os.path.join(d, "javac")) and os.path.isfile(os.path.join(d, "java"))):
            continue
        ok_c, _ = _works(d, "javac")
        ok_j, ver = _works(d, "java")
        if ok_c and ok_j:
            return os.path.join(d, "javac"), os.path.join(d, "java"), ver.splitlines()[0]
    return None


JDK = find_jdk()


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------
def strip_comments_and_strings(src):
    """Blank out comments and string/char literals so our regex checks on the
    source aren't fooled by e.g. a comment saying 'public class Foo'."""
    pattern = re.compile(
        r'//[^\n]*|/\*.*?\*/|"""(?:\\.|[^\\])*?"""|"(?:\\.|[^"\\\n])*"|\'(?:\\.|[^\'\\\n])*\'',
        re.S,
    )
    return pattern.sub(lambda m: " " * len(m.group(0)), src)


def check_class_name(code):
    """Return a friendly error string if the code can't work as Main.java, else None.
    (Without this, javac says something confusing like 'class Foo is public,
    should be declared in a file named Foo.java'.)"""
    clean = strip_comments_and_strings(code)
    public_classes = re.findall(r"\bpublic\s+(?:final\s+|abstract\s+)*(?:class|interface|enum|record)\s+(\w+)", clean)
    has_main_class = re.search(r"\b(?:class|record|enum)\s+Main\b", clean)
    wrong = [c for c in public_classes if c != "Main"]
    if wrong:
        return (
            f"Your public class is named '{wrong[0]}', but it must be named 'Main'.\n"
            f"Change  'public class {wrong[0]}'  to  'public class Main'.\n"
            "(The judge saves your code as Main.java and runs 'java Main'.)"
        )
    if not has_main_class:
        return (
            "No class named 'Main' found.\n"
            "Your code must contain:\n\n"
            "    public class Main {\n"
            "        public static void main(String[] args) { ... }\n"
            "    }"
        )
    if not re.search(r"\bvoid\s+main\s*\(", clean):
        return "No main method found. Add:  public static void main(String[] args) { ... }"
    return None


def normalize_output(text):
    """Judge rule: ignore trailing whitespace on each line and trailing blank lines.
    Everything else (case, inner spaces, blank lines in the middle) must match."""
    lines = [ln.rstrip() for ln in text.replace("\r\n", "\n").replace("\r", "\n").split("\n")]
    while lines and lines[-1] == "":
        lines.pop()
    return lines


def first_diff_line(expected, actual):
    """1-based index of the first differing line, or None if equal."""
    for i in range(max(len(expected), len(actual))):
        e = expected[i] if i < len(expected) else None
        a = actual[i] if i < len(actual) else None
        if e != a:
            return i + 1
    return None


def read_capped(path):
    try:
        with open(path, "rb") as f:
            data = f.read(MAX_OUTPUT_BYTES + 1)
    except OSError:
        return "", False
    truncated = len(data) > MAX_OUTPUT_BYTES
    return data[:MAX_OUTPUT_BYTES].decode("utf-8", errors="replace"), truncated


def _limit_child():
    # Runs in the child just before exec: cap the size of any file it writes
    # (including our stdout/stderr capture files) so `while(true) print(...)` can't fill the disk.
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_FILE_BYTES, MAX_FILE_BYTES))


def run_one_test(java_path, class_dir, io_dir, index, stdin_text, timeout):
    """Run `java Main` once.

    SANDBOXING: every test gets its OWN fresh working directory, so files the program
    creates (e.g. birthdays.ser) can't leak into the next test. The compiled classes
    live elsewhere (class_dir) and are put on the classpath instead of being the cwd.
    """
    cwd = os.path.join(io_dir, f"cwd{index}")
    os.makedirs(cwd)
    in_path = os.path.join(io_dir, f"in{index}.txt")
    out_path = os.path.join(io_dir, f"out{index}.txt")
    err_path = os.path.join(io_dir, f"err{index}.txt")

    if stdin_text and not stdin_text.endswith("\n"):
        stdin_text += "\n"
    with open(in_path, "w", encoding="utf-8") as f:
        f.write(stdin_text)

    # stdout/stderr go to files (not pipes): simple, and never blocks or eats RAM.
    timed_out = False
    start = time.perf_counter()
    with open(in_path, "rb") as fin, open(out_path, "wb") as fout, open(err_path, "wb") as ferr:
        proc = subprocess.Popen(
            [java_path, "-Xmx256m", "-Xss16m", "-XX:+UseSerialGC", "-XX:TieredStopAtLevel=1",
             "-cp", class_dir, "Main"],
            cwd=cwd,
            stdin=fin,
            stdout=fout,
            stderr=ferr,
            start_new_session=True,  # own process group, so we can kill java and anything it spawned
            preexec_fn=_limit_child,
        )
        try:
            # TIMEOUT: wait up to `timeout` seconds; if still running, kill the whole group.
            proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            proc.wait()
    elapsed_ms = int((time.perf_counter() - start) * 1000)

    stdout, out_trunc = read_capped(out_path)
    stderr, err_trunc = read_capped(err_path)
    return {
        "exitCode": proc.returncode,
        "timedOut": timed_out,
        "timeMs": elapsed_ms,
        "stdout": stdout + ("\n...[output truncated]" if out_trunc else ""),
        "stderr": stderr + ("\n...[stderr truncated]" if err_trunc else ""),
    }


def judge_one(java_path, class_dir, io_dir, index, test, timeout):
    res = run_one_test(java_path, class_dir, io_dir, index, test.get("input", ""), timeout)
    result = {
        "index": index + 1,
        "timeMs": res["timeMs"],
        "exitCode": res["exitCode"],
        "stdout": res["stdout"],
        "stderr": res["stderr"],
    }
    expected = test.get("expected")
    if res["timedOut"]:
        result["verdict"] = "Time Limit Exceeded"
    elif res["exitCode"] != 0:
        result["verdict"] = "Runtime Error"
        if res["exitCode"] < 0:
            result["signal"] = -res["exitCode"]
    elif expected is None:
        result["verdict"] = "Finished"  # custom-input run: nothing to compare against
    else:
        exp_lines = normalize_output(expected)
        act_lines = normalize_output(res["stdout"])
        diff = first_diff_line(exp_lines, act_lines)
        if diff is None:
            result["verdict"] = "Accepted"
        else:
            result["verdict"] = "Wrong Answer"
            result["diffLine"] = diff
    return result


# --------------------------------------------------------------------------
# Routes
# --------------------------------------------------------------------------
@app.before_request
def only_localhost_host_header():
    # Defence against "DNS rebinding": a malicious website making your browser talk to
    # this server under a different hostname. We only answer to localhost names.
    host = (request.host or "").split(":")[0]
    if host not in ("127.0.0.1", "localhost"):
        return jsonify(error="forbidden host"), 403


@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.get("/api/health")
def health():
    if JDK:
        return jsonify(ok=True, version=JDK[2])
    return jsonify(ok=False, error="No working JDK (javac + java) found. See README for setup.")


@app.post("/api/judge")
def judge():
    # get_json() (without force=True) only accepts Content-Type: application/json.
    # A random web page can't send that cross-origin without a CORS preflight, which
    # we never approve - so other sites can't make your Mac run code through us.
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return jsonify(error="Expected a JSON body"), 400
    if not JDK:
        return jsonify(error="No working JDK found on this machine. See README for setup."), 500
    javac_path, java_path, _ = JDK

    code = data.get("code")
    tests = data.get("tests")
    if not isinstance(code, str) or not code.strip():
        return jsonify(error="No code to run."), 400
    if len(code) > MAX_CODE_CHARS:
        return jsonify(error="Code is too large."), 400
    if not isinstance(tests, list) or not tests or len(tests) > MAX_TESTS:
        return jsonify(error=f"Provide between 1 and {MAX_TESTS} test cases."), 400
    for t in tests:
        if not isinstance(t, dict) or not isinstance(t.get("input", ""), str) \
                or not (t.get("expected") is None or isinstance(t.get("expected"), str)):
            return jsonify(error="Malformed test case."), 400
    try:
        timeout = min(max(float(data.get("timeout", DEFAULT_TIMEOUT)), 0.5), MAX_TIMEOUT)
    except (TypeError, ValueError):
        timeout = DEFAULT_TIMEOUT

    name_error = check_class_name(code)
    if name_error:
        return jsonify(compile={"ok": False, "output": name_error, "friendly": True}, verdict="Compilation Error", results=[])

    # One temp dir per submission; always removed in `finally`.
    root = tempfile.mkdtemp(prefix="javaide-")
    try:
        build_dir = os.path.join(root, "build")
        io_dir = os.path.join(root, "io")
        os.makedirs(build_dir)
        os.makedirs(io_dir)
        with open(os.path.join(build_dir, "Main.java"), "w", encoding="utf-8") as f:
            f.write(code)

        try:
            comp = subprocess.run(
                [javac_path, "-encoding", "UTF-8", "-Xlint:-options", "Main.java"],
                cwd=build_dir, capture_output=True, text=True, timeout=COMPILE_TIMEOUT,
            )
        except subprocess.TimeoutExpired:
            return jsonify(compile={"ok": False, "output": "javac took too long and was stopped."},
                           verdict="Compilation Error", results=[])
        if comp.returncode != 0:
            return jsonify(compile={"ok": False, "output": (comp.stderr or comp.stdout).strip()},
                           verdict="Compilation Error", results=[])

        # Compile ONCE, then run the same classes for every test (each in a fresh cwd).
        results = [judge_one(java_path, build_dir, io_dir, i, t, timeout) for i, t in enumerate(tests)]
    finally:
        shutil.rmtree(root, ignore_errors=True)

    # Overall verdict = the first non-passing test's verdict (like LeetCode).
    good = ("Accepted", "Finished")
    overall = next((r["verdict"] for r in results if r["verdict"] not in good), None)
    if overall is None:
        overall = "Accepted" if all(r["verdict"] == "Accepted" for r in results) else "Finished"
    passed = sum(1 for r in results if r["verdict"] == "Accepted")
    return jsonify(compile={"ok": True}, verdict=overall, passed=passed, total=len(results), results=results)


if __name__ == "__main__":
    print(f"JDK: {JDK[2] if JDK else 'NOT FOUND - see README'}")
    print(f"Open http://{HOST}:{PORT}")
    app.run(host=HOST, port=PORT, debug=False, threaded=True)
