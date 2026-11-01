// Write dist/latest-mac.json and its Ed25519 signature for the zips of one release.
// usage: bun scripts/update-manifest.ts <version> <zip>...
// The private key comes from SKM_UPDATE_SIGN_KEY (PEM text, e.g. a GitHub Actions secret) or SKM_UPDATE_SIGN_KEY_FILE.
// The app only installs a release whose manifest verifies against package.json "updatePublicKey".
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import pkg from "../package.json";
import { MANIFEST, MANIFEST_SIG, manifestText } from "../src/main/update-core";

const [version, ...zips] = process.argv.slice(2);
if (version === undefined || zips.length === 0) {
  console.error("usage: bun scripts/update-manifest.ts <version> <zip>...");
  process.exit(2);
}
const pem = process.env["SKM_UPDATE_SIGN_KEY"] ?? (process.env["SKM_UPDATE_SIGN_KEY_FILE"] ? readFileSync(process.env["SKM_UPDATE_SIGN_KEY_FILE"], "utf8") : undefined);
if (pem === undefined || pem.trim() === "") {
  console.error("no signing key: set SKM_UPDATE_SIGN_KEY or SKM_UPDATE_SIGN_KEY_FILE");
  process.exit(1);
}
const key = createPrivateKey(pem);
const files = zips.map((z) => ({ name: basename(z), sha512: createHash("sha512").update(readFileSync(z)).digest("base64"), size: statSync(z).size }));
const text = manifestText(version, files);
const sig = sign(null, Buffer.from(text), key).toString("base64");
// refuse to publish a manifest the shipped app could not verify
const pub = (pkg as { updatePublicKey?: string }).updatePublicKey;
if (pub === undefined || !verify(null, Buffer.from(text), createPublicKey(pub), Buffer.from(sig, "base64"))) {
  console.error("the signing key does not match package.json updatePublicKey");
  process.exit(1);
}
const out = join(import.meta.dir, "..", "dist");
writeFileSync(join(out, MANIFEST), text);
writeFileSync(join(out, MANIFEST_SIG), `${sig}\n`);
console.log(`wrote dist/${MANIFEST} and dist/${MANIFEST_SIG} for ${files.map((f) => f.name).join(", ")}`);
