const WebSocket = require("ws");
const id = process.argv[2];
const url = `wss://agent-web-einh.vercel.app/ws/backend/api/tasks/${id}/ws`;
console.log("PROD WS ->", url);
const ws = new WebSocket(url, { handshakeTimeout: 30000 });
let n = 0;
ws.on("upgrade", (res) => console.log("HTTP", res.statusCode, "UPGRADE"));
ws.on("open", () => console.log("WS OPEN"));
ws.on("message", (d) => {
  const m = JSON.parse(String(d)); n++;
  console.log(`#${m.seq} event=${m.event?m.event.type:"-"} status=${(m.snapshot||m.task||{}).status||"-"} bytes=${String(d).length}`);
});
ws.on("close", (c,r) => { console.log("WS CLOSE", c, String(r), "frames:", n); process.exit(0); });
ws.on("error", (e) => { console.log("WS ERR", e.message); process.exit(1); });
setTimeout(()=>{ console.log("timeout frames:", n); process.exit(0); }, 40000);
