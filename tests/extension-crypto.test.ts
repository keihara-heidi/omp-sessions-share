import { expect, test } from "bun:test";
import { encryptWithPublicJwk } from "../extension/crypto";

test("extension encrypts collab link only for requester private key", async () => {
  const algorithm: RsaHashedKeyGenParams = {
    name: "RSA-OAEP",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  };
  const requester = (await crypto.subtle.generateKey(algorithm, false, [
    "encrypt",
    "decrypt",
  ])) as CryptoKeyPair;
  const stranger = (await crypto.subtle.generateKey(algorithm, false, [
    "encrypt",
    "decrypt",
  ])) as CryptoKeyPair;
  const publicKey = await crypto.subtle.exportKey("jwk", requester.publicKey);
  const link = "https://my.omp.sh/#room.secret";

  const ciphertext = await encryptWithPublicJwk(link, publicKey);
  const bytes = Buffer.from(ciphertext, "base64url");
  const plaintext = await crypto.subtle.decrypt(
    { name: "RSA-OAEP" },
    requester.privateKey,
    bytes,
  );

  expect(new TextDecoder().decode(plaintext)).toBe(link);
  await expect(
    crypto.subtle.decrypt({ name: "RSA-OAEP" }, stranger.privateKey, bytes),
  ).rejects.toThrow();
});
