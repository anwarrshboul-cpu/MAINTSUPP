import { chromium } from "playwright";
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args:["--no-sandbox"] });
const p = await (await b.newContext({viewport:{width:1500,height:1050}})).newPage();
await p.goto("http://localhost:5173/dashboard/jobs", { waitUntil:"networkidle" });
await p.waitForTimeout(6000);
const btns = await p.locator("button").allTextContents();
console.log(JSON.stringify([...new Set(btns.map(s=>s.trim()).filter(Boolean))].slice(0,30)));
await b.close();
