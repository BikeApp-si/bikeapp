import { connect } from "node:net";

// Every upload is checked for viruses before it is kept (brief › Guardrails). SCAN_PROVIDER picks how:
//   clamd   ClamAV's daemon over TCP (CLAMD_HOST, CLAMD_PORT; docker-compose runs it in dev and Playwright)
//   memory  for Vitest: finds only the EICAR test string, the standard harmless "virus" for testing scanners
// When the scanner can't be reached the upload is refused, never kept unchecked.

export type ScanResult = { clean: true } | { clean: false; found: string };
export class ScanUnavailable extends Error {}

const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
const TIMEOUT_MS = 30_000;
const CHUNK = 64 * 1024;

export async function scan(body: Uint8Array): Promise<ScanResult> {
  const provider = process.env.SCAN_PROVIDER ?? "clamd";
  if (provider === "memory") return Buffer.from(body).includes(EICAR) ? { clean: false, found: "Eicar-Test-Signature" } : { clean: true };
  if (provider !== "clamd") throw new Error(`Scan provider ${provider} isn't set up`);
  return clamd(body, process.env.CLAMD_HOST ?? "localhost", Number(process.env.CLAMD_PORT ?? 3310));
}

// clamd's INSTREAM: "zINSTREAM\0", then chunks each led by its length (4 bytes, big-endian), then a zero
// length. The reply is "stream: OK" or "stream: <name> FOUND".
function clamd(body: Uint8Array, host: string, port: number): Promise<ScanResult> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    let reply = "";
    const fail = (why: string) => {
      socket.destroy();
      reject(new ScanUnavailable(why));
    };
    socket.setTimeout(TIMEOUT_MS, () => fail("clamd timed out"));
    socket.on("error", (e) => fail(e.message));
    socket.on("connect", () => {
      socket.write("zINSTREAM\0");
      for (let at = 0; at < body.length; at += CHUNK) {
        const part = body.subarray(at, at + CHUNK);
        const size = Buffer.alloc(4);
        size.writeUInt32BE(part.length);
        socket.write(size);
        socket.write(part);
      }
      socket.write(Buffer.alloc(4));
    });
    socket.on("data", (d) => (reply += d.toString("utf8")));
    socket.on("end", () => {
      const text = reply.replace(/\0/g, "").trim();
      const found = /^stream: (.+) FOUND$/.exec(text);
      if (text === "stream: OK") resolve({ clean: true });
      else if (found) resolve({ clean: false, found: found[1]! });
      else reject(new ScanUnavailable(`clamd said “${text}”`));
    });
  });
}

// Whether the scanner answers right now (clamd's PING → PONG), for the uptime check; never throws.
export function scannerAnswers(timeoutMs = 5_000): Promise<boolean> {
  if ((process.env.SCAN_PROVIDER ?? "clamd") === "memory") return Promise.resolve(true);
  return new Promise((resolve) => {
    const socket = connect({ host: process.env.CLAMD_HOST ?? "localhost", port: Number(process.env.CLAMD_PORT ?? 3310) });
    let reply = "";
    const done = (ok: boolean) => (socket.destroy(), resolve(ok));
    socket.setTimeout(timeoutMs, () => done(false));
    socket.on("error", () => done(false));
    socket.on("connect", () => socket.write("zPING\0"));
    socket.on("data", (d) => (reply += d.toString("utf8")));
    socket.on("end", () => done(reply.replace(/\0/g, "").trim() === "PONG"));
  });
}
