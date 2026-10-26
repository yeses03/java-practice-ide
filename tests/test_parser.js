// Run with:  node tests/test_parser.js
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { parseQuestion, guessTitle } = require("../static/parser.js");

const sample = fs.readFileSync(path.join(__dirname, "sample_question.txt"), "utf8");
const r = parseQuestion(sample);
assert.deepStrictEqual(r.tests, [
  { input: "12 15", expected: "Winter" },
  { input: "4 21", expected: "Spring" },
  { input: "6 5", expected: "Summer" },
  { input: "10 18", expected: "Fall" },
  { input: "13 20", expected: "Invalid month" }, // last fence is unclosed
]);
assert.deepStrictEqual(r.warnings, []);
assert(!r.statement.includes("Input 1"));
assert(r.statement.includes("Input format :"));
console.log("title:", guessTitle(r.statement));

// Variants: no fences, "Sample Input", "Expected Output", inline "Input:", CRLF
const v = parseQuestion("Some problem\r\nSample Input 1\r\n3 4\r\nExpected Output 1\r\n7\r\n\r\nSample Input 2\r\n10 5\r\nExpected Output 2\r\n15\r\n");
assert.deepStrictEqual(v.tests, [{ input: "3 4", expected: "7" }, { input: "10 5", expected: "15" }]);

const u = parseQuestion("Input:\n```\n1\n2\n```\nExpected Output:\n```\n3\n```\nInput:\n5\nOutput:\n5\n");
assert.deepStrictEqual(u.tests, [{ input: "1\n2", expected: "3" }, { input: "5", expected: "5" }]);

const inl = parseQuestion("Sample test cases:\nInput 1: 8 9\nOutput 1: 17");
assert.deepStrictEqual(inl.tests, [{ input: "8 9", expected: "17" }]);

// Out-of-order and missing pair
const m = parseQuestion("Sample test cases\nOutput 2\n```\nb\n```\nInput 2\n```\nB\n```\nInput 1\n```\nA\n```\n");
assert.strictEqual(m.tests.length, 2);
assert.deepStrictEqual(m.tests[1], { input: "B", expected: "b" });
assert(m.warnings.some((w) => /Input 1 has no matching Output 1/.test(w)));

// JDBC question: tests plus auto-generated setup SQL
const jd = parseQuestion(fs.readFileSync(path.join(__dirname, "sample_jdbc_question.txt"), "utf8"));
assert.strictEqual(jd.tests.length, 2);
assert.strictEqual(jd.tests[1].expected, "No student found with ID 11");
assert.strictEqual(jd.setupSql, [
  "DROP TABLE IF EXISTS students;",
  "CREATE TABLE students (id INT PRIMARY KEY, name VARCHAR(100), age INT, grade CHAR(1));",
  "INSERT INTO students VALUES",
  "  (1, 'John Doe', 20, 'A'),",
  "  (2, 'Jane Smith', 22, 'B'),",
  "  (3, 'Sam Brown', 21, 'A'),",
  "  (4, 'Lucy Green', 23, 'C'),",
  "  (5, 'Michael Blue', 24, 'B');",
].join("\n"));
assert.strictEqual(r.setupSql, ""); // non-JDBC questions get none

console.log("all parser tests passed");
