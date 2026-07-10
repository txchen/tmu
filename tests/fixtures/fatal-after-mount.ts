import { main } from "../../src/main";

setTimeout(() => {
  throw new Error("injected fatal error after terminal takeover");
}, 5_000);
await main();
