// One-off patch helper: turn the "Choose source" span into a real button so it
// is keyboard reachable and gets the pointer/keyboard affordances for free.
const fs = require("fs");
const path = require("path");

const file = path.join(__dirname, "..", "src", "components", "Toolbar.tsx");
let text = fs.readFileSync(file, "utf8");

const eol = text.includes("\r\n") ? "\r\n" : "\n";

const oldBlock = [
  "            <span",
  '              className="text-[10px] text-violet-300/90 hover:text-violet-200 font-medium cursor-pointer"',
  '              onClick={() => setView("record")}',
  "            >",
  "              Choose source",
  "            </span>",
].join(eol);

const newBlock = [
  "            <button",
  '              type="button"',
  '              className="text-[10px] text-violet-300/90 hover:text-violet-200 font-medium"',
  '              onClick={() => setView("record")}',
  "            >",
  "              Choose source",
  "            </button>",
].join(eol);

if (!text.includes(oldBlock)) {
  console.error("pattern not found");
  process.exit(1);
}
text = text.replace(oldBlock, newBlock);
fs.writeFileSync(file, text);
console.log("patched");