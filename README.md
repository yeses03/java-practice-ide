# Java Practice IDE

A LeetCode-style practice tool that runs locally on your Mac. Paste a question, the app extracts the
Input/Output test cases, you write Java in a Monaco editor, and it judges your code with your own JDK.

**Backend choice: Python + Flask.** Python 3 already ships with macOS developer tools, Flask is one
`pip install`, and the whole judge is ~250 lines of readable code. (Node/Express would have worked too,
but would need Node installed first.)

## Folder structure

```
java-practice-ide/
├── app.py              Flask server: compile (javac) + run (java) + judge
├── requirements.txt    Flask
├── static/
│   ├── index.html      page layout
│   ├── style.css       dark theme
│   ├── parser.js       question -> test cases (also runs under Node for tests)
│   └── app.js          UI, localStorage, results rendering
└── tests/              test_parser.js, test_judge.py, sample_question.txt
```

## Mac setup

1. **Check for Java**
   ```
   java -version
   javac -version
   ```
   Both must print a version (17 or newer is fine). If you see "Unable to locate a Java Runtime" or
   `javac` is missing, install a JDK:

2. **Install the JDK with Homebrew** (install Homebrew first from https://brew.sh if `brew` isn't found)
   ```
   brew install openjdk
   sudo ln -sfn $(brew --prefix)/opt/openjdk/libexec/openjdk.jdk /Library/Java/JavaVirtualMachines/openjdk.jdk
   ```
   The symlink makes macOS find it. Open a **new** terminal and re-run the two version commands.
   (The app also looks in Homebrew's folder directly, so it usually works even if you skip the symlink.)

3. **Install the dependencies** (inside the project folder; a virtual environment avoids the
   "externally-managed-environment" pip error on newer Pythons):
   ```
   cd java-practice-ide
   python3 -m venv .venv
   source .venv/bin/activate
   pip install -r requirements.txt
   ```

4. **Start the app**
   ```
   cd java-practice-ide
   source .venv/bin/activate     # only needed in a new terminal
   python app.py
   ```
   Then open **http://127.0.0.1:5050** in your browser. Stop the server with Ctrl+C.

## Using it

- **New question** → paste the whole question → *Parse & load*. Test cases appear in the
  collapsible "Parsed test cases" panel where you can edit, add, delete, and mark tests *hidden*
  (hidden tests don't reveal their input/expected output in the results).
- **Run** (⌘↵): runs sample 1, or your custom stdin if "Run with custom input" is ticked.
- **Submit** (⌘⇧↵): runs every test and shows the verdict, `X / Y passed`, and per-test details.
- **Reset code** restores the starter template. **Questions ▾** lists saved questions (with delete).
- Everything (questions, tests, code) is saved in your browser's localStorage.
- Your class must be `public class Main` with `main`.

Judging ignores trailing spaces on each line and trailing blank lines; otherwise output must match exactly (case-sensitive).

## Supported question formats

Labels like `Input 1 :`, `Output 1:`, `Sample Input 1`, `Expected Output`, `Input:`, with ``` fenced
blocks (the last closing fence may be missing) or plain lines right after the label. Pairs are matched by number.

## Tests

```
node tests/test_parser.js                  # parser (incl. the unclosed last fence)
# with the server running in another terminal:
python tests/test_judge.py                 # judge: AC/WA/CE/RE/TLE, isolation, class-name check
```

## Safety notes

- The server binds to `127.0.0.1` only, rejects non-localhost `Host` headers, and requires JSON requests,
  so other machines and other websites can't make it run code.
- Your Java code runs as **you**, with a timeout and memory/file-size limits but **not** a real sandbox.
  Only run code you wrote or trust.
- First request is slower (JVM warm-up); reported times include JVM startup (~70 ms+).
