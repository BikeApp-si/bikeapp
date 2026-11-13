import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scan, ScanUnavailable } from "./scan";

// The real scanner: ClamAV from docker-compose (pnpm db:up starts it with the other services). A clean
// file passes, the EICAR test file is found, and no scanner at the address means no upload.

const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
let before: string | undefined;
beforeAll(() => {
  before = process.env.SCAN_PROVIDER;
  process.env.SCAN_PROVIDER = "clamd";
});
afterAll(() => {
  process.env.SCAN_PROVIDER = before;
  delete process.env.CLAMD_PORT;
});

describe("ClamAV", () => {
  it("passes a clean file and finds the EICAR test file, in small and chunked streams", async () => {
    expect(await scan(new TextEncoder().encode("Name,Amount\nTaxi,42.50\n"))).toEqual({ clean: true });
    expect(await scan(new TextEncoder().encode(EICAR))).toEqual({ clean: false, found: expect.stringMatching(/Eicar/i) });
    const big = new Uint8Array(200 * 1024).fill(0x41);
    expect(await scan(big)).toEqual({ clean: true });
  }, 30_000);

  it("refuses rather than letting a file through when no scanner answers", async () => {
    process.env.CLAMD_PORT = "3999";
    await expect(scan(new TextEncoder().encode("hello"))).rejects.toBeInstanceOf(ScanUnavailable);
    delete process.env.CLAMD_PORT;
  });
});
