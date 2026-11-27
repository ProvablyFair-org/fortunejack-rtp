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

const NONCES_PER_ROUND = 40;

function drawRound(serverSeed, clientSeed, startNonce) {
  const balls = [];
  for (let i = 1; i <= 40; i++) balls.push(i);
  let nonce = startNonce;
  for (let i = 0; i < balls.length - 1; i++) {
    nonce++;
    const j = i + nextInt(balls.length - i, serverSeed, clientSeed, nonce);
    [balls[i], balls[j]] = [balls[j], balls[i]];
  }
  return balls.slice(0, 10).sort((a, b) => a - b);
}

async function calculate() {
  const s = readSeeds();
  const id = await start(s);
  if (!id) return;
  const picks = el("userselected").value.split(",").map((x) => parseInt(x.trim(), 10)).filter((x) => x >= 1 && x <= 40);
  const rounds = Math.floor(s.nonce / NONCES_PER_ROUND);
  const first = Math.max(1, rounds - MAX_ROUNDS + 1);
  if (!(await prepare(id, s, (first - 1) * NONCES_PER_ROUND + 1, rounds * NONCES_PER_ROUND))) return;
  let html = "";
  for (let r = rounds; r >= Math.max(1, rounds - MAX_ROUNDS + 1); r--) {
    const drawn = drawRound(s.serverSeed, s.clientSeed, (r - 1) * NONCES_PER_ROUND);
    const hits = drawn.filter((b) => picks.includes(b)).length;
    html += '<div class="round"><div class="label">Round ' + r + "<small>nonce " + ((r - 1) * NONCES_PER_ROUND + 1) + "-" + r * NONCES_PER_ROUND + "</small></div><div class=\"balls\">" +
      drawn.map((b) => '<span class="ball' + (picks.includes(b) ? " hit" : "") + '">' + b + "</span>").join("") +
      "</div>" + (picks.length ? '<div class="label">' + hits + " hits</div>" : "") + "</div>";
  }
  el("output").innerHTML = html || '<p class="note">No rounds with this seed pair.</p>';
  if (s.nonce % NONCES_PER_ROUND !== 0) note("Nonce " + s.nonce + " is not a multiple of 40 - the last " + (s.nonce % NONCES_PER_ROUND) + " nonces are not a full round.");
}

init(calculate, { userselected: "userselected" });