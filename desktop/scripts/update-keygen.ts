// Make an Ed25519 key pair for signing update manifests (for a fork that publishes its own releases).
// usage: bun scripts/update-keygen.ts <private-key-out.pem>
// Writes the private key (mode 600, refuses to overwrite) and prints the public key for package.json "updatePublicKey".
// Keep the private key outside the repository; store it as the SKM_UPDATE_SIGN_KEY Actions secret.
import { generateKeyPairSync } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";

const out = process.argv[2];
if (out === undefined) {
  console.error("usage: bun scripts/update-keygen.ts <private-key-out.pem>");
  process.exit(2);
}
if (existsSync(out)) {
  console.error(`${out} exists; not overwriting it`);
  process.exit(1);
}
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
writeFileSync(out, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
const pub = publicKey.export({ type: "spki", format: "pem" }).toString().trim();
console.log(`wrote ${out}\n\nupdatePublicKey for desktop/package.json:\n${JSON.stringify(pub)}`);
