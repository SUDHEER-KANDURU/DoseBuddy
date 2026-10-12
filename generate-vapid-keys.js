// VAPID private keys must be generated and stored through an approved secret-management
// workflow. This repository utility intentionally does not generate, print, or write key material.
console.error("Generate VAPID credentials through your secret manager; never print or commit the private key.");
process.exitCode = 1;
