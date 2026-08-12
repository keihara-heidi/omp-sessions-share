/** RSA-OAEP-256 encrypt for collab webLink delivery. Never log plaintext. */

export type PublicKeyJwk = JsonWebKey;

export async function encryptWithPublicJwk(
	plaintext: string,
	publicKeyJwk: PublicKeyJwk,
): Promise<string> {
	const key = await crypto.subtle.importKey(
		"jwk",
		publicKeyJwk,
		{ name: "RSA-OAEP", hash: "SHA-256" },
		false,
		["encrypt"],
	);
	const ciphertext = await crypto.subtle.encrypt(
		{ name: "RSA-OAEP" },
		key,
		new TextEncoder().encode(plaintext),
	);
	return bytesToBase64Url(new Uint8Array(ciphertext));
}

function bytesToBase64Url(bytes: Uint8Array): string {
	let bin = "";
	for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
