import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { loadSet, type AppSet } from "@/server/kernel/gallery/format";

// The app sets the gallery shows (G2): folders in GALLERY_DIR (gallery/ in the repo; tests point it at their own)
// whose set.json says listed, which it does only once someone from the industry has reviewed the set. With none,
// the gallery isn't anywhere: the public page is a 404 and the app's ways in are hidden.

export const galleryDir = () => path.resolve(process.cwd(), process.env.GALLERY_DIR || "gallery");

export function listedSets(dir = galleryDir()): AppSet[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(path.join(dir, d.name, "set.json")))
    .map((d) => loadSet(path.join(dir, d.name)))
    .filter((s) => s.listed)
    .sort((a, b) => a.name.localeCompare(b.name));
}

// One listed set by its folder's name; undefined for anything else, so an unlisted set reads as no set at all.
export function listedSet(key: string, dir = galleryDir()): AppSet | undefined {
  if (!/^[a-z0-9-]{1,60}$/.test(key)) return undefined;
  return listedSets(dir).find((s) => s.key === key);
}
