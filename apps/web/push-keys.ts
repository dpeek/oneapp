import { generateVAPIDKeys } from "web-push";

const { publicKey, privateKey } = generateVAPIDKeys();
console.log(`PUSH_PUBLIC_KEY=${publicKey}\nPUSH_PRIVATE_KEY=${privateKey}`);
