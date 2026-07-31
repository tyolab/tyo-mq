'use strict';
// OFFLINE operator tool — mint the sealed-sender trust chain.
// Prints: the ROOT PUBLIC key (pin in client apps), the broker .env lines
// (server cert + server key), and the ROOT PRIVATE key (store offline; needed
// ONLY to rotate the server cert later). Run: `node scripts/sealed-mint-server-cert.js`
const { PrivateKey, ServerCertificate } = require('@signalapp/libsignal-client');

const b64 = (u8) => Buffer.from(u8).toString('base64');
const root = PrivateKey.generate();
const serverKey = PrivateKey.generate();
const keyId = 1;
const serverCert = ServerCertificate.new(keyId, serverKey.getPublicKey(), root);

console.log('# --- PIN THIS in each client app (sealed-sender trust root, base64 public key) ---');
console.log('SEALED_TRUST_ROOT_PUBLIC=' + b64(root.getPublicKey().serialize()));
console.log('');
console.log('# --- Add these to the broker .env (gitignored) ---');
console.log('TYO_MQ_SEALED_SERVER_CERT=' + b64(serverCert.serialize()));
console.log('TYO_MQ_SEALED_SERVER_KEY=' + b64(serverKey.serialize()));
console.log('');
console.log('# --- STORE OFFLINE (root private key; only needed to re-mint the server cert). Do NOT put on the broker. ---');
console.log('SEALED_ROOT_PRIVATE=' + b64(root.serialize()));
