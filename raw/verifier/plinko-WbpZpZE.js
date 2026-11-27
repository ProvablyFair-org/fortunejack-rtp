window.CP = window.CP || { shouldStopExecution: () => false, exitedLoop: () => {} };
const MAX_ROUNDS = 100;
const params = new URLSearchParams(window.location.search);
let HASHES = new Map();
let runId = 0;

function el(id) {
  return document.getElementById(id);
}

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256(text) {
  return toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

async function prepare(id, seeds, from, to) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(seeds.serverSeed), { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
  const map = new Map();
  const jobs = [];
  for (let n = Math.max(1, from); n <= to; n++) {
    jobs.push(crypto.subtle.sign("HMAC", key, enc.encode(seeds.clientSeed + "-" + n)).then((sig) => map.set(n, toHex(sig))));
  }
  await Promise.all(jobs);
  if (id !== runId) return false;
  HASHES = map;
  return true;
}

function hmac(serverSeed, clientSeed, nonce) {
  return HASHES.get(nonce);
}

function nextDouble(serverSeed, clientSeed, nonce) {
  const hash = hmac(serverSeed, clientSeed, nonce);
  return Number("0x" + hash.substring(0, 16)) / Number("0xffffffffffffffff");
}

function nextInt(max, serverSeed, clientSeed, nonce) {
  return parseInt(max * nextDouble(serverSeed, clientSeed, nonce));
}

function readSeeds() {
  return {
    serverSeed: el("serverseed").value.trim(),
    clientSeed: el("clientseed").value.trim(),
    nonce: Math.max(0, parseInt(el("nonce").value, 10) || 0)
  };
}

async function start(seeds, required) {
  const id = ++runId;
  el("output").innerHTML = "";
  el("hash").innerHTML = "";
  if (!seeds.serverSeed || !seeds.clientSeed) {
    el("output").innerHTML = '<p class="note">Enter client seed, server seed and nonce.</p>';
    return 0;
  }
  const missing = (required || []).filter((field) => !el(field).value);
  if (missing.length) {
    missing.forEach((field) => el(field).classList.add("missing"));
    const names = missing.map((field) => document.querySelector('label[for="' + field + '"]').textContent);
    el("output").innerHTML = '<p class="note missing-note">Select ' + names.join(" and ") + " - use the same settings you played with.</p>";
    return 0;
  }
  if (!window.crypto || !window.crypto.subtle) {
    el("output").innerHTML = '<p class="note">This browser does not support Web Crypto. Please open the verifier in an up-to-date browser.</p>';
    return 0;
  }
  const hashed = await sha256(seeds.serverSeed);
  if (id !== runId) return 0;
  el("hash").innerHTML = "Server Seed (Hashed): <code>" + hashed + "</code>";
  return id;
}

function note(text) {
  el("output").insertAdjacentHTML("beforeend", '<p class="note">' + text + "</p>");
}

function init(calculate, extraParams) {
  const map = Object.assign(
    { clientSeed: "clientseed", serverSeed: "serverseed", nonce: "nonce" },
    extraParams || {}
  );
  for (const [param, id] of Object.entries(map)) {
    const v = params.get(param);
    if (v === null || v === "") continue;
    const field = el(id);
    if (field.tagName === "SELECT" && ![...field.options].some((o) => o.value === v && !o.disabled)) continue;
    field.value = v;
  }
  const clear = (e) => {
    runId++;
    if (e && e.target) e.target.classList.remove("missing");
    el("output").innerHTML = "";
    el("hash").innerHTML = "";
  };
  el("calc").addEventListener("click", calculate);
  document.querySelectorAll("input, select").forEach((i) => i.addEventListener("input", clear));
}

const COEFFS = {
  8: { low: [5.5, 1.8, 1.1, 1, 0.5, 1, 1.1, 1.8, 5.5], medium: [14, 3.2, 1.2, 0.6, 0.5, 0.6, 1.2, 3.2, 14], high: [30, 3.9, 1.4, 0.3, 0.2, 0.3, 1.4, 3.9, 30] },
  9: { low: [5.5, 2.2, 1.3, 1.2, 0.6, 0.6, 1.2, 1.3, 2.2, 5.5], medium: [20, 3.6, 1.6, 0.9, 0.5, 0.5, 0.9, 1.6, 3.6, 20], high: [43, 6.4, 2, 0.6, 0.2, 0.2, 0.6, 2, 6.4, 43] },
  10: { low: [8.9, 3.3, 1.3, 1.1, 0.9, 0.6, 0.9, 1.1, 1.3, 3.3, 8.9], medium: [22, 4, 2, 1.4, 0.6, 0.4, 0.6, 1.4, 2, 4, 22], high: [75, 9, 3, 0.9, 0.3, 0.2, 0.3, 0.9, 3, 9, 75] },
  11: { low: [9, 3.1, 1.8, 1.2, 1, 0.7, 0.7, 1, 1.2, 1.8, 3.1, 9], medium: [24, 6.1, 2.9, 1.7, 0.7, 0.5, 0.5, 0.7, 1.7, 2.9, 6.1, 24], high: [120, 13, 5, 1.4, 0.4, 0.2, 0.2, 0.4, 1.4, 5, 13, 120] },
  12: { low: [10, 3.3, 1.6, 1.2, 1.1, 1, 0.5, 1, 1.1, 1.2, 1.6, 3.3, 10], medium: [33, 9.4, 3.7, 2, 1.1, 0.6, 0.3, 0.6, 1.1, 2, 3.7, 9.4, 33], high: [170, 21, 8, 2, 0.7, 0.2, 0.2, 0.2, 0.7, 2, 8, 21, 170] },
  13: { low: [8.1, 4, 2.9, 1.9, 1.1, 0.9, 0.7, 0.7, 0.9, 1.1, 1.9, 2.9, 4, 8.1], medium: [43, 13, 5, 3, 1.3, 0.7, 0.4, 0.4, 0.7, 1.3, 3, 5, 13, 43], high: [255, 37, 10, 4, 1, 0.2, 0.2, 0.2, 0.2, 1, 4, 10, 37, 255] },
  14: { low: [7.1, 4, 1.6, 1.3, 1.2, 1.1, 1, 0.5, 1, 1.1, 1.2, 1.3, 1.6, 4, 7.1], medium: [65, 16, 5, 4, 1.9, 1, 0.5, 0.2, 0.5, 1, 1.9, 4, 5, 16, 65], high: [420, 58, 18, 4.5, 1.9, 0.3, 0.2, 0.2, 0.2, 0.3, 1.9, 4.5, 18, 58, 420] },
  15: { low: [15, 7, 1.9, 1.6, 1.5, 1.1, 1, 0.7, 0.7, 1, 1.1, 1.5, 1.6, 1.9, 7, 15], medium: [88, 18, 9.3, 4.7, 3, 1.3, 0.5, 0.3, 0.3, 0.5, 1.3, 3, 4.7, 9.3, 18, 88], high: [620, 83, 27, 7.3, 3, 0.5, 0.2, 0.2, 0.2, 0.2, 0.5, 3, 7.3, 27, 83, 620] },
  16: { low: [16, 8, 3, 1.8, 1.3, 1.2, 1, 1, 0.5, 1, 1, 1.2, 1.3, 1.8, 3, 8, 16], medium: [110, 35, 7.8, 4.5, 3, 1.5, 1, 0.5, 0.3, 0.5, 1, 1.5, 3, 4.5, 7.8, 35, 110], high: [1000, 130, 25, 8, 4, 2, 0.2, 0.2, 0.2, 0.2, 0.2, 2, 4, 8, 25, 130, 1000] }
};

function dropBall(serverSeed, clientSeed, startNonce, rows) {
  let slot = 0;
  for (let i = 1; i <= rows; i++) slot += nextInt(2, serverSeed, clientSeed, startNonce + i);
  return slot;
}

async function calculate() {
  const s = readSeeds();
  const id = await start(s, ["rows", "risk"]);
  if (!id) return;
  const rows = parseInt(el("rows").value, 10);
  const risk = el("risk").value;
  const coeffs = COEFFS[rows][risk];
  const balls = Math.floor(s.nonce / rows);
  if (!(await prepare(id, s, s.nonce - Math.min(balls, MAX_ROUNDS) * rows + 1, s.nonce))) return;
  let html = "";
  for (let k = 0; k < Math.min(balls, MAX_ROUNDS); k++) {
    const end = s.nonce - k * rows;
    const slot = dropBall(s.serverSeed, s.clientSeed, end - rows, rows);
    html += '<div class="round"><div class="label">Ball ' + (balls - k) + "<small>nonce " + (end - rows + 1) + "-" + end + '</small></div><div class="slots">' +
      coeffs.map((c, i) => '<span class="slot' + (i === slot ? " win" : "") + '">' + c + "x</span>").join("") + "</div></div>";
  }
  el("output").innerHTML = html || '<p class="note">No balls with this seed pair.</p>';
  if (s.nonce % rows !== 0) note("Nonce " + s.nonce + " is not a multiple of " + rows + ". Balls are counted back from nonce " + s.nonce + " - if Rows was changed during this seed pair, set Nonce to the last nonce of the balls played with the selected Rows.");
}

init(calculate, { rows: "rows", risk: "risk" });