"""End-to-end checks against a running server:  python tests/test_judge.py"""
import json, urllib.request

URL = "http://127.0.0.1:5050/api/judge"
TESTS = [("12 15", "Winter"), ("4 21", "Spring"), ("6 5", "Summer"), ("10 18", "Fall"), ("13 20", "Invalid month")]
T = [{"input": i, "expected": e} for i, e in TESTS]

GOOD = '''import java.io.*; import java.util.*;
class Birthday implements Serializable { int month, day; Birthday(int m, int d){month=m;day=d;} }
public class Main { public static void main(String[] a) throws Exception {
  Scanner sc = new Scanner(System.in); int m = sc.nextInt(), d = sc.nextInt();
  try (ObjectOutputStream o = new ObjectOutputStream(new FileOutputStream("birthdays.ser"))) { o.writeObject(new Birthday(m,d)); }
  Birthday b; try (ObjectInputStream i = new ObjectInputStream(new FileInputStream("birthdays.ser"))) { b = (Birthday) i.readObject(); }
  String s = b.month==12||b.month<=2&&b.month>=1 ? "Winter" : b.month>=3&&b.month<=5 ? "Spring" : b.month>=6&&b.month<=8 ? "Summer" : b.month>=9&&b.month<=11 ? "Fall" : "Invalid month";
  System.out.print(s); } }'''

def post(code, tests=T, **kw):
    req = urllib.request.Request(URL, json.dumps({"code": code, "tests": tests, **kw}).encode(), {"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req))

def verdicts(r): return [x["verdict"] for x in r["results"]]

r = post(GOOD); assert r["verdict"] == "Accepted" and r["passed"] == 5, r; print("AC ok", [x["timeMs"] for x in r["results"]])
r = post(GOOD.replace('"Fall"', '"Autumn"')); assert r["verdict"] == "Wrong Answer" and verdicts(r).count("Wrong Answer") == 1 and r["passed"] == 4, r
assert r["results"][3]["diffLine"] == 1; print("WA ok")
r = post(GOOD.replace("System.out.print(s);", "System.out.print(s)")); assert r["verdict"] == "Compilation Error" and "Main.java:" in r["compile"]["output"]; print("CE ok")
r = post(GOOD.replace("public class Main", "public class Solution")); assert r["verdict"] == "Compilation Error" and "must be named 'Main'" in r["compile"]["output"]; print("class name ok")
r = post('public class Main { public static void main(String[] a){ int[] x = new int[1]; x[2]=1; } }'); assert r["results"][0]["verdict"] == "Runtime Error" and "ArrayIndexOutOfBounds" in r["results"][0]["stderr"] and r["results"][0]["exitCode"] == 1; print("RE ok")
r = post('public class Main { public static void main(String[] a){ while(true){} } }', T[:1], timeout=1); assert r["verdict"] == "Time Limit Exceeded" and r["results"][0]["timeMs"] < 3000; print("TLE ok", r["results"][0]["timeMs"])
# isolation: test 1 creates a file, test 2 must not see it
iso = 'import java.io.*; public class Main { public static void main(String[] a) throws Exception { File f = new File("leak.txt"); System.out.println(f.exists()); f.createNewFile(); } }'
r = post(iso, [{"input": "", "expected": "false"}, {"input": "", "expected": "false"}]); assert r["verdict"] == "Accepted", r; print("isolation ok")
# whitespace rules + missing trailing newline
r = post('public class Main { public static void main(String[] a){ System.out.println("hi   "); System.out.println(); } }', [{"input": "", "expected": "hi"}]); assert r["verdict"] == "Accepted"
r = post('public class Main { public static void main(String[] a){ System.out.print("Hi"); } }', [{"input": "", "expected": "hi"}]); assert r["verdict"] == "Wrong Answer"; print("compare ok")
# custom run (no expected)
r = post(GOOD, [{"input": "1 1", "expected": None}]); assert r["verdict"] == "Finished" and r["results"][0]["stdout"] == "Winter"; print("custom ok")
print("ALL OK")
