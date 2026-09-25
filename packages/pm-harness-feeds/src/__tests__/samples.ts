import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const samples = new URL("../../../../docs/samples/", import.meta.url);

export const sampleJson = <T>(name: string): T => JSON.parse(readFileSync(new URL(name, samples), "utf8")) as T;

/** Raw recorder captures: one `{src?, recvMs, data}` per line. */
export function sampleFrames(name: string): { src?: string; recvMs: number; data: string }[] {
  let buf = readFileSync(new URL(name, samples));
  if (name.endsWith(".gz")) buf = gunzipSync(buf);
  return buf
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { src?: string; recvMs: number; data: string });
}
